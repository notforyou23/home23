# Fix 2.1 — engine heartbeat (H1) + server status exposure (H2): cosmo23/engine/src/core/heartbeat.js (new), orchestrator wiring, status-contract reader, /api/status plumbing

## Target current state

1) lastHeartbeat is permanently null (Patch 9) — cosmo23/server/lib/status-contract.js:37 inside buildStatusContract's return object:
    lastHeartbeat: null,
The whole file (70 lines) is a pure function `buildStatusContract({ activeContext, processStatus, isLaunching, ports, runTruth, now, uptimeMs })` with `module.exports = { buildStatusContract };` (line 70). No fs access, no heartbeat concept.

2) No heartbeat exists anywhere in the engine — `grep -c "heartbeat" cosmo23/engine/src/core/orchestrator.js` → 0; `cosmo23/engine/src/core/heartbeat.js` does not exist.

3) Cycle loop anchor points (cosmo23/engine/src/core/orchestrator.js, 10103 lines, current tree):
- executeCycle entry (1217–1219):
  async executeCycle() {
    const cycleStart = new Date();
    this.cycleCount++;
- consolidation-mode early return BEFORE the main try block (1271–1272):
      // RETURN - skip ALL normal cycle processing
      return;
- end-of-cycle finally, the only place covering all in-try exits (3394–3397):
    } finally {
      // Phase A: Always cancel cycle timeout (success or failure)
      this.timeoutManager.cancelCycleTimer();
    }
- start() which launches the while-loop (934–936):
  async start() {
    this.running = true;
    this.runStartTime = Date.now(); // Track when this run started
- stop() (9326–9328):
  async stop() {
    this.logger.info('Stopping GPT-5.2 system...');
    this.running = false;
- constructor tail where hardening modules are built, this.logsDir already set at 235–237 (249–250):
    this.telemetry = new TelemetryCollector(config, logger, this.logsDir);
    this.shutdownHandler = null; // Created after initialization

4) Server knows the run dir already: cosmo23/server/index.js:985–995 sets `activeContext = { runName, runPath: brain.path, ... }`; startProcessesForRun (951) sets `process.env.COSMO_RUNTIME_PATH = runPath`; engine/src/index.js:346 sets `config.logsDir = runtimeRoot` (= COSMO_RUNTIME_PATH). So `<logsDir>/.heartbeat` === `<activeContext.runPath>/.heartbeat` — the plumbing exists, activeContext is already passed to buildStatusContract at all three call sites (/api/health 1047, /api/status 2034, /api/watch/logs 2079) plus server/lib/interactive-live-status.js:120. /api/status already echoes `lastHeartbeat: health.lastHeartbeat,` (index.js:2059).

5) Test conventions: cosmo23/server/lib/status-contract.test.js is node:test + assert/strict (NOT mocha) — but it is registered NOWHERE (cosmo23/package.json has no test script at all; root package.json test chain has no server/lib entries). It only runs ad hoc via `node --test cosmo23/server/lib/status-contract.test.js`. Registered coverage therefore goes in tests/cosmo23/ per H7. Red-check evidence: `Orchestrator.prototype.stop.call(fake)` with a real HeartbeatWriter on the CURRENT tree completes without TypeError but leaves writer.timer set and phase unchanged — the new test discriminates current vs fixed behavior.

## CHANGE: cosmo23/engine/src/core/heartbeat.js

NEW FILE — H1 heartbeat module: crash-safe-cheap tmp+rename writer (sync fs, ~200B payload), null-safe reader, staleness math (liveness=ts, progress=lastCycleEndTs), and HeartbeatWriter class with unref'd interval (default 15s, override via intervalMs). stamp()/start()/stop() never throw; stop() writes nothing if never stamped. Validated in scratchpad: 9/9 tests green.

### Code
```js
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
   */
  stamp(patch = {}) {
    for (const key of ['cycle', 'lastCycleStartTs', 'lastCycleEndTs', 'phase']) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        this.state[key] = patch[key];
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

```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Add require for the heartbeat module (top-of-file requires block, after brain-backups). Anchor is unique (grep count 1), no trailing whitespace.

### Anchor
```
const { maybeBackupBrain } = require('./brain-backups');
```

### Code
```js
const { maybeBackupBrain } = require('./brain-backups');
const { HeartbeatWriter } = require('./heartbeat');
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Constructor (~line 249): create the writer alongside the Phase A hardening modules. this.logsDir is already resolved at lines 235-237. Config knob: config.heartbeat?.intervalMs (default 15000 inside the writer). Anchor pair is unique, no trailing whitespace.

### Anchor
```
    this.telemetry = new TelemetryCollector(config, logger, this.logsDir);
    this.shutdownHandler = null; // Created after initialization
