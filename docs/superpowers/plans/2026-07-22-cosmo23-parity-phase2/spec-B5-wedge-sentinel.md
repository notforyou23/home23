# Fix 2.5 — server-side wedge detection → bounded remediation → escalation (cosmo23/server run sentinel + status-contract wedged/sentinel fields)

## Target current state

1) No wedge detection exists anywhere server-side. `cosmo23/server/lib/status-contract.js:37` has the permanently-null heartbeat field (Patch 9): `    lastHeartbeat: null,` — the server never reads any run heartbeat and has no wedged concept.

2) The only run-death handling is the passive cosmo-exit listener, `cosmo23/server/index.js:342-349`:
```js
processManager.on('cosmo-exit', ({ code, signal }) => {
  if (activeContext) {
    const runName = activeContext.runName;
    activeContext = null;
    processManager.recordLog('Launcher', 'info',
      `Run "${runName}" ended (code: ${code}, signal: ${signal || 'none'}) — cleared activeContext`);
  }
});
```
It only clears context; nothing observes a live-but-stuck engine (process online, no cycle progress), and nothing relaunches a dead one.

3) The continuation path exists but is only caller-driven: `cosmo23/server/index.js:1013-1027` `launchResearch(payload, req)` (409 guard on `activeContext || isLaunching`, then `ensureLocalBrainForLaunch` resolves `payload.brainId` and `launchPreparedResearch` restarts MCP/dashboard/engine and sets a fresh `activeContext` with new `startedAt` — index.js:985-995). No automatic caller exists.

4) `cosmo23/launcher/process-manager.js` has no engine-only stop; `stopAll()` (line 494) is the scoped child shutdown (SIGINT → up to 3-min wait → SIGKILL, then SIGTERM support processes, then killPort on tracked usedPorts only — no pkill). `getStatus()` (line 617) reports `running: [{name:'cosmo-main',...}]`. Both are sufficient as-is; no process-manager changes needed.

5) Engine heartbeat (H1) has NOT landed in the current tree: `grep -n "heartbeat\|lastCycleEndTs" cosmo23/engine/src/core/orchestrator.js` returns nothing as of this reading (orchestrator.js is being modified by a concurrent session). Engine `logsDir` IS the run dir (`cosmo23/engine/src/index.js:346` `config.logsDir = runtimeRoot`), so `<logsDir>/.heartbeat` == `<activeContext.runPath>/.heartbeat`.

6) `/api/status` flattens health fields at `cosmo23/server/index.js:2059` (`    lastHeartbeat: health.lastHeartbeat,`) — no wedged surface. Sentinel test file `tests/cosmo23/run-sentinel.test.cjs` and module `cosmo23/server/lib/run-sentinel.js` do not exist (verified), and `grep -c run-sentinel` is 0 in package.json, the registration test, index.js, and status-contract.js.

## CHANGE: cosmo23/server/lib/run-sentinel.js

