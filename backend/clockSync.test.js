const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateOffset } = require('./clockSync');

test('estimateOffset picks the sample with minimum RTT', () => {
  const result = estimateOffset([
    { T: 1000, rtt: 20, localHw: 900 },
    { T: 500, rtt: 4, localHw: 400 },
    { T: 2000, rtt: 10, localHw: 1800 },
  ]);
  assert.deepEqual(result, { offsetMs: 102, rttMs: 4, errorBoundMs: 2 });
});

test('theta is server time plus half RTT minus local hardware time', () => {
  assert.deepEqual(estimateOffset([{ T: 1200, rtt: 40, localHw: 1000 }]),
    { offsetMs: 220, rttMs: 40, errorBoundMs: 20 });
});

test('empty samples return null', () => {
  assert.equal(estimateOffset([]), null);
});
