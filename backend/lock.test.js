'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const LockManager = require('./lock');

function fixture(options = {}) {
  let time = 1000;
  const lock = new LockManager({ leaseMs: 1000, nowFn: () => time, ...options });
  return { lock, advance: (ms) => { time += ms; }, time: () => time };
}

test('grants first request and promotes queued request with a new fence', () => {
  const { lock } = fixture();
  assert.deepEqual(lock.request({ requestId: 'a', clientId: 'c' }), { status: 'granted', fence: 1 });
  assert.deepEqual(lock.request({ requestId: 'b', lc: 2 }), { status: 'queued', position: 1 });
  assert.deepEqual(lock.release('a', 1), { released: true, next: { requestId: 'b', clientId: 'anonymous', label: 'search', lc: 2, requestedAt: 1000, grantedAt: 1000, leaseExpiresAt: 2000, fence: 2 } });
  assert.equal(lock.isCurrent(1), false);
  assert.equal(lock.isCurrent(2), true);
});

test('wrong fence does not release, and queue order is FIFO by Lamport stamp then id', () => {
  const { lock } = fixture();
  const first = lock.request({ requestId: 'holder' });
  lock.request({ requestId: 'c', lc: 3 });
  lock.request({ requestId: 'a', lc: 2 });
  lock.request({ requestId: 'b', lc: 2 });
  const before = lock.snapshot();
  assert.equal(lock.release('holder', first.fence + 1), false);
  assert.deepEqual(lock.snapshot(), before);
  lock.release('holder', first.fence);
  assert.equal(lock.view().holder.requestId, 'a');
  lock.release('a', 2);
  assert.equal(lock.view().holder.requestId, 'b');
  lock.release('b', 3);
  assert.equal(lock.view().holder.requestId, 'c');
});

test('duplicate ids are idempotent and the queue limit is enforced', () => {
  const { lock } = fixture({ maxQueue: 1 });
  lock.request({ requestId: 'h' });
  assert.deepEqual(lock.request({ requestId: 'q' }), { status: 'queued', position: 1 });
  assert.deepEqual(lock.request({ requestId: 'q' }), { status: 'queued', position: 1 });
  assert.deepEqual(lock.request({ requestId: 'x' }), { status: 'full' });
  assert.deepEqual(lock.request({ requestId: 'h' }), { status: 'granted', fence: 1 });
  assert.equal(lock.queue.length, 1);
});

test('renew extends the lease; expiry promotes the next request', () => {
  const { lock, advance, time } = fixture();
  lock.request({ requestId: 'h' });
  lock.request({ requestId: 'q' });
  advance(900);
  assert.equal(lock.renew('h'), true);
  advance(900);
  assert.equal(lock.expire(), null);
  advance(101);
  const expired = lock.expire();
  assert.equal(expired.expired.requestId, 'h');
  assert.equal(expired.next.requestId, 'q');
  assert.equal(expired.next.fence, 2);
  assert.equal(lock.view().holder.leaseRemainingMs, 1000);
  assert.equal(time(), 2901);
});

test('snapshot restore preserves order and grants holder a fresh lease', () => {
  const source = fixture();
  source.lock.request({ requestId: 'h', clientId: 'one' });
  source.lock.request({ requestId: 'q1', lc: 4 });
  source.lock.request({ requestId: 'q2', lc: 5 });
  source.advance(900);
  const snapshot = source.lock.snapshot();
  const target = fixture();
  target.advance(100);
  target.lock.restore(snapshot, { freshLease: true });
  assert.equal(target.lock.view().fence, 1);
  assert.equal(target.lock.view().holder.requestId, 'h');
  assert.equal(target.lock.view().holder.leaseRemainingMs, 1000);
  assert.deepEqual(target.lock.view().queue.map((entry) => entry.requestId), ['q1', 'q2']);
});
