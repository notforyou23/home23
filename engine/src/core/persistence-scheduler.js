'use strict';

// brain_search and chat memory search read the persisted memory manifest,
// never live memory, and live memory reached it only when a cognitive cycle
// finished a successful save. Discarded thoughts, thrown cycles, a paused
// engine and refused saves all skipped that save: Jerry once went 5.4 h
// without one and Forrest 61 h (H23-003). This bounds the age of unpersisted
// memory apart from cycles: a graph dirty for maxDirtyAgeMs is saved, a
// feeder commit asks for a save within requestDelayMs, and refused saves back
// off and are counted for the stale alarm. It saves through saveState, so the
// node-loss guard and joining of a running save still apply. saveState reports
// every save (cycle, scheduler, shutdown) back through recordSave.

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

class PersistenceScheduler {
  constructor({
    isDirty,
    save,
    isSaving = () => false,
    logger = null,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    tickMs = 15_000,
    maxDirtyAgeMs = 60_000,
    requestDelayMs = 5_000,
    minIntervalMs = 15_000,
    refusalBackoffMs = 30_000,
    maxRefusalBackoffMs = 10 * 60_000,
  }) {
    Object.assign(this, {
      isDirty, save, isSaving, logger, now, setTimer, clearTimer,
      tickMs, maxDirtyAgeMs, requestDelayMs, minIntervalMs, refusalBackoffMs, maxRefusalBackoffMs,
    });
    this.running = false;
    this.timer = null;
    this.timerAt = null;
    this.inFlight = null;
    this.dirtySince = null;
    this.requestDueAt = null;
    this.requestReason = null;
    this.lastAttemptAt = null;
    this.lastPersistedAt = null;
    this.persistedRevision = null;
    this.lastSaveResult = null;
    this.consecutiveRefusals = 0;
    this.backoffUntil = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._arm(this.now() + this.tickMs);
  }

  // A save already running keeps going; shutdown's final save joins it.
  stop() {
    this.running = false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.timerAt = null;
  }

  /** Ask for a save soon, e.g. after a feeder commit. Requests coalesce. */
  request(reason = 'request') {
    if (!this.running) return;
    const at = this.now();
    this._observe(at);
    if (this.dirtySince === null) return;
    const due = Math.max(at + this.requestDelayMs, (this.lastAttemptAt ?? -Infinity) + this.minIntervalMs);
    if (this.requestDueAt === null || due < this.requestDueAt) this.requestDueAt = due;
    this.requestReason = reason;
    this._arm(this.requestDueAt);
  }

  /** Every saveState outcome, including saves this scheduler did not start. */
  recordSave(result) {
    const at = this.now();
    // A small brain whose sidecar write failed still saves inline, but the
    // manifest that search reads did not move: that is not a persisted save.
    const persisted = result?.saved === true && result.searchStale !== true;
    this.lastSaveResult = {
      at: iso(at),
      saved: result?.saved ?? false,
      ...(result?.reason && { reason: result.reason }),
      ...(result?.error && { error: String(result.error).slice(0, 300) }),
      ...(result?.sidecars && { sidecars: result.sidecars }),
      ...(Number.isSafeInteger(result?.memoryRevision) && { memoryRevision: result.memoryRevision }),
      ...(result?.searchStale === true && { searchStale: true }),
    };
    if (persisted) {
      this.consecutiveRefusals = 0;
      this.backoffUntil = 0;
      this.lastPersistedAt = at;
      if (Number.isSafeInteger(result.memoryRevision)) this.persistedRevision = result.memoryRevision;
      // Mutations made during the save stay dirty; their age starts now.
      this.dirtySince = this.isDirty() ? at : null;
      if (this.dirtySince === null) this.requestDueAt = null;
    } else {
      this.consecutiveRefusals += 1;
      this.backoffUntil = at + Math.min(
        this.maxRefusalBackoffMs,
        this.refusalBackoffMs * 2 ** Math.min(this.consecutiveRefusals - 1, 20),
      );
    }
    // A request blocked by this save (or its refusal) runs when allowed.
    if (this.requestDueAt !== null) this._arm(Math.max(at, this.backoffUntil, this.requestDueAt));
  }

  status() {
    const at = this.now();
    this._observe(at);
    const dirty = this.dirtySince !== null;
    return {
      running: this.running,
      dirty,
      oldestUnpersistedAt: iso(this.dirtySince),
      unpersistedForMs: dirty ? at - this.dirtySince : 0,
      lastPersistedAt: iso(this.lastPersistedAt),
      persistedRevision: this.persistedRevision,
      lastSaveResult: this.lastSaveResult,
      consecutiveRefusals: this.consecutiveRefusals,
      searchStale: this.lastSaveResult?.searchStale === true,
      saving: Boolean(this.inFlight) || Boolean(this.isSaving()),
      nextSaveNotBefore: this.backoffUntil > at ? iso(this.backoffUntil) : null,
    };
  }

  _observe(at) {
    if (!this.isDirty()) {
      this.dirtySince = null;
      this.requestDueAt = null;
    } else if (this.dirtySince === null) {
      this.dirtySince = at;
    }
  }

  _arm(at) {
    if (!this.running) return;
    if (this.timer && this.timerAt <= at) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timerAt = at;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.timerAt = null;
      this._tick();
    }, Math.max(0, at - this.now()));
    this.timer?.unref?.();
  }

  _tick() {
    if (!this.running) return;
    const at = this.now();
    this._observe(at);
    const ageDue = this.dirtySince !== null && at - this.dirtySince >= this.maxDirtyAgeMs;
    const requestDue = this.requestDueAt !== null && at >= this.requestDueAt;
    if ((ageDue || requestDue) && !this.inFlight && !this.isSaving() && at >= this.backoffUntil) {
      this._run(ageDue ? 'dirty-age' : this.requestReason || 'request');
    }
    const next = this.requestDueAt !== null && this.requestDueAt > at
      ? Math.min(at + this.tickMs, this.requestDueAt)
      : at + this.tickMs;
    this._arm(next);
  }

  _run(reason) {
    this.lastAttemptAt = this.now();
    this.requestDueAt = null;
    this.logger?.debug?.('Persistence scheduler saving', { reason, dirtySince: iso(this.dirtySince) });
    this.inFlight = Promise.resolve()
      .then(() => this.save(reason))
      .catch((error) => {
        this.logger?.warn?.('Persistence scheduler save failed', { reason, error: error?.message });
      })
      .finally(() => {
        this.inFlight = null;
        this._arm(this.now());
      });
    return this.inFlight;
  }
}

module.exports = { PersistenceScheduler };
