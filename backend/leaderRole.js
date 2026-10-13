const { Chess } = require('chess.js');
const { getRootMoves } = require('./searchEngine');
const LeaderState = require('./leaderState');
const { ANTI_ENTROPY_MS } = require('./constants');
const { now, emitStamped, onStamped, fetchStamped } = require('./lamport');
const { owners, buildRing } = require('./ring');
const { randomUUID } = require('node:crypto');
const LockManager = require('./lock');
const { LOCK_LEASE_MS } = require('./constants');
const antiEntropyTimers = new WeakMap();
const activeSearchCleanups = new WeakMap();
const socketHandlers = new WeakMap();
const lockTimers = new WeakMap();
const lockWaitersByNode = new WeakMap();
const routeLayersByNode = new WeakMap();
function startLeaderDuties(node) {
  const { app, io, progressNs } = node;
  node.leaderState = node.leaderState || LeaderState.empty();
  let activeSearch = node.leaderState.currentSearch || null;
  let resumeReady = !activeSearch;
  Object.defineProperty(node.leaderState, 'currentSearch', { configurable: true, get: () => activeSearch, set: value => { activeSearch = value; } });
  const workers = new Map();
  const restoredLock = node.leaderState.lock || node.replica?.lock;
  const lockManager = new LockManager({ leaseMs: LOCK_LEASE_MS });
  if (restoredLock) lockManager.restore(restoredLock, { freshLease: true });
  node.lockManager = lockManager;
  node.leaderState.lockManager = lockManager;
  const lockWaiters = new Map();
  lockWaitersByNode.set(node, lockWaiters);
  if (restoredLock?.holder) {
    node.log('LOCK_RESTORED', { holder: restoredLock.holder.requestId, queueLength: lockManager.queue.length, fence: lockManager.fence });
  }
  const emitLockUpdate = () => emitStamped(node, progressNs, 'lock_update', { ...lockManager.view(), nodeId: node.id });
  const lockChanged = () => { node.requestReplicate(); emitLockUpdate(); };
  const grantQueued = (entry) => {
    if (!entry) return;
    node.log('LOCK_GRANTED', { requestId: entry.requestId, clientId: entry.clientId, fence: entry.fence });
    lockChanged();
    const waiter = lockWaiters.get(entry.requestId);
    if (waiter) {
      clearTimeout(waiter.timer);
      lockWaiters.delete(entry.requestId);
      waiter.resolve({ requestId: entry.requestId, fence: entry.fence });
    }
  };
  const releaseLock = (requestId, fence) => {
    const result = lockManager.release(requestId, fence);
    if (!result) return false;
    node.log('LOCK_RELEASED', { requestId, fence });
    lockChanged();
    if (result.next) grantQueued(result.next);
    return true;
  };
  const waitForGrant = (requestId, res) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const cancelled = lockManager.cancel(requestId);
      lockWaiters.delete(requestId);
      if (cancelled.cancelled) lockChanged();
      reject(new Error('lock_timeout'));
    }, 60000);
    lockWaiters.set(requestId, { resolve, reject, timer });
    res.once('close', () => {
      if (res.writableEnded || !lockWaiters.has(requestId)) return;
      const cancelled = lockManager.cancel(requestId);
      clearTimeout(timer);
      lockWaiters.delete(requestId);
      if (cancelled.cancelled) lockChanged();
      reject(new Error('lock_client_disconnected'));
    });
  });
  const getSearchGrant = async (req, res, label) => {
    const requestId = req.body.requestId || randomUUID();
    const clientId = req.body.clientId || 'anonymous';
    const hadHolder = lockManager.holder?.requestId === requestId;
    const hadQueue = lockManager.queue.some((entry) => entry.requestId === requestId);
    const outcome = lockManager.request({ requestId, clientId, label, lc: node.clock.tick() });
    if (outcome.status === 'full') {
      res.status(429).json({ error: 'queue_full' });
      return null;
    }
    if (outcome.status === 'granted') {
      if (hadHolder && activeSearch?.lockRequestId === requestId) {
        res.status(202).json({ status: 'running_resumed', requestId });
        return null;
      }
      if (!hadHolder) {
        node.log('LOCK_GRANTED', { requestId, clientId, fence: outcome.fence });
        lockChanged();
      }
      return { requestId, fence: outcome.fence };
    }
    if (!hadQueue) {
      node.log('LOCK_QUEUED', { requestId, position: outcome.position });
      lockChanged();
    }
    if (lockWaiters.has(requestId)) {
      res.status(202).json({ status: 'queued', requestId, position: outcome.position });
      return null;
    }
    try { return await waitForGrant(requestId, res); }
    catch (error) {
      if (error.message === 'lock_timeout' && !res.headersSent) res.status(408).json({ error: 'lock_timeout' });
      else if (error.message === 'lock_client_disconnected' && !res.headersSent) res.status(408).json({ error: 'lock_timeout' });
      else if (error.message === 'leader_changed' && !res.headersSent && !res.destroyed) res.status(503).json({ error: 'not_leader', leaderId: node.leaderId });
      return null;
    }
  };
  const ring = buildRing(node.peers.map((peer) => peer.id));
  const storeKey = (fen, depth) => `${String(fen).split(/\s+/).slice(0, 4).join(' ')}|${depth}`;
  async function storeRequest(peerId, route, options = {}) {
    const peer = node.peers.find((item) => item.id === peerId);
    if (!peer) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 800);
    try {
      const response = await fetchStamped(node, `http://${peer.host}:${peer.port}${route}`, {
        ...options, signal: controller.signal,
      });
      let data = null;
      try { data = await response.json(); } catch { /* empty body */ }
      return { ok: response.ok, status: response.status, data };
    } catch { return null; }
    finally { clearTimeout(timeout); }
  }
  async function getFromOwner(ownerId, key) {
    if (ownerId === node.id) return { ok: true, data: node.store.get(key) ? { found: true, entry: node.store.get(key) } : { found: false } };
    return storeRequest(ownerId, `/store/get?key=${encodeURIComponent(key)}`);
  }
  async function putToOwners(entry, ownerIds) {
    const succeeded = [];
    for (const ownerId of ownerIds) {
      let result;
      if (ownerId === node.id) {
        try {
          node.store.put(entry);
          node.log('STORE_PUT', { key: entry.key, from: node.id });
          result = { ok: true };
        }
        catch { result = null; }
      } else {
        result = await storeRequest(ownerId, '/store/put', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entry, from: node.id }),
        });
      }
      if (result?.ok) succeeded.push(ownerId);
      else node.log('STORE_PUT_FAILED', { key: entry.key, node: ownerId });
    }
    node.log('STORE_PUT_OK', { key: entry.key, to: succeeded });
  }
  activeSearchCleanups.set(node, () => { activeSearch?.reject?.(new Error('leader_changed')); activeSearch = null; });
  antiEntropyTimers.set(node, setInterval(() => node.requestReplicate(), ANTI_ENTROPY_MS));
  const restoredHolder = lockManager.holder;
  if (activeSearch && restoredHolder) {
    activeSearch.lockRequestId = restoredHolder.requestId;
    activeSearch.fence = restoredHolder.fence;
    activeSearch.storeEnabled = true;
  }
  lockTimers.set(node, setInterval(() => {
    const expired = lockManager.expire();
    if (!expired) return;
    node.log('LOCK_LEASE_EXPIRED', { holder: expired.expired.requestId, fence: expired.expired.fence });
    if (activeSearch?.lockRequestId === expired.expired.requestId && activeSearch.fence === expired.expired.fence) {
      const stale = activeSearch;
      resetActiveSearch();
      stale.reject?.(new Error('lock_lease_expired'));
    }
    lockChanged();
    if (expired.next) grantQueued(expired.next);
  }, 500));

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
  node.requestReplicate();

  progressNs.emit('progress', {
    workerId,
    nodesExploredSoFar: 0,
    ts: now(),
    move: pending.move,
    status: 'searching',
  });

  const workerUrl = `http://localhost:${worker.httpPort}/rpc/search`;
  const requestTerm = node.term;
  const requestSearchId = activeSearch.searchId;
  const requestFence = activeSearch.fence;
  console.log(`Master dispatching move "${pending.move}" to Worker ${workerId} via RPC POST ${workerUrl}`);

  fetchStamped(node, workerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      position: activeSearch.fen,
      move: pending.move,
      depth: activeSearch.depth,
      boundSharing: activeSearch.boundSharing,
      currentBound: activeSearch.globalBound,
      term: requestTerm,
      searchId: requestSearchId,
      searchLc: activeSearch.searchLc,
    }),
  })
    .then((res) => {
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      return res.json();
    })
    .then((data) => {
      handleWorkerResult(workerId, data, requestTerm, requestSearchId, requestFence);
    })
    .catch((err) => {
      console.error(`Worker ${workerId} RPC error on move "${pending.move}":`, err.message);
      if (node.role !== 'leader' || requestTerm !== node.term || !activeSearch || activeSearch.searchId !== requestSearchId) return;
      const assignment = activeSearch.assignments.find((a) => a.move === pending.move);
      if (!assignment || assignment.status === 'complete') return;
      assignment.status = 'pending';
      assignment.workerId = null;
      const failedWorker = workers.get(String(workerId));
      if (failedWorker) {
        workers.delete(String(workerId));
        failedWorker.socket.disconnect(true);
        node.workersRegistered = workers.size;
      }
      node.requestReplicate();
      progressNs.emit('progress', { workerId, move: pending.move, status: 'reassigned', ts: now(), nodesExploredSoFar: 0 });
      distributeMoves();
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

function relayGlobalBound(value, fromWorker, sentTs, sentLc, searchId) {
  if (!activeSearch) return;

  const previousBound = activeSearch.globalBound ?? -Infinity;
  activeSearch.globalBound = Math.max(previousBound, value);
  if (activeSearch.globalBound > previousBound) {
    activeSearch.globalBoundFrom = fromWorker;
    node.requestReplicate();
  }

  const relayTs = now();
  const receivers = [...workers.entries()]
    .filter(([id, worker]) => id !== fromWorker && worker.status === 'searching' && worker.socket.connected);
  const relay = emitStamped(node, receivers.map(([, worker]) => worker.socket), 'global_bound', {
    value, fromWorker, ts: relayTs, sentTs, relayTs, sentLc,
    searchId: activeSearch.searchId, term: node.term,
  });
  const row = { fromWorker: Number(fromWorker), value, searchId: activeSearch.searchId,
    sentLc, relayLc: relay.lc, receivers: [], sentTs, relayTs };
  node.boundLog.push(row);
  if (node.boundLog.length > 100) node.boundLog.shift();
  activeSearch.boundEvents.push({ value, fromWorker, sentTs, relayTs, sentLc, relayLc: relay.lc, deliveries: [] });

  progressNs.emit('bound_event', { value, fromWorker, sentTs, relayTs, sentLc, relayLc: relay.lc, lc: relay.lc });
}

function handleWorkerResult(workerId, data, requestTerm, requestSearchId, requestFence) {
  if (!node.lockManager?.isCurrent(requestFence)) {
    node.log('LOCK_STALE_COMPLETION', { fence: requestFence, currentFence: node.lockManager?.fence ?? 0 });
    return;
  }
  if (!activeSearch || node.role !== 'leader' || requestTerm !== node.term || requestSearchId !== activeSearch.searchId) return;
  if ((data.term != null && data.term !== requestTerm) || (data.searchId != null && data.searchId !== requestSearchId)) return;

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
  node.requestReplicate();

  const worker = workers.get(workerId);
  if (worker) {
    worker.status = 'idle';
    worker.currentMove = null;
  }

  progressNs.emit('progress', {
    workerId,
    nodesExploredSoFar: data.nodesExplored,
    ts: now(),
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
      node.requestReplicate();
      progressNs.emit('progress', {
        workerId,
        nodesExploredSoFar: 0,
        ts: now(),
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
  if (!node.lockManager?.isCurrent(activeSearch.fence)) {
    node.log('LOCK_STALE_COMPLETION', { fence: activeSearch.fence, currentFence: node.lockManager?.fence ?? 0 });
    const stale = activeSearch;
    resetActiveSearch();
    stale.reject?.(new Error('lock_stale_completion'));
    return;
  }

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
    cache: activeSearch.cacheInfo || { hit: false, owners: owners(ring, storeKey(activeSearch.fen, activeSearch.depth)) },
  };

  if (activeSearch.resolve) {
    activeSearch.resolve(result);
  }

  node.leaderState.history.push({
    searchId: activeSearch.searchId, fen: activeSearch.fen, depth: activeSearch.depth,
    bestMove, score: bestScore, totalNodes, boundSharing: activeSearch.boundSharing, finishedAt: now(),
  });
  node.leaderState.history = node.leaderState.history.slice(-20);

  progressNs.emit('search_complete', {
    bestMove,
    bestScore,
    table,
    totalNodesExplored: totalNodes,
    boundSharing: activeSearch.boundSharing,
    cache: result.cache,
  });

  if (activeSearch.storeEnabled && completed.length === activeSearch.assignments.length) {
    const key = storeKey(activeSearch.fen, activeSearch.depth);
    const ownerIds = result.cache.owners || owners(ring, key);
    const entry = {
      key, fen: activeSearch.fen, depth: activeSearch.depth, bestMove, score: bestScore,
      nodesExplored: totalNodes, timeMs: Math.max(0, Date.now() - (activeSearch.startedMonotonic || Date.now())),
      moves: table, computedBy: node.id, term: node.term, storedAt: now(), lc: node.clock.tick(),
    };
    setImmediate(() => void putToOwners(entry, ownerIds));
  }

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

  const completedLock = { requestId: activeSearch.lockRequestId, fence: activeSearch.fence };
  const releaseOnFinish = activeSearch.releaseLockOnFinish === true;
  resetActiveSearch();
  node.requestReplicate();
  // A resumed search has no original HTTP handler left to release its lease.
  if (releaseOnFinish && completedLock.requestId) releaseLock(completedLock.requestId, completedLock.fence);
}

function startDistributedSearch(fen, depth, boundSharing, cacheInfo = null, lockContext = {}) {
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
      searchId: `s-${Date.now()}`,
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
      startedAt: now(),
      searchLc: node.clock.tick(),
      cacheInfo,
      storeEnabled: Boolean(cacheInfo),
      lockRequestId: lockContext.requestId,
      fence: lockContext.fence,
      startedMonotonic: Date.now(),
    };
    resumeReady = true;

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
    node.requestReplicate();
  });
}

const ioConnectionHandler = (socket) => {
  let workerId = null;

  onStamped(node, socket, 'register', ({ workerId: id, httpPort }) => {
    workerId = String(id);
    const resolvedPort = httpPort || (4000 + parseInt(workerId, 10));
    workers.set(workerId, {
      socket,
      httpPort: resolvedPort,
      status: 'idle',
      currentMove: null,
    });
    node.workersRegistered = workers.size;
    node.requestReplicate();
    console.log(`Worker ${workerId} registered (HTTP port ${resolvedPort}, ${workers.size} total)`);
    if (activeSearch && resumeReady) {
      assignNextMove(workerId);
    }
  });

  onStamped(node, socket, 'bound_update', (data) => {
    if (!activeSearch || data.term < node.term || data.searchId !== activeSearch.searchId) return;
    node.log('BOUND_RECEIVED', { workerId: data.workerId, value: data.value, searchId: data.searchId });
    relayGlobalBound(data.value, String(data.workerId), data.ts, data.lc, data.searchId);
  });

  onStamped(node, socket, 'progress_update', (data) => {
    if (!activeSearch || data.term < node.term || data.searchId !== activeSearch.searchId) return;
    if (activeSearch.lockRequestId && lockManager.renew(activeSearch.lockRequestId)) emitLockUpdate();
    progressNs.emit('progress', {
      workerId: data.workerId,
      nodesExploredSoFar: data.nodesExploredSoFar,
      ts: data.ts,
      move: data.move,
      status: 'searching',
    });
  });

  onStamped(node, socket, 'bound_received', (data) => {
    if (!activeSearch || data.term < node.term || data.searchId !== activeSearch.searchId) return;
    const lastEvent = activeSearch.boundEvents[activeSearch.boundEvents.length - 1];
    if (lastEvent && lastEvent.value === data.value) {
      lastEvent.deliveries.push({
        workerId: String(data.workerId),
        receivedTs: data.recvTs ?? data.receivedTs,
      });
      const row = [...node.boundLog].reverse().find((entry) => entry.searchId === data.searchId &&
        entry.value === data.value && entry.fromWorker === Number(data.fromWorker));
      if (row) row.receivers.push({ workerId: Number(data.workerId), recvLc: data.recvLc, recvTs: data.recvTs ?? data.receivedTs });
      progressNs.emit('bound_delivery', {
        fromWorker: lastEvent.fromWorker,
        value: data.value,
        workerId: data.workerId,
        sentTs: lastEvent.sentTs,
        relayTs: lastEvent.relayTs,
        receivedTs: data.recvTs ?? data.receivedTs,
        sentLc: lastEvent.sentLc,
        relayLc: lastEvent.relayLc,
        recvLc: data.recvLc,
        delayMs: (data.recvTs ?? data.receivedTs) - lastEvent.relayTs,
      });
    }
  });

  socket.on('disconnect', () => {
    if (workerId) {
      console.log(`Worker ${workerId} disconnected`);
      handleWorkerDisconnect(workerId);
      workers.delete(workerId);
      node.workersRegistered = workers.size;
      node.requestReplicate();
    }
  });
};
io.on('connection', ioConnectionHandler);

const progressConnectionHandler = (socket) => {
  console.log('Frontend connected to /progress');
  const snapshot = node.leaderState?.toSnapshot(node.term, node.id);
  emitStamped(node, socket, 'state_sync', {
    term: node.term,
    leaderId: node.id,
    currentSearch: snapshot?.currentSearch ?? null,
    history: snapshot?.history ?? [],
  });
  socket.on('disconnect', () => {
    console.log('Frontend disconnected from /progress');
  });
};
progressNs.on('connection', progressConnectionHandler);
socketHandlers.set(node, { ioConnectionHandler, progressConnectionHandler });

const routeStartIndex = app.router.stack.length;
app.get('/lock/view', (_req, res) => res.json(lockManager.view()));
app.post('/lock/acquire', (req, res) => {
  const requestId = req.body?.requestId || randomUUID();
  const clientId = req.body?.clientId || 'anonymous';
  const hadHolder = lockManager.holder?.requestId === requestId;
  const hadQueue = lockManager.queue.some((entry) => entry.requestId === requestId);
  const result = lockManager.request({ requestId, clientId, label: req.body?.label || 'hog', lc: node.clock.tick() });
  if (result.status === 'full') return res.status(429).json({ error: 'queue_full' });
  if (result.status === 'granted' && !hadHolder) {
    node.log('LOCK_GRANTED', { requestId, clientId, fence: result.fence });
    lockChanged();
  } else if (result.status === 'queued' && !hadQueue) {
    node.log('LOCK_QUEUED', { requestId, position: result.position });
    lockChanged();
  }
  return res.json({ ...result, requestId, ...(result.status === 'granted' ? { fence: result.fence } : {}) });
});
app.post('/lock/release', (req, res) => {
  const result = releaseLock(req.body?.requestId, req.body?.fence);
  return result ? res.json({ released: true }) : res.status(409).json({ released: false });
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
  const { fen, depth = 3, boundSharing = true, useCache = true } = req.body;

  if (!fen) {
    return res.status(400).json({ error: 'FEN string is required' });
  }

  try {
    const safeDepth = clampDepth(depth);
    const key = storeKey(fen, safeDepth);
    const ownerIds = owners(ring, key);
    if (useCache) {
      const lookupStarted = Date.now();
      let primaryReply = await getFromOwner(ownerIds[0], key);
      let servedBy = ownerIds[0];
      let hit = primaryReply?.ok && primaryReply.data?.found ? primaryReply.data.entry : null;
      if (!hit) {
        const replicaReply = await getFromOwner(ownerIds[1], key);
        if (replicaReply?.ok && replicaReply.data?.found) {
          hit = replicaReply.data.entry;
          servedBy = ownerIds[1];
          if (primaryReply?.ok && primaryReply.data?.found === false) {
            setImmediate(() => void putToOwners(hit, [ownerIds[0]]));
            node.log('STORE_READ_REPAIR', { key, to: ownerIds[0] });
          }
        }
      }
      if (hit) {
        const cache = { hit: true, servedBy, owners: ownerIds, latencyMs: Date.now() - lookupStarted };
        node.log('STORE_HIT', { key, servedBy, primary: ownerIds[0], replica: ownerIds[1] });
        const result = {
          bestMove: hit.bestMove, bestScore: hit.score, table: hit.moves || [],
          totalNodesExplored: hit.nodesExplored || 0, boundSharing: Boolean(boundSharing),
          boundEvents: [], cache,
        };
        emitStamped(node, progressNs, 'search_complete', {
          bestMove: result.bestMove, bestScore: result.bestScore, table: result.table,
          totalNodesExplored: result.totalNodesExplored, boundSharing: result.boundSharing, cache,
        });
        return res.json(result);
      }
    }
    const cacheInfo = { hit: false, owners: ownerIds };
    const grant = await getSearchGrant(req, res, req.body.label || 'search');
    if (!grant) return;
    try {
      const result = await startDistributedSearch(fen, safeDepth, Boolean(boundSharing), cacheInfo, grant);
      result.cache = cacheInfo;
      result.requestId = grant.requestId;
      res.json(result);
    } catch (err) {
      if (node.role !== 'leader') res.status(503).json({ error: 'not_leader', leaderId: node.leaderId });
      else if (err.message === 'lock_lease_expired' || err.message === 'lock_stale_completion') res.status(409).json({ error: err.message });
      else res.status(500).json({ error: err.message });
    } finally {
      releaseLock(grant.requestId, grant.fence);
    }
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
    const grant = await getSearchGrant(req, res, req.body.label || 'compare');
    if (!grant) return;
    try {
      const withBounds = await startDistributedSearch(fen, clampDepth(depth), true, null, grant);
      const withoutBounds = await startDistributedSearch(fen, clampDepth(depth), false, null, grant);
      res.json({
        withBoundSharing: { totalNodesExplored: withBounds.totalNodesExplored, bestMove: withBounds.bestMove },
        withoutBoundSharing: { totalNodesExplored: withoutBounds.totalNodesExplored, bestMove: withoutBounds.bestMove },
      });
    } catch (err) {
      if (node.role !== 'leader') res.status(503).json({ error: 'not_leader', leaderId: node.leaderId });
      else if (err.message === 'lock_lease_expired' || err.message === 'lock_stale_completion') res.status(409).json({ error: err.message });
      else res.status(500).json({ error: err.message });
    } finally {
      releaseLock(grant.requestId, grant.fence);
    }
  } catch (err) {
    console.error('Compare search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

routeLayersByNode.set(node, app.router.stack.slice(routeStartIndex));

async function resumeSearch() {
  if (!activeSearch) return;
  activeSearch.storeEnabled = true;
  activeSearch.releaseLockOnFinish = true;
  const unfinished = activeSearch.assignments.filter((assignment) => assignment.status !== 'complete');
  if (unfinished.length === 0) return;

  for (let attempt = 0; attempt <= 15; attempt++) {
    if (node.role !== 'leader' || !activeSearch) return;
    if ([...workers.values()].some((worker) => worker.socket.connected)) break;
    if (attempt === 15) {
      node.log('SEARCH_STALLED', { searchId: activeSearch.searchId });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const completed = activeSearch.assignments.filter((assignment) => assignment.status === 'complete').length;
  for (const assignment of activeSearch.assignments) {
    if (assignment.status !== 'complete') {
      assignment.status = 'pending';
      assignment.workerId = null;
    }
  }
  resumeReady = true;
  const remaining = activeSearch.assignments.length - completed;
  node.log('SEARCH_RESUMED', { completed, remaining });
  emitStamped(node, progressNs, 'search_resumed', { completed, remaining });
  activeSearch.searchLc = node.clock.tick();
  node.requestReplicate();
  distributeMoves();
  checkSearchCompletion();
}

node.resumeSearch = resumeSearch;

}
function stopLeaderDuties(node) {
  clearInterval(antiEntropyTimers.get(node));
  antiEntropyTimers.delete(node);
  clearInterval(lockTimers.get(node));
  lockTimers.delete(node);
  for (const waiter of lockWaitersByNode.get(node)?.values() || []) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error('leader_changed'));
  }
  lockWaitersByNode.get(node)?.clear();
  lockWaitersByNode.delete(node);
  const routeLayers = new Set(routeLayersByNode.get(node) || []);
  if (routeLayers.size && node.app.router?.stack) {
    node.app.router.stack = node.app.router.stack.filter((layer) => !routeLayers.has(layer));
  }
  routeLayersByNode.delete(node);
  node.lockManager = null;
  activeSearchCleanups.get(node)?.();
  activeSearchCleanups.delete(node);
  const handlers = socketHandlers.get(node);
  if (handlers) {
    node.io.off('connection', handlers.ioConnectionHandler);
    node.progressNs.off('connection', handlers.progressConnectionHandler);
    socketHandlers.delete(node);
  }
  node.io.disconnectSockets(true);
  node.io.of('/progress').disconnectSockets(true);
}
module.exports = { startLeaderDuties, stopLeaderDuties };