NEW FILE — RunSentinel: interval monitor (unref'd, default 60s) active only while a run exists. Wedge = engine child online AND heartbeat progress (lastCycleEndTs → lastCycleStartTs → context.startedAt) older than wedgeThresholdMs (flat 15min default, config-overridable). Dead engine (processOnline false, context active) enters the same ladder. Guards: actionInFlight, isLaunching, 5-min launch grace (re-applies automatically after each relaunch because launchPreparedResearch stamps a fresh startedAt), missing heartbeat = no-signal skip. Ladder persisted in <runDir>/.sentinel.json (tmp+rename, attempt recorded BEFORE acting, 6h TTL prune on load). K attempts (default 2) of stopEngine+relaunch; failed relaunch continues on later ticks via pendingRelaunch without a second stop; after K → escalate (persisted escalated flag, one loud error log, no further action). Fresh completed cycle after the last attempt resets the ladder. notifyRunEnded cleans state unless remediation in flight / relaunch pending. All side effects injected (getActiveContext, getIsLaunching, getProcessStatus, stopEngine, relaunch, readHeartbeat, log, now) for real-behavior tests.

### Code
```js
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
// The sentinel only acts while a run is supposed to be active. Ladder state
// is persisted per run in <runDir>/.sentinel.json so server restarts do not
// forget prior attempts. After maxAttempts remediations it escalates: sets a
// wedged flag surfaced through the status contract, logs loudly, and stops
// remediating. Sentinel state is cleaned up when the run ends normally.
//
// Guards: never acts while a launch is in flight, never within
// launchGraceMs of the active run's startedAt, and never re-enters while a
// remediation is already running.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const SENTINEL_STATE_FILENAME = '.sentinel.json';
const HEARTBEAT_FILENAME = '.heartbeat';
const SENTINEL_STATE_VERSION = 1;

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

class RunSentinel {
  constructor(deps = {}) {
    for (const method of ['getActiveContext', 'getIsLaunching', 'getProcessStatus', 'stopEngine', 'relaunch']) {
      if (typeof deps[method] !== 'function') {
        throw new TypeError(`RunSentinel requires a ${method}() dependency`);
      }
    }
    this.deps = deps;
    this.readHeartbeat = typeof deps.readHeartbeat === 'function' ? deps.readHeartbeat : defaultReadHeartbeat;
    this.log = typeof deps.log === 'function' ? deps.log : () => {};
    this.now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    this.config = {
      checkIntervalMs: toPositiveInt(deps.config?.checkIntervalMs, DEFAULT_CONFIG.checkIntervalMs),
      wedgeThresholdMs: toPositiveInt(deps.config?.wedgeThresholdMs, DEFAULT_CONFIG.wedgeThresholdMs),
      launchGraceMs: toPositiveInt(deps.config?.launchGraceMs, DEFAULT_CONFIG.launchGraceMs),
      maxAttempts: toPositiveInt(deps.config?.maxAttempts, DEFAULT_CONFIG.maxAttempts),
      attemptTtlMs: toPositiveInt(deps.config?.attemptTtlMs, DEFAULT_CONFIG.attemptTtlMs),
    };
    this.timer = null;
    this.actionInFlight = false;
    this.pendingRelaunch = false;
    this.state = null;   // loaded .sentinel.json contents for the tracked run
    this.tracked = null; // { runPath, runName, brainId }
    this.lastCheck = null;
    this.missingHeartbeatLogged = false;
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

  // The run ended (cosmo-exit or /api/stop). Clean up sentinel state unless
  // the sentinel itself is mid-remediation or still owes a relaunch retry.
  async notifyRunEnded(info = {}) {
    try {
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
      }
      return { cleaned: true };
    } catch (error) {
      this.log('error', `Sentinel cleanup failed: ${error?.message || error}`);
      return { cleaned: false, reason: 'cleanup_error' };
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
    const state = await this.loadStateFor(context);

    const startedAtMs = parseTimestampMs(context.startedAt);
    if (startedAtMs !== null && now - startedAtMs < this.config.launchGraceMs) {
      return { outcome: 'skipped', reason: 'launch_grace' };
    }

    const processStatus = this.deps.getProcessStatus();
    const processOnline = Array.isArray(processStatus?.running)
      && processStatus.running.some((proc) => proc?.name === 'cosmo-main');

    if (!processOnline) {
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
    const attempt = {
      at: new Date(this.now()).toISOString(),
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
      await this.deps.relaunch({
        runPath: context.runPath,
        runName: context.runName,
        brainId: context.brainId || null,
        reason,
        attempt: attemptNumber,
      });
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
  DEFAULT_CONFIG,
  SENTINEL_STATE_FILENAME,
  HEARTBEAT_FILENAME,
};

```

## CHANGE: cosmo23/server/lib/status-contract.js

Add optional `sentinel` input to buildStatusContract (additive param, default null). Anchor is the params block; grep-verified unique (`  runTruth = {},` occurs once).

### Anchor
```
  isLaunching = false,
  ports = {},
  runTruth = {},
```

### Code
```js
  isLaunching = false,
  ports = {},
  runTruth = {},
  sentinel = null,
```

## CHANGE: cosmo23/server/lib/status-contract.js

Expose `wedged` boolean + `sentinel` detail object in the contract output. Compat-safe per Patch 9: fields are ADDED, `lifecycle` keeps its original value set. Deliberately anchored on the hasActiveContext/isLaunching pair (each unique at this indent) and NOT on the `lastHeartbeat: null,` line, so the H2 fix (which rewrites that line) applies without anchor collision.

### Anchor
```
    hasActiveContext,
    isLaunching,
```

### Code
```js
    hasActiveContext,
    isLaunching,
    // Sentinel fields are additive (Patch 9 compat rules): `lifecycle` keeps
    // its original value set; a wedged run is flagged in parallel.
    wedged: sentinel?.escalated === true,
    sentinel: sentinel || null,
```

## CHANGE: cosmo23/server/index.js

Require the sentinel factory. Anchor line 105, unique.

### Anchor
```
const { buildStatusContract } = require('./lib/status-contract');
```

### Code
```js
const { buildStatusContract } = require('./lib/status-contract');
const { createRunSentinel } = require('./lib/run-sentinel');
```

## CHANGE: cosmo23/server/index.js

Create the sentinel and wire run-ended cleanup, replacing the whole cosmo-exit block (index.js:342-349, anchor unique). Placement matters: after `processManager` (line 190) and `initialConfig` (line 153); `launchResearch`, `readJsonFileIfPresent`, `parsePositiveInt` are hoisted function declarations so forward references are safe. stopEngine mirrors /api/stop (stopAll + clear activeContext); relaunch replays the run's own <runDir>/metadata.json (camelCase launch settings written by writeRuntimeMetadata) + brainId through the internal launchResearch — the live-proved /api/launch continuation path — never HTTP, never pkill. Config precedence: COSMO23_SENTINEL_* env > ~/.cosmo2.3/config.json `sentinel` block (initialConfig.config — loadConfigurationSync returns { config, source } in ALL branches) > defaults.

### Anchor
```
processManager.on('cosmo-exit', ({ code, signal }) => {
  if (activeContext) {
    const runName = activeContext.runName;
    activeContext = null;
    processManager.recordLog('Launcher', 'info',
      `Run "${runName}" ended (code: ${code}, signal: ${signal || 'none'}) — cleared activeContext`);
  }
});
```

### Code
```js
// Fix 2.5 — server-side wedge detection → bounded remediation → escalation.
// The sentinel watches the active run's <runDir>/.heartbeat progress signal
// (lastCycleEndTs — progress, never liveness ts), kills+relaunches a wedged
// or dead engine through the same internal continuation path POST /api/launch
// uses (launchResearch with brainId), and escalates through the status
// contract (health.wedged / health.sentinel) after bounded attempts. Ladder
// state persists in <runDir>/.sentinel.json.
const sentinelSettings = initialConfig?.config?.sentinel || {};
const runSentinel = createRunSentinel({
  getActiveContext: () => activeContext,
  getIsLaunching: () => isLaunching,
  getProcessStatus: () => processManager.getStatus(),
  stopEngine: async () => {
    // ProcessManager has no engine-only stop; stopAll() is the scoped child
    // shutdown (SIGINT → bounded wait → SIGKILL, tracked ports only) and the
    // relaunch restarts MCP/dashboard/engine anyway.
    await processManager.stopAll();
    activeContext = null; // mirror /api/stop's finally
  },
  relaunch: async ({ runPath, runName, brainId }) => {
    if (!brainId) {
      throw new Error(`Cannot relaunch run "${runName}" — no brainId available`);
    }
    const storedSettings = await readJsonFileIfPresent(path.join(runPath, 'metadata.json'));
    return launchResearch({ ...(storedSettings || {}), brainId }, null);
  },
  log: (level, message) => processManager.recordLog('Sentinel', level, message),
  config: {
    checkIntervalMs: parsePositiveInt(process.env.COSMO23_SENTINEL_CHECK_INTERVAL_MS,
      parsePositiveInt(sentinelSettings.checkIntervalMs, 60 * 1000)),
    wedgeThresholdMs: parsePositiveInt(process.env.COSMO23_SENTINEL_WEDGE_THRESHOLD_MS,
      parsePositiveInt(sentinelSettings.wedgeThresholdMs, 15 * 60 * 1000)),
    launchGraceMs: parsePositiveInt(process.env.COSMO23_SENTINEL_LAUNCH_GRACE_MS,
      parsePositiveInt(sentinelSettings.launchGraceMs, 5 * 60 * 1000)),
    maxAttempts: parsePositiveInt(process.env.COSMO23_SENTINEL_MAX_ATTEMPTS,
      parsePositiveInt(sentinelSettings.maxAttempts, 2)),
    attemptTtlMs: parsePositiveInt(process.env.COSMO23_SENTINEL_ATTEMPT_TTL_MS,
      parsePositiveInt(sentinelSettings.attemptTtlMs, 6 * 60 * 60 * 1000)),
  },
});

processManager.on('cosmo-exit', ({ code, signal }) => {
  if (activeContext) {
    const runName = activeContext.runName;
    const runPath = activeContext.runPath;
    activeContext = null;
    processManager.recordLog('Launcher', 'info',
      `Run "${runName}" ended (code: ${code}, signal: ${signal || 'none'}) — cleared activeContext`);
    // Run completion cleans up sentinel state; the sentinel keeps it when the
    // exit was its own remediation stop.
    runSentinel.notifyRunEnded({ runPath, runName }).catch(() => {});
  }
});
```

## CHANGE: cosmo23/server/index.js

/api/health: feed sentinel state into the contract. Anchor is the 2-space-indent call WITHOUT runTruth followed by the ports line — grep-verified to match only the /api/health site (the /api/status call has a runTruth line; the /api/watch/logs call is 4-space indented).

### Anchor
```
  const health = buildStatusContract({
    activeContext,
    processStatus,
    isLaunching,
    ports: { app: PORT, websocket: WS_PORT, dashboard: DASHBOARD_PORT, mcpHttp: MCP_HTTP_PORT },
  });
  res.json({
    success: true,
    name: 'cosmo-2.3',
```

### Code
```js
  const health = buildStatusContract({
    activeContext,
    processStatus,
    isLaunching,
    sentinel: runSentinel.getPublicState(),
    ports: { app: PORT, websocket: WS_PORT, dashboard: DASHBOARD_PORT, mcpHttp: MCP_HTTP_PORT },
  });
  res.json({
    success: true,
    name: 'cosmo-2.3',
```

## CHANGE: cosmo23/server/index.js

/api/status: feed sentinel state into the contract. Anchor uses the runTruth line, unique to this call site.

### Anchor
```
    isLaunching,
    runTruth,
    ports: { app: PORT, websocket: WS_PORT, dashboard: DASHBOARD_PORT, mcpHttp: MCP_HTTP_PORT },
```

### Code
```js
    isLaunching,
    runTruth,
    sentinel: runSentinel.getPublicState(),
    ports: { app: PORT, websocket: WS_PORT, dashboard: DASHBOARD_PORT, mcpHttp: MCP_HTTP_PORT },
```

## CHANGE: cosmo23/server/index.js

/api/status flattened response: expose wedged next to the other flattened health fields (index.js:2059, anchor unique).

### Anchor
```
    lastHeartbeat: health.lastHeartbeat,
```

### Code
```js
    lastHeartbeat: health.lastHeartbeat,
    wedged: health.wedged,
```

## CHANGE: cosmo23/server/index.js

/api/watch/logs: feed sentinel state into the contract. Anchor is the 4-space-indent variant, unique (verified: `      isLaunching,\n      ports:` occurs once).

### Anchor
```
      activeContext,
      processStatus,
      isLaunching,
      ports: { app: PORT, websocket: WS_PORT, dashboard: DASHBOARD_PORT, mcpHttp: MCP_HTTP_PORT },
```

### Code
```js
      activeContext,
      processStatus,
      isLaunching,
      sentinel: runSentinel.getPublicState(),
      ports: { app: PORT, websocket: WS_PORT, dashboard: DASHBOARD_PORT, mcpHttp: MCP_HTTP_PORT },
```

## CHANGE: cosmo23/server/index.js

Start the sentinel with the server (interval is unref'd; ticks are no-ops while idle). Anchor is the last startServer log line, unique.

### Anchor
```
    console.log(`[cosmo_2.3] run metadata repair: ${repairSummary.repaired}/${repairSummary.scanned} repaired`);
```

### Code
```js
    console.log(`[cosmo_2.3] run metadata repair: ${repairSummary.repaired}/${repairSummary.scanned} repaired`);
    runSentinel.start();
    console.log(`[cosmo_2.3] run sentinel active (check ${runSentinel.config.checkIntervalMs}ms, wedge threshold ${runSentinel.config.wedgeThresholdMs}ms, max attempts ${runSentinel.config.maxAttempts})`);
```

## CHANGE: cosmo23/server/index.js

Stop the sentinel during main-process shutdown, before the worker stops. Anchor unique.

### Anchor
```
      await brainOperationRuntime?.worker?.stop?.();
```

### Code
```js
      runSentinel.stop();
      await brainOperationRuntime?.worker?.stop?.();
```

## CHANGE: cosmo23/server/index.js

Export the sentinel instance for observability/integration tests. Anchor is the full module.exports block, unique.

### Anchor
```
module.exports = {
  initializeProtectedBrainOperations,
  installMainProcessShutdown,
  launchPreparedResearch,
  registerBrainOperationWorkerRoutes,
  startServer,
};
```

### Code
```js
module.exports = {
  initializeProtectedBrainOperations,
  installMainProcessShutdown,
  launchPreparedResearch,
  registerBrainOperationWorkerRoutes,
  runSentinel,
  startServer,
};
```

## CHANGE: package.json

Register the new suite exactly once in the cosmo23 block of the "test" script chain. Anchor is a substring INSIDE the single very long "test" script line (no newlines) — grep-verified unique in the current tree, but this file is being modified by concurrent sessions, so re-run `grep -cF` on the anchor immediately before applying.

### Anchor
```
tests/cosmo23/graceful-shutdown-honesty.test.cjs tests/cosmo23/research-run-operation-adapter.test.cjs
```

### Code
```js
tests/cosmo23/graceful-shutdown-honesty.test.cjs tests/cosmo23/run-sentinel.test.cjs tests/cosmo23/research-run-operation-adapter.test.cjs
```

## CHANGE: tests/cosmo23/package-test-registration.test.cjs

Add the new suite to the exactly-once registration list (alphabetical-ish slot after research-memory-manifest). Anchor unique; file is concurrently modified — re-grep before applying.

### Anchor
```
    'tests/cosmo23/research-memory-manifest.test.cjs',
```

### Code
```js
    'tests/cosmo23/research-memory-manifest.test.cjs',
    'tests/cosmo23/run-sentinel.test.cjs',
```

## TEST FILE: tests/cosmo23/run-sentinel.test.cjs

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createRunSentinel,
  SENTINEL_STATE_FILENAME,
} = require('../../cosmo23/server/lib/run-sentinel');
const { buildStatusContract } = require('../../cosmo23/server/lib/status-contract');

const MINUTE = 60 * 1000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function makeFixture(t, overrides = {}) {
  const runPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo23-run-sentinel-'));
  t.after(() => fs.rm(runPath, { recursive: true, force: true }));

  const fixture = {
    runPath,
    nowMs: Date.parse('2026-07-22T12:00:00.000Z'),
    activeContext: {
      runName: 'labor23',
      runPath,
      brainId: 'brain-abc123',
      topic: 'labor',
      startedAt: '2026-07-22T11:00:00.000Z', // 60m before nowMs — past grace
    },
    isLaunching: false,
    processRunning: [{ name: 'cosmo-main', pid: 4242, killed: false }],
    heartbeat: {
      ts: '2026-07-22T11:59:50.000Z',
      pid: 4242,
      cycle: 12,
      lastCycleStartTs: '2026-07-22T11:58:00.000Z',
      lastCycleEndTs: '2026-07-22T11:59:00.000Z',
      phase: 'integration',
    },
    stopCalls: [],
    relaunchCalls: [],
    logs: [],
    stopImpl: null,
    relaunchImpl: null,
  };

  const config = {
    checkIntervalMs: MINUTE,
    wedgeThresholdMs: 15 * MINUTE,
    launchGraceMs: 5 * MINUTE,
    maxAttempts: 2,
    ...overrides.config,
  };

  fixture.sentinel = createRunSentinel({
    getActiveContext: () => fixture.activeContext,
    getIsLaunching: () => fixture.isLaunching,
    getProcessStatus: () => ({ running: fixture.processRunning, count: fixture.processRunning.length }),
    readHeartbeat: async () => fixture.heartbeat,
    stopEngine: async (info) => {
      fixture.stopCalls.push(info);
      if (fixture.stopImpl) return fixture.stopImpl(info);
      fixture.activeContext = null;
      fixture.processRunning = [];
      return undefined;
    },
    relaunch: async (info) => {
      fixture.relaunchCalls.push(info);
      if (fixture.relaunchImpl) return fixture.relaunchImpl(info);
      fixture.activeContext = {
        runName: info.runName,
        runPath: info.runPath,
        brainId: info.brainId,
        // Old startedAt keeps subsequent checks outside the launch grace so
        // tests can walk the ladder without simulating a 5-minute wait.
        startedAt: '2026-07-22T11:00:00.000Z',
      };
      fixture.processRunning = [{ name: 'cosmo-main', pid: 4243, killed: false }];
      return { success: true };
    },
    log: (level, message) => fixture.logs.push({ level, message }),
    now: () => fixture.nowMs,
    config,
  });

  fixture.statePath = path.join(runPath, SENTINEL_STATE_FILENAME);
  fixture.readStateFile = async () => JSON.parse(await fs.readFile(fixture.statePath, 'utf8'));
  fixture.stateFileExists = async () => {
    try {
      await fs.access(fixture.statePath);
      return true;
    } catch {
      return false;
    }
  };
  return fixture;
}

function wedgeHeartbeat(fixture) {
  // Progress stalled 20 minutes ago; liveness ts stays fresh (hung LLM await).
  fixture.heartbeat = {
    ...fixture.heartbeat,
    ts: new Date(fixture.nowMs - 5 * 1000).toISOString(),
    lastCycleStartTs: new Date(fixture.nowMs - 21 * MINUTE).toISOString(),
    lastCycleEndTs: new Date(fixture.nowMs - 20 * MINUTE).toISOString(),
  };
}

test('healthy run with fresh cycle progress takes no action and writes no state file', async (t) => {
  const fixture = await makeFixture(t);
  const result = await fixture.sentinel.check();
  assert.equal(result.outcome, 'healthy');
  assert.equal(fixture.stopCalls.length, 0);
  assert.equal(fixture.relaunchCalls.length, 0);
  assert.equal(await fixture.stateFileExists(), false);
});

test('fresh liveness ts alone does not mask a progress wedge (progress, not liveness)', async (t) => {
  const fixture = await makeFixture(t);
  wedgeHeartbeat(fixture);
  const result = await fixture.sentinel.check();
  assert.equal(result.outcome, 'remediated');
  assert.equal(result.reason, 'wedged_no_cycle_progress');
  assert.equal(fixture.stopCalls.length, 1);
  assert.equal(fixture.relaunchCalls.length, 1);
  assert.deepEqual(
    { brainId: fixture.relaunchCalls[0].brainId, attempt: fixture.relaunchCalls[0].attempt },
    { brainId: 'brain-abc123', attempt: 1 },
  );
  const state = await fixture.readStateFile();
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].ok, true);
  assert.equal(state.attempts[0].reason, 'wedged_no_cycle_progress');
  assert.equal(state.escalated, false);
});

