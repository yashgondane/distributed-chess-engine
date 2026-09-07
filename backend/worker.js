const { io } = require('socket.io-client');
const express = require('express');
const { searchAssignedMove } = require('./searchEngine');

const MASTER_URL = process.env.MASTER_URL || 'http://localhost:3001';

function parseArgs() {
  const args = process.argv.slice(2);
  let workerId = '1';
  let httpPort = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--id' && args[i + 1]) {
      workerId = args[i + 1];
    }
    if (args[i] === '--port' && args[i + 1]) {
      httpPort = parseInt(args[i + 1], 10);
    }
  }
  if (!httpPort) {
    httpPort = process.env.HTTP_PORT
      ? parseInt(process.env.HTTP_PORT, 10)
      : 4000 + parseInt(workerId, 10);
  }
  return { workerId, httpPort };
}

const { workerId, httpPort } = parseArgs();
let globalBound = null;
let searching = false;
let currentMove = null;

const app = express();
app.use(express.json());

const socket = io(MASTER_URL, {
  reconnection: true,
  reconnectionDelay: 1000,
});

app.post('/search', async (req, res) => {
  const { position, move, depth, boundSharing, currentBound } = req.body;

  if (searching) {
    console.warn(`Worker ${workerId} is busy on "${currentMove}", ignoring assign_move for "${move}"`);
    return res.status(429).json({ error: `Worker ${workerId} is busy` });
  }

  searching = true;
  currentMove = move;
  const boundSharingEnabled = Boolean(boundSharing);
  globalBound = currentBound ?? null;

  console.log(`Worker ${workerId} assigned move "${move}" at depth ${depth} via HTTP RPC`);
  const startTime = Date.now();

  try {
    const result = await searchAssignedMove(position, move, depth, {
      boundSharing: boundSharingEnabled,
      getGlobalBound: () => globalBound,
      onProgress: (nodesExploredSoFar) => {
        socket.emit('progress_update', {
          workerId,
          nodesExploredSoFar,
          ts: Date.now(),
          move,
        });
      },
      onBoundImprove: (score) => {
        if (Number.isFinite(score) && score > (globalBound ?? -Infinity)) {
          globalBound = score;
          const ts = Date.now();
          socket.emit('bound_update', { workerId, value: score, ts });
        }
      },
    });

    const timeMs = Date.now() - startTime;
    console.log(
      `Worker ${workerId} finished "${move}": score=${result.score}, nodes=${result.nodesExplored}, time=${timeMs}ms`
    );

    res.json({
      move,
      score: result.score,
      nodesExplored: result.nodesExplored,
      timeMs,
    });
  } catch (err) {
    console.error(`Worker ${workerId} search error on "${move}":`, err.message);
    res.json({
      move,
      score: -Infinity,
      nodesExplored: 0,
      timeMs: Date.now() - startTime,
    });
  } finally {
    searching = false;
    currentMove = null;
  }
});

app.listen(httpPort, () => {
  console.log(`Worker ${workerId} HTTP RPC server listening on port ${httpPort}`);
});

socket.on('connect', () => {
  console.log(`Worker ${workerId} connected to master`);
  searching = false;
  currentMove = null;
  socket.emit('register', { workerId, httpPort });
});

socket.on('disconnect', () => {
  console.log(`Worker ${workerId} disconnected from master`);
  searching = false;
  currentMove = null;
});

socket.on('global_bound', ({ value, fromWorker, ts }) => {
  const receivedTs = Date.now();
  globalBound = Math.max(globalBound ?? -Infinity, value);
  console.log(
    `[Worker ${workerId}] global_bound=${value} from worker ${fromWorker} (delay ${receivedTs - ts}ms)`
  );
  socket.emit('bound_received', {
    workerId,
    value,
    receivedTs,
  });
});

console.log(`Worker ${workerId} starting, connecting to ${MASTER_URL}...`);

