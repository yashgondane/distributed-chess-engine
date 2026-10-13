const { nodes } = require('./cluster.json');

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

(async () => {
  const live = await Promise.all(nodes.map(async (node) => {
    try { return { node, status: await get(`http://${node.host}:${node.port}/cluster/status`) }; }
    catch { return null; }
  }));
  const rows = live.filter(Boolean);
  const leaderRow = rows.filter(({ status }) => status.role === 'leader')
    .sort((a, b) => b.status.term - a.status.term || b.status.id - a.status.id)[0];
  if (!leaderRow) throw new Error('No reachable leader found');
  const leader = leaderRow.status;
  const enabled = leader.clockSync?.enabled === true;
  let pass = enabled;
  for (const { status } of rows) {
    if (status.id === leader.id) continue;
    const offset = status.clockSync?.syncOffsetMs ?? 0;
    const trueErrorMs = (status.skewMs + offset) - (leader.skewMs + (leader.clockSync?.syncOffsetMs ?? 0));
    if (enabled) {
      const within = status.clockSync?.enabled === true && Math.abs(trueErrorMs) <= 50;
      if (!within) pass = false;
      console.log(`Node ${status.id}: raw skew ${status.skewMs} ms, offset ${offset.toFixed(2)} ms, error bound ${status.clockSync?.errorBoundMs?.toFixed(2) ?? '—'} ms, true error ${trueErrorMs.toFixed(2)} ms ${within ? 'PASS' : 'FAIL'}`);
    } else {
      console.log(`Node ${status.id}: sync off; raw skew ${status.skewMs} ms (leader raw skew ${leader.skewMs} ms)`);
    }
  }
  console.log(enabled ? `CLOCK SYNC: ${pass ? 'PASS' : 'FAIL'}` : 'CLOCK SYNC: off (raw skew shown)');
  if (enabled && !pass) process.exitCode = 1;
})().catch((error) => {
  console.error(`check-sync failed: ${error.stack || error}`);
  process.exitCode = 1;
});