test('no action during launch grace period even with a stale heartbeat', async (t) => {
  const fixture = await makeFixture(t);
  wedgeHeartbeat(fixture);
  fixture.activeContext.startedAt = new Date(fixture.nowMs - 2 * MINUTE).toISOString();
  const result = await fixture.sentinel.check();
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'skipped', reason: 'launch_grace' });
  assert.equal(fixture.stopCalls.length, 0);
  assert.equal(fixture.relaunchCalls.length, 0);
});

test('no action while a launch is in flight', async (t) => {
  const fixture = await makeFixture(t);
  wedgeHeartbeat(fixture);
  fixture.isLaunching = true;
  const result = await fixture.sentinel.check();
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'skipped', reason: 'launching' });
  assert.equal(fixture.stopCalls.length, 0);
});

test('missing heartbeat file is a no-signal skip, never a remediation', async (t) => {
  const fixture = await makeFixture(t);
  fixture.heartbeat = null;
  const result = await fixture.sentinel.check();
  assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'skipped', reason: 'no_heartbeat' });
  assert.equal(fixture.stopCalls.length, 0);
  assert.equal(fixture.relaunchCalls.length, 0);
});

test('idle server (no active run) does nothing', async (t) => {
  const fixture = await makeFixture(t);
  fixture.activeContext = null;
  const result = await fixture.sentinel.check();
  assert.equal(result.outcome, 'idle');
});

