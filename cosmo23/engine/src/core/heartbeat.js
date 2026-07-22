'use strict';

/**
 * Phase 2 (contract H1) — engine heartbeat.
 *
 * A small JSON file at <logsDir>/.heartbeat, written via tmp+rename:
 *   { ts, pid, cycle, lastCycleStartTs, lastCycleEndTs, phase }
 *
 * Liveness  = `ts` freshness            (event loop alive — interval stamps).
 * Progress  = `lastCycleEndTs` freshness (cycles actually completing).
 *
 * A hung LLM await keeps `ts` fresh while `lastCycleEndTs` goes stale —
 * wedge detection MUST use progress, not liveness.
 *
 * The writer is best-effort by design: stamp()/start()/stop() never throw.
 * Sync fs calls are intentional — the payload is ~200 bytes and tmp+rename
 * keeps readers from ever seeing a torn file.
 */

const fs = require('fs');
const path = require('path');

const HEARTBEAT_FILENAME = '.heartbeat';
const DEFAULT_INTERVAL_MS = 15000;

function heartbeatPath(dir) {
  return path.join(dir, HEARTBEAT_FILENAME);
}

/**
 * Crash-safe-cheap write of a heartbeat payload (tmp + rename). Throws on
 * fs errors — callers that must not throw (HeartbeatWriter.stamp) wrap it.
 */
function writeHeartbeatFile(dir, payload) {
  const target = heartbeatPath(dir);
  const tmp = `${target}.tmp-${payload?.pid || process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, target);
  return target;
}

/**
 * Read the heartbeat file for a run dir. Returns the parsed object, or null
 * when the file is missing, unreadable, or corrupt. Never throws.
 */
function readHeartbeat(dir) {
  if (!dir) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(heartbeatPath(dir), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toEpochMs(value) {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Staleness math for a raw heartbeat payload.
 *   heartbeatAgeMs     — age of `ts` (liveness).
 *   cycleProgressAgeMs — age of `lastCycleEndTs` (progress).
 * Missing/unparseable fields yield null. Ages clamp at 0 (a future
 * timestamp from minor clock skew reads as "fresh", never negative).
 */
function computeHeartbeatAges(heartbeat, nowMs = Date.now()) {
  if (!heartbeat || typeof heartbeat !== 'object') {
    return { heartbeatAgeMs: null, cycleProgressAgeMs: null };
  }
  const tsMs = toEpochMs(heartbeat.ts);
  const endMs = toEpochMs(heartbeat.lastCycleEndTs);
  return {
    heartbeatAgeMs: tsMs === null ? null : Math.max(0, nowMs - tsMs),
    cycleProgressAgeMs: endMs === null ? null : Math.max(0, nowMs - endMs),
  };
}

class HeartbeatWriter {
  constructor(dir, options = {}) {
    this.dir = dir;
    const intervalMs = Number(options.intervalMs);
    this.intervalMs = Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : DEFAULT_INTERVAL_MS;
    this.pid = options.pid || process.pid;
    this.logger = options.logger || null;
    this.timer = null;
    this.state = {
      cycle: 0,
      lastCycleStartTs: null,
      lastCycleEndTs: null,
      phase: null,
    };
    this._everStamped = false;
    this._warned = false;
  }

  /**
   * Stamp once (optionally merging a patch) and start the unref'd interval
   * timer. Idempotent; never throws. The unref means this timer can never
   * hold the process open.
   */
  start(patch = {}) {
    this.stamp(patch);
    if (this.timer) return;
    this.timer = setInterval(() => this.stamp(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /**
   * Clear the interval and write a final stamp (phase defaults to
   * 'stopped'). Idempotent; never throws. Writes nothing if the writer
   * never stamped (so a constructed-but-never-started orchestrator does
   * not create a .heartbeat file).
   */
  stop(finalPhase = 'stopped') {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this._everStamped) {
      this.stamp({ phase: finalPhase });
    }
  }

  /**
   * Merge `patch` ({ cycle, lastCycleStartTs, lastCycleEndTs, phase }) into
   * the in-memory state and write the heartbeat file with a fresh `ts`.
   * Best-effort: returns the payload on success, null on failure. NEVER
   * throws into the cycle.
   *
   * Stale-stamp rejection (O1, Fix 2.2): a watchdog-abandoned cycle's
   * finally block eventually fires a LATE end-stamp. If a newer cycle has
   * already advanced the writer, that late stamp would be indistinguishable
   * from genuine progress — a false-recovery signal for wedge detection. A
   * patch carrying a cycle number OLDER than the writer's current cycle is
   * therefore dropped entirely: the write still happens (fresh `ts` =
   * liveness), but no merged field (cycle/lastCycleEndTs/phase) moves.
   * Patches without a `cycle` field (interval stamps, watchdog phase
   * stamps, stop()) always apply.
   */
  stamp(patch = {}) {
    const patchCycle = Number(patch && patch.cycle);
    const stale = Object.prototype.hasOwnProperty.call(patch || {}, 'cycle')
      && Number.isFinite(patchCycle)
      && Number.isFinite(Number(this.state.cycle))
      && patchCycle < this.state.cycle;
    if (!stale) {
      for (const key of ['cycle', 'lastCycleStartTs', 'lastCycleEndTs', 'phase']) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
          this.state[key] = patch[key];
        }
      }
    }
    const payload = {
      ts: new Date().toISOString(),
      pid: this.pid,
      cycle: this.state.cycle,
      lastCycleStartTs: this.state.lastCycleStartTs,
      lastCycleEndTs: this.state.lastCycleEndTs,
      phase: this.state.phase,
    };
    try {
      writeHeartbeatFile(this.dir, payload);
      this._everStamped = true;
      return payload;
    } catch (error) {
      if (!this._warned) {
        this._warned = true;
        if (this.logger && typeof this.logger.warn === 'function') {
          this.logger.warn('Heartbeat write failed (non-fatal; further failures logged silently)', {
            path: heartbeatPath(this.dir),
            error: error.message,
          });
        }
      }
      return null;
    }
  }
}

module.exports = {
  HEARTBEAT_FILENAME,
  DEFAULT_INTERVAL_MS,
  HeartbeatWriter,
  heartbeatPath,
  writeHeartbeatFile,
  readHeartbeat,
  computeHeartbeatAges,
};
