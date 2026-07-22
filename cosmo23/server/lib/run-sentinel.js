'use strict';

// COSMO23 run sentinel — server-side wedge detection for the active research
// run, with a bounded remediation ladder and explicit escalation.
//
// Signal (heartbeat contract): the engine writes <runDir>/.heartbeat with
//   { ts, pid, cycle, lastCycleStartTs, lastCycleEndTs, phase }.
// Liveness = ts freshness (event loop alive). Progress = lastCycleEndTs
// freshness (cycles completing). A hung LLM await keeps ts fresh while
// lastCycleEndTs goes stale, so wedge detection uses PROGRESS ONLY, never
// liveness.
//
// DIVISION OF LABOR with the engine-side CycleWatchdog (Fix 2.2): a cycle
// that throws INSTANTLY every iteration keeps lastCycleEndTs fresh — progress
// staleness alone cannot see fast-fail loops. That failure class belongs to
// the engine's own watchdog (consecutive-failure circuit breaker, cooloff,
// revive probe, exit-86 escalation). The sentinel's scope is deliberately:
//   1. wedge  — process online, no cycle progress (hung await);
//   2. death  — process gone while a run context is active;
//   3. belt-and-braces — the engine's breaker sits 'open' with its cooloff
//      long past (breakerStuckMs) and no cycle progress since: the engine's
//      self-management failed without escalating, so the sentinel treats it
//      as a wedge.
//
// WATCHDOG HAND-OFF CONTRACT (S1 — future sessions will be tempted; don't):
// the engine watchdog escalates by persisting <runDir>/.watchdog.json with
// restartRequested: true and exiting with code 86. That persisted flag
// SURVIVES the reboot and stays true through a relaunch's residual cooloff —
// it is cleared only by the FIRST SUCCESSFUL CYCLE (recordSuccess). The
// sentinel must therefore NEVER key restart decisions on the persisted
// restartRequested flag (it would restart-loop a run that is recovering
// normally). Key ONLY on live signals: process exit (cosmo-exit /
// processOnline false with an active context) and heartbeat progress
// staleness. Exit code 86 is treated exactly like any other engine death —
// no exit-code special-casing anywhere (a wedged stop() can exit 0 with a
// dirty marker); the context_without_process detection covers every death
// uniformly.
//
// HEARTBEAT PHASE AWARENESS (S3): heartbeat phases 'breaker_cooloff' and
// 'revive_probe' mean the engine is DELIBERATELY not cycling — the watchdog
// is managing its own cooloff and the heartbeat ts stays fresh via interval
// stamps. Cooloff time is not wedge time: the sentinel skips wedge
// accounting for those ticks (the stuck-breaker check above still runs
// first, so a breaker that never leaves cooloff cannot hide behind its own
// phase stamp).
//
// The sentinel only acts while a run is supposed to be active. Ladder state
// is persisted per run in <runDir>/.sentinel.json so server restarts do not
// forget prior attempts. After maxAttempts remediations it escalates: sets a
// wedged flag surfaced through the status contract, logs loudly, and stops
// remediating. Sentinel state is cleaned up when the run ends normally.
//
// Guards: never acts while a launch is in flight, never within
// launchGraceMs of the active run's startedAt, and never re-enters while a
// remediation is already running.

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
// Phase 4 (component 4.5): the server-side park-file contract is owned by
// operator-intents.js — a parked run (<runDir>/.park.json, engine exit 81)
// is deliberately stopped and must never be remediated by the sentinel.
const { readParkFile: defaultReadParkFile } = require('./operator-intents');

const SENTINEL_STATE_FILENAME = '.sentinel.json';
// User-stopped runs archive their ladder state here (evidence is never
// silently deleted): <runDir>/.sentinel.json.last
const SENTINEL_ARCHIVE_SUFFIX = '.last';
const HEARTBEAT_FILENAME = '.heartbeat';
const WATCHDOG_STATE_FILENAME = '.watchdog.json';
const SENTINEL_STATE_VERSION = 1;