test('dead engine child with active context runs the same ladder', async (t) => {
  const fixture = await makeFixture(t);
  fixture.processRunning = []; // context_without_process
  const result = await fixture.sentinel.check();
  assert.equal(result.outcome, 'remediated');
  assert.equal(result.reason, 'engine_process_died');
  assert.equal(fixture.stopCalls.length, 1);
  assert.equal(fixture.relaunchCalls.length, 1);
});

test('ladder is bounded: maxAttempts remediations then escalation, then silence', async (t) => {
  const fixture = await makeFixture(t);

  wedgeHeartbeat(fixture);
  assert.equal((await fixture.sentinel.check()).outcome, 'remediated'); // attempt 1

  fixture.nowMs += 30 * MINUTE;
  wedgeHeartbeat(fixture);
  assert.equal((await fixture.sentinel.check()).outcome, 'remediated'); // attempt 2

  fixture.nowMs += 30 * MINUTE;
  wedgeHeartbeat(fixture);
  const escalation = await fixture.sentinel.check();
  assert.equal(escalation.outcome, 'escalated');
  assert.equal(fixture.stopCalls.length, 2);
  assert.equal(fixture.relaunchCalls.length, 2);

  const state = await fixture.readStateFile();
  assert.equal(state.escalated, true);
  assert.equal(typeof state.escalatedAt, 'string');
  assert.equal(fixture.sentinel.getPublicState().escalated, true);
  assert.ok(fixture.logs.some((entry) => entry.level === 'error' && entry.message.includes('SENTINEL ESCALATION')));

  // Escalated: no further remediation, no fresh escalation logs.
  const logCount = fixture.logs.length;
  fixture.nowMs += 30 * MINUTE;
  wedgeHeartbeat(fixture);
  assert.equal((await fixture.sentinel.check()).outcome, 'escalated');
  assert.equal(fixture.stopCalls.length, 2);
  assert.equal(fixture.relaunchCalls.length, 2);
  assert.equal(fixture.logs.length, logCount);
});

