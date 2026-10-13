const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'cluster.json'), 'utf8'));
const id = Number(process.argv.slice(2).filter((arg) => arg !== '--').at(-1));
const node = config.nodes.find((entry) => entry.id === id);
if (!node) {
  console.error(`Unknown node id: ${process.argv.slice(2).join(' ') || '(missing)'}`);
  process.exit(2);
}

if (process.platform !== 'win32') {
  console.error('kill:node currently supports Windows only (netstat/taskkill).');
  process.exit(2);
}

const output = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
const port = String(node.port);
const pids = new Set();
for (const line of output.split(/\r?\n/)) {
  const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
  if (match && match[1] === port) pids.add(match[2]);
}

if (!pids.size) {
  console.error(`No process is listening on node ${id} port ${node.port}.`);
  process.exit(1);
}

for (const pid of pids) {
  execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'inherit' });
}
