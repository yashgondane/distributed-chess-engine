'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRing, owners, shares } = require('./ring');

test('ring owners are deterministic and distinct', () => {
  const ring = buildRing([1, 2, 3, 4]);
  assert.deepEqual(owners(ring, 'position|3'), owners(ring, 'position|3'));
  assert.equal(new Set(owners(ring, 'position|3')).size, 2);
});

test('ring distributes primaries and preserves unaffected placements on removal', () => {
  const ids = [1, 2, 3, 4];
  const ring = buildRing(ids);
  const reduced = buildRing([1, 2, 3]);
  const counts = new Map(ids.map((id) => [id, 0]));
  for (let i = 0; i < 10000; i += 1) {
    const key = `random-${i}-${Math.random()}`;
    const primary = owners(ring, key)[0];
    counts.set(primary, counts.get(primary) + 1);
    if (primary !== 4) assert.equal(owners(reduced, key)[0], primary);
  }
  for (const count of counts.values()) assert.ok(count / 10000 >= 0.15 && count / 10000 <= 0.35);
});

test('ring shares sum to one', () => {
  const values = [...shares(buildRing([1, 2, 3, 4])).values()];
  assert.ok(Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
});
