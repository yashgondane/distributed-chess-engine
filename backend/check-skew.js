const { nodes } = require('./cluster.json');

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

(async () => {
  const statuses = await Promise.all(nodes.map(async (node) => ({
    node, status: await get(`http://${node.host}:${node.port}/cluster/status`),
  })));
  const leader = statuses.filter(({ status }) => status.role === 'leader')
    .sort((a, b) => b.status.term - a.status.term || b.status.id - a.status.id)[0];
  if (!leader) throw new Error('No reachable leader found');

  const allRows = await get(`http://${leader.node.host}:${leader.node.port}/cluster/bound-log`);
  const latestSearchId = allRows.at(-1)?.searchId;
  const rows = allRows.filter((row) => row.searchId === latestSearchId).slice(-10);
  let skewVisible = false;
  let lamportAllPass = rows.length > 0;
  let receiverCount = 0;

  for (const row of rows) {
    for (const receiver of row.receivers || []) {
      receiverCount += 1;
      const wallDelay = receiver.recvTs - row.sentTs;
      const chainPass = row.sentLc < row.relayLc && row.relayLc < receiver.recvLc;
      if (wallDelay < 0 || wallDelay > 5000) skewVisible = true;
      if (!chainPass) lamportAllPass = false;
      console.log(`row ${row.searchId} from W${row.fromWorker} to W${receiver.workerId}: wall delay ${wallDelay} ms; ${row.sentLc} < ${row.relayLc} < ${receiver.recvLc}: ${chainPass ? 'PASS' : 'FAIL'}`);
    }
  }
  if (receiverCount === 0) lamportAllPass = false;
  console.log(`WALL-CLOCK SKEW VISIBLE: ${skewVisible ? 'yes' : 'no'}`);
  console.log(`LAMPORT ORDER ALL PASS: ${lamportAllPass ? 'yes' : 'no'}`);
  const syncEnabled = leader.status.clockSync?.enabled === true;
  if (syncEnabled ? skewVisible || !lamportAllPass : !skewVisible || !lamportAllPass) process.exitCode = 1;
})().catch((error) => {
  console.error(`check-skew failed: ${error.stack || error}`);
  process.exitCode = 1;
});
