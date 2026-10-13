'use strict';

const crypto = require('node:crypto');

function hash(value) {
  return crypto.createHash('sha1').update(String(value)).digest().readUInt32BE(0);
}

function buildRing(nodeIds, vnodes = 50) {
  const points = [];
  for (const nodeId of nodeIds) {
    for (let i = 0; i < vnodes; i += 1) {
      points.push({ position: hash(`node-${nodeId}#${i}`), nodeId });
    }
  }
  points.sort((a, b) => a.position - b.position || a.nodeId - b.nodeId);
  return points;
}

function owners(ring, key, replicas = 2) {
  if (!ring.length || replicas <= 0) return [];
  const position = hash(key);
  let start = ring.findIndex((point) => point.position >= position);
  if (start < 0) start = 0;
  const result = [];
  for (let offset = 0; offset < ring.length && result.length < replicas; offset += 1) {
    const nodeId = ring[(start + offset) % ring.length].nodeId;
    if (!result.includes(nodeId)) result.push(nodeId);
  }
  return result;
}

function shares(ring) {
  const totals = new Map();
  if (!ring.length) return totals;
  const space = 2 ** 32;
  for (let i = 0; i < ring.length; i += 1) {
    const point = ring[i];
    const previous = ring[(i - 1 + ring.length) % ring.length].position;
    const arc = (point.position - previous + space) % space || space;
    totals.set(point.nodeId, (totals.get(point.nodeId) || 0) + arc / space);
  }
  return totals;
}

module.exports = { hash, buildRing, owners, shares };
