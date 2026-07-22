# Fix 2.2 — cycle watchdog that ACTS + circuit breaker with revive probe (contract H3)

## Target current state

GAP 1 — cycle timeout is monitoring-only. cosmo23/engine/src/core/timeout-manager.js:39-79 `startCycleTimer(cycle, timeoutMs, onTimeout)` sets a setTimeout that logs `'[TimeoutManager] Cycle timeout exceeded'` and fires an optional callback, then clears itself. It aborts nothing. The single orchestrator call site passes NO callback — orchestrator.js:1291-1293:
```js
    // Phase A: Start cycle timeout (default 60s, configurable)
    const cycleTimeout = this.config.timeouts?.cycleTimeoutMs || 60000;
    this.timeoutManager.startCycleTimer(this.cycleCount, cycleTimeout);
```
and orchestrator.js:3394-3397 cancels it in `finally`. `wrapWithTimeout` (timeout-manager.js:106) is defined but used NOWHERE in the engine (repo-wide grep: only its definition matches).

GAP 2 — cycle errors are swallowed with zero consecutive-error handling. orchestrator.js:3386-3397:
```js
    } catch (error) {
      this.logger.error('Cycle error', { error: error.message, stack: error.stack });

      this.stateModulator.updateState({
        type: 'error',
        success: false,
        surprise: 0.5
      });
    } finally {
      // Phase A: Always cancel cycle timeout (success or failure)
      this.timeoutManager.cancelCycleTimer();
    }
```
No counter, no breaker, no escalation anywhere (`grep -c "consecutive" orchestrator.js` relevant to cycles: 0; `grep -c "watchdog\|CycleWatchdog" orchestrator.js`: 0). The consolidation-mode catch (orchestrator.js:1264-1269) swallows identically. A cycle that errors before the every-cycle save (orchestrator.js:3285 `await this.saveState();` is inside the try) simply skips that save and the loop continues forever.

GAP 3 — the while-loop calls executeCycle unconditionally. orchestrator.js:951 `while (this.running) {` → orchestrator.js:1033 `await this.executeCycle();` (exactly one call site, grep-verified). A hung await inside executeCycle wedges the run permanently with no detection and no action.

ABORT PLUMBING (honest report): cosmo23/engine/src/core/chat-completions-client.js HAS real AbortSignal support — `options.signal` threaded through non-stream and stream paths (lines 370, 420-425, 440-520, 548-688) using `throwIfAborted`/`rethrowCancellation`/`abortableDelay`/`awaitWithCancellation` from cosmo23/lib/provider-execution.js. But gpt5-client.js (the DEFAULT Responses-API client) has ZERO abort/signal mentions, unified-client.js has ZERO `signal` mentions and `generate()` does not accept or forward one, and no orchestrator/coordinator/agent call site passes a signal. Hard-aborting in-flight LLM calls would be a new, large surface (UnifiedClient → GPT5Client → SDK options + anthropic-client + openai-client + every call site) — correctly out of Phase-2 scope.

DONOR (honest report): the task said "Home23 os-kernel circuit breaker under engine/src/os-kernel/" — that is WRONG. `grep -rni "circuit|breaker|revive" engine/src/os-kernel/` returns zero matches (os-kernel files: authorize.js, belief-delta.js, index.js, operator-intents.js, receipts.js, safe-actions.js, schemas.js, store.js). The real Home23 donor PATTERNS are: /Users/jtr/_JTR23_/release/home23/src/scheduler/cron.ts:652-675 (3 consecutive errors → `circuitOpenUntilMs = now + 15min` → withhold while open → backoff expiry = "circuit breaker revive probe after backoff" → reset counters) and /Users/jtr/_JTR23_/release/home23/engine/src/ingestion/document-feeder.js:44-46,625-627 (compile circuit failures/cooldownMs/openUntil). The proposed module adapts the cron.ts trip/cooloff/probe-once semantics and adds H3's persisted-state requirement (.watchdog.json) so restarts don't amnesia the breaker.

CONCURRENT-CYCLE SAFETY ANALYSIS (why in-process "abandon and keep cycling" is unsafe, argued from code): (1) executeCycle begins `this.cycleCount++` (orchestrator.js:1219) which drives every phase gate (`% 3` topic queue :1313, `% 2` action queue :1327, `% 5` checkpoints :3299); two interleaved bodies corrupt phase scheduling. (2) `this.memory.startCycleTracking()` (:1280-1282) resets cluster diff tracking — a concurrent cycle clears the other's diff mid-flight. (3) `taskStateQueue.processAll()` and `planExecutor.tick(cycleCount)` serialize task-state mutations and can double-spawn agents for the same task if interleaved. (4) TimeoutManager has ONE cycleTimer slot — `startCycleTimer` cancels the other cycle's timer (:40-41). (5) `saveState()` has a join-guard (orchestrator.js:8091-8101) and the every-save safety guard, but a concurrent cycle mutating `this.memory` between the exporting cycle's awaits yields torn graph snapshots. Conclusion: NEVER run two executeCycle bodies concurrently. Therefore: hard timeout → abandon at the boundary, contain the orphaned promise (no new cycle while it is pending), trip the breaker immediately. If the orphan settles during cooloff (most hangs are slow-but-finite LLM calls — OpenAI SDK per-request timeout is 10 min, generateWithRetry stacks 3 retries), in-process revive proceeds. If the orphan is STILL pending when cooloff expires, the process is wedged on an un-abortable await → restart escalation (exit code 86 for Fix 2.5's supervisor; Phase 1 made restart safe: saves are guarded+atomic, boot re-hydrates from durable sidecars, dirty marker triggers crash recovery).

