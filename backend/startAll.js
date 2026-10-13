const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'cluster.json'), 'utf8'));
const skewMode = process.argv.includes('--skew') || process.argv.includes('--sync');
const syncMode = process.argv.includes('--sync');
const lockMode = process.argv.includes('--lock');
const skewById = { 1: 0, 2: 8000, 3: -5000, 4: 2000 };
const children = config.nodes.map(({ id }) => spawn(
  process.execPath,
  [path.join(__dirname, 'index.js'), '--id', String(id)],
  {
    cwd: __dirname, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, CLOCK_SKEW_MS: String(skewMode ? (skewById[id] ?? 0) : 0),
      CLOCK_SYNC_ENABLED: syncMode ? '1' : '0',
      LOCK_LEASE_MS: String(lockMode ? 5000 : (process.env.LOCK_LEASE_MS || 30000)) },
  },
));

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode == null && !child.killed) child.kill();
  }
}

process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
for (const child of children) {
  child.on('error', (error) => {
    console.error(`Failed to start node process: ${error.message}`);
  });
  child.on('exit', (code) => {
    if (!stopping) console.log(`Node ${config.nodes[children.indexOf(child)].id} exited with code ${code}.`);
  });
}