```

### Code
```js
    this.telemetry = new TelemetryCollector(config, logger, this.logsDir);
    // Phase 2 (H1): liveness/progress heartbeat — <logsDir>/.heartbeat via
    // tmp+rename, stamped by an unref'd interval (default 15s, config
    // heartbeat.intervalMs) plus at cycle start/end. Best-effort by design:
    // it never throws into the cycle and cannot hold the process open.
    this.heartbeatWriter = new HeartbeatWriter(this.logsDir, {
      intervalMs: config.heartbeat?.intervalMs,
      logger
    });
    this.shutdownHandler = null; // Created after initialization
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

start() (~line 936): first stamp + start the unref'd interval before entering the while-loop. Anchor line unique, no trailing whitespace.

### Anchor
```
    this.runStartTime = Date.now(); // Track when this run started
```

### Code
```js
    this.runStartTime = Date.now(); // Track when this run started

    // Phase 2 (H1): first heartbeat stamp + unref'd interval. Interval
    // stamps prove liveness only; cycle start/end stamps carry progress.
    this.heartbeatWriter?.start({ cycle: this.cycleCount, phase: 'loop_start' });
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

executeCycle() entry (~line 1219): stamp cycle start immediately after cycleCount++. Anchor (3 lines incl. method signature) unique, no trailing whitespace.

### Anchor
```
  async executeCycle() {
    const cycleStart = new Date();
    this.cycleCount++;
```

### Code
```js
  async executeCycle() {
    const cycleStart = new Date();
    this.cycleCount++;

    // Phase 2 (H1): stamp cycle start — opens the progress window. A cycle
    // that never stamps an end (hung LLM await) shows fresh ts with stale
    // lastCycleEndTs: the wedge signature. Detection MUST use progress.
    this.heartbeatWriter?.stamp({
      cycle: this.cycleCount,
      lastCycleStartTs: cycleStart.toISOString(),
      phase: 'cycle_start'
    });
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Consolidation-mode early return (~line 1271) — this return happens BEFORE the main try/finally, so the finally end-stamp does not cover it; consolidation cycles completing count as progress. WARNING: the line directly ABOVE this anchor (1270) ends in trailing spaces — anchor exactly on the comment+return lines shown, which are clean.

### Anchor
```
      // RETURN - skip ALL normal cycle processing
      return;
```

### Code
```js
      // Phase 2 (H1): consolidation cycles complete too — stamp progress
      // (this return path is before the main try/finally end-stamp).
      this.heartbeatWriter?.stamp({ lastCycleEndTs: new Date().toISOString(), phase: 'cycle_end' });

      // RETURN - skip ALL normal cycle processing
      return;
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

End-of-cycle finally (~line 3394): stamp cycle end on EVERY exit from the cycle body — success, in-try early returns (sleep skip ~1819, guided-waiting ~1869), or handled error. A cycle that errors still ended (H3's breaker counts failures separately); only a hung await leaves lastCycleEndTs stale, which is exactly the H1 wedge signal. Anchor unique (cancelCycleTimer appears once), no trailing whitespace.

### Anchor
```
    } finally {
      // Phase A: Always cancel cycle timeout (success or failure)
      this.timeoutManager.cancelCycleTimer();
    }
```

### Code
```js
    } finally {
      // Phase A: Always cancel cycle timeout (success or failure)
      this.timeoutManager.cancelCycleTimer();
      // Phase 2 (H1): stamp cycle end on every exit from the cycle body —
      // success, in-try early return, or handled error. Progress
      // (lastCycleEndTs freshness) is the wedge-detection signal, not ts.
      this.heartbeatWriter?.stamp({ lastCycleEndTs: new Date().toISOString(), phase: 'cycle_end' });
    }
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

stop() (~line 9328): clear the interval and write a final 'stopped' stamp so readers can distinguish deliberate stop from wedge. Idempotent (writer.stop is). Anchor pair unique, no trailing whitespace.

### Anchor
```
    this.logger.info('Stopping GPT-5.2 system...');
    this.running = false;
```

### Code
```js
    this.logger.info('Stopping GPT-5.2 system...');
    this.running = false;

    // Phase 2 (H1): clear the heartbeat interval; the final stamp marks a
    // deliberate stop (a stopped run's heartbeat then goes stale naturally).
    this.heartbeatWriter?.stop('stopped');
```

## CHANGE: cosmo23/server/lib/status-contract.js

