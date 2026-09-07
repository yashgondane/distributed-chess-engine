const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const { getRootMoves } = require('./searchEngine');

const PORT = process.env.PORT || 3001;
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const progressNs = io.of('/progress');

app.use(cors());
app.use(express.json());

const workers = new Map();
let activeSearch = null;

function clampDepth(depth) {
  const n = parseInt(depth, 10);
  if (!Number.isFinite(n) || n < 1) return 3;
  return Math.min(n, 4);
}

function resetActiveSearch() {
  activeSearch = null;
}

function assignNextMove(workerId) {
  if (!activeSearch) return;
  const worker = workers.get(workerId);
  if (!worker || worker.status !== 'idle' || !worker.socket.connected) return;

  const pending = activeSearch.assignments.find((a) => a.status === 'pending');
  if (!pending) return;

  pending.status = 'assigned';
  pending.workerId = workerId;
  worker.status = 'searching';
  worker.currentMove = pending.move;

  progressNs.emit('progress', {
    workerId,
    nodesExploredSoFar: 0,
    ts: Date.now(),
    move: pending.move,
    status: 'searching',
  });

  const workerUrl = `http://localhost:${worker.httpPort}/search`;
  console.log(`Master dispatching move "${pending.move}" to Worker ${workerId} via RPC POST ${workerUrl}`);

  fetch(workerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      position: activeSearch.fen,
      move: pending.move,
      depth: activeSearch.depth,
      boundSharing: activeSearch.boundSharing,
      currentBound: activeSearch.globalBound,
    }),
  })
    .then((res) => {
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      return res.json();
    })
    .then((data) => {
      handleWorkerResult(workerId, data);
    })
    .catch((err) => {
      console.error(`Worker ${workerId} RPC error on move "${pending.move}":`, err.message);
      handleWorkerResult(workerId, {
        move: pending.move,
        score: -Infinity,
        nodesExplored: 0,
        timeMs: 0,
      });
    });
}

function distributeMoves() {
  if (!activeSearch) return;
  for (const [workerId, worker] of workers) {
    if (worker.status === 'idle' && worker.socket.connected) {
      assignNextMove(workerId);
    }
  }
}

function checkSearchCompletion() {
  if (!activeSearch) return;
  const allDone = activeSearch.assignments.every(
    (a) => a.status === 'complete' || a.status === 'failed'
  );
  if (allDone) {
    finishSearch();
  }
}

function relayGlobalBound(value, fromWorker, sentTs) {
  if (!activeSearch) return;

  activeSearch.globalBound = Math.max(activeSearch.globalBound ?? -Infinity, value);

  const relayTs = Date.now();
  activeSearch.boundEvents.push({
    value,
    fromWorker,
    sentTs,
    relayTs,
    deliveries: [],
  });
  const eventIndex = activeSearch.boundEvents.length - 1;

  progressNs.emit('bound_event', {
    value,
    fromWorker,
    sentTs,
    relayTs,
  });

  for (const [id, worker] of workers) {
    if (id !== fromWorker && worker.status === 'searching' && worker.socket.connected) {
      worker.socket.emit('global_bound', {
        value,
        fromWorker,
        ts: relayTs,
      });
      activeSearch.boundEvents[eventIndex].deliveries.push({
        workerId: id,
        receivedTs: relayTs,
      });
    }
  }
}

function handleWorkerResult(workerId, data) {
  if (!activeSearch) return;

  // Match assignment by move name (unique among root moves)
  const assignment = activeSearch.assignments.find((a) => a.move === data.move);
  if (!assignment) return;

  if (assignment.status === 'complete') {
    return; // Ignore duplicate result if already marked complete
  }

  if (assignment.workerId && assignment.workerId !== workerId && assignment.status === 'assigned') {
    return; // Ignore result from worker if reassigned to another worker
  }

  assignment.status = 'complete';
  assignment.workerId = workerId;
  assignment.score = data.score;
  assignment.nodesExplored = data.nodesExplored;
  assignment.timeMs = data.timeMs;

  const worker = workers.get(workerId);
  if (worker) {
    worker.status = 'idle';
    worker.currentMove = null;
  }

  progressNs.emit('progress', {
    workerId,
    nodesExploredSoFar: data.nodesExplored,
    ts: Date.now(),
    move: data.move,
    score: data.score,
    status: 'complete',
  });

  assignNextMove(workerId);
  distributeMoves();
  checkSearchCompletion();
}

