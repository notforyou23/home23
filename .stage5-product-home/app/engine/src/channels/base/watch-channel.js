/**
 * WatchChannel — base class for filesystem-event channels.
 * Used by build/fswatch (design docs, config, code), os/fswatch-home23,
 * and work/goals (watches lifecycle directories).
 */

'use strict';

import chokidar from 'chokidar';
import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { Channel } from '../contract.js';

export class WatchChannel extends Channel {
  constructor({ id, class: cls, paths, ignored, usePolling = false, interval = 1000 }) {
    super({ id, class: cls });
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error('WatchChannel requires at least one path');
    }
    this.paths = paths;
    this.ignored = ignored || /(^|[/\\])\.[^/\\]/;
    this.usePolling = Boolean(usePolling);
    this.interval = interval;
    this._running = false;
    this._queue = [];
    this._waiters = [];
    this._watcher = null;
  }

  async start() {
    if (this._running) return;
    this._running = true;
    // Startup add bookkeeping for _reconcileStartupAdds() below.
    this._startupAdds = new Map();
    this._ready = false;
    // persistent:true — lifetime watcher, closed in stop(). Under chokidar
    // v4, persistent:false unrefs the poll timer, so a process (or test
    // runner) whose event loop drains never sees events.
    //
    // ignoreInitial:false + the pre-ready filter below replaces chokidar's
    // own ignoreInitial with identical semantics: the initial scan emits
    // before 'ready' and is dropped here. Emitting the scan lets
    // _reconcileStartupAdds() know which files chokidar actually saw.
    this._watcher = chokidar.watch(this.paths, {
      ignored: this.ignored,
      ignoreInitial: false,
      persistent: true,
      usePolling: this.usePolling,
      interval: this.interval,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    for (const type of ['add', 'change', 'unlink', 'addDir', 'unlinkDir']) {
      this._watcher.on(type, (path) => {
        if (type === 'add' && this._startupAdds) {
          if (this._startupAdds.get(path) === 'synthesized') {
            // The startup reconcile already delivered this add.
            this._startupAdds.set(path, 'emitted');
            return;
          }
          this._startupAdds.set(path, 'emitted');
        }
        if (!this._ready) return; // initial-scan event — see ignoreInitial note
        const parsed = this.parseEvent({ type, path, ts: new Date().toISOString() });
        if (parsed) this._enqueue(parsed);
      });
    }
    await new Promise((resolve) => this._watcher.once('ready', resolve));
    this._ready = true;
    await this._reconcileStartupAdds();
  }

  /**
   * chokidar v4 can fold a file created during watcher startup into its
   * baseline without ever emitting it: with the polling backend, the
   * directory mtime change lands before the poller's first stat, so no
   * later poll re-scans the directory and the file stays invisible
   * forever (it does not even appear in getWatched()). One bounded rescan
   * after 'ready' synthesizes add events for anything on disk that
   * chokidar never reported. Startup-only; once the baseline is
   * established, live events are detected normally.
   */
  async _reconcileStartupAdds() {
    // Give in-flight startup events (awaitWriteFinish stabilization, slow
    // scans) a chance to emit and be recorded before diffing against disk.
    await new Promise((resolve) => setTimeout(resolve, Math.max(this.interval, 100)));
    if (!this._running || !this._startupAdds) return;
    const isIgnored = typeof this.ignored === 'function'
      ? this.ignored
      : (p) => (this.ignored instanceof RegExp ? this.ignored.test(p) : false);
    const walk = async (target) => {
      if (!this._running || !this._startupAdds) return;
      let entry;
      try { entry = await lstat(target); } catch { return; }
      if (entry.isFile()) {
        if (isIgnored(target) || this._startupAdds.has(target)) return;
        this._startupAdds.set(target, 'synthesized');
        const parsed = this.parseEvent({ type: 'add', path: target, ts: new Date().toISOString() });
        if (parsed) this._enqueue(parsed);
        return;
      }
      if (!entry.isDirectory() || isIgnored(target)) return;
      let names;
      try { names = await readdir(target); } catch { return; }
      for (const name of names) await walk(join(target, name));
    };
    for (const root of this.paths) await walk(root);
    // Close the startup window: drop the bookkeeping so live adds flow
    // untouched and the map cannot grow unboundedly.
    const cleanup = setTimeout(() => { this._startupAdds = null; }, 2 * Math.max(this.interval, 1000));
    cleanup.unref?.();
  }

  async stop() {
    this._running = false;
    this._startupAdds = null;
    if (this._watcher) {
      try { await this._watcher.close(); } catch {}
      this._watcher = null;
    }
    for (const w of this._waiters) w.resolve({ done: true, value: undefined });
    this._waiters = [];
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

  parseEvent(_evt) { throw new Error('WatchChannel.parseEvent() not implemented'); }
  parse(preParsed) { return preParsed; }
}