## CHANGE: cosmo23/engine/src/core/cycle-watchdog.js

NEW FILE. CycleWatchdog: circuit breaker (closed/open/half-open) over consecutive cycle failures with injectable clock, tmp+rename-persisted state in <logsDir>/.watchdog.json, hard-deadline computation with a configurable floor, and revive-probe semantics adapted from the Home23 cron.ts donor. Validated 11/11 in scratchpad (byte-identical copy).

### Anchor
```
(new file — no anchor)
```

### Code
```js
/**
 * CycleWatchdog — Fix 2.2 (Phase 2 reliability program)
 *
 * A cycle watchdog that ACTS, unlike TimeoutManager's cycle timer which is
 * monitoring-only (it fires a log callback and aborts nothing).
 *
 * Responsibilities:
 *  1. Circuit breaker over consecutive cycle failures (thrown cycle errors,
 *     hard timeouts, optionally soft timeouts): consecutiveFailures >=
 *     watchdog.tripThreshold (default 3) trips the breaker. While tripped the
 *     orchestrator pauses cycling for watchdog.cooloffMs (default 15 min),
 *     then runs exactly one revive probe cycle; success closes the breaker,
 *     failure re-trips it.
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
  pauseSleepMs: 5000,
  restartExitCode: 86,
  restartStopTimeoutMs: 30000,
  stateFile: '.watchdog.json'
});

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
   * @param {object} failure - { type: 'error'|'soft_timeout'|'hard_timeout', message, cycle }
   *
   * type 'hard_timeout' trips immediately regardless of the failure streak:
   * an abandoned cycle leaves an orphaned in-flight promise, so continuing to
   * cycle is unsafe — the open breaker doubles as the orphan-settling window.
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
    if (type === 'hard_timeout') {
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

```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Add the CycleWatchdog require next to the other Phase-A hardening requires. Anchor is line 14, grep-verified unique.

### Anchor
```
const { TimeoutManager } = require('./timeout-manager');
```

### Code
```js
const { TimeoutManager } = require('./timeout-manager');
const { CycleWatchdog } = require('./cycle-watchdog');
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Construct the watchdog in the constructor's Phase-A hardening block (after this.logsDir is resolved at ~line 235 and crashRecovery/timeoutManager at ~247-248) and initialize the wiring fields. CycleWatchdog._load() runs here, so a breaker left open by a previous process is restored at boot and the start() loop honors the remaining cooloff with no extra boot code. Anchor is line 248, grep-verified unique.

### Anchor
```
    this.timeoutManager = new TimeoutManager(config, logger);
```

### Code
```js
    this.timeoutManager = new TimeoutManager(config, logger);
    // Fix 2.2: acting cycle watchdog + circuit breaker (state persisted in
    // <logsDir>/.watchdog.json so restarts don't amnesia an open breaker).
    this.cycleWatchdog = new CycleWatchdog({ logsDir: this.logsDir, config, logger });
    this._abandonedCyclePromise = null;
    this._lastCycleError = null;
    this._watchdogPauseAnnounced = false;
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Rewire the start() loop (line 1033) through the watchdog. A false return means the watchdog paused/abandoned/escalated this iteration (it already did its own bounded sleep), so the loop `continue`s — mirroring the dashboard-pause pattern a few lines above and skipping cluster sync / maxCycles bookkeeping for iterations where no cycle settled. Multi-line anchor grep-verified unique via its first line (`await this.executeCycle();` occurs exactly once). NOTE: the line ABOVE this anchor is 6 spaces + newline (trailing whitespace) — it is deliberately NOT part of the anchor.

### Anchor
```
      await this.executeCycle();
      if (this.runCompletionRequested) {
        await this.finishRequestedRunCompletion();
        return;
      }
      const cycleForSync = this.cycleCount;
```

