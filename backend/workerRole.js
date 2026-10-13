const { io } = require('socket.io-client');
const { searchAssignedMove } = require('./searchEngine');
const { now, emitStamped, onStamped, shouldAcceptBound } = require('./lamport');

const runtimes = new WeakMap();

function startWorkerRole(node, leaderUrl) {
  let runtime = runtimes.get(node);
  if (!runtime) {
    runtime = { client: null, job: null, bound: null, routeRegistered: false };
    runtimes.set(node, runtime);
  }
  if (runtime.client) runtime.client.disconnect();
  const client = io(leaderUrl, { reconnection: false });
  runtime.client = client;
  node.workerSocket = client;

  client.on('connect', () => emitStamped(node, client, 'register', { workerId: node.id, httpPort: node.port }));
  onStamped(node, client, 'global_bound', (data) => {
    const job = runtime.job;
    if (!shouldAcceptBound(job, data)) {
      node.log('BOUND_DROPPED_STALE', {
        value: data?.value, msgLc: data?.lc, searchLc: job?.searchLc, searchId: data?.searchId,
      });
      return;
    }
    runtime.bound = Math.max(runtime.bound ?? -Infinity, data.value);
    const recvLc = node.clock.value;
    const recvTs = now();
    node.log('GLOBAL_BOUND_RECEIVED', { value: data.value, searchId: data.searchId, msgLc: data.lc });
    emitStamped(node, client, 'bound_received', {
      workerId: node.id, fromWorker: data.fromWorker, value: data.value, recvLc, recvTs, receivedTs: recvTs,
      searchId: job.searchId, term: job.term,
    });
  });

  if (!runtime.routeRegistered) {
    runtime.routeRegistered = true;
    node.app.post('/rpc/search', async (req, res) => {
      const { term, searchId, searchLc, position, move, depth, boundSharing, currentBound } = req.body;
      if (node.role !== 'follower' || (term != null && term < node.term)) {
        return res.status(409).json({ error: 'stale_term' });
      }
      if (runtime.job) return res.status(429).json({ error: 'busy' });
      const job = { searchId, term, searchLc, cancelled: false };
      runtime.job = job;
      runtime.bound = currentBound ?? null;
      const started = Date.now();
      try {
        const result = await searchAssignedMove(position, move, depth, {
          boundSharing,
          getGlobalBound: () => runtime.bound,
          shouldCancel: () => job.cancelled || (job.term != null && job.term < node.term),
          onProgress: (nodesExploredSoFar) => runtime.client && emitStamped(node, runtime.client, 'progress_update', {
            workerId: node.id, nodesExploredSoFar, ts: now(), move, searchId, term,
          }),
          onBoundImprove: (value) => {
            if (value > (runtime.bound ?? -Infinity)) {
              runtime.bound = value;
              if (runtime.client) emitStamped(node, runtime.client, 'bound_update', {
                workerId: node.id, value, ts: now(), searchId, term,
              });
            }
          },
        });
        if (job.cancelled || (job.term != null && job.term < node.term)) {
          return res.status(410).json({ cancelled: true });
        }
        return res.json({ move, score: result.score, nodesExplored: result.nodesExplored,
          timeMs: Date.now() - started, searchId, term });
      } catch (error) {
        if (job.cancelled || error.cancelled || (job.term != null && job.term < node.term)) {
          return res.status(410).json({ cancelled: true });
        }
        return res.status(500).json({ error: error.message });
      } finally {
        if (runtime.job === job) runtime.job = null;
      }
    });
  }

  node.cancelWorker = () => {
    if (runtime.job) runtime.job.cancelled = true;
    if (runtime.client) runtime.client.disconnect();
    runtime.client = null;
  };
  return client;
}

function stopWorkerRole(node) {
  if (node.cancelWorker) node.cancelWorker();
}

module.exports = { startWorkerRole, stopWorkerRole };
