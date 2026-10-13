const SKEW_MS = Number(process.env.CLOCK_SKEW_MS || 0);
let clockSyncState = null;

class LamportClock {
  constructor() { this._value = 0; }
  get value() { return this._value; }
  tick() { this._value += 1; return this._value; }
  receive(t) {
    this._value = Number.isFinite(t) ? Math.max(this._value, t) + 1 : this._value + 1;
    return this._value;
  }
}

function hw() { return Date.now() + SKEW_MS; }
function setClockSyncState(state) { clockSyncState = state; }
function now() { return hw() + (clockSyncState?.syncOffsetMs || 0); }

function compareEvents(a, b) {
  return a.lc - b.lc || a.nodeId - b.nodeId;
}

function shouldAcceptBound(job, msg) {
  if (!job || !msg) return false;
  if (msg.searchId !== job.searchId) return false;
  if (typeof msg.term === 'number' && msg.term < job.term) return false;
  if (Number.isFinite(msg.lc) && Number.isFinite(job.searchLc) && msg.lc < job.searchLc) return false;
  return true;
}

async function fetchStamped(node, url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('x-lamport', String(node.clock.tick()));
  const response = await fetch(url, { ...options, headers });
  node.clock.receive(Number(response.headers.get('x-lamport')));
  return response;
}

function emitStamped(node, target, event, payload = {}) {
  const stamped = { ...payload, lc: node.clock.tick() };
  if (Array.isArray(target)) {
    for (const socket of target) socket.emit(event, stamped);
  } else {
    target.emit(event, stamped);
  }
  return stamped;
}

function onStamped(node, socket, event, handler) {
  socket.on(event, (payload) => {
    node.clock.receive(payload && payload.lc);
    handler(payload);
  });
}

module.exports = { LamportClock, hw, now, setClockSyncState, compareEvents, shouldAcceptBound, fetchStamped, emitStamped, onStamped, SKEW_MS };