### Code
```js
      const cycled = await this.runCycleWithWatchdog();
      if (this.runCompletionRequested) {
        await this.finishRequestedRunCompletion();
        return;
      }
      if (!cycled) {
        // Watchdog paused or abandoned this iteration (bounded sleep already
        // happened inside runCycleWithWatchdog) — skip post-cycle work,
        // mirroring the dashboard-pause `continue` above.
        continue;
      }
      const cycleForSync = this.cycleCount;
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Insert the three new methods immediately BEFORE executeCycle (its doc comment at lines 1214-1217 is the anchor; the anchor text is re-emitted unchanged at the end of the replacement). Bodies are byte-identical to the scratch-validated copy (11/11 green). runCycleWithWatchdog: containment gate -> cooloff pause -> revive probe -> Promise.race(executeCycle, hard deadline) -> outcome recording. escalateWatchdogRestart: persist restartRequested, bounded stop() (which performs the guarded shutdown save and only marks the clean marker on a CONFIRMED save), backstop timer, process.exit(watchdog.restartExitCode). _emitWatchdogStatus: resilient emitRunStatus wrapper.

### Anchor
```
  /**
   * Execute one cognitive cycle with GPT-5
   */
  async executeCycle() {
```

### Code
```js
  /**
   * Fix 2.2: run one cycle under the acting cycle watchdog.
   *
   * - Breaker OPEN (cooloff) → pause: no cycle this iteration (returns false).
   * - Cooloff elapsed → the next cycle is the revive probe (half-open).
   * - The cycle races a hard deadline (cycleWatchdog.hardDeadlineMs). On hard
   *   timeout the cycle is ABANDONED at the boundary: the orphaned promise is
   *   contained — no new executeCycle may start while it is pending, because
   *   two concurrent executeCycle bodies interleave over cycleCount, the
   *   cluster diff tracker, taskStateQueue, planExecutor and the memory
   *   graph — and the breaker trips immediately. If the orphan settles during
   *   cooloff (slow LLM calls usually do), in-process revive proceeds; if it
   *   is STILL pending when cooloff expires, the process is wedged on an
   *   un-abortable await and we escalate to a supervisor restart. State is
   *   safe either way: saves are guarded + atomic and boot re-hydrates from
   *   the durable sidecars (Phase 1).
   *
   * @returns {boolean} true if executeCycle settled this iteration; false if
   *   the watchdog paused, abandoned, or escalated (caller should `continue`).
   */
  async runCycleWithWatchdog() {
    const wd = this.cycleWatchdog;
    if (!wd) {
      await this.executeCycle();
      return true;
    }

    // 1. Containment: never start a new cycle while an abandoned one is pending.
    if (this._abandonedCyclePromise) {
      if (wd.shouldPause()) {
        await this.sleep(Math.min(Math.max(wd.cooloffRemainingMs(), 1), wd.pauseSleepMs));
        return false;
      }
      await this.escalateWatchdogRestart('abandoned_cycle_never_settled');
      return false;
    }

    // 2. Breaker open → pause cycling for the cooloff window.
    if (wd.shouldPause()) {
      if (!this._watchdogPauseAnnounced) {
        this._watchdogPauseAnnounced = true;
        this.logger.warn('⛔ [CycleWatchdog] Breaker open — pausing cycles', wd.getStatus());
        this._emitWatchdogStatus('watchdog_cooloff', 'Cycle circuit breaker open — cooling off');
      }
      await this.sleep(Math.min(Math.max(wd.cooloffRemainingMs(), 1), wd.pauseSleepMs));
      return false;
    }

    // 3. Cooloff elapsed → this cycle is the revive probe.
    if (wd.canProbe()) {
      wd.beginProbe();
      this._watchdogPauseAnnounced = false;
      this._emitWatchdogStatus('watchdog_probe', 'Cooloff elapsed — revive probe cycle');
    }

    // 4. Run the cycle against the hard abandonment deadline.
    const cycleTimeoutMs = this.config.timeouts?.cycleTimeoutMs || 60000;
    const hardMs = wd.hardDeadlineMs(cycleTimeoutMs);
    this._lastCycleError = null;
    const startedAt = Date.now();
    const cyclePromise = this.executeCycle();

    // executeCycle swallows its own errors by design; this rejection guard is
    // belt-and-braces so an unexpected rejection cannot escape the loop.
    const guarded = Promise.resolve(cyclePromise).then(
      () => 'COMPLETED',
      (error) => {
        this._lastCycleError = {
          message: error?.message || String(error),
          code: error?.code || null,
          cycle: this.cycleCount,
          at: Date.now()
        };
        return 'COMPLETED';
      }
    );

    let hardTimer = null;
    const deadline = new Promise((resolve) => {
      hardTimer = setTimeout(() => resolve('HARD_TIMEOUT'), hardMs);
      if (typeof hardTimer.unref === 'function') hardTimer.unref();
    });

    const outcome = await Promise.race([guarded, deadline]);
    if (hardTimer) clearTimeout(hardTimer);

    if (outcome === 'HARD_TIMEOUT') {
      const cycle = this.cycleCount;
      this.logger.error('⛔ [CycleWatchdog] Cycle exceeded hard deadline — ABANDONED at cycle boundary', {
        cycle,
        hardDeadlineMs: hardMs,
        cycleTimeoutMs
      });
      this._abandonedCyclePromise = cyclePromise;
      guarded.then(() => {
        this._abandonedCyclePromise = null;
        this.logger.warn('[CycleWatchdog] Abandoned cycle finally settled', {
          cycle,
          settledAfterMs: Date.now() - startedAt
        });
      });
      this._watchdogPauseAnnounced = false;
      wd.recordFailure({
        type: 'hard_timeout',
        message: `cycle ${cycle} exceeded hard deadline ${hardMs}ms`,
        cycle
      });
      this._emitWatchdogStatus('watchdog_tripped', `Cycle ${cycle} abandoned after ${hardMs}ms — breaker open`);
      return false;
    }

    const durationMs = Date.now() - startedAt;
    if (this._lastCycleError) {
      const status = wd.recordFailure({
        type: 'error',
        message: this._lastCycleError.message,
        cycle: this._lastCycleError.cycle
      });
      if (status.state === 'open') {
        this._watchdogPauseAnnounced = false;
        this._emitWatchdogStatus('watchdog_tripped', `Breaker open after ${status.consecutiveFailures} consecutive cycle failures`);
      }
    } else if (wd.countSoftTimeouts && durationMs > cycleTimeoutMs) {
      wd.recordFailure({
        type: 'soft_timeout',
        message: `cycle took ${durationMs}ms (> ${cycleTimeoutMs}ms)`,
        cycle: this.cycleCount
      });
    } else {
      wd.recordSuccess();
    }
    return true;
  }

  /**
   * Fix 2.2: the process is wedged on an un-abortable in-flight await (an
   * abandoned cycle that never settled through a full cooloff). Persist the
   * breaker (so the restarted process honors the remaining cooloff), do a
   * bounded stop() — which performs the guarded shutdown save and only marks
   * the clean-shutdown marker on a CONFIRMED save — then exit with a distinct
   * code for the process-level supervisor (Fix 2.5). Restart is the safe
   * remediation: saves are guarded + atomic and boot re-hydrates from the
   * durable sidecars (Phase 1).
   */
  async escalateWatchdogRestart(reason) {
    const wd = this.cycleWatchdog;
    const exitCode = wd?.restartExitCode ?? 86;
    const stopBudgetMs = wd?.restartStopTimeoutMs ?? 30000;
    if (wd) wd.markRestartRequested(reason);

    this.logger.error('⛔ [CycleWatchdog] Restart escalation — engine wedged, exiting for supervisor restart', {
      reason,
      exitCode,
      stopBudgetMs
    });
    this._emitWatchdogStatus('watchdog_restart', `Engine wedged (${reason}) — exiting for restart`);

    // Backstop: if stop() itself hangs (it can await the same wedged
    // machinery), exit anyway once the budget expires.
    const backstop = setTimeout(() => process.exit(exitCode), stopBudgetMs);
    if (typeof backstop.unref === 'function') backstop.unref();

    this.running = false;
    try {
      await this.stop();
    } catch (error) {
      this.logger.error('[CycleWatchdog] stop() failed during restart escalation', { error: error.message });
    }
    process.exit(exitCode);
  }

  _emitWatchdogStatus(status, message) {
    try {
      this._getEvents().emitRunStatus({
        status,
        message,
        cycle: this.cycleCount,
        details: this.cycleWatchdog ? this.cycleWatchdog.getStatus() : null
      });
    } catch (error) {
      this.logger.debug?.('[CycleWatchdog] Status emit failed (non-fatal)', { error: error.message });
    }
  }

  /**
   * Execute one cognitive cycle with GPT-5
   */
  async executeCycle() {
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Surface swallowed cycle errors to the watchdog: executeCycle's main catch (lines 3386-3393) deliberately absorbs errors so the loop survives, so the watchdog can only count failures if the catch flags them. One assignment added; behavior otherwise unchanged. Anchor grep-verified unique ('Cycle error' logger line occurs once); no trailing whitespace in this block.

### Anchor
```
    } catch (error) {
      this.logger.error('Cycle error', { error: error.message, stack: error.stack });

      this.stateModulator.updateState({
        type: 'error',
        success: false,
        surprise: 0.5
      });
    } finally {
```

### Code
```js
    } catch (error) {
      this.logger.error('Cycle error', { error: error.message, stack: error.stack });

      // Fix 2.2: flag the failure for the cycle watchdog (errors are
      // deliberately swallowed here so the loop survives; the watchdog reads
      // this flag after the cycle settles to count consecutive failures).
      this._lastCycleError = {
        message: error.message,
        code: error.code || null,
        cycle: this.cycleCount,
        at: Date.now()
      };

      this.stateModulator.updateState({
        type: 'error',
        success: false,
        surprise: 0.5
      });
    } finally {
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Same flag in the consolidation-mode catch (lines 1264-1269) so perpetual consolidation failures also trip the breaker. WARNING — this anchor contains TRAILING WHITESPACE that must be matched exactly: line 1265 ends with '{ ' (brace + ONE SPACE before newline) and line 1267 ends with 'error.stack ' (ONE trailing space). 'Consolidation cycle failed' occurs exactly once in the file.

### Anchor
```
      } catch (error) {
        this.logger.error('Consolidation cycle failed', { 
          error: error.message,
          stack: error.stack 
        });
      }
```

### Code
```js
      } catch (error) {
        this.logger.error('Consolidation cycle failed', { 
          error: error.message,
          stack: error.stack 
        });
        // Fix 2.2: consolidation cycles count toward the watchdog breaker too.
        this._lastCycleError = {
          message: error.message,
          code: error.code || null,
          cycle: this.cycleCount,
          at: Date.now()
        };
      }
