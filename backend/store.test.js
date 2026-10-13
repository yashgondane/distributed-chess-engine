'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AnalysisStore = require('./store');

test('store put/get/keys/clear round trip', () => {
  const directory = fs.mkdtempSync(path.join(__dirname, '.analysis-store-'));
  try {
    const store = new AnalysisStore(2, { directory });
    const entry = { key: 'fen|3', bestMove: 'Nc3' };
    assert.equal(store.put(entry), 1);
    assert.deepEqual(store.get(entry.key), entry);
    assert.deepEqual(store.keys(), [entry]);
    store.clear();
    assert.equal(store.get(entry.key), null);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('store reloads persisted entries and ignores corrupt files', () => {
  const directory = fs.mkdtempSync(path.join(__dirname, '.analysis-store-'));
  try {
    const store = new AnalysisStore(3, { directory });
    store.put({ key: 'fen|4', score: 0 });
    assert.equal(new AnalysisStore(3, { directory }).get('fen|4').score, 0);
    fs.writeFileSync(path.join(directory, 'store-node4.json'), '{bad json');
    const logs = [];
    const corrupt = new AnalysisStore(4, { directory, log: (type) => logs.push(type) });
    assert.equal(corrupt.keys().length, 0);
    assert.deepEqual(logs, ['STORE_LOAD_FAILED']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
