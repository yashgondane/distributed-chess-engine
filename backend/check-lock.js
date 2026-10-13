'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'cluster.json'), 'utf8'));
const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(url, options = {}) {
  const response = await fetch(url, options);
  let data = {};
  try { data = await response.json(); } catch { /* no response body */ }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(data)}`);
  return data;
}

async function findLeader() {
  const statuses = await Promise.all(config.nodes.map(async (peer) => {
    try { return { peer, status: await json(`http://${peer.host}:${peer.port}/cluster/status`) }; }
    catch { return null; }
  }));
  const leader = statuses.filter((item) => item?.status.role === 'leader').sort((a, b) => b.status.term - a.status.term)[0];
  if (!leader) throw new Error('No reachable leader');
  return { ...leader, url: `http://${leader.peer.host}:${leader.peer.port}` };
}

async function watchLeaderEvents(url, stop) {
  const events = new Map();
  while (!stop.done) {
    try {
      const status = await json(`${url}/cluster/status`);
      for (const event of status.events || []) events.set(`${event.nodeId}:${event.seq}`, event);
    } catch { /* retry while request is running */ }
    await delay(200);
  }
  try {
    const status = await json(`${url}/cluster/status`);
    for (const event of status.events || []) events.set(`${event.nodeId}:${event.seq}`, event);
  } catch { /* retain events already observed */ }
  return [...events.values()].sort((a, b) => a.seq - b.seq);
}

async function runSearch(url, requestId, clientId) {
  return json(`${url}/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, clientId, label: 'check-lock', fen: FEN, depth: 4, boundSharing: true, useCache: false }),
  });
}

async function checkQueue() {
  const leader = await findLeader();
  const ids = [randomUUID(), randomUUID()];
  const started = Date.now();
  const stop = { done: false };
  const eventsPromise = watchLeaderEvents(leader.url, stop);
  const first = runSearch(leader.url, ids[0], 'check-lock-queue');
  await delay(500);
  const second = runSearch(leader.url, ids[1], 'check-lock-queue');
  const results = await Promise.all([first, second]);
  stop.done = true;
  const events = await eventsPromise;
  const grants = ids.map((id) => events.find((event) => event.type === 'LOCK_GRANTED' && event.detail.requestId === id));
  const releases = ids.map((id) => events.find((event) => event.type === 'LOCK_RELEASED' && event.detail.requestId === id));
  console.log(`first started=${grants[0]?.ts ?? 'missing'} finished=${releases[0]?.ts ?? 'missing'}`);
  console.log(`second started=${grants[1]?.ts ?? 'missing'} finished=${releases[1]?.ts ?? 'missing'}`);
  const ordered = grants[0] && releases[0] && grants[1] && events.indexOf(grants[0]) < events.indexOf(releases[0]) && events.indexOf(releases[0]) < events.indexOf(grants[1]);
  const passed = ordered && results.every((result) => result.bestMove);
  console.log(`QUEUE ${passed ? 'PASS' : 'FAIL'} (${Date.now() - started} ms)`);
  if (!passed) process.exitCode = 1;
}

async function checkLease() {
  const leader = await findLeader();
  const hogId = randomUUID();
  const searchId = randomUUID();
  const stop = { done: false };
  const eventsPromise = watchLeaderEvents(leader.url, stop);
  const hog = await json(`${leader.url}/lock/acquire`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: hogId, clientId: 'check-lock-hog', label: 'hog', hold: true }),
  });
  const started = Date.now();
  const result = await runSearch(leader.url, searchId, 'check-lock-lease');
  const elapsed = Date.now() - started;
  stop.done = true;
  const events = await eventsPromise;
  const expired = events.find((event) => event.type === 'LOCK_LEASE_EXPIRED' && event.detail.holder === hogId);
  console.log(`hog status=${hog.status} fence=${hog.fence}; queued search elapsed=${elapsed} ms; expired=${expired?.type || 'missing'}`);
  const passed = hog.status === 'granted' && Boolean(expired) && Boolean(result.bestMove) && elapsed >= 4500;
  console.log(`LEASE ${passed ? 'PASS' : 'FAIL'} bestMove=${result.bestMove ?? 'missing'}`);
  if (!passed) process.exitCode = 1;
}

const mode = process.argv[2];
if (mode === 'queue') checkQueue().catch((error) => { console.error(error.message); process.exitCode = 1; });
else if (mode === 'lease') checkLease().catch((error) => { console.error(error.message); process.exitCode = 1; });
else { console.error('Usage: node check-lock.js queue|lease'); process.exitCode = 1; }