```

## CHANGE: cosmo23/engine/src/config.yaml

Document the watchdog.* config keys next to the timeouts block (lines 274-276; 'timeouts:' and 'operationTimeoutMs' each occur once — anchor unique, no trailing whitespace). This is the local-dev config; launcher-generated run configs omit the block and get identical behavior from the code defaults.

### Anchor
```
timeouts:
  cycleTimeoutMs: 180000  # 5min for local LLM, 3min for cloud
  operationTimeoutMs: 120000  # Increased for local LLM
```

### Code
```js
timeouts:
  cycleTimeoutMs: 180000  # 5min for local LLM, 3min for cloud
  operationTimeoutMs: 120000  # Increased for local LLM

# Fix 2.2: acting cycle watchdog + circuit breaker (contract H3).
# Breaker state persists in <logsDir>/.watchdog.json across restarts.
watchdog:
  tripThreshold: 3          # consecutive cycle failures that trip the breaker
  cooloffMs: 900000         # 15 min pause after a trip, then one revive probe
  hardMultiplier: 3         # hard abandon deadline = cycleTimeoutMs * this ...
  minHardTimeoutMs: 600000  # ... floored here (10 min): LLM calls are un-abortable; 0 = pure multiplier
  countSoftTimeouts: false  # count completed-but-over-cycleTimeoutMs cycles as failures
  pauseSleepMs: 5000        # poll interval while pausing during cooloff
  restartExitCode: 86       # exit code for supervisor-restart escalation (Fix 2.5 watches this)
  restartStopTimeoutMs: 30000  # bound on stop() during restart escalation