function handleWorkerDisconnect(workerId) {
  const worker = workers.get(workerId);
  if (worker) {
    worker.status = 'disconnected';
  }

  if (!activeSearch) return;

  for (const assignment of activeSearch.assignments) {
    if (assignment.workerId === workerId && assignment.status === 'assigned') {
      assignment.status = 'pending';
      assignment.workerId = null;
      progressNs.emit('progress', {
        workerId,
        nodesExploredSoFar: 0,
        ts: Date.now(),
        move: assignment.move,
        status: 'reassigned',
      });
    }
  }

  const remainingWorkers = [...workers.values()].filter((w) => w.socket.connected);
  if (remainingWorkers.length === 0) {
    activeSearch.assignments.forEach((a) => {
      if (a.status !== 'complete') a.status = 'failed';
    });
    finishSearch();
  } else {
    distributeMoves();
    checkSearchCompletion();
  }
}

function finishSearch() {
  if (!activeSearch) return;

  const completed = activeSearch.assignments.filter((a) => a.status === 'complete');
  let bestMove = null;
  let bestScore = -Infinity;

  for (const a of completed) {
    if (a.score > bestScore) {
      bestScore = a.score;
      bestMove = a.move;
    }
  }

  const table = activeSearch.assignments.map((a) => ({
    workerId: a.workerId ?? '—',
    move: a.move,
    score: a.status === 'complete' ? a.score : null,
    nodesExplored: a.status === 'complete' ? a.nodesExplored : 0,
    timeMs: a.status === 'complete' ? a.timeMs : 0,
    status: a.status,
  }));

  const totalNodes = completed.reduce((sum, a) => sum + (a.nodesExplored || 0), 0);

  const result = {
    bestMove,
    bestScore,
    table,
    totalNodesExplored: totalNodes,
    boundSharing: activeSearch.boundSharing,
    boundEvents: activeSearch.boundEvents,
  };

  if (activeSearch.resolve) {
    activeSearch.resolve(result);
  }

  progressNs.emit('search_complete', {
    bestMove,
    table,
    totalNodesExplored: totalNodes,
    boundSharing: activeSearch.boundSharing,
  });

  console.log(`[Master] Distributed search complete! Best move: "${bestMove}", Score: ${bestScore}, Total nodes: ${totalNodes}`);

  for (const [, worker] of workers) {
    if (worker.socket.connected) {
      worker.status = 'idle';
      worker.currentMove = null;
    }
  }

  if (activeSearch.timeoutId) {
    clearTimeout(activeSearch.timeoutId);
  }

  resetActiveSearch();
}

function startDistributedSearch(fen, depth, boundSharing) {
  return new Promise((resolve, reject) => {
    if (activeSearch) {
      return reject(new Error('A search is already in progress'));
    }

    const board = new Chess(fen);
    if (board.isGameOver()) {
      return resolve({ bestMove: null, table: [], totalNodesExplored: 0, gameOver: true });
    }

    const rootMoves = getRootMoves(fen);
    if (rootMoves.length === 0) {
      return resolve({ bestMove: null, table: [], totalNodesExplored: 0, gameOver: true });
    }

    const connectedWorkers = [...workers.values()].filter((w) => w.socket.connected);
    if (connectedWorkers.length === 0) {
      return reject(new Error('No workers connected'));
    }

    // Reset worker statuses before starting
    for (const [, worker] of workers) {
      if (worker.socket.connected) {
        worker.status = 'idle';
        worker.currentMove = null;
      }
    }

    activeSearch = {
      fen,
      depth,
      boundSharing,
      globalBound: null,
      boundEvents: [],
      assignments: rootMoves.map((move) => ({
        move,
        status: 'pending',
        workerId: null,
        score: null,
        nodesExplored: 0,
        timeMs: 0,
      })),
      resolve,
      reject,
      startedAt: Date.now(),
    };

    distributeMoves();

    const timeout = setTimeout(() => {
      if (activeSearch) {
        console.warn('Search timed out after 60s, completing with available results');
        activeSearch.assignments.forEach((a) => {
          if (a.status !== 'complete') {
            a.status = 'failed';
          }
        });
        finishSearch();
      }
    }, 60000);

    activeSearch.timeoutId = timeout;
  });
}

