'use strict';

const fs = require('node:fs');
const path = require('node:path');

class AnalysisStore {
  constructor(nodeId, { directory = process.env.STORE_DIR || path.join(__dirname, 'data'), log = () => {} } = {}) {
    this.nodeId = nodeId;
    this.directory = directory;
    this.file = path.join(directory, `store-node${nodeId}.json`);
    this.log = log;
    this.entries = new Map();
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const rows = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(rows)) throw new Error('store file must contain an array');
      this.entries = new Map(rows.filter((entry) => entry && typeof entry.key === 'string').map((entry) => [entry.key, entry]));
      this.log('STORE_LOADED', { count: this.entries.size });
    } catch (error) {
      this.entries.clear();
      this.log('STORE_LOAD_FAILED', { message: error.message });
    }
  }

  put(entry) {
    if (!entry || typeof entry.key !== 'string') throw new TypeError('entry.key must be a string');
    this.entries.set(entry.key, entry);
    fs.mkdirSync(this.directory, { recursive: true });
    const tempFile = `${this.file}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify([...this.entries.values()]));
    fs.renameSync(tempFile, this.file);
    return this.entries.size;
  }

  get(key) { return this.entries.get(key) || null; }
  keys() { return [...this.entries.values()]; }

  clear() {
    this.entries.clear();
    fs.mkdirSync(this.directory, { recursive: true });
    const tempFile = `${this.file}.tmp`;
    fs.writeFileSync(tempFile, '[]');
    fs.renameSync(tempFile, this.file);
  }
}

module.exports = AnalysisStore;