FULL FILE REPLACEMENT (file is 70 lines; replacing wholesale is safer than 4 fragment edits). Adds: require of the engine heartbeat reader (relative path ../../engine/src/core/heartbeat — cosmo23's OWN engine, two levels up), summarizeHeartbeat() shaping + staleness math against the injectable `now`, new `heartbeat` param (undefined = read <activeContext.runPath>/.heartbeat from disk; raw object or null = injected for tests), populated lastHeartbeat, and a full `heartbeat` block { lastHeartbeat, lastCycleStartTs, lastCycleEndTs, cycle, pid, phase, heartbeatAgeMs, cycleProgressAgeMs }. All 6 existing tests pass unchanged against this version (verified in scratchpad). Anchor = current first line `function hasProcess(processStatus, name) {` (file starts there today).

### Anchor
```
function hasProcess(processStatus, name) {
```

### Code
```js
const { readHeartbeat, computeHeartbeatAges } = require('../../engine/src/core/heartbeat');

function hasProcess(processStatus, name) {
  return Array.isArray(processStatus?.running)
    && processStatus.running.some((process) => process?.name === name);
}

// Phase 2 (H2): shape a raw .heartbeat payload into the status-contract
// heartbeat block, with staleness math computed against `now`.
// heartbeatAgeMs tracks liveness (ts); cycleProgressAgeMs tracks progress
// (lastCycleEndTs) — wedge detection must use progress, not liveness.
function summarizeHeartbeat(raw, now = new Date()) {
  if (!raw || typeof raw !== 'object') return null;
  const nowMsCandidate = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const nowMs = Number.isFinite(nowMsCandidate) ? nowMsCandidate : Date.now();
  const { heartbeatAgeMs, cycleProgressAgeMs } = computeHeartbeatAges(raw, nowMs);
  return {
    lastHeartbeat: typeof raw.ts === 'string' ? raw.ts : null,
    lastCycleStartTs: typeof raw.lastCycleStartTs === 'string' ? raw.lastCycleStartTs : null,
    lastCycleEndTs: typeof raw.lastCycleEndTs === 'string' ? raw.lastCycleEndTs : null,
    cycle: Number.isFinite(Number(raw.cycle)) ? Number(raw.cycle) : null,
    pid: Number.isFinite(Number(raw.pid)) ? Number(raw.pid) : null,
    phase: typeof raw.phase === 'string' ? raw.phase : null,
    heartbeatAgeMs,
    cycleProgressAgeMs,
  };
}

function buildStatusContract({
  activeContext = null,
  processStatus = { running: [], count: 0 },
  isLaunching = false,
  ports = {},
  runTruth = {},
  heartbeat = undefined,
  now = new Date(),
  uptimeMs = Math.round(process.uptime() * 1000),
} = {}) {
  const cosmoMainOnline = hasProcess(processStatus, 'cosmo-main');
  const hasActiveContext = !!activeContext;
  const planStatus = String(runTruth?.plan?.status || '').toUpperCase();
  const blockedByPlan = planStatus === 'BLOCKED';
  const blockedByGovernor = runTruth?.commitmentDecision?.shouldStopForBlockedRun === true;
  const blockedRun = blockedByPlan || blockedByGovernor;
  const activeRun = hasActiveContext && cosmoMainOnline && !blockedRun;

  // Phase 2 (H2): heartbeat truth comes from the active run's .heartbeat
  // file. `heartbeat` (raw payload or null) can be injected for tests;
  // undefined means "read from disk at activeContext.runPath".
  const heartbeatRaw = heartbeat !== undefined
    ? heartbeat
    : (activeContext?.runPath ? readHeartbeat(activeContext.runPath) : null);
  const runHeartbeat = summarizeHeartbeat(heartbeatRaw, now);

  let lifecycle = 'idle';
  if (isLaunching) lifecycle = 'launching';
  else if (blockedRun) lifecycle = 'blocked';
  else if (activeRun) lifecycle = 'running';
  else if (hasActiveContext) lifecycle = 'context_without_process';
  else if (cosmoMainOnline) lifecycle = 'process_without_context';

  return {
    apiReachable: true,
    lifecycle,
    activeRun,
    processOnline: cosmoMainOnline,
    hasActiveContext,
    isLaunching,
    lastHeartbeat: runHeartbeat?.lastHeartbeat || null,
    heartbeat: runHeartbeat,
    generatedAt: now instanceof Date ? now.toISOString() : String(now),
    uptimeMs,
    process: {
      cosmoMainOnline,
      count: processStatus?.count || 0,
      runningNames: Array.isArray(processStatus?.running)
        ? processStatus.running.map((process) => process?.name).filter(Boolean)
        : [],
    },
    run: activeContext ? {
      runName: activeContext.runName || null,
      brainId: activeContext.brainId || null,
      topic: activeContext.topic || null,
      startedAt: activeContext.startedAt || null,
      runPath: activeContext.runPath || null,
      status: blockedRun ? 'blocked' : (planStatus ? planStatus.toLowerCase() : null),
      blockedReason: runTruth?.plan?.blockedReason || null,
      artifactInventory: runTruth?.artifactInventory || null,
    } : null,
    supervision: {
      shouldStopForBlockedRun: runTruth?.commitmentDecision?.shouldStopForBlockedRun === true,
      reasonCodes: Array.isArray(runTruth?.commitmentDecision?.reasonCodes)
        ? runTruth.commitmentDecision.reasonCodes
        : [],
      appliedActions: Array.isArray(runTruth?.commitmentDecision?.appliedActions)
        ? runTruth.commitmentDecision.appliedActions
        : [],
    },
    ports,
  };
}

module.exports = { buildStatusContract, summarizeHeartbeat };
```

## CHANGE: cosmo23/server/index.js

/api/status (~line 2059): expose the full heartbeat block top-level next to the already-echoed lastHeartbeat (which now self-populates because buildStatusContract already receives activeContext with runPath — no other index.js plumbing is required; /api/health and /api/watch/logs gain it automatically inside `health`). Anchor pair unique via the lastHeartbeat line, no trailing whitespace.

### Anchor
```
    lastHeartbeat: health.lastHeartbeat,
    activeContext,
```

### Code
```js
    lastHeartbeat: health.lastHeartbeat,
    heartbeat: health.heartbeat,
    activeContext,
```

## CHANGE: cosmo23/server/lib/status-contract.test.js

Extend the existing node:test suite (it is node:test + assert/strict, NOT mocha — and note it is registered in no package.json chain; it runs ad hoc via `node --test cosmo23/server/lib/status-contract.test.js`). Append two tests at end of file using the injectable `heartbeat` param + fixed `now` (2026-04-24T15:00:00Z) for deterministic staleness math. Anchor = unique closing lines of the last existing test.

### Anchor
```
  assert.equal(status.supervision.shouldStopForBlockedRun, true);
});
```

### Code
```js
  assert.equal(status.supervision.shouldStopForBlockedRun, true);
});

test('buildStatusContract populates heartbeat block and staleness math from injected raw heartbeat', () => {
  const status = buildStatusContract({
    activeContext: { runName: 'run-1', runPath: '/tmp/run-1' },
    processStatus: { running: [{ name: 'cosmo-main', pid: 1234, killed: false }], count: 1 },
    heartbeat: {
      ts: '2026-04-24T14:59:55.000Z',
      pid: 4242,
      cycle: 17,
      lastCycleStartTs: '2026-04-24T14:59:40.000Z',
      lastCycleEndTs: '2026-04-24T14:49:00.000Z',
      phase: 'cycle_start'
    },
    ports,
    now,
  });

  assert.equal(status.lastHeartbeat, '2026-04-24T14:59:55.000Z');
  assert.equal(status.heartbeat.cycle, 17);
  assert.equal(status.heartbeat.pid, 4242);
  assert.equal(status.heartbeat.phase, 'cycle_start');
  assert.equal(status.heartbeat.heartbeatAgeMs, 5000);
  // The wedge signature: fresh ts (liveness) but stale lastCycleEndTs
  // (progress). Wedge detection must key off cycleProgressAgeMs.
  assert.equal(status.heartbeat.cycleProgressAgeMs, 11 * 60 * 1000);
});

test('buildStatusContract reports null heartbeat when none is available', () => {
  const status = buildStatusContract({
    activeContext: { runName: 'run-1', runPath: '/tmp/run-1' },
    processStatus: { running: [], count: 0 },
    heartbeat: null,
    ports,
    now,
  });

  assert.equal(status.lastHeartbeat, null);
  assert.equal(status.heartbeat, null);
});
```

## CHANGE: package.json

Register tests/cosmo23/engine-heartbeat.test.cjs exactly once in the root `test` script's cosmo23 segment, right after graceful-shutdown-honesty. WARNING: this is a substring replace inside one very long line; the anchor ends with a SPACE (file-list separator) which must be preserved. The worktree package.json is already locally modified by other sessions — re-grep before applying: `grep -c "tests/cosmo23/graceful-shutdown-honesty.test.cjs" package.json` must be 1 and `grep -c "engine-heartbeat" package.json` must be 0.

### Anchor
```
tests/cosmo23/graceful-shutdown-honesty.test.cjs tests/cosmo23/research-run-operation-adapter.test.cjs
```

### Code
```js
tests/cosmo23/graceful-shutdown-honesty.test.cjs tests/cosmo23/engine-heartbeat.test.cjs tests/cosmo23/research-run-operation-adapter.test.cjs
```

## CHANGE: tests/cosmo23/package-test-registration.test.cjs

Add the new suite to the exactly-once registration list (file is locally modified by other sessions — anchor re-verified against current tree, count 1). Insert after the graceful-shutdown-honesty entry.

### Anchor
```
    'tests/cosmo23/graceful-shutdown-honesty.test.cjs',
```

### Code
```js
    'tests/cosmo23/graceful-shutdown-honesty.test.cjs',
    'tests/cosmo23/engine-heartbeat.test.cjs',
```

## TEST FILE: tests/cosmo23/engine-heartbeat.test.cjs

```js
'use strict';

// Fix 2.1 (contracts H1 + H2) — engine heartbeat + server status exposure.
//
// H1: <logsDir>/.heartbeat, tmp+rename JSON { ts, pid, cycle,
//     lastCycleStartTs, lastCycleEndTs, phase }, stamped by an unref'd
//     interval (default 15s) plus at cycle start/end.
//     Liveness = ts freshness. Progress = lastCycleEndTs freshness.
//     A hung LLM await keeps ts fresh but lastCycleEndTs stale — wedge
//     detection must use progress, not liveness.
// H2: buildStatusContract reads the active run's .heartbeat and exposes
//     { lastHeartbeat, lastCycleEndTs, cycle, heartbeatAgeMs,
//       cycleProgressAgeMs } — lastHeartbeat is no longer permanently null.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  HEARTBEAT_FILENAME,
  DEFAULT_INTERVAL_MS,
  HeartbeatWriter,
  heartbeatPath,
  writeHeartbeatFile,
  readHeartbeat,
  computeHeartbeatAges,
} = require('../../cosmo23/engine/src/core/heartbeat');
const { buildStatusContract } = require('../../cosmo23/server/lib/status-contract');
const { Orchestrator } = require('../../cosmo23/engine/src/core/orchestrator');

const ORCHESTRATOR_SOURCE = fsSync.readFileSync(
  require.resolve('../../cosmo23/engine/src/core/orchestrator.js'),
  'utf8'
);

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

async function makeTmpRunDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo23-heartbeat-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function waitFor(predicate, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('heartbeat writer/reader round-trip preserves the H1 payload shape', async (t) => {
  const dir = await makeTmpRunDir(t);
  const writer = new HeartbeatWriter(dir, { pid: 4242 });
  t.after(() => writer.stop());

  const payload = writer.stamp({
    cycle: 7,
    lastCycleStartTs: '2026-07-22T10:00:00.000Z',
    phase: 'cycle_start',
  });
  assert.ok(payload, 'stamp returns the written payload');

  const readBack = readHeartbeat(dir);
  assert.ok(readBack, 'heartbeat file readable');
  assert.equal(readBack.pid, 4242);
  assert.equal(readBack.cycle, 7);
  assert.equal(readBack.lastCycleStartTs, '2026-07-22T10:00:00.000Z');
  assert.equal(readBack.lastCycleEndTs, null);
  assert.equal(readBack.phase, 'cycle_start');
  assert.ok(Number.isFinite(Date.parse(readBack.ts)), 'ts is a parseable ISO timestamp');

  // tmp+rename must not leave staging files behind
  const leftovers = (await fs.readdir(dir)).filter((name) => name !== HEARTBEAT_FILENAME);
  assert.deepEqual(leftovers, [], 'no .heartbeat.tmp-* staging files left');
});

test('heartbeat stamp merges patches — cycle-end stamp preserves cycle-start fields', async (t) => {
  const dir = await makeTmpRunDir(t);
  const writer = new HeartbeatWriter(dir, { pid: 1 });
  t.after(() => writer.stop());

  writer.stamp({ cycle: 3, lastCycleStartTs: '2026-07-22T10:00:00.000Z', phase: 'cycle_start' });
  writer.stamp({ lastCycleEndTs: '2026-07-22T10:00:09.000Z', phase: 'cycle_end' });

  const readBack = readHeartbeat(dir);
  assert.equal(readBack.cycle, 3, 'cycle survives the end-of-cycle stamp');
  assert.equal(readBack.lastCycleStartTs, '2026-07-22T10:00:00.000Z');
  assert.equal(readBack.lastCycleEndTs, '2026-07-22T10:00:09.000Z');
  assert.equal(readBack.phase, 'cycle_end');
});

test('staleness math distinguishes liveness (ts) from progress (lastCycleEndTs)', () => {
  const nowMs = Date.parse('2026-07-22T10:10:00.000Z');

  // The wedge signature: fresh ts (interval timer alive during a hung LLM
  // await) but stale lastCycleEndTs (no cycle completing).
  const wedged = computeHeartbeatAges({
    ts: '2026-07-22T10:09:55.000Z',
    lastCycleEndTs: '2026-07-22T09:40:00.000Z',
  }, nowMs);
  assert.equal(wedged.heartbeatAgeMs, 5000);
  assert.equal(wedged.cycleProgressAgeMs, 30 * 60 * 1000);
  assert.ok(
    wedged.cycleProgressAgeMs > wedged.heartbeatAgeMs,
    'wedge detection must key off progress, not liveness'
  );

  // Missing fields yield null, not fake freshness.
  assert.deepEqual(
    computeHeartbeatAges({ ts: '2026-07-22T10:09:55.000Z' }, nowMs),
    { heartbeatAgeMs: 5000, cycleProgressAgeMs: null }
  );
  assert.deepEqual(
    computeHeartbeatAges({ ts: 'not-a-date', lastCycleEndTs: 'garbage' }, nowMs),
    { heartbeatAgeMs: null, cycleProgressAgeMs: null }
  );
  assert.deepEqual(
    computeHeartbeatAges(null, nowMs),
    { heartbeatAgeMs: null, cycleProgressAgeMs: null }
  );

  // Minor clock skew (future ts) clamps to 0, never negative.
  const skewed = computeHeartbeatAges({ ts: '2026-07-22T10:10:01.000Z' }, nowMs);
  assert.equal(skewed.heartbeatAgeMs, 0);
});

test('heartbeat reader and writer never throw on bad input', async (t) => {
  const dir = await makeTmpRunDir(t);

  // Corrupt file -> null, no throw.
  await fs.writeFile(heartbeatPath(dir), '{ torn json');
  assert.equal(readHeartbeat(dir), null);

  // Non-object JSON -> null.
  await fs.writeFile(heartbeatPath(dir), '[1,2,3]');
  assert.equal(readHeartbeat(dir), null);

  // Missing dir -> null.
  assert.equal(readHeartbeat(path.join(dir, 'nope')), null);
  assert.equal(readHeartbeat(null), null);

  // Writer pointed at a nonexistent dir: stamp is best-effort — returns
  // null, never throws into the cycle. Warns exactly once.
  const warns = [];
  const writer = new HeartbeatWriter(path.join(dir, 'missing', 'nested'), {
    logger: { warn: (msg) => warns.push(msg) },
  });
  assert.equal(writer.stamp({ cycle: 1 }), null);
  assert.equal(writer.stamp({ cycle: 2 }), null);
  assert.equal(warns.length, 1, 'warns exactly once');
  writer.stop();
});

test('interval timer stamps liveness, is unref\'d, and stop() clears it', async (t) => {
  const dir = await makeTmpRunDir(t);
  const writer = new HeartbeatWriter(dir, { intervalMs: 20, pid: 99 });
  t.after(() => writer.stop());

  writer.start({ cycle: 1, phase: 'loop_start' });
  assert.ok(writer.timer, 'interval timer exists');
  assert.equal(writer.timer.hasRef(), false, 'timer must be unref\'d (cannot hold process open)');

  const first = readHeartbeat(dir);
  assert.equal(first.phase, 'loop_start');

  // The interval refreshes ts without any explicit stamp() call.
  const advanced = await waitFor(() => {
    const current = readHeartbeat(dir);
    return current && current.ts !== first.ts;
  });
  assert.ok(advanced, 'interval timer refreshed ts');

  // start() is idempotent — no second timer.
  const timerBefore = writer.timer;
  writer.start();
  assert.equal(writer.timer, timerBefore);

  writer.stop();
  assert.equal(writer.timer, null, 'stop() clears the interval');
  const stopped = readHeartbeat(dir);
  assert.equal(stopped.phase, 'stopped');

  // No further writes after stop.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(readHeartbeat(dir).ts, stopped.ts, 'no stamps after stop()');
});

test('default interval is 15s per H1 and config override wins', () => {
  const writer = new HeartbeatWriter('/tmp/unused');
  assert.equal(writer.intervalMs, DEFAULT_INTERVAL_MS);
  assert.equal(DEFAULT_INTERVAL_MS, 15000);
  assert.equal(new HeartbeatWriter('/tmp/unused', { intervalMs: 250 }).intervalMs, 250);
  assert.equal(new HeartbeatWriter('/tmp/unused', { intervalMs: 'bogus' }).intervalMs, 15000);
  assert.equal(new HeartbeatWriter('/tmp/unused', { intervalMs: -5 }).intervalMs, 15000);
});

test('a never-started writer does not create a heartbeat file on stop()', async (t) => {
  const dir = await makeTmpRunDir(t);
  const writer = new HeartbeatWriter(dir);
  writer.stop();
  assert.equal(readHeartbeat(dir), null, 'no file written by stop() alone');
});

test('buildStatusContract reads the active run\'s .heartbeat from disk (H2)', async (t) => {
  const dir = await makeTmpRunDir(t);
  writeHeartbeatFile(dir, {
    ts: '2026-07-22T10:00:00.000Z',
    pid: 777,
    cycle: 42,
    lastCycleStartTs: '2026-07-22T09:59:30.000Z',
    lastCycleEndTs: '2026-07-22T09:50:00.000Z',
    phase: 'cycle_start',
  });

  const status = buildStatusContract({
    activeContext: { runName: 'run-hb', runPath: dir },
    processStatus: { running: [{ name: 'cosmo-main', pid: 777, killed: false }], count: 1 },
    ports: { app: 43210 },
    now: new Date('2026-07-22T10:00:05.000Z'),
  });

  assert.equal(status.lastHeartbeat, '2026-07-22T10:00:00.000Z',
    'lastHeartbeat no longer permanently null (Patch 9 gap closed)');
  assert.equal(status.heartbeat.cycle, 42);
  assert.equal(status.heartbeat.pid, 777);
  assert.equal(status.heartbeat.phase, 'cycle_start');
  assert.equal(status.heartbeat.lastCycleStartTs, '2026-07-22T09:59:30.000Z');
  assert.equal(status.heartbeat.lastCycleEndTs, '2026-07-22T09:50:00.000Z');
  assert.equal(status.heartbeat.heartbeatAgeMs, 5000);
  assert.equal(status.heartbeat.cycleProgressAgeMs, 605000);
});

test('buildStatusContract heartbeat is null with no run, no file, or explicit null', async (t) => {
  const dir = await makeTmpRunDir(t);

  const noRun = buildStatusContract({ activeContext: null, now: new Date() });
  assert.equal(noRun.lastHeartbeat, null);
  assert.equal(noRun.heartbeat, null);

  const noFile = buildStatusContract({
    activeContext: { runName: 'r', runPath: dir },
    now: new Date(),
  });
  assert.equal(noFile.lastHeartbeat, null);
  assert.equal(noFile.heartbeat, null);

  const injectedNull = buildStatusContract({
    activeContext: { runName: 'r', runPath: dir },
    heartbeat: null,
    now: new Date(),
  });
  assert.equal(injectedNull.heartbeat, null);
});

test('Orchestrator.prototype.stop clears the heartbeat interval and stamps a final phase', async (t) => {
  const dir = await makeTmpRunDir(t);
  const writer = new HeartbeatWriter(dir, { intervalMs: 20 });
  t.after(() => writer.stop());
  writer.start({ cycle: 5, phase: 'cycle_start' });
  assert.ok(writer.timer, 'precondition: interval running');

  // Minimal fake covering everything stop() touches (verified against the
  // real prototype: no shutdownHandler -> falls through to saveState()).
  const fake = {
    logger: quietLogger,
    running: true,
    stopImmediateActionPoller() {},
    stopGuardianControlPoller() {},
    clusterOrchestrator: null,
    clusterStateStore: null,
    feeder: null,
    shutdownHandler: null,
    async saveState() { return { saved: true }; },
    heartbeatWriter: writer,
  };

  await Orchestrator.prototype.stop.call(fake);

  assert.equal(writer.timer, null, 'stop() must clear the unref\'d interval');
  assert.equal(readHeartbeat(dir).phase, 'stopped');
});

test('orchestrator cycle loop is wired to the heartbeat at start, cycle start/end, and stop', () => {
  // Source pins for wiring points that cannot be exercised without a full
  // subsystem stack (start() enters the while-loop; executeCycle needs
  // dozens of subsystems). These pin the exact proposed call sites.
  assert.ok(
    ORCHESTRATOR_SOURCE.includes("const { HeartbeatWriter } = require('./heartbeat');"),
    'orchestrator requires the heartbeat module'
  );
  assert.ok(
    ORCHESTRATOR_SOURCE.includes('this.heartbeatWriter = new HeartbeatWriter(this.logsDir'),
    'constructor builds the writer on logsDir'
  );
  assert.ok(
    ORCHESTRATOR_SOURCE.includes("this.heartbeatWriter?.start({ cycle: this.cycleCount, phase: 'loop_start' });"),
    'start() stamps and starts the unref\'d interval'
  );
  assert.ok(
    ORCHESTRATOR_SOURCE.includes('lastCycleStartTs: cycleStart.toISOString(),'),
    'executeCycle stamps cycle start'
  );

  const endStamp = "this.heartbeatWriter?.stamp({ lastCycleEndTs: new Date().toISOString(), phase: 'cycle_end' });";
  assert.equal(
    countOccurrences(ORCHESTRATOR_SOURCE, endStamp),
    2,
    'cycle end stamped exactly twice: consolidation-mode return + main finally'
  );

  // The finally-block stamp must sit with cancelCycleTimer so every exit
  // from the cycle body (success, early return, handled error) stamps.
  const finallyIdx = ORCHESTRATOR_SOURCE.indexOf('this.timeoutManager.cancelCycleTimer();');
  assert.ok(finallyIdx > -1, 'cycle finally block present');
  const window = ORCHESTRATOR_SOURCE.slice(finallyIdx, finallyIdx + 500);
  assert.ok(window.includes(endStamp), 'finally block stamps lastCycleEndTs');

  assert.ok(
    ORCHESTRATOR_SOURCE.includes("this.heartbeatWriter?.stop('stopped');"),
    'stop() clears the interval and stamps a final phase'
  );
});

```

## API NOTES

DONOR/TARGET + WIRING NOTES (all verified by reading the current tree, 2026-07-22):

1) Run-path plumbing already exists — verified chain: server/index.js:987 `activeContext.runPath = brain.path`; :951/:978 `process.env.COSMO_RUNTIME_PATH = runPath`; engine/src/index.js:346 `config.logsDir = runtimeRoot` (from COSMO_RUNTIME_PATH); orchestrator.js:235 `this.logsDir = config.logsDir || ...`. So `<logsDir>/.heartbeat` === `<activeContext.runPath>/.heartbeat`, and all three buildStatusContract call sites in index.js (plus interactive-live-status.js:120) already pass activeContext. The only index.js edit is the optional top-level `heartbeat: health.heartbeat` echo in /api/status; /api/health and /api/watch/logs gain the data automatically inside `health`.