test('failed relaunch continues the ladder on later ticks without a second engine stop', async (t) => {
  const fixture = await makeFixture(t);
  fixture.relaunchImpl = async () => {
    fixture.activeContext = null;
    throw new Error('launch refused: provider offline');
  };

  wedgeHeartbeat(fixture);
  const first = await fixture.sentinel.check(); // attempt 1: stop + failed relaunch
  assert.equal(first.outcome, 'remediation_failed');
  assert.equal(fixture.stopCalls.length, 1);

  const second = await fixture.sentinel.check(); // attempt 2: relaunch retry only
  assert.equal(second.outcome, 'remediation_failed');
  assert.equal(second.reason, 'relaunch_retry');
  assert.equal(fixture.stopCalls.length, 1);
  assert.equal(fixture.relaunchCalls.length, 2);

  const third = await fixture.sentinel.check(); // attempts exhausted → escalate
  assert.equal(third.outcome, 'escalated');
  assert.equal(fixture.relaunchCalls.length, 2);
  const state = await fixture.readStateFile();
  assert.equal(state.escalated, true);
  assert.equal(state.attempts.filter((attempt) => !attempt.ok).length, 2);
});

test('a completed cycle after remediation resets the ladder', async (t) => {
  const fixture = await makeFixture(t);
  wedgeHeartbeat(fixture);
  assert.equal((await fixture.sentinel.check()).outcome, 'remediated');

  fixture.nowMs += 10 * MINUTE;
  fixture.heartbeat = {
    ...fixture.heartbeat,
    ts: new Date(fixture.nowMs - 5 * 1000).toISOString(),
    lastCycleStartTs: new Date(fixture.nowMs - 3 * MINUTE).toISOString(),
    lastCycleEndTs: new Date(fixture.nowMs - 2 * MINUTE).toISOString(),
  };
  assert.equal((await fixture.sentinel.check()).outcome, 'healthy');

  const state = await fixture.readStateFile();
  assert.equal(state.attempts.length, 0);
  assert.equal(state.recoveries, 1);
  assert.equal(state.escalated, false);
  assert.equal(fixture.sentinel.getPublicState().attempts, 0);
});