```

## CHANGE: package.json

Register the new suite in the cosmo23 node --test segment of the "test" script, exactly once, after crash-recovery-scalar-checkpoints (anchor string occurs exactly once in package.json — verified against the CURRENT tree, which already carries other sessions' modifications to this file; do not resolve from a stale copy).

### Anchor
```
tests/cosmo23/crash-recovery-scalar-checkpoints.test.cjs
```

### Code
```js
tests/cosmo23/crash-recovery-scalar-checkpoints.test.cjs tests/cosmo23/cycle-watchdog.test.cjs
```

## CHANGE: tests/cosmo23/package-test-registration.test.cjs

Add the new suite to the exactly-once registration list (anchor line occurs exactly once; file is already dirty from other sessions — edit the current tree).

### Anchor
```
    'tests/cosmo23/crash-recovery-scalar-checkpoints.test.cjs',
```

### Code
```js
    'tests/cosmo23/crash-recovery-scalar-checkpoints.test.cjs',
    'tests/cosmo23/cycle-watchdog.test.cjs',
```

## TEST FILE: tests/cosmo23/cycle-watchdog.test.cjs

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CycleWatchdog, WATCHDOG_DEFAULTS } = require('../../cosmo23/engine/src/core/cycle-watchdog');
const { Orchestrator } = require('../../cosmo23/engine/src/core/orchestrator');

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cycle-watchdog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeClock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance(ms) { nowMs += ms; }
  };
}

function makeFakeOrchestrator(t, { watchdogConfig = {}, cycleTimeoutMs = 40, logsDir, clock } = {}) {
  const dir = logsDir || makeTmpDir(t);
  const clk = clock || makeClock();
  const wd = new CycleWatchdog({
    logsDir: dir,
    config: { watchdog: watchdogConfig },
    logger: quietLogger,
    now: clk.now
  });
  const fake = {
    config: { timeouts: { cycleTimeoutMs } },
    logger: quietLogger,
    cycleWatchdog: wd,
    cycleCount: 0,
    running: true,
    calls: { executeCycle: 0, sleep: 0, escalate: 0, stop: 0 },
    _abandonedCyclePromise: null,
    _lastCycleError: null,
    _watchdogPauseAnnounced: false,
    async sleep() { this.calls.sleep += 1; },
    async executeCycle() { this.calls.executeCycle += 1; this.cycleCount += 1; },
    async stop() { this.calls.stop += 1; },
    async escalateWatchdogRestart(reason) { this.calls.escalate += 1; this.escalateReason = reason; },
    _getEvents() { return { emitRunStatus() {} }; },
    _emitWatchdogStatus: Orchestrator.prototype._emitWatchdogStatus
  };
  return { fake, wd, clock: clk, logsDir: dir };
}

const runCycle = (fake) => Orchestrator.prototype.runCycleWithWatchdog.call(fake);

// ─── breaker unit tests (fake clock injection, no real waiting) ───

test('breaker trips after tripThreshold consecutive errors and success resets it', (t) => {
  const clock = makeClock();
  const dir = makeTmpDir(t);
  const wd = new CycleWatchdog({ logsDir: dir, config: {}, logger: quietLogger, now: clock.now });

  wd.recordFailure({ type: 'error', message: 'boom 1', cycle: 1 });
  wd.recordFailure({ type: 'error', message: 'boom 2', cycle: 2 });
  assert.equal(wd.state, 'closed');
  assert.equal(wd.consecutiveFailures, 2);

  wd.recordFailure({ type: 'error', message: 'boom 3', cycle: 3 });
  assert.equal(wd.state, 'open');
  assert.equal(wd.tripCount, 1);
  assert.equal(wd.shouldPause(), true);
  assert.equal(wd.cooloffRemainingMs(), WATCHDOG_DEFAULTS.cooloffMs);
});

test('cooloff → revive probe → success closes; probe failure re-trips', (t) => {
  const clock = makeClock();
  const dir = makeTmpDir(t);
  const wd = new CycleWatchdog({
    logsDir: dir,
    config: { watchdog: { tripThreshold: 2, cooloffMs: 10_000 } },
    logger: quietLogger,
    now: clock.now
  });

  wd.recordFailure({ type: 'error', cycle: 1 });
  wd.recordFailure({ type: 'error', cycle: 2 });
  assert.equal(wd.state, 'open');
  assert.equal(wd.canProbe(), false);

  clock.advance(9_999);
  assert.equal(wd.shouldPause(), true);
  clock.advance(1);
  assert.equal(wd.shouldPause(), false);
  assert.equal(wd.canProbe(), true);

  assert.equal(wd.beginProbe(), true);
  assert.equal(wd.state, 'half-open');

  // Probe failure re-trips immediately with a fresh cooloff.
  wd.recordFailure({ type: 'error', cycle: 3 });
  assert.equal(wd.state, 'open');
  assert.equal(wd.tripCount, 2);
  assert.equal(wd.cooloffRemainingMs(), 10_000);

  // Second probe succeeds → closed, streak reset.
  clock.advance(10_000);
  assert.equal(wd.beginProbe(), true);
  wd.recordSuccess();
  assert.equal(wd.state, 'closed');
  assert.equal(wd.consecutiveFailures, 0);
});

test('hard_timeout trips immediately from closed', (t) => {
  const clock = makeClock();
  const dir = makeTmpDir(t);
  const wd = new CycleWatchdog({ logsDir: dir, config: {}, logger: quietLogger, now: clock.now });
  wd.recordFailure({ type: 'hard_timeout', message: 'abandoned', cycle: 7 });
  assert.equal(wd.state, 'open');
  assert.equal(wd.consecutiveFailures >= wd.tripThreshold, true);
  assert.equal(wd.lastFailure.type, 'hard_timeout');
});

test('breaker state persists across restart (no amnesia); mid-probe crash restores as open', (t) => {
  const clock = makeClock();
  const dir = makeTmpDir(t);
  const cfg = { watchdog: { tripThreshold: 1, cooloffMs: 60_000 } };
  const wd = new CycleWatchdog({ logsDir: dir, config: cfg, logger: quietLogger, now: clock.now });
  wd.recordFailure({ type: 'error', cycle: 4 });
  assert.equal(wd.state, 'open');

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, '.watchdog.json'), 'utf8'));
  assert.equal(onDisk.state, 'open');
  assert.equal(onDisk.version, 1);

  // "Restart": a fresh instance on the same dir restores the open breaker.
  const wd2 = new CycleWatchdog({ logsDir: dir, config: cfg, logger: quietLogger, now: clock.now });
  assert.equal(wd2.state, 'open');
  assert.equal(wd2.shouldPause(), true);
  assert.equal(wd2.tripCount, 1);

  // Crash mid-probe: persisted half-open must restore as open (re-probe).
  clock.advance(60_000);
  assert.equal(wd2.beginProbe(), true);
  const wd3 = new CycleWatchdog({ logsDir: dir, config: cfg, logger: quietLogger, now: clock.now });
  assert.equal(wd3.state, 'open');
  assert.equal(wd3.canProbe(), true, 'cooloff already elapsed — restart should re-probe');
});

test('corrupt state file starts closed without throwing', (t) => {
  const dir = makeTmpDir(t);
  fs.writeFileSync(path.join(dir, '.watchdog.json'), '{ not json');
  const wd = new CycleWatchdog({ logsDir: dir, config: {}, logger: quietLogger });
  assert.equal(wd.state, 'closed');
});

test('hardDeadlineMs = max(multiplier * cycleTimeout, floor)', (t) => {
  const dir = makeTmpDir(t);
  const wd = new CycleWatchdog({ logsDir: dir, config: {}, logger: quietLogger });
  assert.equal(wd.hardDeadlineMs(60_000), WATCHDOG_DEFAULTS.minHardTimeoutMs);
  assert.equal(wd.hardDeadlineMs(600_000), 1_800_000);

  const pure = new CycleWatchdog({
    logsDir: dir,
    config: { watchdog: { minHardTimeoutMs: 0 } },
    logger: quietLogger
  });
  assert.equal(pure.hardDeadlineMs(60_000), 180_000);
});

// ─── orchestrator wiring (real behavior via Orchestrator.prototype.<method>.call(fake)) ───

test('hard-timeout path: hung executeCycle is abandoned at the boundary and trips the breaker', async (t) => {
  const { fake, wd } = makeFakeOrchestrator(t, {
    watchdogConfig: { hardMultiplier: 1, minHardTimeoutMs: 0, cooloffMs: 60_000 },
    cycleTimeoutMs: 40
  });
  fake.executeCycle = function hang() {
    this.calls.executeCycle += 1;
    this.cycleCount += 1;
    return new Promise(() => {}); // never settles
  };

  const cycled = await runCycle(fake);

  assert.equal(cycled, false, 'abandoned iteration must report no settled cycle');
  assert.equal(fake.calls.executeCycle, 1);
  assert.notEqual(fake._abandonedCyclePromise, null, 'orphan must be contained');
  assert.equal(wd.state, 'open');
  assert.equal(wd.lastFailure.type, 'hard_timeout');

  // While cooling off with the orphan pending: no new cycle may start.
  assert.equal(await runCycle(fake), false);
  assert.equal(fake.calls.executeCycle, 1, 'no concurrent cycle while orphan pending');
  assert.equal(fake.calls.sleep, 1);
});

test('orphan still pending after full cooloff → restart escalation', async (t) => {
  const clock = makeClock();
  const { fake } = makeFakeOrchestrator(t, {
    watchdogConfig: { hardMultiplier: 1, minHardTimeoutMs: 0, cooloffMs: 60_000 },
    cycleTimeoutMs: 40,
    clock
  });
  fake.executeCycle = function hang() {
    this.calls.executeCycle += 1;
    return new Promise(() => {});
  };

  await runCycle(fake); // abandons + trips
  clock.advance(60_001); // cooloff expired, orphan still pending
  await runCycle(fake);

  assert.equal(fake.calls.escalate, 1);
  assert.equal(fake.escalateReason, 'abandoned_cycle_never_settled');
  assert.equal(fake.calls.executeCycle, 1, 'escalation path must not start a cycle');
});

test('orphan settles during cooloff → in-process revive probe, success closes breaker', async (t) => {
  const clock = makeClock();
  const { fake, wd } = makeFakeOrchestrator(t, {
    watchdogConfig: { hardMultiplier: 1, minHardTimeoutMs: 0, cooloffMs: 60_000 },
    cycleTimeoutMs: 40,
    clock
  });
  let releaseOrphan;
  fake.executeCycle = function hangOnce() {
    this.calls.executeCycle += 1;
    this.cycleCount += 1;
    return new Promise((resolve) => { releaseOrphan = resolve; });
  };

  await runCycle(fake); // abandoned + tripped
  assert.notEqual(fake._abandonedCyclePromise, null);

  releaseOrphan(); // the slow LLM call finally finished
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake._abandonedCyclePromise, null, 'settled orphan must clear containment');

  clock.advance(60_001);
  fake.executeCycle = async function healthy() {
    this.calls.executeCycle += 1;
    this.cycleCount += 1;
  };
  assert.equal(await runCycle(fake), true); // revive probe succeeds

  assert.equal(fake.calls.executeCycle, 2);
  assert.equal(fake.calls.escalate, 0);
  assert.equal(wd.state, 'closed', 'probe success closes the breaker');
});

test('consecutive swallowed cycle errors trip breaker; pause skips cycles; probe resets', async (t) => {
  const clock = makeClock();
  const { fake, wd } = makeFakeOrchestrator(t, {
    watchdogConfig: { tripThreshold: 3, cooloffMs: 60_000, minHardTimeoutMs: 0, hardMultiplier: 100 },
    cycleTimeoutMs: 1_000,
    clock
  });
  // Simulate executeCycle's internal catch: swallow the error, flag it.
  fake.executeCycle = async function failing() {
    this.calls.executeCycle += 1;
    this.cycleCount += 1;
    this._lastCycleError = { message: 'LLM exploded', cycle: this.cycleCount, at: Date.now() };
  };

  assert.equal(await runCycle(fake), true, 'an errored-but-settled cycle still counts as cycled');
  await runCycle(fake);
  assert.equal(wd.state, 'closed');
  await runCycle(fake);
  assert.equal(wd.state, 'open', 'third consecutive failure trips');

  assert.equal(await runCycle(fake), false); // cooling off
  assert.equal(fake.calls.executeCycle, 3, 'no cycle during cooloff');

  clock.advance(60_001);
  fake.executeCycle = async function healthy() {
    this.calls.executeCycle += 1;
    this.cycleCount += 1;
  };
  await runCycle(fake); // revive probe
  assert.equal(fake.calls.executeCycle, 4);
  assert.equal(wd.state, 'closed');
  assert.equal(wd.consecutiveFailures, 0);
});

test('open breaker restored from disk pauses a fresh orchestrator (restart honors cooloff)', async (t) => {
  const clock = makeClock();
  const dir = makeTmpDir(t);
  const first = makeFakeOrchestrator(t, {
    watchdogConfig: { tripThreshold: 1, cooloffMs: 60_000 },
    logsDir: dir,
    clock
  });
  first.wd.recordFailure({ type: 'error', cycle: 9 });
  assert.equal(first.wd.state, 'open');

  // "Restarted" orchestrator: new watchdog instance, same logsDir + clock.
  const second = makeFakeOrchestrator(t, {
    watchdogConfig: { tripThreshold: 1, cooloffMs: 60_000 },
    logsDir: dir,
    clock
  });
  assert.equal(await runCycle(second.fake), false);
  assert.equal(second.fake.calls.executeCycle, 0, 'restored open breaker must pause cycling');
  assert.equal(second.fake.calls.sleep, 1);
});

test('orchestrator wiring: start() routes through the watchdog and executeCycle flags failures', () => {
  assert.equal(typeof Orchestrator.prototype.runCycleWithWatchdog, 'function');
  assert.equal(typeof Orchestrator.prototype.escalateWatchdogRestart, 'function');
  const startSrc = String(Orchestrator.prototype.start);
  assert.equal(startSrc.includes('this.runCycleWithWatchdog()'), true, 'start() loop must call runCycleWithWatchdog');
  assert.equal(startSrc.includes('await this.executeCycle()'), false, 'start() must not call executeCycle directly anymore');
  const cycleSrc = String(Orchestrator.prototype.executeCycle);
  assert.equal(cycleSrc.includes('_lastCycleError'), true, 'executeCycle catch must flag failures for the watchdog');
});

```

