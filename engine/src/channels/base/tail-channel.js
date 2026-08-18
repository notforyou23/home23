/**
 * TailChannel — base class for JSONL-tail channels.
 * Drains each new line appended to a file as a parsed observation.
 * Used by agenda, notify, pressure, health, sauna, and other stream readers.
 *
 * Uses chokidar with polling enabled for reliability on macOS / network FS.
 */

'use strict';

import { createReadStream, statSync, existsSync, openSync, closeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import chokidar from 'chokidar';
import { Channel } from '../contract.js';

export class TailChannel extends Channel {
  constructor({ id, class: cls, path, fromStart = false, pollIntervalMs = 250 }) {
    super({ id, class: cls });
    if (!path) throw new Error('TailChannel requires path');
    this.path = path;
    this.fromStart = fromStart;
    this.pollIntervalMs = pollIntervalMs;
    this._running = false;
    this._position = fromStart ? 0 : null;
    this._queue = [];
    this._waiters = [];
    this._watcher = null;
    this._safetyPoll = null;
  }

  async start() {
    if (this._running) return;
    this._running = true;
    if (!existsSync(this.path)) {
      closeSync(openSync(this.path, 'a'));
    }
    if (this._position === null) {
      try { this._position = statSync(this.path).size; } catch { this._position = 0; }
    }
    // persistent:true — these are lifetime watchers, closed in stop().
    // Under chokidar v4, persistent:false unrefs the poll timer, so a
    // process (or test runner) whose event loop drains never sees events.
    this._watcher = chokidar.watch(this.path, {
      persistent: true,
      usePolling: true,
      interval: this.pollIntervalMs,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 50 },
    });
    const onChange = () => this._readIncrement();
    this._watcher.on('change', onChange);
    this._watcher.on('add', onChange);
    await new Promise((resolve) => this._watcher.once('ready', resolve));
    // Safety poll: chokidar v4 can fold a write that lands while the
    // watcher is establishing its stat baseline into that baseline and
    // never emit a change for it. _readIncrement() is cheap (one stat,
    // no-op unless the file grew) and position-guarded, so this interval
    // guarantees the tail makes progress even when an event is swallowed.
    this._safetyPoll = setInterval(() => { void this._readIncrement(); }, this.pollIntervalMs);
    await this._readIncrement();
  }

  async stop() {
    this._running = false;
    if (this._safetyPoll) {
      clearInterval(this._safetyPoll);
      this._safetyPoll = null;
    }
    if (this._watcher) {
      try { await this._watcher.close(); } catch {}
      this._watcher = null;
    }
    for (const w of this._waiters) w.resolve({ done: true, value: undefined });
    this._waiters = [];
  }

  async _readIncrement() {
    if (!this._running) return;
    let size;
    try { size = statSync(this.path).size; } catch { return; }
    if (size <= this._position) return;
    const start = this._position;
    this._position = size; // advance before awaiting to avoid reentrant double-reads
    await new Promise((resolve) => {
      const stream = createReadStream(this.path, { start, end: size - 1 });
      const rl = createInterface({ input: stream });
      rl.on('line', (line) => {
        const parsed = this.parseLine(line);
        if (parsed) this._enqueue(parsed);
      });
      rl.on('close', resolve);
      rl.on('error', resolve);
    });
  }

  _enqueue(item) {
    if (this._waiters.length) {
      const w = this._waiters.shift();
      w.resolve({ done: false, value: item });
    } else {
      this._queue.push(item);
    }
  }

  async *source() {
    while (this._running || this._queue.length) {
      if (this._queue.length) { yield this._queue.shift(); continue; }
      const next = await new Promise((resolve) => this._waiters.push({ resolve }));
      if (next.done) return;
      yield next.value;
    }
  }

  parseLine(_line) { throw new Error('TailChannel.parseLine() not implemented'); }

  parse(preParsed) { return preParsed; }
}
