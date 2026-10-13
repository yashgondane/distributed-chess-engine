'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { LamportClock, fetchStamped } = require('./lamport');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'cluster.json'), 'utf8'));
const clockNode = { clock: new LamportClock() };

Promise.allSettled(config.nodes.map(async (node) => {
  await fetchStamped(clockNode, `http://${node.host}:${node.port}/store/clear`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    signal: AbortSignal.timeout(800),
  });
  console.log(`Cleared node ${node.id}`);
})).then((results) => {
  const failed = results.filter((result) => result.status === 'rejected').length;
  if (failed) console.log(`Skipped ${failed} unavailable node(s).`);
});
