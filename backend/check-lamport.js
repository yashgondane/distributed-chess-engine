const { nodes } = require('./cluster.json');

async function get(node, path) {
  const response = await fetch(`http://${node.host}:${node.port}${path}`, { signal: AbortSignal.timeout(2500) });
  if (!response.ok) throw new Error(`${node.id} ${path}: HTTP ${response.status}`);
  return response.json();
}

function report(label, passed, details = '') {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}${details ? ` — ${details}` : ''}`);
  return passed;
}

(async () => {
  const statusResults = await Promise.all(nodes.map(async (node) => {
    try {
      const [status, boundLog] = await Promise.all([get(node, '/cluster/status'), get(node, '/cluster/bound-log')]);
      return { node, status, boundLog };
    } catch (error) { return { node, error }; }
  }));
  let allPassed = statusResults.every((result) => !result.error);
  const reachable = statusResults.filter((result) => !result.error);
  for (const result of statusResults.filter((item) => item.error)) {
    console.log(`FAIL node ${result.node.id} reachable — ${result.error.message}`);
  }

  const eventOrderPassed = reachable.every(({ status }) => {
    const events = [...(status.events || []), ...(status.replicationEvents || [])].sort((a, b) => a.seq - b.seq);
    return events.every((event, index) => index === 0 || events[index - 1].lc < event.lc);
  }) && reachable.length === nodes.length;
  allPassed = report('per-node event lc strictly increases by seq', eventOrderPassed) && allPassed;

  const clockCoversEvents = reachable.every(({ status }) => {
    const events = [...(status.events || []), ...(status.replicationEvents || [])];
    return status.lamport >= Math.max(0, ...events.map((event) => event.lc));
  }) && reachable.length === nodes.length;
  allPassed = report('node lamport >= own event lc maximum', clockCoversEvents) && allPassed;

  const rows = reachable.flatMap(({ boundLog }) => boundLog || []);
  const receiverChains = rows.flatMap((row) => (row.receivers || []).map((receiver) => ({ row, receiver })));
  const chainsPassed = rows.length > 0 && receiverChains.length > 0 && receiverChains.every(({ row, receiver }) =>
    Number.isFinite(row.sentLc) && Number.isFinite(row.relayLc) && Number.isFinite(receiver.recvLc) &&
    row.sentLc < row.relayLc && row.relayLc < receiver.recvLc);
  allPassed = report('bound sentLc < relayLc < recvLc', chainsPassed,
    `${receiverChains.length} receiver chain(s) across ${rows.length} row(s)`) && allPassed;

  const positiveClocks = reachable.every(({ status }) => status.lamport > 0) && reachable.length === nodes.length;
  allPassed = report('every node lamport > 0', positiveClocks) && allPassed;
  const leaders = reachable.filter(({ status }) => status.role === 'leader')
    .sort((a, b) => b.status.term - a.status.term);
  console.log(`Leader: ${leaders[0] ? `node ${leaders[0].status.id}, term ${leaders[0].status.term}` : 'none'}`);
  if (!allPassed) process.exitCode = 1;
})().catch((error) => { console.error(`FAIL check-lamport: ${error.stack || error}`); process.exitCode = 1; });