test('run completion cleans up sentinel state', async (t) => {
  const fixture = await makeFixture(t);
  wedgeHeartbeat(fixture);
  await fixture.sentinel.check();
  assert.equal(await fixture.stateFileExists(), true);

  const cleaned = await fixture.sentinel.notifyRunEnded({ runPath: fixture.runPath, runName: 'labor23' });
  assert.equal(cleaned.cleaned, true);
  assert.equal(await fixture.stateFileExists(), false);
  assert.equal(fixture.sentinel.getPublicState(), null);
});

test('run-ended notification during an in-flight remediation does not wipe ladder state', async (t) => {
  const fixture = await makeFixture(t);
  const stopStarted = deferred();
  const stopGate = deferred();
  fixture.stopImpl = async () => {
    stopStarted.resolve();
    await stopGate.promise;
    fixture.activeContext = null;
  };

  wedgeHeartbeat(fixture);
  const inFlight = fixture.sentinel.check();
  await stopStarted.promise;

  // cosmo-exit fires while the sentinel is stopping the engine itself.
  const cleaned = await fixture.sentinel.notifyRunEnded({ runPath: fixture.runPath });
  assert.equal(cleaned.cleaned, false);
  assert.equal(cleaned.reason, 'remediation_in_flight');
  assert.equal(await fixture.stateFileExists(), true);

  stopGate.resolve();
  await inFlight;
  assert.equal(await fixture.stateFileExists(), true);
});

