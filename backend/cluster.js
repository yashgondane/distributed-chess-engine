const {
  HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, HTTP_CONTROL_TIMEOUT_MS,
  ELECTION_COORD_WAIT_MS, RESUME_GRACE_MS,
} = require('./constants');
const LeaderState = require('./leaderState');
const { startLeaderDuties, stopLeaderDuties } = require('./leaderRole');
const { startWorkerRole, stopWorkerRole } = require('./workerRole');
const { fetchStamped, hw, now, SKEW_MS } = require('./lamport');
const { estimateOffset, takeSamples } = require('./clockSync');
const { buildRing, owners, shares } = require('./ring');

async function post(node, peer, route, body, timeoutMs = HTTP_CONTROL_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchStamped(node, `http://${peer.host}:${peer.port}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal,
    });
    let data = {};
    try { data = await response.json(); } catch { /* empty response */ }
    return { status: response.status, data };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function compareKey(aTerm, aId, bTerm, bId) {
  return aTerm - bTerm || aId - bId;
}

function initCluster(node) {
  const ring = buildRing(node.peers.map((peer) => peer.id));
  const peerUrl = (id) => {
    const peer = node.peers.find((p) => p.id === id);
    return peer ? `http://${peer.host}:${peer.port}` : null;
  };

  async function remoteJson(peer, route, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 800);
    try {
      const response = await fetchStamped(node, `${peerUrl(peer.id)}${route}`, { ...options, signal: controller.signal });
      let data = null;
      try { data = await response.json(); } catch { /* empty body */ }
      return { ok: response.ok, status: response.status, data };
    } catch { return null; }
    finally { clearTimeout(timeout); }
  }

  node.app.put('/store/put', (req, res) => {
    try {
      const count = node.store.put(req.body?.entry);
      node.log('STORE_PUT', { key: req.body.entry.key, from: req.body.from ?? null });
      return res.json({ ok: true, count });
    } catch (error) { return res.status(400).json({ error: error.message }); }
  });
  node.app.get('/store/get', (req, res) => {
    const entry = node.store.get(String(req.query.key || ''));
    return entry ? res.json({ found: true, entry }) : res.json({ found: false });
  });
  node.app.get('/store/keys', (_req, res) => res.json({
    nodeId: node.id, count: node.store.keys().length,
    keys: node.store.keys().map(({ key, fen, depth, bestMove, score, storedAt }) => ({ key, fen, depth, bestMove, score, storedAt })),
  }));
  node.app.post('/store/clear', (_req, res) => {
    node.store.clear();
    node.log('STORE_CLEARED');
    return res.json({ ok: true, count: 0 });
  });
  node.app.get('/store/view', async (_req, res) => {
    const results = await Promise.all(node.peers.map(async (peer) => {
      if (peer.id === node.id) return { ok: true, data: { nodeId: node.id, count: node.store.keys().length, keys: node.store.keys() } };
      return remoteJson(peer, '/store/keys');
    }));
    const byKey = new Map();
    results.forEach((result, index) => {
      if (!result?.ok) return;
      for (const entry of result.data?.keys || []) {
        if (!byKey.has(entry.key)) byKey.set(entry.key, { ...entry, presentOn: [] });
        byKey.get(entry.key).presentOn.push(node.peers[index].id);
      }
    });
    const sharesByNode = shares(ring);
    const entries = [...byKey.values()].map((entry) => ({
      key: entry.key, fen: entry.fen, depth: entry.depth, bestMove: entry.bestMove, score: entry.score,
      owners: owners(ring, entry.key), presentOn: entry.presentOn,
    }));
    const ringView = node.peers.map((peer, index) => ({
      nodeId: peer.id, sharePct: (sharesByNode.get(peer.id) || 0) * 100,
      alive: Boolean(results[index]?.ok), count: results[index]?.data?.count || 0,
    }));
    return res.json({ ring: ringView, entries });
  });

  async function syncClock(target, leaderId, logFirst = false) {
    const sync = target.clockSync;
    const peer = target.peers.find((p) => p.id === leaderId);
    if (!sync?.enabled || target.role !== 'follower' || !peer || sync.syncInProgress) return;
    sync.syncInProgress = true;
    try {
      const samples = await takeSamples(async () => {
        const reply = await post(target, peer, '/cluster/time', {});
        return reply?.status === 200 ? reply.data : null;
      }, hw);
      const estimate = estimateOffset(samples);
      if (!estimate || !sync.enabled || target.role !== 'follower' || target.leaderId !== leaderId) return;
      const oldOffset = sync.syncOffsetMs;
      sync.syncOffsetMs = estimate.offsetMs;
      sync.lastSyncAt = now();
      sync.bestRttMs = estimate.rttMs;
      sync.errorBoundMs = estimate.errorBoundMs;
      sync.source = leaderId;
      if (Math.abs(sync.syncOffsetMs - oldOffset) > 5 || logFirst || sync.firstSyncAfterChange) {
        target.log('CLOCK_SYNCED', { offsetMs: sync.syncOffsetMs, rttMs: sync.bestRttMs,
          errorBoundMs: sync.errorBoundMs, leaderId });
      }
      sync.firstSyncAfterChange = false;
    } finally {
      sync.syncInProgress = false;
    }
  }

  let replicateTimer = null;
  node.requestReplicate = () => {
    if (node.role !== 'leader' || !node.leaderState) return;
    clearTimeout(replicateTimer);
    replicateTimer = setTimeout(() => {
      if (node.role !== 'leader' || !node.leaderState) return;
      const state = node.leaderState;
      state.version += 1;
      const snapshot = state.toSnapshot(node.term, node.id);
      node.replicaVersion = state.version;
      for (const peer of node.peers) {
        if (peer.id !== node.id) {
          void post(node, peer, '/cluster/replicate', { term: node.term, version: state.version, snapshot });
        }
      }
      node.log('REPLICATED', { version: state.version });
    }, 250);
  };

  node.app.post('/cluster/heartbeat', (req, res) => {
    const { leaderId, term } = req.body;
    if (compareKey(term, leaderId, node.term, node.leaderId ?? 0) < 0) {
      return res.status(409).json({ term: node.term, leaderId: node.leaderId });
    }
    if (node.role !== 'follower' || node.leaderId !== leaderId || node.term !== term) {
      becomeFollower(node, leaderId, term);
    }
    node.lastHeartbeatAt = Date.now();
    node.heartbeatLostLogged = false;
    return res.json({ ok: true, id: node.id, term: node.term, role: node.role });
  });

  node.app.post('/cluster/election', (req, res) => {
    const { fromId, term } = req.body;
    if (term < node.term || node.id <= fromId) {
      return res.json({ ok: false, term: node.term, leaderId: node.leaderId });
    }
    res.json({ ok: true });
    void startElection(node);
  });

  node.app.post('/cluster/coordinator', (req, res) => {
    const { leaderId, term } = req.body;
    if (compareKey(term, leaderId, node.term, node.leaderId ?? 0) < 0) {
      return res.status(409).json({ term: node.term, leaderId: node.leaderId });
    }
    becomeFollower(node, leaderId, term);
    node.log('COORDINATOR_RECEIVED', { leaderId, term });
    return res.json({ ok: true });
  });

  node.app.post('/cluster/replicate', (req, res) => {
    const { term, version, snapshot } = req.body;
    if (term < node.term) return res.status(409).json({ error: 'stale_term', term: node.term });
    if (term === node.term && version <= node.replicaVersion) {
      return res.json({ ok: true, ignored: true, version: node.replicaVersion });
    }
    node.replica = snapshot;
    node.replicaVersion = version;
    node.log('REPLICA_RECEIVED', { version });
    return res.json({ ok: true, version });
  });

  node.app.post('/cluster/time', (_req, res) => {
    if (node.role !== 'leader') return res.status(409).json({ error: 'not_leader', leaderId: node.leaderId });
    return res.json({ t: now(), leaderId: node.id });
  });
  node.app.post('/cluster/clock-sync', (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled_must_be_boolean' });
    node.clockSync.enabled = req.body.enabled;
    if (!req.body.enabled) {
      node.clockSync.syncOffsetMs = 0;
      node.clockSync.bestRttMs = null;
      node.clockSync.errorBoundMs = null;
      node.clockSync.lastSyncAt = null;
      node.log('CLOCK_SYNC_OFF');
    } else {
      node.log('CLOCK_SYNC_ON');
      if (node.role === 'follower' && node.leaderId != null) {
        node.clockSync.firstSyncAfterChange = true;
        void syncClock(node, node.leaderId, true);
      }
    }
    return res.json({ ok: true, enabled: node.clockSync.enabled });
  });

  node.app.get('/cluster/replica', (_req, res) => res.json(
    node.role === 'leader' ? node.leaderState?.toSnapshot(node.term, node.id) || node.replica : node.replica,
  ));
  node.app.get('/cluster/bound-log', (_req, res) => res.json(node.role === 'leader' ? node.boundLog : []));
  node.app.get('/cluster/status', (_req, res) => res.json({
    id: node.id, role: node.role, term: node.term, leaderId: node.leaderId,
    lastHeartbeatAgeMs: Date.now() - node.lastHeartbeatAt,
    replicaVersion: node.replicaVersion, peerStatus: node.peerStatus,
    workersRegistered: node.workersRegistered || 0,
    storeCount: node.store.keys().length,
    searchInProgress: Boolean(node.leaderState?.currentSearch),
    events: node.events.slice(-50), replicationEvents: node.replicationEvents.slice(-20),
    lamport: node.clock.value, skewMs: SKEW_MS,
    clockSync: { enabled: node.clockSync.enabled, syncOffsetMs: node.clockSync.syncOffsetMs,
      bestRttMs: node.clockSync.bestRttMs, errorBoundMs: node.clockSync.errorBoundMs,
      lastSyncAt: node.clockSync.lastSyncAt },
  }));

  setInterval(async () => {
    if (node.role !== 'leader') return;
    for (const peer of node.peers.filter((p) => p.id !== node.id)) {
      const reply = await post(node, peer, '/cluster/heartbeat', { leaderId: node.id, term: node.term });
      const status = reply?.data?.ok ? 'UP' : 'DOWN';
      if (node.peerStatus[peer.id] !== status) {
        node.peerStatus[peer.id] = status;
        node.log(status === 'UP' ? 'PEER_UP' : 'PEER_DOWN', { peerId: peer.id });
      }
      if (reply && reply.data.term > node.term) {
        becomeFollower(node, reply.data.leaderId, reply.data.term);
        break;
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  setInterval(() => {
    if (node.role === 'follower' && Date.now() - node.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS && !node.electionInProgress) {
      node.heartbeatLostLogged = true;
      node.log('HEARTBEAT_LOST');
      void startElection(node);
    }
  }, 500);

  setInterval(() => {
    if (node.role === 'follower' && node.clockSync.enabled && node.leaderId != null) {
      void syncClock(node, node.leaderId);
    }
  }, 10000);

  node.startElection = () => startElection(node);
  node.becomeLeader = () => becomeLeader(node);
  node.becomeFollower = (leaderId, term) => becomeFollower(node, leaderId, term);

  async function startElection(target) {
    if (target.electionInProgress) return;
    target.electionInProgress = true;
    target.role = 'candidate';
    target.log('ELECTION_STARTED');
    const higher = target.peers.filter((peer) => peer.id > target.id);
    const replies = await Promise.all(higher.map(async (peer) => {
      target.log('ELECTION_SENT', { peerId: peer.id });
      return post(target, peer, '/cluster/election', { fromId: target.id, term: target.term });
    }));

    // A coordinator or heartbeat may have arrived while the peer requests were in flight.
    if (!target.electionInProgress || target.role !== 'candidate') return;
    const newerLeader = replies.find((reply) => reply?.data?.term > target.term && reply.data.leaderId);
    if (newerLeader) {
      becomeFollower(target, newerLeader.data.leaderId, newerLeader.data.term);
      return;
    }

    if (!replies.some((reply) => reply?.data?.ok)) {
      target.log('ELECTION_NO_REPLY');
      await becomeLeader(target);
      target.electionInProgress = false;
      return;
    }

    target.log('ELECTION_OK');
    target.role = 'follower';
    setTimeout(() => {
      if (target.electionInProgress && target.role === 'follower') {
        target.electionInProgress = false;
        void startElection(target);
      }
    }, ELECTION_COORD_WAIT_MS);
  }

  async function becomeLeader(target) {
    if (target.role !== 'candidate') return;
    stopWorkerRole(target);
    target.term += 1;
    target.role = 'leader';
    target.leaderId = target.id;
    target.leaderState = LeaderState.fromSnapshot(target.replica);
    target.log('BECAME_LEADER', { term: target.term });
    startLeaderDuties(target);
    for (const peer of target.peers.filter((p) => p.id !== target.id)) {
      const reply = await post(target, peer, '/cluster/coordinator', { leaderId: target.id, term: target.term });
      if (reply?.data?.ok) target.log('COORDINATOR_ANNOUNCED', { peerId: peer.id });
      else if (!reply) target.peerStatus[peer.id] = 'DOWN';
    }
    target.electionInProgress = false;
    target.requestReplicate();
    setTimeout(() => target.resumeSearch?.(), RESUME_GRACE_MS);
  }

  function becomeFollower(target, leaderId, term) {
    if (compareKey(term, leaderId, target.term, target.leaderId ?? 0) < 0) return;
    const leaderChanged = target.leaderId !== leaderId || target.term !== term;
    const steppedDown = target.role === 'leader';
    if (steppedDown) {
      target.replica = target.leaderState?.toSnapshot(target.term, target.id) || target.replica;
      target.replicaVersion = target.replica?.version || target.replicaVersion;
      stopLeaderDuties(target);
      target.leaderState = null;
    }
    stopWorkerRole(target);
    target.role = 'follower';
    target.leaderId = leaderId;
    target.term = term;
    target.lastHeartbeatAt = Date.now();
    target.heartbeatLostLogged = false;
    target.electionInProgress = false;
    target.log(steppedDown ? 'STEPPED_DOWN' : 'BECAME_FOLLOWER', { leaderId, term });
    startWorkerRole(target, peerUrl(leaderId));
    if (target.clockSync.enabled && leaderChanged) {
      target.clockSync.firstSyncAfterChange = true;
      void syncClock(target, leaderId, true);
    }
  }
}

module.exports = initCluster;