## API NOTES

DONOR MISMATCH (H6 verify-by-reading): the fix brief pointed at "the Home23 os-kernel circuit breaker under engine/src/os-kernel/" — it does not exist; grep for circuit/breaker/revive across all 8 os-kernel files returns zero matches (only engine/src/agency/charter.js mentions 'cron_circuit_revive' as an intent NAME). The real donor patterns, read and adapted: /Users/jtr/_JTR23_/release/home23/src/scheduler/cron.ts:652-675 (3-consecutive-errors → circuitOpenUntilMs = now+15min → withhold while open → "revive probe after backoff" → counters reset on probe) and engine/src/ingestion/document-feeder.js:44-46/625-627 (compileCircuitFailures/cooldownMs/openUntil). Neither donor persists breaker state or distinguishes half-open; both were added per H3.

ABORT PLUMBING (honest): chat-completions-client.js HAS full AbortSignal support (options.signal + cosmo23/lib/provider-execution.js helpers, lines 370-688) — but it only serves Ollama-Cloud-style providers. gpt5-client.js (default Responses client), unified-client.js, anthropic-client.js, openai-client.js have ZERO signal plumbing, and timeout-manager.wrapWithTimeout is defined but used nowhere in the engine. Hard-aborting in-flight LLM calls is therefore new surface across 4 clients + every call site — rejected for Phase 2. Design (a) resolution: watchdog-at-cycle-boundary with a three-way outcome — (1) abandoned cycle's orphan promise is CONTAINED (invariant: executeCycle is never invoked while a previous invocation is pending — argued from code in targetCurrentState: cycleCount phase gating, cluster diff reset, taskStateQueue/planExecutor serial assumptions, single cycleTimer slot, torn exportGraph snapshots); (2) if the orphan settles during cooloff (common: OpenAI SDK per-request timeout is 10min and generateWithRetry stacks 3 backoff retries, so most "hangs" are slow-but-finite), in-process revive probe proceeds — no process churn for live runs; (3) if the orphan is still pending when cooloff expires, restart escalation: persist restartRequested to .watchdog.json, bounded this.stop() (does the guarded shutdown save; clean marker only on CONFIRMED save, else dirty marker → crash recovery → loadState-always re-hydration — all Phase 1 guarantees), then process.exit(86). A settled-late orphan is harmless: all its mutations complete before any new cycle starts, and its own saveState is join-guarded + save-safety-guarded + atomic.

