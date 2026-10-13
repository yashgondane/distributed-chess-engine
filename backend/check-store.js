'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'cluster.json'), 'utf8'));
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';

async function json(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${url}`);
  return response.json();
}

async function findLeader() {
  const statuses = await Promise.all(config.nodes.map(async (node) => {
    try { return { node, status: await json(`http://${node.host}:${node.port}/cluster/status`) }; }
    catch { return null; }
  }));
  const leaders = statuses.filter((row) => row?.status.role === 'leader').sort((a, b) => b.status.term - a.status.term);
  if (!leaders.length) throw new Error('No reachable leader');
  return { ...leaders[0], statuses };
}

async function run() {
  const mode = process.argv[2];
  if (!['prime', 'verify'].includes(mode)) throw new Error('Usage: node check-store.js prime|verify');
  const { node: leader, statuses } = await findLeader();
  const started = Date.now();
  const result = await json(`http://${leader.host}:${leader.port}/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fen: START_FEN, depth: 3, boundSharing: true, useCache: true }),
  });
  const elapsedMs = Date.now() - started;
  console.log(`mode=${mode} hit=${result.cache?.hit} servedBy=${result.cache?.servedBy ?? '—'} requestMs=${elapsedMs} cacheLatencyMs=${result.cache?.latencyMs ?? '—'}`);
  const ids = result.cache?.owners || [];
  console.log(`owners: primary=${ids[0] ?? '—'} replica=${ids[1] ?? '—'}; alive=${statuses.filter(Boolean).map((r) => r.node.id).join(',')}`);
  if (mode === 'prime') {
    if (result.cache?.hit !== false) throw new Error('prime expected cache.hit=false');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const keysByNode = await Promise.all(config.nodes.map(async (peer) => {
      try {
        const data = await json(`http://${peer.host}:${peer.port}/store/keys`);
        return { id: peer.id, keys: data.keys || [] };
      } catch { return { id: peer.id, keys: [] }; }
    }));
    const keyRows = keysByNode.flatMap((row) => row.keys.map((entry) => ({ ...entry, nodeId: row.id })));
    const matching = keyRows.find((entry) => entry.fen?.split(/\s+/).slice(0, 4).join(' ') === START_FEN && entry.depth === 3);
    const present = matching ? keyRows.filter((entry) => entry.key === matching.key).map((entry) => entry.nodeId) : [];
    console.log(`key=${matching?.key ?? 'missing'} presentOn=${present.join(',') || 'none'}`);
    const pass = Boolean(matching && present.length === 2 && ids.every((id) => present.includes(id)));
    console.log(`PRIME ${pass ? 'PASS' : 'FAIL'}`);
    if (!pass) process.exitCode = 1;
    return;
  }
  if (result.cache?.hit !== true) throw new Error('verify expected cache.hit=true');
  console.log('VERIFY PASS');
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