io.on('connection', (socket) => {
  let workerId = null;

  socket.on('register', ({ workerId: id, httpPort }) => {
    workerId = String(id);
    const resolvedPort = httpPort || (4000 + parseInt(workerId, 10));
    workers.set(workerId, {
      socket,
      httpPort: resolvedPort,
      status: 'idle',
      currentMove: null,
    });
    console.log(`Worker ${workerId} registered (HTTP port ${resolvedPort}, ${workers.size} total)`);
    if (activeSearch) {
      assignNextMove(workerId);
    }
  });

  socket.on('bound_update', (data) => {
    relayGlobalBound(data.value, String(data.workerId), data.ts);
  });

  socket.on('progress_update', (data) => {
    if (!activeSearch) return;
    progressNs.emit('progress', {
      workerId: data.workerId,
      nodesExploredSoFar: data.nodesExploredSoFar,
      ts: data.ts,
      move: data.move,
      status: 'searching',
    });
  });

  socket.on('bound_received', (data) => {
    if (!activeSearch) return;
    const lastEvent = activeSearch.boundEvents[activeSearch.boundEvents.length - 1];
    if (lastEvent && lastEvent.value === data.value) {
      lastEvent.deliveries.push({
        workerId: String(data.workerId),
        receivedTs: data.receivedTs,
      });
      progressNs.emit('bound_delivery', {
        fromWorker: lastEvent.fromWorker,
        value: data.value,
        workerId: data.workerId,
        sentTs: lastEvent.sentTs,
        relayTs: lastEvent.relayTs,
        receivedTs: data.receivedTs,
        delayMs: data.receivedTs - lastEvent.relayTs,
      });
    }
  });

  socket.on('disconnect', () => {
    if (workerId) {
      console.log(`Worker ${workerId} disconnected`);
      handleWorkerDisconnect(workerId);
      workers.delete(workerId);
    }
  });
});

progressNs.on('connection', (socket) => {
  console.log('Frontend connected to /progress');
  socket.on('disconnect', () => {
    console.log('Frontend disconnected from /progress');
  });
});

app.get('/workers', (_req, res) => {
  const list = [...workers.entries()].map(([id, w]) => ({
    workerId: id,
    status: w.status,
    currentMove: w.currentMove,
    connected: w.socket.connected,
  }));
  res.json({ count: list.length, workers: list });
});

app.post('/search', async (req, res) => {
  const { fen, depth = 3, boundSharing = true } = req.body;

  if (!fen) {
    return res.status(400).json({ error: 'FEN string is required' });
  }

  try {
    const result = await startDistributedSearch(fen, clampDepth(depth), Boolean(boundSharing));
    res.json(result);
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/search/compare', async (req, res) => {
  const { fen, depth = 3 } = req.body;

  if (!fen) {
    return res.status(400).json({ error: 'FEN string is required' });
  }

  try {
    const withBounds = await startDistributedSearch(fen, clampDepth(depth), true);
    const withoutBounds = await startDistributedSearch(fen, clampDepth(depth), false);

    res.json({
      withBoundSharing: {
        totalNodesExplored: withBounds.totalNodesExplored,
        bestMove: withBounds.bestMove,
      },
      withoutBoundSharing: {
        totalNodesExplored: withoutBounds.totalNodesExplored,
        bestMove: withoutBounds.bestMove,
      },
    });
  } catch (err) {
    console.error('Compare search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Master server listening on port ${PORT}`);
  console.log(`  REST:  POST /search, POST /search/compare, GET /workers`);
  console.log(`  Workers: Socket.IO (default namespace)`);
  console.log(`  Frontend: Socket.IO /progress namespace`);
});