DELIBERATE DEVIATIONS from the H3 letter (flag for orchestrator review): (1) watchdog.minHardTimeoutMs floor (default 600000) on top of the contract's hardMultiplier=3 — with the contract's 60s example the pure 3x deadline is 180s, which would abandon routinely-healthy multi-minute coordinator cycles (the shipped engine config already sets cycleTimeoutMs: 180000, config.yaml:275, precisely because 60s cycles are normal-slow); set minHardTimeoutMs: 0 for pure contract semantics. (2) Soft timeouts (completed but over cycleTimeoutMs) do NOT count toward consecutiveFailures by default (watchdog.countSoftTimeouts: false) — counting them at threshold 3 would trip healthy live runs (e.g. labor23); the contract's "cycle-timeout" failure class is satisfied by hard timeouts, which trip immediately. (3) Hard timeout trips the breaker immediately rather than incrementing toward the threshold — justified because post-abandonment cycling is unsafe until the orphan settles, so the open state doubles as the containment window.

H4 COMPOSITION: the watchdog never skips, degrades, or races a state save — pausing happens at the cycle boundary before any cycle work, and an abandoned cycle's in-flight saveState (orchestrator.js:3285 via the :8091 join-guard) always runs to completion. H1/H2 COMPOSITION: no contention — watchdog owns <logsDir>/.watchdog.json, heartbeat (Fix 2.1) owns <logsDir>/.heartbeat; cycleWatchdog.getStatus() is a ready-made payload if Fix 2.3's status contract wants a watchdog field, and the emitted run statuses are 'watchdog_cooloff' / 'watchdog_probe' / 'watchdog_tripped' / 'watchdog_restart'. Fix 2.5 dependency: launcher/process-manager.js today only emits 'cosmo-exit' (line 294-298) with NO auto-restart, so until 2.5 lands, restart escalation stops the run visibly (exit code 86, breaker persisted, dirty marker → clean recovery on next start) — strictly better than today's silent permanent wedge.

