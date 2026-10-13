'use strict';

class LockManager {
  constructor({ leaseMs, maxQueue = 10, nowFn = Date.now } = {}) {
    this.leaseMs = Number.isFinite(leaseMs) && leaseMs > 0 ? leaseMs : 30000;
    this.maxQueue = maxQueue;
    this.nowFn = nowFn;
    this.fence = 0;
    this.holder = null;
    this.queue = [];
  }

  _entry({ requestId, clientId = 'anonymous', label = 'search', lc = 0 }) {
    return { requestId, clientId, label, lc, requestedAt: this.nowFn() };
  }

  _grant(entry) {
    this.fence += 1;
    const grantedAt = this.nowFn();
    this.holder = { ...entry, grantedAt, leaseExpiresAt: grantedAt + this.leaseMs, fence: this.fence };
    return this.holder;
  }

  request(request) {
    // A recovered snapshot may contain queued work without a live holder.
    // Drain that saved FIFO head before considering a newly arriving request.
    if (!this.holder && this.queue.length) this._grant(this.queue.shift());
    if (this.holder?.requestId === request.requestId) return { status: 'granted', fence: this.holder.fence };
    const queuedIndex = this.queue.findIndex((entry) => entry.requestId === request.requestId);
    if (queuedIndex >= 0) return { status: 'queued', position: queuedIndex + 1 };
    const entry = this._entry(request);
    if (!this.holder) {
      const granted = this._grant(entry);
      return { status: 'granted', fence: granted.fence };
    }
    if (this.queue.length >= this.maxQueue) return { status: 'full' };
    this.queue.push(entry);
    this.queue.sort((a, b) => a.lc - b.lc || String(a.requestId).localeCompare(String(b.requestId)));
    return { status: 'queued', position: this.queue.findIndex((item) => item.requestId === entry.requestId) + 1 };
  }

  renew(requestId) {
    if (this.holder?.requestId !== requestId) return false;
    this.holder.leaseExpiresAt = this.nowFn() + this.leaseMs;
    return true;
  }

  _releaseCurrent() {
    this.holder = null;
    const entry = this.queue.shift() || null;
    return entry ? this._grant(entry) : null;
  }

  release(requestId, fence) {
    if (!this.holder || this.holder.requestId !== requestId || this.holder.fence !== fence) return false;
    const next = this._releaseCurrent();
    return { released: true, next };
  }

  cancel(requestId) {
    const index = this.queue.findIndex((entry) => entry.requestId === requestId);
    if (index >= 0) {
      const [removed] = this.queue.splice(index, 1);
      return { cancelled: true, queued: true, entry: removed };
    }
    if (this.holder?.requestId === requestId) {
      const holder = this.holder;
      const released = this.release(requestId, holder.fence);
      return { cancelled: true, queued: false, ...released };
    }
    return { cancelled: false };
  }

  expire() {
    if (!this.holder || this.nowFn() < this.holder.leaseExpiresAt) return null;
    const expired = this.holder;
    const next = this._releaseCurrent();
    return { expired, next };
  }

  isCurrent(fence) {
    return Boolean(this.holder && this.holder.fence === fence);
  }

  view() {
    const now = this.nowFn();
    return {
      fence: this.fence,
      leaseMs: this.leaseMs,
      holder: this.holder ? {
        requestId: this.holder.requestId, clientId: this.holder.clientId, label: this.holder.label,
        grantedAt: this.holder.grantedAt, leaseRemainingMs: Math.max(0, this.holder.leaseExpiresAt - now),
        fence: this.holder.fence,
      } : null,
      queue: this.queue.map((entry) => ({
        requestId: entry.requestId, clientId: entry.clientId, label: entry.label, lc: entry.lc,
        waitingMs: Math.max(0, now - entry.requestedAt),
      })),
    };
  }

  snapshot() {
    return {
      fence: this.fence,
      holder: this.holder ? { ...this.holder } : null,
      queue: this.queue.map((entry) => ({ ...entry })),
    };
  }

  restore(snapshot, { freshLease = true } = {}) {
    this.fence = Math.max(this.fence, Number(snapshot?.fence) || 0);
    this.queue = Array.isArray(snapshot?.queue) ? snapshot.queue.map((entry) => ({ ...entry })) : [];
    this.queue.sort((a, b) => a.lc - b.lc || String(a.requestId).localeCompare(String(b.requestId)));
    if (snapshot?.holder) {
      const grantedAt = freshLease ? this.nowFn() : snapshot.holder.grantedAt;
      const leaseExpiresAt = freshLease ? grantedAt + this.leaseMs : snapshot.holder.leaseExpiresAt;
      this.holder = { ...snapshot.holder, grantedAt, leaseExpiresAt, fence: snapshot.holder.fence };
      this.fence = Math.max(this.fence, this.holder.fence || 0);
    } else this.holder = null;
    return this;
  }
}

module.exports = LockManager;