// Heartbeat phases stamped by the engine watchdog while it is deliberately
// not cycling (see S3 note above).
const WATCHDOG_PHASES = Object.freeze(new Set(['breaker_cooloff', 'revive_probe']));

const DEFAULT_CONFIG = Object.freeze({
  // How often the sentinel evaluates the active run.
  checkIntervalMs: 60 * 1000,
  // Wedge = engine online but no cycle progress for this long. Flat default:
  // the server does not know the run's cycleTimeoutMs, so this is a
  // config-overridable constant rather than a multiple of it.
  wedgeThresholdMs: 15 * 60 * 1000,
  // No action this soon after a launch (covers boot + first slow cycle).
  launchGraceMs: 5 * 60 * 1000,
  // Remediation attempts per run before escalation.
  maxAttempts: 2,
  // Attempts older than this are pruned when (re)loading persisted state, so
  // an ancient incident cannot poison a fresh run in the same directory.
  attemptTtlMs: 6 * 60 * 60 * 1000,
  // S2 belt-and-braces: an engine breaker still 'open' this long AFTER its
  // own cooloffUntil, with no cycle progress since, is a stuck breaker —
  // treated as a wedge.
  breakerStuckMs: 30 * 60 * 1000,
});

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTimestampMs(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function defaultReadHeartbeat(runPath) {
  try {
    const raw = await fsp.readFile(path.join(runPath, HEARTBEAT_FILENAME), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function defaultReadWatchdog(runPath) {
  try {
    const raw = await fsp.readFile(path.join(runPath, WATCHDOG_STATE_FILENAME), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function defaultReadJsonFile(filePath) {
  try {
    const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Live wedge drill finding (2026-07-22): the sentinel's relaunch must NEVER
// resolve the brain through the catalog. Catalog-backed launchResearch goes
// ensureLocalBrainForLaunch → resolveCatalogBrainBySelector, and the brain
// catalog only lists completed/queryable brains (Patch 69 lifecycle
// authority: COMPLETED plan or committed memory-manifest). A young, mid-run,
// just-killed brain — the sentinel's primary clientele — is in neither state,
// so both live-drill relaunch attempts failed with "Brain not found".
//
// The sentinel already knows the exact run directory, so this factory builds
// a relauncher that constructs the prepared-launch brain object directly from
// the tracked runPath + <runDir>/metadata.json (the camelCase launch settings
// writeRuntimeMetadata persists) and hands it to launchPreparedResearch — the
// same function POST /api/launch ends in. launchResearch's guard semantics
// are mirrored exactly: 409 when a user launch owns the context or the
// isLaunching flag (recorded upstream as a normal failed attempt; the
// pendingRelaunch path self-clears when it next sees an active context), and
// the isLaunching bracket is only set/cleared by a relaunch that passed the
// guard — a losing relaunch must not clobber the user launch's flag.
function createContinuationRelauncher(deps = {}) {
  for (const method of ['getActiveContext', 'getIsLaunching', 'setIsLaunching', 'launchPreparedResearch']) {
    if (typeof deps[method] !== 'function') {
      throw new TypeError(`createContinuationRelauncher requires a ${method}() dependency`);
    }
  }
  const readJsonFile = typeof deps.readJsonFile === 'function' ? deps.readJsonFile : defaultReadJsonFile;

  return async function relaunchFromRunDir({ runPath, runName, brainId } = {}) {
    if (typeof runPath !== 'string' || !runPath) {
      throw new Error('Cannot relaunch — no runPath available');
    }
    if (deps.getActiveContext() || deps.getIsLaunching()) {
      const error = new Error('COSMO is already running — sentinel relaunch yields');
      error.statusCode = 409;
      throw error;
    }
    deps.setIsLaunching(true);
    try {
      const storedSettings = await readJsonFile(path.join(runPath, 'metadata.json'));
      const name = (typeof runName === 'string' && runName) ? runName : path.basename(runPath);
      // Same id convention ensureLocalBrainForLaunch uses for local runs
      // (sha1 of the run path, 16 hex chars) when the tracked id is missing.
      const id = (typeof brainId === 'string' && brainId)
        ? brainId
        : crypto.createHash('sha1').update(runPath).digest('hex').slice(0, 16);
      const brain = {
        id,
        routeKey: id,
        name,
        path: runPath,
        sourceType: 'local',
        sourceLabel: 'Local',
        topic: (storedSettings && typeof storedSettings.topic === 'string' && storedSettings.topic) || name,
        hasState: true, // a relaunch of an existing run dir is a continuation
        cycleCount: 0,
      };
      return await deps.launchPreparedResearch(brain, { ...(storedSettings || {}), brainId: id }, null);
    } finally {
      deps.setIsLaunching(false);
    }
  };
}

class RunSentinel {
  constructor(deps = {}) {
    for (const method of ['getActiveContext', 'getIsLaunching', 'getProcessStatus', 'stopEngine', 'relaunch']) {
      if (typeof deps[method] !== 'function') {
        throw new TypeError(`RunSentinel requires a ${method}() dependency`);
      }
    }
    this.deps = deps;
    this.readHeartbeat = typeof deps.readHeartbeat === 'function' ? deps.readHeartbeat : defaultReadHeartbeat;
    this.readWatchdog = typeof deps.readWatchdog === 'function' ? deps.readWatchdog : defaultReadWatchdog;
    this.readParkFile = typeof deps.readParkFile === 'function' ? deps.readParkFile : defaultReadParkFile;
    this.log = typeof deps.log === 'function' ? deps.log : () => {};
    this.now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    this.config = {
      checkIntervalMs: toPositiveInt(deps.config?.checkIntervalMs, DEFAULT_CONFIG.checkIntervalMs),
      wedgeThresholdMs: toPositiveInt(deps.config?.wedgeThresholdMs, DEFAULT_CONFIG.wedgeThresholdMs),
      launchGraceMs: toPositiveInt(deps.config?.launchGraceMs, DEFAULT_CONFIG.launchGraceMs),
      maxAttempts: toPositiveInt(deps.config?.maxAttempts, DEFAULT_CONFIG.maxAttempts),
      attemptTtlMs: toPositiveInt(deps.config?.attemptTtlMs, DEFAULT_CONFIG.attemptTtlMs),
      breakerStuckMs: toPositiveInt(deps.config?.breakerStuckMs, DEFAULT_CONFIG.breakerStuckMs),
    };
    this.timer = null;
    this.actionInFlight = false;
    this.pendingRelaunch = false;
    this.state = null;   // loaded .sentinel.json contents for the tracked run
    this.tracked = null; // { runPath, runName, brainId }
    this.lastCheck = null;
    this.missingHeartbeatLogged = false;
    this.watchdogPhaseLogged = false;
    this.parkedSkipLogged = false;
    // Epoch ms of the most recent user-initiated stop. USER INTENT IS FINAL:
    // an in-flight remediation re-checks this between its stop and relaunch
    // and aborts if a user stop arrived. Superseded by any launch whose
    // startedAt is newer (see _evaluate).
    this.userStopEpoch = null;
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => {
      this.check().catch((error) => {
        this.log('error', `Sentinel check failed: ${error?.message || error}`);
      });
    }, this.config.checkIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  statePath(runPath) {
    return path.join(runPath, SENTINEL_STATE_FILENAME);
  }

  getPublicState() {
    const state = this.state;
    if (!state) return null;
    const lastAttempt = state.attempts[state.attempts.length - 1] || null;
    return {
      runPath: state.runPath,
      runName: state.runName || null,
      attempts: state.attempts.length,
      maxAttempts: this.config.maxAttempts,
      lastAttemptAt: lastAttempt ? lastAttempt.at : null,
      lastReason: state.lastReason || null,
      escalated: state.escalated === true,
      escalatedAt: state.escalatedAt || null,
      recoveries: state.recoveries || 0,
      pendingRelaunch: this.pendingRelaunch === true,
      lastCheckAt: this.lastCheck ? this.lastCheck.at : null,
      lastOutcome: this.lastCheck ? this.lastCheck.outcome : null,
    };
  }

  // Stamp user-stop intent WITHOUT touching ladder state. /api/stop's ACTIVE
  // branch calls this at the TOP of the branch — BEFORE its awaited stopAll —
  // so a remediation already past its own stopEngine cannot slip a relaunch
  // through the sub-second window before the finally's notifyRunEnded runs.
  // notifyRunEnded (finally) still does the full cleanup + archive.
  recordUserStopIntent() {
    this.userStopEpoch = this.now();
  }

  // The run ended. Two very different callers, two very different contracts:
  //
  // USER-INITIATED (/api/stop, info.userInitiated === true): a user stop is
  // FINAL. Force-clear the ladder — pendingRelaunch, tracked run, in-memory
  // escalated/wedged state — even while a remediation is in flight (the
  // remediation re-checks userStopEpoch between its stop and relaunch and
  // aborts). The on-disk .sentinel.json is archived to .sentinel.json.last,
  // never silently deleted, so escalation evidence survives the stop.
  //
  // NON-USER (cosmo-exit): clean up unless the sentinel itself is
  // mid-remediation (the exit is its own stopEngine) or still owes a
  // relaunch retry.
  async notifyRunEnded(info = {}) {
    try {
      if (info.userInitiated === true) {
        this.userStopEpoch = this.now();
        const runPath = info.runPath || (this.tracked ? this.tracked.runPath : null);
        const hadState = !!this.state;
        this.state = null;
        this.tracked = null;
        this.pendingRelaunch = false;
        this.missingHeartbeatLogged = false;
        this.watchdogPhaseLogged = false;
        if (!runPath) return { cleaned: true, reason: 'user_stop_idle' };
        await this._archiveStateFile(runPath);
        if (hadState) {
          this.log('info',
            `Sentinel: user stop for run "${info.runName || runPath}" — remediation ladder cleared, `
            + `state archived to ${SENTINEL_STATE_FILENAME}${SENTINEL_ARCHIVE_SUFFIX}`);
        }
        return { cleaned: true, reason: 'user_stop' };
      }

      if (this.actionInFlight) return { cleaned: false, reason: 'remediation_in_flight' };
      const runPath = info.runPath || (this.tracked ? this.tracked.runPath : null);
      if (!runPath) return { cleaned: false, reason: 'no_run_path' };
      if (this.pendingRelaunch && this.tracked && this.tracked.runPath === runPath) {
        return { cleaned: false, reason: 'pending_relaunch' };
      }
      await fsp.rm(this.statePath(runPath), { force: true });
      if (this.tracked && this.tracked.runPath === runPath) {
        this.state = null;
        this.tracked = null;
        this.pendingRelaunch = false;
        this.missingHeartbeatLogged = false;
        this.watchdogPhaseLogged = false;
      }
      return { cleaned: true };
    } catch (error) {
      this.log('error', `Sentinel cleanup failed: ${error?.message || error}`);
      return { cleaned: false, reason: 'cleanup_error' };
    }
  }

  async _archiveStateFile(runPath) {
    const src = this.statePath(runPath);
    try {
      await fsp.rename(src, `${src}${SENTINEL_ARCHIVE_SUFFIX}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.log('error', `Sentinel state archive failed: ${error?.message || error}`);
      }
    }
  }

  async loadStateFor(context) {
    const identity = {
      runPath: context.runPath,
      runName: context.runName || null,
      brainId: context.brainId || null,
    };
    if (this.state && this.state.runPath === identity.runPath) {
      if (identity.runName) this.state.runName = identity.runName;
      if (identity.brainId) this.state.brainId = identity.brainId;
      this.tracked = { runPath: identity.runPath, runName: this.state.runName, brainId: this.state.brainId };
      return this.state;
    }

    let onDisk = null;
    try {
      const parsed = JSON.parse(await fsp.readFile(this.statePath(identity.runPath), 'utf8'));
      if (parsed && parsed.runPath === identity.runPath && Array.isArray(parsed.attempts)) {
        onDisk = parsed;
      }
    } catch {
      onDisk = null;
    }

    if (onDisk) {
      const now = this.now();
      onDisk.attempts = onDisk.attempts.filter((entry) => {
        const atMs = parseTimestampMs(entry ? entry.at : null);
        return atMs !== null && now - atMs <= this.config.attemptTtlMs;
      });
      // Fresh-launch amnesty (I2): a NEW launch — startedAt after the last
      // recorded attempt/escalation — must not wear the previous run's ladder
      // or wedged flag; a real wedge then gets a fresh bounded ladder. This
      // only applies on DISK loads: the sentinel's own relaunches keep the
      // in-memory state (loadStateFor early-returns above), so the ladder
      // stays bounded across remediations.
      const launchMs = parseTimestampMs(context.startedAt);
      const lastAttemptEntry = onDisk.attempts[onDisk.attempts.length - 1] || null;
      const ladderMarkerMs = Math.max(
        parseTimestampMs(lastAttemptEntry ? lastAttemptEntry.at : null) ?? 0,
        parseTimestampMs(onDisk.escalatedAt) ?? 0,
      );
      if (launchMs !== null && ladderMarkerMs > 0 && launchMs > ladderMarkerMs) {
        onDisk.attempts = [];
        onDisk.escalated = false;
        onDisk.escalatedAt = null;
      }
      if (onDisk.attempts.length === 0 && onDisk.escalated) {
        onDisk.escalated = false;
        onDisk.escalatedAt = null;
      }
      this.state = { ...onDisk, ...identity, version: SENTINEL_STATE_VERSION };
    } else {
      this.state = {
        version: SENTINEL_STATE_VERSION,
        ...identity,
        attempts: [],
        recoveries: 0,
        escalated: false,
        escalatedAt: null,
        lastReason: null,
        updatedAt: null,
      };
    }
    this.tracked = { ...identity };
    this.missingHeartbeatLogged = false;
    return this.state;
  }

  async persistStateSafe() {
    if (!this.state || !this.state.runPath) return;
    try {
      this.state.updatedAt = new Date(this.now()).toISOString();
      const target = this.statePath(this.state.runPath);
      const tmp = `${target}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      await fsp.rename(tmp, target);
    } catch (error) {
      this.log('error', `Sentinel state persist failed: ${error?.message || error}`);
    }
  }

  async check() {
    const result = await this._evaluate();
    this.lastCheck = {
      at: new Date(this.now()).toISOString(),
      outcome: result.outcome,
      reason: result.reason || null,
    };
    return result;
  }

  async _evaluate() {
    if (this.actionInFlight) return { outcome: 'skipped', reason: 'action_in_flight' };
    if (this.deps.getIsLaunching()) return { outcome: 'skipped', reason: 'launching' };

    const context = this.deps.getActiveContext();
    if (!context || !context.runPath) {
      if (this.pendingRelaunch && this.tracked && this.state) {
        // Phase 4 (R2): a park that lands while a relaunch retry is pending
        // cancels the retry — parked runs resume only by operator intent
        // (POST /api/resume), never by the sentinel.
        const retryPark = await this.readParkFile(this.tracked.runPath);
        if (retryPark) {
          this.pendingRelaunch = false;
          this.log('info',
            `Sentinel: run "${this.tracked.runName}" is parked — pending relaunch retry cancelled`);
          return { outcome: 'parked', reason: 'run_parked' };
        }
        return this._remediate(
          { runPath: this.tracked.runPath, runName: this.tracked.runName, brainId: this.tracked.brainId },
          'relaunch_retry',
          `previous sentinel relaunch of run "${this.tracked.runName}" did not succeed — retrying`,
          { skipStop: true },
        );
      }
      return { outcome: 'idle', reason: 'no_active_run' };
    }
    this.pendingRelaunch = false;

    const now = this.now();

    // A launch newer than the last user stop supersedes it — the stop was
    // aimed at the previous run, not this one.
    if (this.userStopEpoch !== null) {
      const launchedMs = parseTimestampMs(context.startedAt);
      if (launchedMs !== null && launchedMs > this.userStopEpoch) {
        this.userStopEpoch = null;
      }
    }

    const state = await this.loadStateFor(context);

    // Phase 4 (R2): <runDir>/.park.json means the engine parked itself —
    // graceful pause with resumable state (guarded save, exit code 81). A
    // parked run is deliberately stopped: NOT wedged, NOT a crash. Every
    // remediation below (context_without_process death, progress-stale
    // wedge) must stand down, or the sentinel would resurrect a run that
    // governance chose to pause. Resume goes through POST /api/resume only.
    const park = await this.readParkFile(context.runPath);
    if (park) {
      if (!this.parkedSkipLogged) {
        this.parkedSkipLogged = true;
        this.log('info',
          `Sentinel: run "${context.runName}" is parked (${park.reason || 'no reason recorded'}) — `
          + 'skipping wedge/death remediation until it is resumed');
      }
      return { outcome: 'parked', reason: 'run_parked' };
    }
    this.parkedSkipLogged = false;

    const startedAtMs = parseTimestampMs(context.startedAt);
    if (startedAtMs !== null && now - startedAtMs < this.config.launchGraceMs) {
      return { outcome: 'skipped', reason: 'launch_grace' };
    }

    const processStatus = this.deps.getProcessStatus();
    const processOnline = Array.isArray(processStatus?.running)
      && processStatus.running.some((proc) => proc?.name === 'cosmo-main');

    if (!processOnline) {
      // S1: every engine death lands here — exit 86 (watchdog escalation),
      // exit 0 with a dirty marker, SIGKILL — no exit-code special-casing.
      return this._remediate(context, 'engine_process_died',
        `engine child is gone while run "${context.runName}" is still active (context_without_process)`);
    }

    const heartbeat = await this.readHeartbeat(context.runPath);
    if (!heartbeat || typeof heartbeat !== 'object') {
      if (!this.missingHeartbeatLogged) {
        this.missingHeartbeatLogged = true;
        this.log('info',
          `Sentinel: no heartbeat file for run "${context.runName}" yet — monitoring without a progress signal`);
      }
      return { outcome: 'skipped', reason: 'no_heartbeat' };
    }

    // S2 belt-and-braces: the engine's own breaker got stuck 'open' — its
    // cooloff expired more than breakerStuckMs ago with no cycle progress
    // since — and it never escalated. Runs BEFORE the S3 phase skip so a
    // stuck breaker cannot hide behind its own 'breaker_cooloff' stamp.
    // NOTE (S1): this reads .watchdog.json for state/cooloffUntil only —
    // never restartRequested (that flag legitimately survives a relaunch).
    const watchdog = await this.readWatchdog(context.runPath);
    const cooloffUntilRaw = Number(watchdog?.cooloffUntil);
    const cooloffUntilMs = Number.isFinite(cooloffUntilRaw) && cooloffUntilRaw > 0 ? cooloffUntilRaw : null;
    const lastCycleEndForBreakerMs = parseTimestampMs(heartbeat.lastCycleEndTs);
    if (
      watchdog?.state === 'open'
      && cooloffUntilMs !== null
      && now - cooloffUntilMs > this.config.breakerStuckMs
      && (lastCycleEndForBreakerMs === null || lastCycleEndForBreakerMs <= cooloffUntilMs)
    ) {
      return this._remediate(context, 'watchdog_breaker_stuck',
        `run "${context.runName}" engine breaker has been open ${Math.round((now - cooloffUntilMs) / 60000)}m `
        + `past its own cooloff with no cycle progress since (threshold ${Math.round(this.config.breakerStuckMs / 60000)}m) `
        + '— the engine\'s self-management is stuck');
    }

    // S3: watchdog phases mean the engine is deliberately not cycling —
    // cooloff time is not wedge time.
    if (typeof heartbeat.phase === 'string' && WATCHDOG_PHASES.has(heartbeat.phase)) {
      if (!this.watchdogPhaseLogged) {
        this.watchdogPhaseLogged = true;
        this.log('debug',
          `Sentinel: run "${context.runName}" heartbeat phase is "${heartbeat.phase}" — `
          + 'engine is managing its own cooloff, skipping wedge accounting');
      }
      return { outcome: 'skipped', reason: 'watchdog_phase' };
    }
    this.watchdogPhaseLogged = false;

    const progressMs = parseTimestampMs(heartbeat.lastCycleEndTs)
      ?? parseTimestampMs(heartbeat.lastCycleStartTs)
      ?? startedAtMs;
    if (progressMs === null) return { outcome: 'skipped', reason: 'no_progress_baseline' };

    const progressAgeMs = now - progressMs;
    if (progressAgeMs > this.config.wedgeThresholdMs) {
      return this._remediate(context, 'wedged_no_cycle_progress',
        `run "${context.runName}" engine is online but has made no cycle progress for `
        + `${Math.round(progressAgeMs / 60000)}m (threshold ${Math.round(this.config.wedgeThresholdMs / 60000)}m)`,
        { progressAgeMs });
    }

    // Healthy. A completed cycle after the last remediation attempt means the
    // remediation worked — reset the ladder so a later, unrelated incident
    // gets a fresh bounded ladder.
    if (state.attempts.length > 0 || state.escalated) {
      const lastAttempt = state.attempts[state.attempts.length - 1] || null;
      const lastAttemptMs = parseTimestampMs(lastAttempt ? lastAttempt.at : null) ?? 0;
      const lastCycleEndMs = parseTimestampMs(heartbeat.lastCycleEndTs);
      if (lastCycleEndMs !== null && lastCycleEndMs > lastAttemptMs) {
        state.attempts = [];
        state.escalated = false;
        state.escalatedAt = null;
        state.recoveries = (state.recoveries || 0) + 1;
        await this.persistStateSafe();
        this.log('info',
          `Sentinel: run "${context.runName}" recovered (fresh completed cycle) — remediation ladder reset`);
      }
    }
    return { outcome: 'healthy', reason: null };
  }

  async _remediate(context, reason, description, opts = {}) {
    const state = this.state;
    if (!state) return { outcome: 'skipped', reason: 'no_state' };
    if (state.escalated) return { outcome: 'escalated', reason: state.lastReason || reason };

    state.lastReason = reason;

    if (state.attempts.length >= this.config.maxAttempts) {
      state.escalated = true;
      state.escalatedAt = new Date(this.now()).toISOString();
      this.pendingRelaunch = false;
      await this.persistStateSafe();
      this.log('error',
        `SENTINEL ESCALATION: ${description}. `
        + `${state.attempts.length}/${this.config.maxAttempts} remediation attempts are exhausted — `
        + 'flagging the run as wedged and stopping automatic restarts. Manual intervention required.');
      return { outcome: 'escalated', reason };
    }

    const attemptNumber = state.attempts.length + 1;
    const attemptStartMs = this.now();
    const attempt = {
      at: new Date(attemptStartMs).toISOString(),
      reason,
      progressAgeMs: Number.isFinite(opts.progressAgeMs) ? opts.progressAgeMs : null,
      ok: false,
      error: null,
    };
    state.attempts.push(attempt);
    // Record intent BEFORE acting — a crash mid-remediation must not forget
    // that an attempt was spent.
    await this.persistStateSafe();

    this.log('error',
      `Sentinel remediation ${attemptNumber}/${this.config.maxAttempts}: ${description} — `
      + `restarting engine for run "${context.runName}"`);

    this.actionInFlight = true;
    this.pendingRelaunch = true;
    try {
      if (opts.skipStop !== true) {
        await this.deps.stopEngine({ runPath: context.runPath, runName: context.runName, reason });
      }
      // USER INTENT IS FINAL (I1): if a user stop arrived while this attempt
      // was in flight (notifyRunEnded already force-cleared the ladder and
      // archived the state file), the relaunch would resurrect a run the
      // user killed. Abort — no relaunch, no retry. `>=` on purpose: a stop
      // in the same millisecond as the attempt start still wins the tie.
      if (this.userStopEpoch !== null && this.userStopEpoch >= attemptStartMs) {
        attempt.error = 'aborted_user_stop';
        this.pendingRelaunch = false;
        this.log('info',
          `Sentinel remediation ${attemptNumber}/${this.config.maxAttempts} aborted — `
          + `user stop arrived during remediation of run "${context.runName}"`);
        return { outcome: 'aborted_user_stop', reason, attempt: attemptNumber };
      }
      await this.deps.relaunch({
        runPath: context.runPath,
        runName: context.runName,
        brainId: context.brainId || null,
        reason,
        attempt: attemptNumber,
      });
      // USER INTENT IS FINAL, part 2 (Task 7 polish): a stop that lands while
      // relaunch() itself is resolving misses the pre-relaunch check above —
      // the fresh child is already up by the time we see the epoch. Kill it.
      if (this.userStopEpoch !== null && this.userStopEpoch >= attemptStartMs) {
        attempt.error = 'aborted_user_stop_late';
        this.pendingRelaunch = false;
        try {
          await this.deps.stopEngine({
            runPath: context.runPath,
            runName: context.runName,
            reason: 'user_stop_during_relaunch',
          });
        } catch (stopError) {
          this.log('error',
            `Sentinel late-abort stop failed for run "${context.runName}": ${stopError?.message || stopError}`);
        }
        this.log('info',
          `Sentinel remediation ${attemptNumber}/${this.config.maxAttempts} aborted late — `
          + `user stop arrived during the relaunch of run "${context.runName}"; fresh run stopped`);
        return { outcome: 'aborted_user_stop_late', reason, attempt: attemptNumber };
      }
      attempt.ok = true;
      this.pendingRelaunch = false;
      this.log('info',
        `Sentinel remediation ${attemptNumber}/${this.config.maxAttempts} relaunched run "${context.runName}"`);
      return { outcome: 'remediated', reason, attempt: attemptNumber };
    } catch (error) {
      attempt.error = error?.message || String(error);
      this.log('error',
        `Sentinel remediation ${attemptNumber}/${this.config.maxAttempts} failed for run "${context.runName}": ${attempt.error}`);
      return { outcome: 'remediation_failed', reason, attempt: attemptNumber };
    } finally {
      this.actionInFlight = false;
      await this.persistStateSafe();
    }
  }
}

function createRunSentinel(deps) {
  return new RunSentinel(deps);
}

module.exports = {
  RunSentinel,
  createRunSentinel,
  createContinuationRelauncher,
  DEFAULT_CONFIG,
  SENTINEL_STATE_FILENAME,
  SENTINEL_ARCHIVE_SUFFIX,
  HEARTBEAT_FILENAME,
  WATCHDOG_STATE_FILENAME,
};