test('persisted ladder survives a server restart (no attempt amnesia)', async (t) => {
  const fixture = await makeFixture(t);
  wedgeHeartbeat(fixture);
  assert.equal((await fixture.sentinel.check()).outcome, 'remediated'); // attempt 1

  // "Restart": a brand new sentinel over the same run directory.
  const restarted = await makeFixture(t);
  await fs.rm(restarted.runPath, { recursive: true, force: true });
  restarted.runPath = fixture.runPath;
  restarted.statePath = fixture.statePath;
  restarted.activeContext.runPath = fixture.runPath;
  restarted.nowMs = fixture.nowMs + 30 * MINUTE;
  wedgeHeartbeat(restarted);

  const result = await restarted.sentinel.check();
  assert.equal(result.outcome, 'remediated');
  assert.equal(result.attempt, 2);
  const state = JSON.parse(await fs.readFile(fixture.statePath, 'utf8'));
  assert.equal(state.attempts.length, 2);
});

test('stale attempts beyond the TTL are pruned on load', async (t) => {
  const fixture = await makeFixture(t);
  await fs.writeFile(fixture.statePath, JSON.stringify({
    version: 1,
    runPath: fixture.runPath,
    runName: 'labor23',
    brainId: 'brain-abc123',
    attempts: [
      { at: '2026-07-20T12:00:00.000Z', reason: 'wedged_no_cycle_progress', ok: false, error: 'old incident' },
      { at: '2026-07-20T13:00:00.000Z', reason: 'wedged_no_cycle_progress', ok: false, error: 'old incident' },
    ],
    recoveries: 0,
    escalated: true,
    escalatedAt: '2026-07-20T13:00:00.000Z',
  }, null, 2), 'utf8');

  wedgeHeartbeat(fixture);
  const result = await fixture.sentinel.check();
  assert.equal(result.outcome, 'remediated');
  assert.equal(result.attempt, 1);
  const state = await fixture.readStateFile();
  assert.equal(state.attempts.length, 1);
  assert.equal(state.escalated, false);
});

test('status contract exposes wedged and sentinel as additive fields', () => {
  const ports = { app: 43210, websocket: 43240, dashboard: 43244, mcpHttp: 43247 };
  const activeContext = {
    runName: 'labor23', brainId: 'brain-abc123', topic: 'labor',
    startedAt: '2026-07-22T11:00:00.000Z', runPath: '/tmp/labor23',
  };
  const processStatus = { running: [{ name: 'cosmo-main', pid: 4242, killed: false }], count: 1 };

  const escalatedStatus = buildStatusContract({
    activeContext,
    processStatus,
    sentinel: {
      runPath: '/tmp/labor23', runName: 'labor23', attempts: 2, maxAttempts: 2,
      lastAttemptAt: '2026-07-22T12:30:00.000Z', lastReason: 'wedged_no_cycle_progress',
      escalated: true, escalatedAt: '2026-07-22T13:00:00.000Z',
      recoveries: 0, pendingRelaunch: false, lastCheckAt: null, lastOutcome: 'escalated',
    },
    ports,
    now: new Date('2026-07-22T13:01:00.000Z'),
  });
  assert.equal(escalatedStatus.wedged, true);
  assert.equal(escalatedStatus.sentinel.escalated, true);
  // Additive only: lifecycle keeps its Patch 9 value set.
  assert.equal(escalatedStatus.lifecycle, 'running');
  assert.equal(escalatedStatus.activeRun, true);

  const plainStatus = buildStatusContract({
    activeContext: null,
    processStatus: { running: [], count: 0 },
    ports,
    now: new Date('2026-07-22T13:01:00.000Z'),
  });
  assert.equal(plainStatus.wedged, false);
  assert.equal(plainStatus.sentinel, null);
  assert.equal(plainStatus.lifecycle, 'idle');
});