2) server→engine require: the new require in status-contract.js is `../../engine/src/core/heartbeat` = cosmo23/engine (TWO levels up). CAUTION: the existing precedent in server/lib (brain-operation-worker.js:38) uses `../../../engine/...` which resolves to the HOME23 engine, NOT cosmo23's — do not copy that depth. This is exactly the donor/target conflation H6 warns about.

3) Design decisions: (a) buildStatusContract stays deterministic for tests via the new `heartbeat` param — undefined = read disk at activeContext.runPath, raw object/null = injected; ages are computed against the already-injectable `now`. (b) Ages clamp at 0 so minor clock skew reads as fresh, never negative. (c) HeartbeatWriter.stop() writes nothing if never stamped (constructed-but-never-started orchestrators leave no .heartbeat). (d) Orchestrator call sites use `this.heartbeatWriter?.` optional chaining — extends the never-throw guarantee to prototype.call(fake) test patterns (verified none exist today: only crash-recovery-scalar-checkpoints pins executeCycle source). (e) The end-of-cycle stamp lives in the finally block (covers success, in-try early returns at ~1819/~1869, and handled errors) PLUS one explicit stamp on the consolidation-mode return, which exits BEFORE the try block. An errored-but-completed cycle deliberately counts as progress — H3's breaker counts failures; H1 staleness only flags hangs. (f) `cycle_end` phase after an error is acceptable: phase is informational; wedge detection uses cycleProgressAgeMs.

