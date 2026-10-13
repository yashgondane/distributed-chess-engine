const test = require('node:test');
const assert = require('node:assert/strict');
const { LamportClock, compareEvents, shouldAcceptBound } = require('./lamport');

test('tick increments by one', () => {
  const clock = new LamportClock();
  assert.equal(clock.tick(), 1);
  assert.equal(clock.tick(), 2);
});

test('receive advances past remote or local clock', () => {
  const clock = new LamportClock();
  clock._value = 2;
  assert.equal(clock.receive(5), 6);
  clock._value = 9;
  assert.equal(clock.receive(1), 10);
});

test('invalid receive values behave like tick', () => {
  for (const value of [undefined, NaN, 'x']) {
    const clock = new LamportClock();
    assert.equal(clock.receive(value), 1);
  }
});

test('two-clock bound exchange has strict causal order', () => {
  const worker1 = new LamportClock();
  const leader = new LamportClock();
  const worker2 = new LamportClock();
  worker1._value = 10;
  leader._value = 40;
  worker2._value = 5;
  const sentLc = worker1.tick();
  leader.receive(sentLc);
  const relayLc = leader.tick();
  worker2.receive(relayLc);
  const recvLc = worker2.value;
  assert.deepEqual([sentLc, relayLc, recvLc], [11, 42, 43]);
  assert.ok(sentLc < relayLc && relayLc < recvLc);
});

test('compareEvents orders by Lamport clock then node id', () => {
  const ordered = [
    { lc: 2, nodeId: 3 }, { lc: 1, nodeId: 4 }, { lc: 2, nodeId: 1 },
  ].sort(compareEvents);
  assert.deepEqual(ordered.map(({ lc, nodeId }) => [lc, nodeId]), [[1, 4], [2, 1], [2, 3]]);
});

test('shouldAcceptBound applies search, term, and causal guards', () => {
  const job = { searchId: 's-1', term: 3, searchLc: 20 };
  assert.equal(shouldAcceptBound(null, {}), false);
  assert.equal(shouldAcceptBound(job, { searchId: 's-2', term: 3, lc: 21 }), false);
  assert.equal(shouldAcceptBound(job, { searchId: 's-1', term: 2, lc: 21 }), false);
  assert.equal(shouldAcceptBound(job, { searchId: 's-1', term: 3, lc: 19 }), false);
  assert.equal(shouldAcceptBound(job, { searchId: 's-1', term: 3, lc: 20 }), true);
  assert.equal(shouldAcceptBound(job, { searchId: 's-1', term: 3 }), true);
  assert.equal(shouldAcceptBound(job, null), false);
});