```

## API NOTES

VALIDATION (repo untouched): I never edited any repo file. Module + test were built and executed in a scratchpad mirror (/private/tmp/.../scratchpad/fix25) with the same relative-path shape: new suite 15/15 green under `node --test`, and the existing `cosmo23/server/lib/status-contract.test.js` (Patch 9 coverage) 6/6 green against the modified contract copy. `node --check` clean on both files. Nothing to revert.

DONOR VS TARGET: Home23's engine/src/live-problems (verify→remediate→escalate) is a PATTERN donor only — no code was ported and no API parity assumed. Every target API was read in the current tree: ProcessManager.stopAll()/getStatus()/recordLog (launcher/process-manager.js:494/617/56), launchResearch/launchPreparedResearch (server/index.js:1013/970), buildStatusContract (server/lib/status-contract.js:6), metadata.json writer (writeRuntimeMetadata, index.js:830-882).

KEY DESIGN DECISIONS:
1. Wedge threshold: flat 15-min default, config-overridable (COSMO23_SENTINEL_WEDGE_THRESHOLD_MS / config.json sentinel.wedgeThresholdMs) — the server cannot know the run's cycleTimeoutMs (it lives in the generated run config.yaml, varies with enable_local_llm). Progress signal is lastCycleEndTs → lastCycleStartTs → context.startedAt; liveness ts is never used (H1: hung LLM await keeps ts fresh).
2. Kill method: ProcessManager has NO engine-only stop; `stopAll()` is the correct scoped method (SIGINT → 3-min bounded wait → SIGKILL; SIGTERM support children; killPort only on its tracked usedPorts — no pkill anywhere). Relaunch restarts MCP/dashboard/engine anyway via launchPreparedResearch→startProcessesForRun. stopAll's SIGINT triggers the engine's graceful-shutdown save path (bounded per e6b5ce73) — no state save is ever skipped (H4 sacred-saves respected; sentinel throttles nothing else).
3. Relaunch: replays the run's own <runDir>/metadata.json (camelCase launch settings, exactly the shape serializeLaunchSettings consumes) merged with { brainId } through the INTERNAL launchResearch — the live-proved 2026-07-22 /api/launch continuation path — not HTTP, not /api/continue. stopEngine clears activeContext (mirroring /api/stop's finally) so launchResearch's 409 guard passes; if a user launch races in first, the sentinel's relaunch 409s, is recorded as a failed attempt, and the pendingRelaunch path self-clears when it next sees an active context.
4. Ladder: attempts persisted to <runDir>/.sentinel.json via tmp+rename, attempt recorded BEFORE acting (crash can't grant amnesia), 6h TTL prune on load (stale incident can't poison a fresh run), recovery reset only on a genuinely completed cycle newer than the last attempt. Failed relaunch continues on later ticks (reason 'relaunch_retry', no second stop) — this closes the gap where stopEngine cleared the context and the run would otherwise silently die unmonitored.
5. Escalation: ADDITIVE status fields per Patch 9 compat rules — `health.wedged` (boolean) + `health.sentinel` (detail object) + flattened `wedged` on /api/status; `lifecycle` value set is untouched. Escalation logs once (level 'error', 'SENTINEL ESCALATION' prefix) then goes silent; the flag persists until run end or recovery.
6. Missing heartbeat = no-signal SKIP, never remediation: the engine-side heartbeat writer (Fix 2.1/H1) had NOT landed in cosmo23/engine/src/core/orchestrator.js at read time (a concurrent session is modifying it). Landing order is safe either way: without H1 the sentinel still catches dead-engine (context_without_process) cases; with H1 it gains wedge detection. Engine logsDir == run dir (engine/src/index.js:346), so <logsDir>/.heartbeat == <activeContext.runPath>/.heartbeat.

COMPOSITION WITH OTHER PHASE 2 FIXES: status-contract.js changes deliberately do NOT touch the `lastHeartbeat: null,` line — the H2 fix rewrites that line and would otherwise anchor-collide. No engine files touched (H6: cosmo23-native, server-side only). Event-ledger (H5) and backpressure (H4) untouched.

CONCURRENCY WARNING: the tree is actively moving (git status changed during this analysis; package.json, package-test-registration.test.cjs, orchestrator.js all modified by other sessions). Every anchor above was grep-verified unique against the tree as of this writing (counts all == 1), but the implementer MUST re-run `grep -cF <anchor>` immediately before each edit, especially in package.json (anchor sits inside the single long \"test\" script line) and the registration test. No trailing whitespace in any anchor region (verified with `sed -n l`).

RISKS: (a) stopAll can block up to 3 minutes on a truly stuck engine — actionInFlight prevents tick re-entry and the interval is unref'd; (b) if metadata.json is missing/corrupt the relaunch still proceeds with { brainId } only and catalog defaults — recorded as a normal attempt either way; (c) the sentinel intentionally does not act on 'blocked' runs (plan BLOCKED keeps producing heartbeats? — no: a blocked run may stop cycling; if its heartbeat goes stale it WILL be remediated once, which is acceptable because relaunch of a blocked guided run re-enters the same blocked state and the ladder then escalates rather than looping forever).

PATCH-LOG ENTRY (server API surface touched → short entry warranted per doctrine; append to docs/design/COSMO23-VENDORED-PATCHES.md using the next free number — 71 as of this reading):

## Patch 71 — run sentinel: server-side wedge detection and additive wedged status (2026-07-22)

**Why:** a wedged engine (child alive, cycles not completing — e.g. a hung LLM await) or a silently dead engine child left the active run stuck forever with no server-side detection, remediation, or operator signal.

**What changed (server API surface):** `server/lib/run-sentinel.js` (new) monitors the active run's `<runDir>/.heartbeat` progress signal every `sentinel.checkIntervalMs` (60s). Wedge = process online with no cycle progress for `sentinel.wedgeThresholdMs` (15min). Bounded ladder (`sentinel.maxAttempts`, default 2): stop children via ProcessManager.stopAll(), relaunch through the internal `launchResearch({ ...metadata.json, brainId })` continuation path; state persists in `<runDir>/.sentinel.json`. After exhaustion it escalates. Status contract gains ADDITIVE fields only (Patch 9 compat): `health.wedged` (boolean), `health.sentinel` (attempts/maxAttempts/lastReason/escalated/escalatedAt/...), plus flattened `wedged` on `/api/status`. `lifecycle` values are unchanged. Guards: no action while `isLaunching`, within 5min of launch (`sentinel.launchGraceMs`), or when no heartbeat file exists. Env overrides: `COSMO23_SENTINEL_{CHECK_INTERVAL_MS,WEDGE_THRESHOLD_MS,LAUNCH_GRACE_MS,MAX_ATTEMPTS,ATTEMPT_TTL_MS}`; config block `sentinel:` in `~/.cosmo2.3/config.json`.

**Effect standalone:** backward-compatible; existing consumers of `running`/`health.lifecycle` unaffected. **Tests:** `tests/cosmo23/run-sentinel.test.cjs` (ladder, bounds, escalation, grace, persistence, cleanup) + existing `server/lib/status-contract.test.js` still green.