4) Composition with later fixes: H3 watchdog should read progress via `computeHeartbeatAges(...).cycleProgressAgeMs` (exported) — never heartbeatAgeMs. The writer's `stamp(patch)` accepts any phase string, so watchdog/breaker states ('breaker_cooloff', 'revive_probe') can stamp without module changes. Status API additions are purely additive: lastHeartbeat transitions null→ISO (its documented intent), new `heartbeat` block added; all 6 existing status-contract tests pass unchanged against the new file (verified).

5) Config: `config.heartbeat.intervalMs` read directly off the engine config object; ConfigValidator is non-breaking so an absent/unknown `heartbeat:` YAML block is harmless. No config-generator change needed for defaults.

6) Known benign edge: an interactive dashboard session orchestrator pointed at the same run dir as a live run would alternate .heartbeat writes (last-writer-wins); the `pid` field disambiguates. Not worth guarding in Phase 2.

7) Test registration truth: cosmo23/package.json has NO test script; cosmo23/server/lib/status-contract.test.js (node:test + assert/strict, NOT mocha) is registered nowhere and runs only ad hoc (`node --test cosmo23/server/lib/status-contract.test.js`) — run it manually after applying. Registered coverage is the new tests/cosmo23/engine-heartbeat.test.cjs, added exactly once to the root package.json chain and to package-test-registration.test.cjs. Note requiring orchestrator.js prints one dotenv info line — same as the already-registered graceful-shutdown-honesty suite.

8) Anchors: all grep-verified unique against the CURRENT (dirty, multi-session) tree. Trailing-whitespace warnings: orchestrator.js line 1270 (directly above the consolidation-return anchor) ends in spaces — anchor only on the clean comment+return lines given; the package.json anchor is a substring of one very long line and its trailing space separator must be preserved. package.json and package-test-registration.test.cjs are locally modified by other sessions — re-run the two grep count checks in the change description immediately before applying.

9) Validation performed: all proposed modules/tests were validated in the session scratchpad only (/private/tmp/.../scratchpad/hb/) — 9/9 new tests green, 6/6 existing status-contract tests green against the modified contract, and a red-check proving Orchestrator.prototype.stop.call(fake) completes on the current tree but leaves the timer running (so the new stop-wiring test discriminates). NO repo files were edited, applied, or stashed; nothing to revert.

RISKS: minimal — writer is fire-and-forget sync I/O of ~200 bytes/15s plus 2 writes per cycle; the unref'd timer cannot block shutdown; graceful-shutdown path already routes through orchestrator.stop() which now clears it. The status endpoints add one tiny sync file read per poll.