WIRING/ANCHOR NOTES: all anchors grep-verified unique against the CURRENT tree (which carries other sessions' uncommitted work in package.json, tests/cosmo23/package-test-registration.test.cjs, and cosmo23/engine — do not apply against a stale checkout). Trailing-whitespace traps: the consolidation-catch anchor has a trailing space after '{' on the logger line AND after 'error.stack'; the line above the loop anchor is 6 spaces + newline (excluded from the anchor). Loop rewire returns boolean: false → `continue` (mirrors the existing dashboard-pause pattern and skips handleClusterCycleSync for iterations where no cycle settled, avoiding duplicate-cycle diff submission). this.sleep exists (orchestrator.js:7972); _getEvents exists (:434); stop() is bounded when shutdownHandler is set (:9367-9384) and the escalation path adds its own unref'd exit backstop in case stop() wedges. VALIDATION: full logic validated in the scratchpad only (11/11 node:test green) against byte-identical copies of the proposed module and prototype methods; no repository file was created or modified by this session (verified via git status — the pre-existing dirty files were untouched). The delivered test additionally pins the wiring via Function.prototype.toString on start()/executeCycle. Suggested follow-up docs (not in scope): update cosmo23/engine/src/core/CLAUDE.md "Timeout Protection" + "Common Pitfalls #3" to say cycle timeouts now act via CycleWatchdog, and add .watchdog.json to the State Files table.
