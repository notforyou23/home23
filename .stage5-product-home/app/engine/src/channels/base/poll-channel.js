/**
 * PollChannel — base class for channels that pull on an interval.
 * CPU samplers, git log pollers, pm2 jlist, live-problems.json, etc.
 *
 * Subclasses override poll() to return an array of raw records per tick;
 * the base class handles scheduling, queueing, and backpressure-friendly
 * async iteration via source().
 */

'use strict';

import { Channel } from '../contract.js';

export class PollChannel extends Channel {
  constructor({ id, class: cls, intervalMs, initialDelayMs = 0 }) {
    super({ id, class: cls });
    if (typeof intervalMs !== 'number' || intervalMs <= 0) {
      throw new Error(`PollChannel requires positive intervalMs, got ${intervalMs}`);
    }
    this.intervalMs = intervalMs;
    this.initialDelayMs = Math.max(0, Number(initialDelayMs) || 0);
    this._running = false;
    this._queue = [];
    this._waiters = [];
    this._timer = null;
  }

  start() {
    if (this._running) return;
    this._running = true;
    const tick = async () => {
      if (!this._running) return;
      try {
        const raws = await this.poll();
        for (const r of raws || []) this._enqueue(r);
      } catch (err) {
        this._enqueue({ __error: err && err.message ? err.message : String(err) });
      }
      if (this._running) {
        this._timer = setTimeout(tick, this.intervalMs);
      }
    };
    this._timer = setTimeout(tick, this.initialDelayMs);
  }

  stop() {
    this._running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    for (const w of this._waiters) w.resolve({ done: true, value: undefined });
    this._waiters = [];
  }

  _enqueue(raw) {
    if (this._waiters.length) {
      const w = this._waiters.shift();
      w.resolve({ done: false, value: raw });
    } else {
      this._queue.push(raw);
    }
  }

  async *source() {
    while (this._running || this._queue.length) {
      if (this._queue.length) {
        yield this._queue.shift();
        continue;
      }
      const next = await new Promise((resolve) => this._waiters.push({ resolve }));
      if (next.done) return;
      yield next.value;
    }
  }

  async poll() { throw new Error('PollChannel.poll() not implemented'); }
}
