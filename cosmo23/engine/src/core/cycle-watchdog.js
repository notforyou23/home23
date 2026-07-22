/**
 * CycleWatchdog — Fix 2.2 (Phase 2 reliability program)
 *
 * A cycle watchdog that ACTS, unlike TimeoutManager's cycle timer which is
 * monitoring-only (it fires a log callback and aborts nothing).
 *
 * Responsibilities:
 *  1. Circuit breaker over consecutive cycle failures (thrown cycle errors,
 *     hard timeouts, sustained-critical stalls, optionally soft timeouts):
 *     consecutiveFailures >= watchdog.tripThreshold (default 3) trips the
 *     breaker. While tripped the orchestrator pauses cycling for
 *     watchdog.cooloffMs (default 15 min), then runs exactly one revive
 *     probe cycle; success closes the breaker, failure re-trips it.
 *  2. Hard-deadline bookkeeping for cycle abandonment: hardDeadlineMs() is
 *     max(cycleTimeoutMs * watchdog.hardMultiplier, watchdog.minHardTimeoutMs).
 *  3. Persistence: breaker state lives in <logsDir>/.watchdog.json (written
 *     via tmp+rename) so an engine restart does not amnesia an open breaker.
 *
 * NOT responsible for: aborting in-flight LLM calls (gpt5-client has no
 * AbortSignal plumbing), heartbeat stamping (Fix 2.1), or process restarts
 * (Fix 2.5 supervises; this module only records restartRequested and the
 * orchestrator exits with watchdog.restartExitCode).
 *
 * The clock is injectable (`now`) so tests can drive trip/cooloff/revive
 * transitions without real waiting.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const WATCHDOG_STATE_VERSION = 1;

const WATCHDOG_DEFAULTS = Object.freeze({
  tripThreshold: 3,
  cooloffMs: 15 * 60 * 1000,        // 15 min pause after a trip
  hardMultiplier: 3,                 // hard deadline = cycleTimeoutMs * 3 ...
  minHardTimeoutMs: 10 * 60 * 1000,  // ... floored at 10 min (LLM calls are un-abortable)
  countSoftTimeouts: false,
  criticalStallMs: 10 * 60 * 1000,   // O2: sustained-critical + zero agents window
  pauseSleepMs: 5000,
  restartExitCode: 86,
  restartStopTimeoutMs: 30000,
  stateFile: '.watchdog.json'
});

// Failure types that trip the breaker IMMEDIATELY regardless of the streak:
// 'hard_timeout' leaves an orphaned in-flight promise (cycling on is unsafe
// until it settles — the open breaker doubles as the containment window);
// 'critical_stall' (O2) means backpressure has been critical with zero
// active agents for watchdog.criticalStallMs — the run is parked and pausing
// is also the remediation (no cycling → no new allocation pressure).
const HARD_FAILURE_TYPES = Object.freeze(new Set(['hard_timeout', 'critical_stall']));

function positiveInt(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return fallback;
}

function nonNegativeInt(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  return fallback;
}

class CycleWatchdog {
  constructor({ logsDir, config = {}, logger = console, now = () => Date.now() } = {}) {
    if (!logsDir) {
      throw new Error('CycleWatchdog requires logsDir');
    }
    this.logsDir = logsDir;
    this.logger = logger || console;
    this.now = now;

    const wd = (config && config.watchdog) || {};
    this.tripThreshold = positiveInt(wd.tripThreshold, WATCHDOG_DEFAULTS.tripThreshold);
    this.cooloffMs = positiveInt(wd.cooloffMs, WATCHDOG_DEFAULTS.cooloffMs);
    this.hardMultiplier = positiveInt(wd.hardMultiplier, WATCHDOG_DEFAULTS.hardMultiplier);
    this.minHardTimeoutMs = nonNegativeInt(wd.minHardTimeoutMs, WATCHDOG_DEFAULTS.minHardTimeoutMs);
    this.countSoftTimeouts = wd.countSoftTimeouts === true || wd.countSoftTimeouts === 'true';
    this.criticalStallMs = positiveInt(wd.criticalStallMs, WATCHDOG_DEFAULTS.criticalStallMs);
    this.pauseSleepMs = positiveInt(wd.pauseSleepMs, WATCHDOG_DEFAULTS.pauseSleepMs);
    this.restartExitCode = positiveInt(wd.restartExitCode, WATCHDOG_DEFAULTS.restartExitCode);
    this.restartStopTimeoutMs = positiveInt(wd.restartStopTimeoutMs, WATCHDOG_DEFAULTS.restartStopTimeoutMs);
    this.statePath = path.join(
      logsDir,
      typeof wd.stateFile === 'string' && wd.stateFile ? wd.stateFile : WATCHDOG_DEFAULTS.stateFile
    );

    // Breaker state (restored from disk below so restarts don't amnesia it).
    this.state = 'closed';          // 'closed' | 'open' | 'half-open'
    this.consecutiveFailures = 0;
    this.cooloffUntil = 0;          // epoch ms
    this.tripCount = 0;
    this.trippedAt = null;          // ISO string
    this.lastFailure = null;        // { type, message, cycle, at }
    this.restartRequested = false;
    this.restartReason = null;

    this._load();
  }

  /**
   * Hard abandonment deadline for one cycle:
   * max(cycleTimeoutMs * hardMultiplier, minHardTimeoutMs).
   * The floor exists because in-flight LLM calls cannot be aborted (no signal
   * plumbing in gpt5-client / unified-client) and the OpenAI SDK's own
   * per-request timeout is 10 minutes — a sub-10-minute hard deadline would
   * routinely abandon healthy-but-slow cycles. Set watchdog.minHardTimeoutMs
   * to 0 for pure multiplier semantics.
   */
  hardDeadlineMs(cycleTimeoutMs) {
    const base = positiveInt(cycleTimeoutMs, 60000);
    return Math.max(base * this.hardMultiplier, this.minHardTimeoutMs);
  }

  recordSuccess() {
    const wasNoteworthy = this.state !== 'closed' || this.consecutiveFailures > 0 || this.restartRequested;
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.cooloffUntil = 0;
    this.restartRequested = false;
    this.restartReason = null;
    if (wasNoteworthy) {
      this.logger.info('[CycleWatchdog] Breaker closed — cycle succeeded, failure streak reset');
      this._persist();
    }
    return this.getStatus();
  }

  /**
   * Record a failed cycle.
   * @param {object} failure - { type: 'error'|'soft_timeout'|'hard_timeout'|'critical_stall', message, cycle }
   *
   * HARD_FAILURE_TYPES ('hard_timeout', 'critical_stall') trip immediately
   * regardless of the failure streak — see the constant's rationale above.
   * A failure while half-open (revive probe) also re-trips immediately.
   */
  recordFailure(failure = {}) {
    const type = failure.type || 'error';
    this.lastFailure = {
      type,
      message: failure.message || null,
      cycle: Number.isFinite(failure.cycle) ? failure.cycle : null,
      at: new Date(this.now()).toISOString()
    };

    const probeFailed = this.state === 'half-open';
    if (HARD_FAILURE_TYPES.has(type)) {
      this.consecutiveFailures = Math.max(this.consecutiveFailures + 1, this.tripThreshold);
    } else {
      this.consecutiveFailures += 1;
    }

    if (probeFailed || this.consecutiveFailures >= this.tripThreshold) {
      this._trip(probeFailed ? 'revive_probe_failed' : type);
    } else {
      this.logger.warn('[CycleWatchdog] Cycle failure recorded', {
        type,
        consecutiveFailures: this.consecutiveFailures,
        tripThreshold: this.tripThreshold,
        cycle: this.lastFailure.cycle
      });
      this._persist();
    }
    return this.getStatus();
  }

  isTripped() {
    return this.state === 'open' || this.state === 'half-open';
  }

  /** Breaker open and still inside the cooloff window → do not cycle. */
  shouldPause() {
    return this.state === 'open' && this.now() < this.cooloffUntil;
  }

  cooloffRemainingMs() {
    if (this.state !== 'open') return 0;
    return Math.max(0, this.cooloffUntil - this.now());
  }

  /** Breaker open and cooloff elapsed → the next cycle is the revive probe. */
  canProbe() {
    return this.state === 'open' && this.now() >= this.cooloffUntil;
  }

  beginProbe() {
    if (!this.canProbe()) return false;
    this.state = 'half-open';
    this.logger.warn('[CycleWatchdog] Cooloff elapsed — running revive probe cycle', {
      tripCount: this.tripCount
    });
    this._persist();
    return true;
  }

  markRestartRequested(reason) {
    this.restartRequested = true;
    this.restartReason = reason || null;
    this._persist();
    return this.getStatus();
  }

  getStatus() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      tripThreshold: this.tripThreshold,
      tripCount: this.tripCount,
      trippedAt: this.trippedAt,
      cooloffUntil: this.cooloffUntil || null,
      cooloffRemainingMs: this.cooloffRemainingMs(),
      lastFailure: this.lastFailure,
      restartRequested: this.restartRequested,
      restartReason: this.restartReason
    };
  }

  _trip(reason) {
    this.state = 'open';
    this.tripCount += 1;
    this.trippedAt = new Date(this.now()).toISOString();
    this.cooloffUntil = this.now() + this.cooloffMs;
    this.logger.error('[CycleWatchdog] Circuit breaker TRIPPED — pausing cycles for cooloff', {
      reason,
      consecutiveFailures: this.consecutiveFailures,
      tripCount: this.tripCount,
      cooloffMs: this.cooloffMs,
      cooloffUntil: new Date(this.cooloffUntil).toISOString()
    });
    this._persist();
  }

  _persist() {
    const payload = {
      version: WATCHDOG_STATE_VERSION,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      tripCount: this.tripCount,
      trippedAt: this.trippedAt,
      cooloffUntil: this.cooloffUntil || null,
      lastFailure: this.lastFailure,
      restartRequested: this.restartRequested,
      restartReason: this.restartReason,
      updatedAt: new Date(this.now()).toISOString()
    };
    const tmpPath = `${this.statePath}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
      fs.renameSync(tmpPath, this.statePath);
    } catch (error) {
      this.logger.warn('[CycleWatchdog] Failed to persist breaker state (non-fatal)', {
        path: this.statePath,
        error: error.message
      });
      try { fs.unlinkSync(tmpPath); } catch (_) { /* best effort */ }
    }
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.statePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn('[CycleWatchdog] Could not read breaker state file (starting closed)', {
          path: this.statePath,
          error: error.message
        });
      }
      return;
    }
    try {
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object') return;
      // A persisted 'half-open' means the process died mid-probe: restore as
      // 'open' with the original cooloffUntil (already in the past), so the
      // next eligible cycle re-probes.
      this.state = saved.state === 'open' || saved.state === 'half-open' ? 'open' : 'closed';
      this.consecutiveFailures = nonNegativeInt(saved.consecutiveFailures, 0);
      this.tripCount = nonNegativeInt(saved.tripCount, 0);
      this.trippedAt = typeof saved.trippedAt === 'string' ? saved.trippedAt : null;
      this.cooloffUntil = nonNegativeInt(saved.cooloffUntil, 0);
      this.lastFailure = saved.lastFailure && typeof saved.lastFailure === 'object' ? saved.lastFailure : null;
      this.restartRequested = saved.restartRequested === true;
      this.restartReason = typeof saved.restartReason === 'string' ? saved.restartReason : null;
      if (this.state === 'open') {
        this.logger.warn('[CycleWatchdog] Restored OPEN breaker from disk — restart does not reset the cooloff', {
          cooloffRemainingMs: this.cooloffRemainingMs(),
          consecutiveFailures: this.consecutiveFailures,
          tripCount: this.tripCount
        });
      }
    } catch (error) {
      this.logger.warn('[CycleWatchdog] Breaker state file unparsable (starting closed)', {
        path: this.statePath,
        error: error.message
      });
    }
  }
}

module.exports = { CycleWatchdog, WATCHDOG_DEFAULTS };
