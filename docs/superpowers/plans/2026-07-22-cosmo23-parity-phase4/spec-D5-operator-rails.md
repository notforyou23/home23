# cosmo23 Phase 4 component 4.5 — operator rails: Needs-You typed intents, server-side park recognition (exit 81 + .park.json), sentinel parked-run guard, POST /api/resume, Patch 72

## Target current state

FIRST-STOP REPORT — RunCommitmentGovernor (/Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/run-commitment-governor.js, required by orchestrator.js line 29, instantiated line 104): a PURE run-level decision unit. evaluate(snapshot) turns cycle count, active agents, goals, artifact audit, synthesis commit, provider errors, and plan status into a bounded decision {spawnAllowed, rateLimited, requiresArtifactCommitment, shouldStopForCompletion, shouldStopForBlockedRun, strategic/urgent spawn budgets, reasonCodes, nextActions}. It never spawns, never writes files, never talks to the server. Its decisions reach the server only as durable receipts: index.js loadActiveRunTruth() reads <runDir>/commitment-governor-receipts.jsonl (latest line) into runTruth.commitmentDecision, which buildStatusContract surfaces as health.supervision (shouldStopForBlockedRun/reasonCodes/appliedActions) and folds into lifecycle 'blocked'. Component 4.5 builds WITH this pattern — durable run-dir evidence in, derived status out, no second store — it does not modify the governor.

SERVER STATE (cosmo23/server/index.js, 2837 lines): module-level `let activeContext` / `let isLaunching` (lines 214-215). launchPreparedResearch (line 1021, Patch 50) is the single choke point all launches flow through (POST /api/launch → launchResearch → it; research-run adapter; sentinel relauncher). POST /api/stop (line 2025) has two branches, both notify the sentinel userInitiated:true; the active branch captures runPath/runName before stopAll and clears context in finally. cosmo-exit handler (line 389) receives {code, signal} from ProcessManager (proc.on('exit') → processes.delete → emit), clears activeContext, logs generic "ended", calls runSentinel.notifyRunEnded non-user. GET /api/status (line 2104) builds the status contract with runTruth + sentinel public state and flattens wedged/heartbeat; GET /api/health (line 1098) and /api/watch/logs (line 2146) build it without runTruth. readJsonFileIfPresent is a hoisted function declaration at line 2069 (already referenced from line 370 — precedent for forward references). parsePositiveInt at line 432, same hoisting precedent (used at line 374).

RUN SENTINEL (server/lib/run-sentinel.js, Patch 71): progress-only wedge detection (<runDir>/.heartbeat lastCycleEndTs), context_without_process death detection, S2 stuck-breaker check, S3 watchdog-phase skip, bounded ladder persisted to <runDir>/.sentinel.json, user-stop-is-final semantics, pendingRelaunch retry path when no active context. createContinuationRelauncher (exported, line 152) is the direct-runPath continuation: builds a brain object from runPath + metadata.json replay (sha1(runPath).slice(0,16) id convention), mirrors launchResearch's 409/isLaunching guards, calls launchPreparedResearch — this is the Phase 2 cd23e6e4 machinery R2 says resume must reuse. It has NO park awareness: a parked engine (writes .park.json, exits 81) would be remediated as engine_process_died if the sentinel's 60s check fires in the exit window, and a parking engine mid-guarded-save would eventually trip wedged_no_cycle_progress. Exit 86 is deliberately NOT special-cased (S1) — exit 81 park recognition must pair the code WITH the .park.json file, keeping S1 intact for every real death.

STATUS CONTRACT (server/lib/status-contract.js): buildStatusContract already demonstrates the additive pattern to follow exactly — wedged/sentinel fields added in parallel, lifecycle value set unchanged (Patch 9 compat comment at lines 70-73). Its own test (server/lib/status-contract.test.js, 8 node:test tests) asserts no exact key sets, so additive fields are safe (verified green against the patched copy).

PARK MACHINERY: does NOT exist anywhere in the tree — grepped; only comment-word coincidences (cycle-watchdog.js:52 "run is parked", model-catalog "Spark"). Component 4.1 (engine half) is being proposed in parallel; this component defines the server half of the R2 contract: <logsDir>/.park.json == <runPath>/.park.json (the engine's logsDir is the run dir — same resolution the sentinel uses for .heartbeat), payload {reason, lane, at, resumable: true}, exit code 81 (no collision: watchdog uses 86).

UI CONSUMER (public/app.js loadStatus(), line ~1690): polls /api/status and reads status.running, status.activeContext, status.dashboardUrl, status.ports, status.wsUrl only — none of the new fields, nothing breaks. A future UI Needs-You surface would read the flattened `intents` array (or health.intents); each intent carries id/type/severity/actions so it can render buttons mapping to POST /api/resume, POST /api/stop, POST /api/launch. No UI is built per the brief.

TEST PIN DISCOVERED (would have broken silently): tests/cosmo23/run-sentinel.test.cjs contains a source-text pin test (line ~850) that slices index.js from 'const runSentinel = createRunSentinel({' to the first '\n});' and asserts the block includes 'createContinuationRelauncher({'. Hoisting the relauncher (required for reuse by /api/resume) breaks that pin, so the pin is updated to assert the STRONGER invariant: hoisted relauncher present and replaying launchPreparedResearch, sentinel block uses `relaunch: continuationRelauncher`, resume block uses `continuationRelauncher(info)`, no catalog launchResearch anywhere in those blocks. No other test pins index.js text in the edited regions (grepped all suites that read server/index.js).

PATCH LOG: Patch 71 is the last entry; the doc ends with its final paragraph. Next free number is 72. VALIDATION: every anchor below verified to occur exactly once in the current repo files; all edits applied to byte-identical scratch copies; node --check clean on operator-intents.js, run-sentinel.js, status-contract.js, index.js; full scratch regression 61/61 green (19 new operator-intents tests + 34 run-sentinel tests including the updated pin + 8 status-contract tests); zero trailing whitespace in any emitted code. Repo files were never modified. Concurrent-tree note: at validation time the worktree also showed another session's in-flight edits to cosmo23/server/config/model-catalog.js and package.json — anchors were validated against the live file contents at 2026-07-22; re-verify the package.json anchor still matches at apply time.

## CHANGE: cosmo23/server/lib/operator-intents.js

NEW FILE (create FIRST — run-sentinel.js will require it). Owns the server-side park-file contract (PARK_STATE_FILENAME '.park.json', PARK_EXIT_CODE 81, SPEND_STATE_FILENAME '.spend.json') and everything derived from it: readParkFile/archiveParkFile/restoreParkFile (archive = rename to .park.json.last — evidence never deleted, R1), normalizeParkDetail, summarizeSpendPressure, deriveOperatorIntents (pure, fixture-testable: run_parked action intent with actions ['resume','stop'], run_wedged_escalated from sentinel.escalated with actions ['relaunch','stop'], advisory spend_warning at/over config.spendWarnRatio of a configured budget — no budget, no intent), createParkedRunResolver (active context park -> in-memory last park re-verified on disk -> TTL-cached newest-.park.json scan of the runs dir so server restarts do not forget a parked run), and createResumeHandler (Express-free route factory: 409 already_running, 409 not_parked, archive-before-relaunch, restore-on-failure).

### Code
```js
'use strict';

// COSMO23 operator rails (Phase 4, component 4.5) — Needs-You typed intents.
//
// Intents are DERIVED, never stored: every read recomputes them from durable
// run-dir evidence (<runDir>/.park.json, sentinel public state, the spend
// meter file) so there is no second source of truth to drift. Three sources:
//
//   1. run_parked           — the engine parked itself (R2 contract: graceful
//                             pause, guarded save, exit code 81, park state
//                             persisted to <runDir>/.park.json with
//                             { reason, lane, at, resumable: true }). Actions:
//                             resume (POST /api/resume) or stop (POST
//                             /api/stop archives the park file).
//   2. run_wedged_escalated — the run sentinel exhausted its bounded
//                             remediation ladder (existing
//                             health.sentinel.escalated — Patch 71). Actions:
//                             relaunch or stop.
//   3. spend_warning        — advisory only: the active run's spend meter
//                             (<runDir>/.spend.json, Phase 4 spend metering)
//                             is at/over the warn ratio of a configured
//                             budget. No budget configured = no intent —
//                             never an estimate.
//
// The server-side park-file CONTRACT lives here: PARK_STATE_FILENAME /
// PARK_EXIT_CODE / readParkFile are the single authority that run-sentinel.js
// and index.js both import. The engine's park machinery (component 4.1)
// writes the file; this module is the only server-side reader/mover of it.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PARK_STATE_FILENAME = '.park.json';
const PARK_ARCHIVE_SUFFIX = '.last';
const PARK_EXIT_CODE = 81;
const SPEND_STATE_FILENAME = '.spend.json';

const DEFAULT_SPEND_WARN_RATIO = 0.8;
const DEFAULT_SCAN_TTL_MS = 30 * 1000;

function parkFilePath(runPath) {
  return path.join(runPath, PARK_STATE_FILENAME);
}

// Presence of a parseable JSON object is the parked signal; a corrupt or
// missing file reads as "not parked" (same tolerance as the sentinel's
// heartbeat reader — the engine writes the file tmp+rename, so torn files
// are rare and transient).
async function readParkFile(runPath) {
  if (typeof runPath !== 'string' || runPath.length === 0) return null;
  try {
    const parsed = JSON.parse(await fsp.readFile(parkFilePath(runPath), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Archive <runDir>/.park.json to .park.json.last. Evidence is never deleted
// (R1) — rename preserves the payload. Returns true when a file was moved,
// false when there was nothing to move (ENOENT); rethrows anything else.
async function archiveParkFile(runPath) {
  const src = parkFilePath(runPath);
  try {
    await fsp.rename(src, `${src}${PARK_ARCHIVE_SUFFIX}`);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

// Undo a resume's archive when the relaunch failed — the run must stay
// visibly parked instead of ending up neither parked nor running. Best
// effort: returns true when the park file was restored.
async function restoreParkFile(runPath) {
  const target = parkFilePath(runPath);
  try {
    await fsp.rename(`${target}${PARK_ARCHIVE_SUFFIX}`, target);
    return true;
  } catch {
    return false;
  }
}

// { runPath, runName, brainId, park } -> flat status-contract park detail.
function normalizeParkDetail(parkedRun) {
  if (!parkedRun || typeof parkedRun !== 'object' || !parkedRun.runPath) return null;
  const park = parkedRun.park && typeof parkedRun.park === 'object' ? parkedRun.park : {};
  return {
    runPath: parkedRun.runPath,
    runName: parkedRun.runName || path.basename(parkedRun.runPath),
    brainId: parkedRun.brainId || null,
    reason: typeof park.reason === 'string' ? park.reason : null,
    lane: typeof park.lane === 'string' ? park.lane : null,
    at: typeof park.at === 'string' ? park.at : null,
    resumable: park.resumable !== false,
  };
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Spend meter probe (R4 shape, tolerant): cumulative usage under `totals`
// (or legacy flat totalTokens/totalUsd), budget under `budget` (or flat
// maxTokens/maxUsd). Anything the meter does not provide yields no advisory.
function summarizeSpendPressure(spend) {
  if (!spend || typeof spend !== 'object') return null;
  const totals = spend.totals && typeof spend.totals === 'object' ? spend.totals : {};
  const budget = spend.budget && typeof spend.budget === 'object' ? spend.budget : {};
  const candidates = [
    {
      unit: 'tokens',
      used: toFiniteNumber(totals.tokens ?? spend.totalTokens),
      max: toFiniteNumber(budget.maxTokens ?? spend.maxTokens),
    },
    {
      unit: 'usd',
      used: toFiniteNumber(totals.usd ?? spend.totalUsd),
      max: toFiniteNumber(budget.maxUsd ?? spend.maxUsd),
    },
  ];
  let worst = null;
  for (const candidate of candidates) {
    if (candidate.used === null || candidate.max === null || candidate.max <= 0) continue;
    const ratio = candidate.used / candidate.max;
    if (!worst || ratio > worst.ratio) worst = { unit: candidate.unit, used: candidate.used, max: candidate.max, ratio };
  }
  return worst;
}

// Pure derivation — fixture-testable, no I/O. `parked` is a resolver result
// ({ runPath, runName, brainId, park }), `sentinel` is
// runSentinel.getPublicState(), `spend` is the parsed .spend.json of the
// ACTIVE run (or null). Action intents come first, advisories last.
function deriveOperatorIntents({ parked = null, sentinel = null, spend = null, config = {} } = {}) {
  const intents = [];

  const parkDetail = normalizeParkDetail(parked);
  if (parkDetail) {
    intents.push({
      id: `run_parked:${parkDetail.runPath}`,
      type: 'run_parked',
      severity: 'action',
      runName: parkDetail.runName,
      runPath: parkDetail.runPath,
      brainId: parkDetail.brainId,
      reason: parkDetail.reason,
      lane: parkDetail.lane,
      since: parkDetail.at,
      resumable: parkDetail.resumable,
      actions: ['resume', 'stop'],
    });
  }

  if (sentinel && sentinel.escalated === true) {
    intents.push({
      id: `run_wedged_escalated:${sentinel.runPath || 'unknown'}`,
      type: 'run_wedged_escalated',
      severity: 'action',
      runName: sentinel.runName || null,
      runPath: sentinel.runPath || null,
      reason: sentinel.lastReason || null,
      since: sentinel.escalatedAt || null,
      attempts: toFiniteNumber(sentinel.attempts),
      maxAttempts: toFiniteNumber(sentinel.maxAttempts),
      actions: ['relaunch', 'stop'],
    });
  }

  const warnRatioRaw = toFiniteNumber(config.spendWarnRatio);
  const warnRatio = warnRatioRaw !== null && warnRatioRaw > 0 ? warnRatioRaw : DEFAULT_SPEND_WARN_RATIO;
  const pressure = summarizeSpendPressure(spend);
  if (pressure && pressure.ratio >= warnRatio) {
    intents.push({
      id: `spend_warning:${pressure.unit}`,
      type: 'spend_warning',
      severity: 'advisory',
      level: pressure.ratio >= 1 ? 'critical' : 'warn',
      unit: pressure.unit,
      used: pressure.used,
      budget: pressure.max,
      ratio: Math.round(pressure.ratio * 1000) / 1000,
      actions: [],
    });
  }

  return intents;
}

// Resolve "the parked run" (active-or-last, with a TTL-cached runs-dir scan
// as the restart-durable fallback). Order:
//   1. active context runPath — a park landing right now (exit window);
//   2. the last park exit recorded in memory (re-verified on disk — resume
//      and stop archive the file, which retires the intent);
//   3. newest .park.json under runsPath (survives server restarts).
function createParkedRunResolver({
  getActiveContext,
  getLastParked = () => null,
  runsPath,
  readPark = readParkFile,
  fsImpl = fsp,
  now = () => Date.now(),
  scanTtlMs = DEFAULT_SCAN_TTL_MS,
} = {}) {
  if (typeof getActiveContext !== 'function') {
    throw new TypeError('createParkedRunResolver requires a getActiveContext() dependency');
  }
  if (typeof runsPath !== 'string' || runsPath.length === 0) {
    throw new TypeError('createParkedRunResolver requires a runsPath');
  }
  let scanCache = null; // { at, result } — negative results cache too

  async function scanForParkedRun() {
    if (scanCache && now() - scanCache.at < scanTtlMs) return scanCache.result;
    let result = null;
    try {
      const entries = await fsImpl.readdir(runsPath, { withFileTypes: true });
      let newestRank = -1;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const runPath = path.join(runsPath, entry.name);
        const park = await readPark(runPath);
        if (!park) continue;
        const atMs = typeof park.at === 'string' ? Date.parse(park.at) : NaN;
        const rank = Number.isFinite(atMs) ? atMs : 0;
        if (rank >= newestRank) {
          newestRank = rank;
          result = {
            runPath,
            runName: typeof park.runName === 'string' && park.runName ? park.runName : entry.name,
            brainId: typeof park.brainId === 'string' && park.brainId ? park.brainId : null,
            park,
          };
        }
      }
    } catch {
      result = null;
    }
    scanCache = { at: now(), result };
    return result;
  }

  return {
    async resolve() {
      const active = getActiveContext();
      if (active && typeof active.runPath === 'string' && active.runPath) {
        const park = await readPark(active.runPath);
        if (park) {
          return {
            runPath: active.runPath,
            runName: active.runName || path.basename(active.runPath),
            brainId: active.brainId || null,
            park,
          };
        }
      }
      const last = getLastParked();
      if (last && typeof last.runPath === 'string' && last.runPath) {
        const park = await readPark(last.runPath);
        if (park) {
          return {
            runPath: last.runPath,
            runName: last.runName || path.basename(last.runPath),
            brainId: last.brainId || null,
            park,
          };
        }
      }
      return scanForParkedRun();
    },
    invalidate() {
      scanCache = null;
    },
  };
}

// POST /api/resume route factory. Kept as a factory with injected deps so
// the flow (validate parked -> archive park file -> relaunch through the
// direct-runPath continuation -> restore on failure) is testable without an
// Express server. `relaunch` MUST be the createContinuationRelauncher
// instance — the same metadata.json replay the sentinel uses (Patch 71) —
// never catalog-backed launchResearch (it cannot see mid-run brains).
function createResumeHandler({
  getActiveContext,
  getIsLaunching,
  resolveParkedRun,
  relaunch,
  readPark = readParkFile,
  archivePark = archiveParkFile,
  restorePark = restoreParkFile,
  onResumed = () => {},
  log = () => {},
} = {}) {
  for (const [name, value] of Object.entries({
    getActiveContext, getIsLaunching, resolveParkedRun, relaunch,
  })) {
    if (typeof value !== 'function') {
      throw new TypeError(`createResumeHandler requires a ${name}() dependency`);
    }
  }

  return async function handleResume(req, res) {
    try {
      if (getActiveContext() || getIsLaunching()) {
        return res.status(409).json({
          success: false,
          code: 'already_running',
          error: 'COSMO is already running — stop it before resuming a parked run',
        });
      }

      const requestedPath = typeof req?.body?.runPath === 'string' && req.body.runPath
        ? req.body.runPath
        : null;
      let parkedRun = await resolveParkedRun();
      if (requestedPath && (!parkedRun || parkedRun.runPath !== requestedPath)) {
        const park = await readPark(requestedPath);
        parkedRun = park
          ? {
            runPath: requestedPath,
            runName: (typeof park.runName === 'string' && park.runName) || path.basename(requestedPath),
            brainId: (typeof park.brainId === 'string' && park.brainId) || null,
            park,
          }
          : null;
      }
      if (!parkedRun) {
        return res.status(409).json({
          success: false,
          code: 'not_parked',
          error: 'No parked run to resume',
        });
      }

      // Archive BEFORE relaunch: a .park.json still present beside a live
      // engine would make the sentinel skip wedge monitoring forever. Losing
      // the archive race to a concurrent resume is a clean 409.
      const archived = await archivePark(parkedRun.runPath);
      if (!archived) {
        return res.status(409).json({
          success: false,
          code: 'not_parked',
          error: 'No parked run to resume',
        });
      }

      try {
        const result = await relaunch({
          runPath: parkedRun.runPath,
          runName: parkedRun.runName,
          brainId: parkedRun.brainId,
        });
        onResumed(parkedRun);
        log('info',
          `Resumed parked run "${parkedRun.runName}" (park reason was: ${parkedRun.park?.reason || 'unrecorded'})`);
        const { brainPath, brainSourceType, ...responsePayload } = result || {};
        return res.json({
          ...responsePayload,
          success: true,
          resumed: true,
          park: normalizeParkDetail(parkedRun),
        });
      } catch (error) {
        const restored = await restorePark(parkedRun.runPath);
        log('error',
          `Resume of parked run "${parkedRun.runName}" failed: ${error?.message || error}`
          + (restored ? ' — park state restored' : ' — PARK STATE COULD NOT BE RESTORED'));
        throw error;
      }
    } catch (error) {
      return res.status(error?.statusCode || 500).json({
        success: false,
        error: error?.message || String(error),
      });
    }
  };
}

module.exports = {
  PARK_STATE_FILENAME,
  PARK_ARCHIVE_SUFFIX,
  PARK_EXIT_CODE,
  SPEND_STATE_FILENAME,
  readParkFile,
  archiveParkFile,
  restoreParkFile,
  normalizeParkDetail,
  summarizeSpendPressure,
  deriveOperatorIntents,
  createParkedRunResolver,
  createResumeHandler,
};

```

## CHANGE: cosmo23/server/lib/run-sentinel.js

Edit 1/5 — import the park-file contract from operator-intents (one-directional dependency, no cycle: operator-intents never imports run-sentinel). Replace the anchor text with the code text.

### Anchor
```
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

```

### Code
```js
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
// Phase 4 (component 4.5): the server-side park-file contract is owned by
// operator-intents.js — a parked run (<runDir>/.park.json, engine exit 81)
// is deliberately stopped and must never be remediated by the sentinel.
const { readParkFile: defaultReadParkFile } = require('./operator-intents');

```

## CHANGE: cosmo23/server/lib/run-sentinel.js

Edit 2/5 — injectable park reader on the constructor (mirrors readHeartbeat/readWatchdog pattern; tests may inject, default is the real operator-intents reader).

### Anchor
```
    this.readWatchdog = typeof deps.readWatchdog === 'function' ? deps.readWatchdog : defaultReadWatchdog;

```

### Code
```js
    this.readWatchdog = typeof deps.readWatchdog === 'function' ? deps.readWatchdog : defaultReadWatchdog;
    this.readParkFile = typeof deps.readParkFile === 'function' ? deps.readParkFile : defaultReadParkFile;

```

## CHANGE: cosmo23/server/lib/run-sentinel.js

Edit 3/5 — log-once flag for the parked skip (constructor only; the anchor is unique because of the trailing '// Epoch ms' comment — the same two flag lines also appear in notifyRunEnded, do not touch those).

### Anchor
```
    this.missingHeartbeatLogged = false;
    this.watchdogPhaseLogged = false;
    // Epoch ms of the most recent user-initiated stop.
```

### Code
```js
    this.missingHeartbeatLogged = false;
    this.watchdogPhaseLogged = false;
    this.parkedSkipLogged = false;
    // Epoch ms of the most recent user-initiated stop.
```

## CHANGE: cosmo23/server/lib/run-sentinel.js

Edit 4/5 — a park cancels a pending relaunch retry (the no-active-context path would otherwise resurrect a parked run on a later tick).

### Anchor
```
      if (this.pendingRelaunch && this.tracked && this.state) {
        return this._remediate(
```

### Code
```js
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
```

## CHANGE: cosmo23/server/lib/run-sentinel.js

Edit 5/5 — the main parked guard in _evaluate: placed after loadStateFor and BEFORE both remediation triggers (context_without_process death check and the wedge staleness check), so it covers the park-exit window AND a long park-save (process online, cycles stopped). New additive outcome value 'parked'.

### Anchor
```
    const state = await this.loadStateFor(context);

    const startedAtMs = parseTimestampMs(context.startedAt);
```

### Code
```js
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
```

## CHANGE: cosmo23/server/lib/status-contract.js

Edit 1/3 — new optional inputs `park` and `intents` in the buildStatusContract signature (additive; absent inputs produce compat defaults).

### Anchor
```
  sentinel = null,
  heartbeat = undefined,

```

### Code
```js
  sentinel = null,
  park = null,
  intents = null,
  heartbeat = undefined,

```

## CHANGE: cosmo23/server/lib/status-contract.js

Edit 2/3 — compute the parked flag: true only when the parked run is not superseded by a DIFFERENT active run (lifecycle value set untouched, exactly the Phase 2 wedged pattern).

### Anchor
```
  else if (cosmoMainOnline) lifecycle = 'process_without_context';

  return {
```

### Code
```js
  else if (cosmoMainOnline) lifecycle = 'process_without_context';

  // Phase 4 (component 4.5): parked/park/intents are additive (Patch 9
  // compat), mirroring the wedged/sentinel pattern — `lifecycle` keeps its
  // original value set. `park` is the normalized park detail of the
  // active-or-last parked run; `parked` is true only when that run is not
  // superseded by a DIFFERENT active run.
  const parkDetail = park && typeof park === 'object' ? park : null;
  const parked = !!parkDetail
    && (!hasActiveContext || parkDetail.runPath === (activeContext?.runPath || null));

  return {
```

## CHANGE: cosmo23/server/lib/status-contract.js

Edit 3/3 — additive contract fields next to the existing wedged/sentinel pair.

### Anchor
```
    wedged: sentinel?.escalated === true,
    sentinel: sentinel || null,

```

### Code
```js
    wedged: sentinel?.escalated === true,
    sentinel: sentinel || null,
    parked,
    park: parkDetail,
    intents: Array.isArray(intents) ? intents : [],

```

## CHANGE: cosmo23/server/index.js

Edit 1/13 (A) — require the operator-intents module next to the run-sentinel require.

### Anchor
```
const { createRunSentinel, createContinuationRelauncher } = require('./lib/run-sentinel');

```

### Code
```js
const { createRunSentinel, createContinuationRelauncher } = require('./lib/run-sentinel');
const {
  PARK_EXIT_CODE,
  SPEND_STATE_FILENAME,
  readParkFile,
  archiveParkFile,
  normalizeParkDetail,
  deriveOperatorIntents,
  createParkedRunResolver,
  createResumeHandler,
} = require('./lib/operator-intents');

```

## CHANGE: cosmo23/server/index.js

Edit 2/13 (B) — lastParkedRun in-memory fast path next to the other launcher state lets.

### Anchor
```
let activeContext = null;
let isLaunching = false;
let brainOperationRuntime = null;

```

### Code
```js
let activeContext = null;
let isLaunching = false;
// Phase 4 (component 4.5): the most recent park exit (engine exit code 81
// with <runDir>/.park.json present). In-memory fast path only — the parked
// run resolver re-verifies the park file on disk every read and falls back
// to scanning the runs dir, so a server restart does not forget a parked run.
let lastParkedRun = null;
let brainOperationRuntime = null;

```

## CHANGE: cosmo23/server/index.js

Edit 3/13 (C1) — hoist the continuation relauncher so the sentinel and POST /api/resume share ONE instance (reuse, don't duplicate). NOTE: this refactor requires the run-sentinel.test.cjs pin update (separate change below) — the old pin sliced the createRunSentinel block and expected the inline factory call.

### Anchor
```
const sentinelSettings = initialConfig?.config?.sentinel || {};

```

### Code
```js
// Phase 4 (component 4.5): the resume path reuses the SAME direct-runPath
// continuation relauncher the sentinel uses (metadata.json replay through
// launchPreparedResearch — Patch 71) — hoisted so POST /api/resume and the
// sentinel cannot drift.
const continuationRelauncher = createContinuationRelauncher({
  getActiveContext: () => activeContext,
  getIsLaunching: () => isLaunching,
  setIsLaunching: (value) => { isLaunching = value; },
  launchPreparedResearch: (brain, payload, req) => launchPreparedResearch(brain, payload, req),
  readJsonFile: readJsonFileIfPresent,
});
const sentinelSettings = initialConfig?.config?.sentinel || {};

```

## CHANGE: cosmo23/server/index.js

Edit 4/13 (C2) — the sentinel's relaunch dep becomes the hoisted instance (replaces the whole inline createContinuationRelauncher({...}) block inside createRunSentinel).

### Anchor
```
  relaunch: createContinuationRelauncher({
    getActiveContext: () => activeContext,
    getIsLaunching: () => isLaunching,
    setIsLaunching: (value) => { isLaunching = value; },
    launchPreparedResearch: (brain, payload, req) => launchPreparedResearch(brain, payload, req),
    readJsonFile: readJsonFileIfPresent,
  }),

```

### Code
```js
  relaunch: continuationRelauncher,

```

## CHANGE: cosmo23/server/index.js

Edit 5/13 (D) — intent config + parked-run resolver + park-aware cosmo-exit handler (replaces the entire existing cosmo-exit handler block). Exit 81 WITH a readable .park.json records lastParkedRun and logs 'parked ... resumable via POST /api/resume'; every other exit keeps identical semantics (Patch 71 S1: no exit-code special-casing for real deaths). parsePositiveInt and readJsonFileIfPresent are hoisted function declarations — same precedent as the existing sentinel config directly above.

### Anchor
```
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

### Code
```js
// Phase 4 (component 4.5) — Needs-You intents plumbing. Intents are derived
// on every status read, never stored; the resolver finds "the parked run"
// (active context -> last recorded park -> TTL-cached runs-dir scan).
const intentSettings = initialConfig?.config?.intents || {};
const spendWarnRatioRaw = Number.parseFloat(
  process.env.COSMO23_INTENT_SPEND_WARN_RATIO ?? String(intentSettings.spendWarnRatio ?? ''),
);
const intentConfig = {
  spendWarnRatio: Number.isFinite(spendWarnRatioRaw) && spendWarnRatioRaw > 0
    ? spendWarnRatioRaw
    : 0.8,
};
const parkedRunResolver = createParkedRunResolver({
  getActiveContext: () => activeContext,
  getLastParked: () => lastParkedRun,
  runsPath: LOCAL_RUNS_PATH,
  scanTtlMs: parsePositiveInt(process.env.COSMO23_INTENT_SCAN_TTL_MS,
    parsePositiveInt(intentSettings.scanTtlMs, 30 * 1000)),
});

processManager.on('cosmo-exit', ({ code, signal }) => {
  if (!activeContext) return;
  const runName = activeContext.runName;
  const runPath = activeContext.runPath;
  const brainId = activeContext.brainId || null;
  activeContext = null;
  (async () => {
    // Phase 4 (R2) park recognition: exit code 81 WITH <runDir>/.park.json
    // is a deliberate, resumable pause — not a crash, not wedged. Anything
    // else keeps the original semantics (no exit-code special-casing,
    // Patch 71 S1: the sentinel handles every real death uniformly).
    const park = code === PARK_EXIT_CODE ? await readParkFile(runPath) : null;
    if (park) {
      lastParkedRun = { runPath, runName, brainId };
      parkedRunResolver.invalidate();
      processManager.recordLog('Launcher', 'info',
        `Run "${runName}" parked (exit ${PARK_EXIT_CODE}, reason: ${park.reason || 'unrecorded'}, `
        + `lane: ${park.lane || 'unrecorded'}) — resumable via POST /api/resume`);
    } else {
      processManager.recordLog('Launcher', 'info',
        `Run "${runName}" ended (code: ${code}, signal: ${signal || 'none'}) — cleared activeContext`);
    }
    // Run completion cleans up sentinel state; the sentinel keeps it when the
    // exit was its own remediation stop (and skips parked runs entirely).
    runSentinel.notifyRunEnded({ runPath, runName }).catch(() => {});
  })().catch(() => {});
});

```

## CHANGE: cosmo23/server/index.js

Edit 6/13 (E) — /api/health carries park + intents through the status contract (assembleOperatorSignals is a hoisted function declaration defined near /api/status in Edit 11/13).

### Anchor
```
app.get('/api/health', async (_req, res) => {
  const processStatus = processManager.getStatus();
  const health = buildStatusContract({
    activeContext,
    processStatus,
    isLaunching,
    sentinel: runSentinel.getPublicState(),
    ports: { app: PORT, websocket: WS_PORT, dashboard: DASHBOARD_PORT, mcpHttp: MCP_HTTP_PORT },
  });

```

### Code
```js
app.get('/api/health', async (_req, res) => {
  const processStatus = processManager.getStatus();
  const operatorSignals = await assembleOperatorSignals();
  const health = buildStatusContract({
    activeContext,
    processStatus,
    isLaunching,
    sentinel: runSentinel.getPublicState(),
    park: operatorSignals.park,
    intents: operatorSignals.intents,
    ports: { app: PORT, websocket: WS_PORT, dashboard: DASHBOARD_PORT, mcpHttp: MCP_HTTP_PORT },
  });

```

## CHANGE: cosmo23/server/index.js

Edit 7/13 (I) — launchPreparedResearch defensively archives stale park state on ANY launch of a run dir (a .park.json beside a live engine would blind the sentinel's wedge monitoring; covers manual /api/launch continuations of a parked run — /api/resume archives explicitly before reaching here).

### Anchor
```
  const setupConfig = await readSetupConfig();
  const launchSettings = serializeLaunchSettings(payload, setupConfig);
  processManager.clearLogs();
  processManager.recordLog('Launcher', 'info', `Preparing run ${brain.name}`);

```

### Code
```js
  const setupConfig = await readSetupConfig();
  const launchSettings = serializeLaunchSettings(payload, setupConfig);
  processManager.clearLogs();
  processManager.recordLog('Launcher', 'info', `Preparing run ${brain.name}`);

  // Phase 4 (component 4.5): ANY launch of this run dir clears stale park
  // state (archive, never delete). A .park.json left beside a live engine
  // would make the sentinel treat the run as parked and skip wedge
  // monitoring. /api/resume archives explicitly before it gets here; this
  // covers manual /api/launch continuations of a parked run.
  try {
    const clearedStalePark = await archiveParkFile(brain.path);
    if (clearedStalePark) {
      if (lastParkedRun && lastParkedRun.runPath === brain.path) lastParkedRun = null;
      parkedRunResolver.invalidate();
      processManager.recordLog('Launcher', 'info',
        `Cleared stale park state for run ${brain.name} (.park.json archived)`);
    }
  } catch (error) {
    processManager.recordLog('Launcher', 'error',
      `Could not clear stale park state for run ${brain.name}: ${error?.message || error}`);
  }

```

## CHANGE: cosmo23/server/index.js

Edit 8/13 (G1) — /api/stop not_running branch: a user stop is also the 'stop' action on a run_parked intent — dismiss the parked run (archive, never delete) and report parkCleared additively in the response.

### Anchor
```
    runSentinel.notifyRunEnded({ userInitiated: true }).catch(() => {});
    return res.json({
      status: 'not_running',
      message: 'No research running'
    });
  }

```

### Code
```js
    runSentinel.notifyRunEnded({ userInitiated: true }).catch(() => {});
    // Phase 4 (component 4.5): a user stop is also the 'stop' action on a
    // run_parked intent — dismiss the parked run by archiving its park file
    // (.park.json -> .park.json.last, evidence preserved; the run stays a
    // plain resumable continuation via /api/launch).
    let parkCleared = false;
    let parkedRunName = null;
    try {
      const parkedRun = await parkedRunResolver.resolve();
      if (parkedRun) {
        parkCleared = await archiveParkFile(parkedRun.runPath);
        if (parkCleared) {
          parkedRunName = parkedRun.runName;
          if (lastParkedRun && lastParkedRun.runPath === parkedRun.runPath) lastParkedRun = null;
          parkedRunResolver.invalidate();
          processManager.recordLog('Launcher', 'info',
            `User stop dismissed parked run "${parkedRun.runName}" — park state archived`);
        }
      }
    } catch {
      parkCleared = false;
    }
    return res.json({
      status: 'not_running',
      message: parkCleared
        ? `No research running — parked run "${parkedRunName}" dismissed`
        : 'No research running',
      parkCleared
    });
  }

```

## CHANGE: cosmo23/server/index.js

Edit 9/13 (G2) — /api/stop active branch finally: also dismiss park state for the stopping run dir (covers a stop landing in the park-exit window), fire-and-forget like the adjacent notifyRunEnded.

### Anchor
```
  } finally {
    activeContext = null;
    // User stop is FINAL: force-clears the remediation ladder and the wedged
    // flag even mid-remediation (state archived to .sentinel.json.last, never
    // silently deleted). Also covers escalated dead runs, whose stop produces
    // no cosmo-exit and would otherwise stay wedged until a server restart.
    runSentinel.notifyRunEnded({ runPath, runName, userInitiated: true }).catch(() => {});
  }

```

### Code
```js
  } finally {
    activeContext = null;
    // User stop is FINAL: force-clears the remediation ladder and the wedged
    // flag even mid-remediation (state archived to .sentinel.json.last, never
    // silently deleted). Also covers escalated dead runs, whose stop produces
    // no cosmo-exit and would otherwise stay wedged until a server restart.
    runSentinel.notifyRunEnded({ runPath, runName, userInitiated: true }).catch(() => {});
    // Phase 4 (component 4.5): if the engine had parked (or was parking) in
    // this run dir, the user stop also dismisses the park — best-effort and
    // fire-and-forget, mirroring notifyRunEnded above.
    archiveParkFile(runPath).then((cleared) => {
      if (cleared) {
        if (lastParkedRun && lastParkedRun.runPath === runPath) lastParkedRun = null;
        parkedRunResolver.invalidate();
        processManager.recordLog('Launcher', 'info',
          `User stop dismissed park state for run "${runName}"`);
      }
    }).catch(() => {});
  }

```

## CHANGE: cosmo23/server/index.js

Edit 10/13 (H) — POST /api/resume endpoint, inserted between the /api/stop route and the readJsonFileIfPresent declaration. Wires the operator-intents route factory to the shared continuation relauncher.

### Anchor
```
async function readJsonFileIfPresent(filePath) {

```

### Code
```js
// Phase 4 (component 4.5) — resume a parked run (the 'resume' action on a
// run_parked intent). Validates parked state, archives <runDir>/.park.json
// to .park.json.last, then relaunches through the SAME direct-runPath
// continuation the sentinel uses (metadata.json replay — Patch 71); a
// failed relaunch restores the park file so the run stays visibly parked.
// 409 when nothing is parked (code 'not_parked') or a run is already
// active/launching (code 'already_running'). Optional body { runPath }
// disambiguates when multiple parked runs exist.
app.post('/api/resume', createResumeHandler({
  getActiveContext: () => activeContext,
  getIsLaunching: () => isLaunching,
  resolveParkedRun: () => parkedRunResolver.resolve(),
  relaunch: (info) => continuationRelauncher(info),
  onResumed: (parkedRun) => {
    if (lastParkedRun && lastParkedRun.runPath === parkedRun.runPath) lastParkedRun = null;
    parkedRunResolver.invalidate();
  },
  log: (level, message) => processManager.recordLog('Launcher', level, message),
}));

async function readJsonFileIfPresent(filePath) {

```

## CHANGE: cosmo23/server/index.js

Edit 11/13 (F1) — assembleOperatorSignals helper (never throws — status endpoints stay available on resolver/spend read problems) + /api/status assembles it after runTruth.

### Anchor
```
app.get('/api/status', async (req, res) => {
  const processStatus = processManager.getStatus();
  const runTruth = await loadActiveRunTruth(activeContext);

```

### Code
```js
// Phase 4 (component 4.5): operator signals for the status contract —
// resolved parked run (normalized detail) + derived Needs-You intents.
// Never throws: a resolver or spend-meter read problem degrades to "no
// signals" — the status endpoints must stay available regardless.
async function assembleOperatorSignals() {
  let parkedRun = null;
  try {
    parkedRun = await parkedRunResolver.resolve();
  } catch {
    parkedRun = null;
  }
  let spend = null;
  if (activeContext && activeContext.runPath) {
    spend = await readJsonFileIfPresent(path.join(activeContext.runPath, SPEND_STATE_FILENAME));
  }
  const intents = deriveOperatorIntents({
    parked: parkedRun,
    sentinel: runSentinel.getPublicState(),
    spend,
    config: intentConfig,
  });
  return { park: normalizeParkDetail(parkedRun), intents };
}

app.get('/api/status', async (req, res) => {
  const processStatus = processManager.getStatus();
  const runTruth = await loadActiveRunTruth(activeContext);
  const operatorSignals = await assembleOperatorSignals();

```

## CHANGE: cosmo23/server/index.js

Edit 12/13 (F2) — /api/status buildStatusContract call gains the park + intents inputs.

### Anchor
```
  const health = buildStatusContract({
    activeContext,
    processStatus,
    isLaunching,
    runTruth,
    sentinel: runSentinel.getPublicState(),
    ports: { app: PORT, websocket: WS_PORT, dashboard: DASHBOARD_PORT, mcpHttp: MCP_HTTP_PORT },
  });

```

### Code
```js
  const health = buildStatusContract({
    activeContext,
    processStatus,
    isLaunching,
    runTruth,
    sentinel: runSentinel.getPublicState(),
    park: operatorSignals.park,
    intents: operatorSignals.intents,
    ports: { app: PORT, websocket: WS_PORT, dashboard: DASHBOARD_PORT, mcpHttp: MCP_HTTP_PORT },
  });

```

## CHANGE: cosmo23/server/index.js

Edit 13/13 (F3) — flattened parked/park/intents on the /api/status response body, mirroring the existing wedged flattening.

### Anchor
```
    lastHeartbeat: health.lastHeartbeat,
    wedged: health.wedged,
    heartbeat: health.heartbeat,

```

### Code
```js
    lastHeartbeat: health.lastHeartbeat,
    wedged: health.wedged,
    parked: health.parked,
    park: health.park,
    intents: health.intents,
    heartbeat: health.heartbeat,

```

## CHANGE: tests/cosmo23/run-sentinel.test.cjs

REQUIRED pin update (the old pin fails after the relauncher hoist): replace the index.js source-pin test. The invariant is preserved and strengthened — direct-path relauncher only, now provably shared by the sentinel AND /api/resume. Replace the entire old test block with the new one.

### Anchor
```
test('index.js wires the sentinel relaunch through the direct-path relauncher, not catalog resolution', async () => {
  const src = await fs.readFile(path.resolve(__dirname, '../../cosmo23/server/index.js'), 'utf8');
  const start = src.indexOf('const runSentinel = createRunSentinel({');
  assert.notEqual(start, -1, 'sentinel wiring block present');
  const end = src.indexOf('\n});', start);
  assert.notEqual(end, -1, 'sentinel wiring block closed');
  const block = src.slice(start, end);
  // Live-drill regression pin: catalog-backed launchResearch throws
  // "Brain not found" for young mid-run brains (ensureLocalBrainForLaunch →
  // resolveCatalogBrainBySelector only sees completed/queryable brains). The
  // relaunch leg must go straight to launchPreparedResearch from the tracked
  // run directory.
  assert.ok(block.includes('createContinuationRelauncher({'),
    'relaunch must use the direct-path relauncher');
  assert.ok(!block.includes('launchResearch('),
    'relaunch must not route through catalog-backed launchResearch');
});

```

### Code
```js
test('index.js wires the sentinel relaunch through the direct-path relauncher, not catalog resolution', async () => {
  const src = await fs.readFile(path.resolve(__dirname, '../../cosmo23/server/index.js'), 'utf8');
  // Live-drill regression pin: catalog-backed launchResearch throws
  // "Brain not found" for young mid-run brains (ensureLocalBrainForLaunch →
  // resolveCatalogBrainBySelector only sees completed/queryable brains). The
  // relaunch leg must go straight to launchPreparedResearch from the tracked
  // run directory. Phase 4 (component 4.5) hoisted the relauncher so the
  // sentinel and POST /api/resume share the SAME instance and cannot drift.
  const relauncherStart = src.indexOf('const continuationRelauncher = createContinuationRelauncher({');
  assert.notEqual(relauncherStart, -1, 'hoisted direct-path relauncher present');
  const relauncherEnd = src.indexOf('\n});', relauncherStart);
  assert.notEqual(relauncherEnd, -1, 'relauncher block closed');
  const relauncherBlock = src.slice(relauncherStart, relauncherEnd);
  assert.ok(relauncherBlock.includes('launchPreparedResearch'),
    'relauncher must replay through launchPreparedResearch');
  assert.ok(!relauncherBlock.includes('launchResearch('),
    'relauncher must not route through catalog-backed launchResearch');
  const start = src.indexOf('const runSentinel = createRunSentinel({');
  assert.notEqual(start, -1, 'sentinel wiring block present');
  const end = src.indexOf('\n});', start);
  assert.notEqual(end, -1, 'sentinel wiring block closed');
  const block = src.slice(start, end);
  assert.ok(block.includes('relaunch: continuationRelauncher'),
    'sentinel relaunch must be the shared direct-path relauncher');
  assert.ok(!block.includes('launchResearch('),
    'relaunch must not route through catalog-backed launchResearch');
  const resumeStart = src.indexOf("app.post('/api/resume', createResumeHandler({");
  assert.notEqual(resumeStart, -1, 'resume endpoint present');
  const resumeEnd = src.indexOf('}));', resumeStart);
  assert.notEqual(resumeEnd, -1, 'resume wiring block closed');
  const resumeBlock = src.slice(resumeStart, resumeEnd);
  assert.ok(resumeBlock.includes('continuationRelauncher(info)'),
    'resume must relaunch through the shared direct-path relauncher');
});

```

## CHANGE: package.json

Register the new suite exactly once in the default test authority (scripts.test), immediately after run-sentinel.test.cjs. Anchor is a substring of the single-line test script.

### Anchor
```
tests/cosmo23/run-sentinel.test.cjs tests/cosmo23/research-run-operation-adapter.test.cjs
```

### Code
```js
tests/cosmo23/run-sentinel.test.cjs tests/cosmo23/operator-intents.test.cjs tests/cosmo23/research-run-operation-adapter.test.cjs
```

## CHANGE: tests/cosmo23/package-test-registration.test.cjs

Add the new suite to the exactly-once registration list (the convention every Phase 1-3 suite follows).

### Anchor
```
    'tests/cosmo23/run-sentinel.test.cjs',

```

### Code
```js
    'tests/cosmo23/run-sentinel.test.cjs',
    'tests/cosmo23/operator-intents.test.cjs',

```

## CHANGE: docs/design/COSMO23-VENDORED-PATCHES.md

Patch 72 entry (R5 — next free number after 71; server surface only). Append after the document's final paragraph; the anchor is the doc's unique closing sentence fragment.

### Anchor
```
(the sentinel's own relaunches keep in-memory state, so the ladder stays bounded across remediations).
```

### Code
```js
(the sentinel's own relaunches keep in-memory state, so the ladder stays bounded across remediations).

## Patch 72 — operator rails: parked-run recognition, Needs-You intents, and /api/resume (2026-07-22)

**Why:** Phase 4 run governance (component 4.1) gives the engine a PARK action — a graceful, resumable pause (guarded save, park state persisted to `<runDir>/.park.json` with `{ reason, lane, at, resumable: true }`, distinct exit code 81). Without server-side recognition, a parked run reads as a crash: the run sentinel would "remediate" (relaunch) a run governance deliberately paused, and the operator gets no typed signal that a run is waiting on them.

**What changed (server API surface):** `server/lib/operator-intents.js` (new) owns the server-side park-file contract (`PARK_STATE_FILENAME` `.park.json`, `PARK_EXIT_CODE` 81, `SPEND_STATE_FILENAME` `.spend.json`) and derives Needs-You intents on every status read — intents are DERIVED, never stored: `run_parked` (actions `resume`/`stop`) from the `.park.json` of the active-or-last run (in-memory last-park fast path re-verified on disk; TTL-cached runs-dir scan fallback so server restarts do not forget a parked run), `run_wedged_escalated` (actions `relaunch`/`stop`) from the existing `health.sentinel.escalated`, and advisory `spend_warning` when the active run's spend meter (`.spend.json` `totals.tokens|usd` vs `budget.maxTokens|maxUsd`) reaches `intents.spendWarnRatio` (default 0.8; `level: 'critical'` at >= 1.0; no configured budget = no intent, never an estimate). Status contract gains ADDITIVE fields only (Patch 9 compat): `health.parked` (boolean — true only when the parked run is not superseded by a DIFFERENT active run), `health.park` (runPath/runName/brainId/reason/lane/at/resumable), `health.intents[]`, plus flattened `parked`/`park`/`intents` on `/api/status`; `lifecycle` values are unchanged. Park recognition: `cosmo-exit` with code 81 AND a readable `.park.json` records the park and logs "parked … resumable via POST /api/resume" instead of the generic ended line (any other exit keeps Patch 71's no-exit-code-special-casing — the code alone is never trusted without the file). The run sentinel now SKIPS parked runs (`server/lib/run-sentinel.js`, injectable `readParkFile` defaulting to the operator-intents reader): `.park.json` presence at the tracked runPath returns the additive outcome `parked` BEFORE the death (`context_without_process`) and wedge remediations — covering both the park-exit window and a long park save — and a park also cancels a pending relaunch retry; parked runs resume only by operator intent. New endpoint `POST /api/resume`: validates parked state (409 `not_parked` when nothing is parked or the archive race is lost, 409 `already_running` when a run is active/launching; optional body `runPath` disambiguates), archives `.park.json` -> `.park.json.last` BEFORE relaunching (a park file beside a live engine would blind wedge monitoring), then relaunches through the SAME hoisted `createContinuationRelauncher` direct-runPath continuation the sentinel uses (metadata.json replay — Patch 71, never catalog-backed); a failed relaunch restores the park file so the run stays visibly parked. `POST /api/stop` additionally dismisses park state (archive, never delete) in both branches — the `not_running` branch reports additive `parkCleared` — and `launchPreparedResearch` defensively archives stale `.park.json` on ANY launch of a run dir. Config: `intents.spendWarnRatio` / `intents.scanTtlMs` in `~/.cosmo2.3/config.json`; env `COSMO23_INTENT_SPEND_WARN_RATIO` / `COSMO23_INTENT_SCAN_TTL_MS`.

**Effect standalone:** backward-compatible; all status fields additive, `POST /api/resume` is new, existing consumers of `running`/`health.lifecycle`/`wedged` unaffected (public/app.js reads none of the new fields). Engine-side park machinery is component 4.1 (`engine/`), first-class-editable work not logged here — this entry covers only the server surface. **Tests:** `tests/cosmo23/operator-intents.test.cjs` (intent derivation, park-file round-trip, resolver precedence + TTL + invalidation, sentinel-skips-parked for death and wedge plus retry cancellation with control remediations, resume flow with the real relauncher incl. archive-before-relaunch, restore-on-failure, both 409s, and explicit runPath; status-contract additive fields incl. superseded-parked semantics) + `tests/cosmo23/run-sentinel.test.cjs` (wiring pin updated for the hoisted shared relauncher) and `server/lib/status-contract.test.js` still green.

```

## TEST FILE: tests/cosmo23/operator-intents.test.cjs

```js
'use strict';

// Phase 4 (component 4.5) — operator rails: parked-run recognition, derived
// Needs-You intents, and the /api/resume flow. Real-behavior tests: park
// files are real files in mkdtemp run dirs, the sentinel-skips-parked tests
// drive the REAL RunSentinel through its default park reader, and the resume
// tests drive the REAL createContinuationRelauncher metadata replay.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  PARK_STATE_FILENAME,
  PARK_ARCHIVE_SUFFIX,
  PARK_EXIT_CODE,
  readParkFile,
  archiveParkFile,
  restoreParkFile,
  normalizeParkDetail,
  deriveOperatorIntents,
  createParkedRunResolver,
  createResumeHandler,
} = require('../../cosmo23/server/lib/operator-intents');
const { createRunSentinel, createContinuationRelauncher } = require('../../cosmo23/server/lib/run-sentinel');
const { buildStatusContract } = require('../../cosmo23/server/lib/status-contract');

const MINUTE = 60 * 1000;

const SAMPLE_PARK = Object.freeze({
  reason: 'spend_budget_critical',
  lane: 'spend',
  at: '2026-07-22T11:30:00.000Z',
  resumable: true,
});

async function makeRunDir(t, prefix = 'cosmo23-operator-intents-') {
  const runPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(runPath, { recursive: true, force: true }));
  return runPath;
}

async function writePark(runPath, park = SAMPLE_PARK) {
  await fs.writeFile(path.join(runPath, PARK_STATE_FILENAME), JSON.stringify(park, null, 2), 'utf8');
}

function createFakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('park exit code is the R2 contract value', () => {
  assert.equal(PARK_EXIT_CODE, 81);
  assert.equal(PARK_STATE_FILENAME, '.park.json');
});

test('readParkFile: missing and corrupt files read as not parked; archive/restore round-trip', async (t) => {
  const runPath = await makeRunDir(t);
  assert.equal(await readParkFile(runPath), null);
  assert.equal(await archiveParkFile(runPath), false, 'nothing to archive');

  await fs.writeFile(path.join(runPath, PARK_STATE_FILENAME), 'not json{', 'utf8');
  assert.equal(await readParkFile(runPath), null, 'corrupt park file reads as not parked');

  await writePark(runPath);
  const park = await readParkFile(runPath);
  assert.equal(park.reason, 'spend_budget_critical');

  assert.equal(await archiveParkFile(runPath), true);
  assert.equal(await readParkFile(runPath), null, 'archived park no longer reads as parked');
  const archived = JSON.parse(await fs.readFile(
    path.join(runPath, `${PARK_STATE_FILENAME}${PARK_ARCHIVE_SUFFIX}`), 'utf8'));
  assert.equal(archived.lane, 'spend', 'evidence preserved, never deleted');

  assert.equal(await restoreParkFile(runPath), true);
  assert.equal((await readParkFile(runPath)).lane, 'spend');
  assert.equal(await restoreParkFile(runPath), false, 'nothing left to restore');
});

test('deriveOperatorIntents: parked run yields a run_parked action intent', () => {
  const intents = deriveOperatorIntents({
    parked: { runPath: '/runs/labor23', runName: 'labor23', brainId: 'brain-1', park: SAMPLE_PARK },
  });
  assert.equal(intents.length, 1);
  const intent = intents[0];
  assert.equal(intent.type, 'run_parked');
  assert.equal(intent.severity, 'action');
  assert.equal(intent.id, 'run_parked:/runs/labor23');
  assert.equal(intent.runName, 'labor23');
  assert.equal(intent.reason, 'spend_budget_critical');
  assert.equal(intent.lane, 'spend');
  assert.equal(intent.since, '2026-07-22T11:30:00.000Z');
  assert.equal(intent.resumable, true);
  assert.deepEqual(intent.actions, ['resume', 'stop']);
});

test('deriveOperatorIntents: sentinel escalation yields run_wedged_escalated', () => {
  const intents = deriveOperatorIntents({
    sentinel: {
      runPath: '/runs/labor23',
      runName: 'labor23',
      attempts: 2,
      maxAttempts: 2,
      lastReason: 'wedged_no_cycle_progress',
      escalated: true,
      escalatedAt: '2026-07-22T12:00:00.000Z',
    },
  });
  assert.equal(intents.length, 1);
  const intent = intents[0];
  assert.equal(intent.type, 'run_wedged_escalated');
  assert.equal(intent.severity, 'action');
  assert.equal(intent.reason, 'wedged_no_cycle_progress');
  assert.equal(intent.since, '2026-07-22T12:00:00.000Z');
  assert.equal(intent.attempts, 2);
  assert.deepEqual(intent.actions, ['relaunch', 'stop']);
});

test('deriveOperatorIntents: non-escalated sentinel yields no wedged intent', () => {
  const intents = deriveOperatorIntents({
    sentinel: { runPath: '/runs/labor23', attempts: 1, escalated: false },
  });
  assert.deepEqual(intents, []);
});

test('deriveOperatorIntents: spend advisory only at/over the warn ratio, honest about level', () => {
  const base = { totals: { tokens: 850 }, budget: { maxTokens: 1000 } };
  const warn = deriveOperatorIntents({ spend: base });
  assert.equal(warn.length, 1);
  assert.equal(warn[0].type, 'spend_warning');
  assert.equal(warn[0].severity, 'advisory');
  assert.equal(warn[0].level, 'warn');
  assert.equal(warn[0].unit, 'tokens');
  assert.equal(warn[0].ratio, 0.85);
  assert.deepEqual(warn[0].actions, []);

  const critical = deriveOperatorIntents({
    spend: { totals: { tokens: 1200, usd: 1 }, budget: { maxTokens: 1000, maxUsd: 100 } },
  });
  assert.equal(critical.length, 1);
  assert.equal(critical[0].level, 'critical', 'over budget reads critical');
  assert.equal(critical[0].unit, 'tokens', 'worst ratio wins');

  assert.deepEqual(
    deriveOperatorIntents({ spend: { totals: { tokens: 500 }, budget: { maxTokens: 1000 } } }),
    [], 'below the warn ratio: no intent');
  assert.deepEqual(
    deriveOperatorIntents({ spend: { totals: { tokens: 999999 } } }),
    [], 'no budget configured: no intent, never an estimate');
  const custom = deriveOperatorIntents({
    spend: { totals: { tokens: 600 }, budget: { maxTokens: 1000 } },
    config: { spendWarnRatio: 0.5 },
  });
  assert.equal(custom.length, 1, 'config.spendWarnRatio is honored');
});

test('deriveOperatorIntents: action intents order before advisories; empty input derives nothing', () => {
  assert.deepEqual(deriveOperatorIntents({}), []);
  assert.deepEqual(deriveOperatorIntents(), []);
  const intents = deriveOperatorIntents({
    parked: { runPath: '/runs/a', runName: 'a', brainId: null, park: SAMPLE_PARK },
    sentinel: { runPath: '/runs/b', escalated: true },
    spend: { totals: { tokens: 900 }, budget: { maxTokens: 1000 } },
  });
  assert.deepEqual(intents.map((intent) => intent.type),
    ['run_parked', 'run_wedged_escalated', 'spend_warning']);
});

test('parked-run resolver: active context first, last park re-verified, newest scan wins, TTL cache', async (t) => {
  const runsPath = await makeRunDir(t, 'cosmo23-runs-');
  const runA = path.join(runsPath, 'run-a');
  const runB = path.join(runsPath, 'run-b');
  await fs.mkdir(runA);
  await fs.mkdir(runB);
  await writePark(runA, { ...SAMPLE_PARK, at: '2026-07-22T10:00:00.000Z' });
  await writePark(runB, { ...SAMPLE_PARK, at: '2026-07-22T11:00:00.000Z', runName: 'named-b' });

  let activeContext = null;
  let lastParked = null;
  let nowMs = Date.parse('2026-07-22T12:00:00.000Z');
  const resolver = createParkedRunResolver({
    getActiveContext: () => activeContext,
    getLastParked: () => lastParked,
    runsPath,
    now: () => nowMs,
    scanTtlMs: 30 * 1000,
  });

  // 3) scan fallback: newest park.at wins, park.runName preferred.
  const scanned = await resolver.resolve();
  assert.equal(scanned.runPath, runB);
  assert.equal(scanned.runName, 'named-b');

  // TTL cache: a park archived underneath is still reported until expiry...
  await archiveParkFile(runB);
  assert.equal((await resolver.resolve()).runPath, runB, 'cached inside TTL');
  nowMs += 31 * 1000;
  const rescanned = await resolver.resolve();
  assert.equal(rescanned.runPath, runA, 'fresh scan after TTL sees the archive');
  // ...and invalidate() busts it immediately.
  await archiveParkFile(runA);
  resolver.invalidate();
  assert.equal(await resolver.resolve(), null, 'nothing parked anywhere');

  // 2) lastParked fast path is re-verified on disk.
  await restoreParkFile(runA);
  lastParked = { runPath: runA, runName: 'run-a', brainId: 'brain-a' };
  resolver.invalidate();
  const viaLast = await resolver.resolve();
  assert.equal(viaLast.runPath, runA);
  assert.equal(viaLast.brainId, 'brain-a');

  // 1) active context park wins over everything.
  await restoreParkFile(runB);
  activeContext = { runPath: runB, runName: 'run-b-active', brainId: 'brain-b' };
  const viaActive = await resolver.resolve();
  assert.equal(viaActive.runPath, runB);
  assert.equal(viaActive.runName, 'run-b-active');
});

function makeSentinelFixture(t, runPath) {
  const fixture = {
    runPath,
    nowMs: Date.parse('2026-07-22T12:00:00.000Z'),
    activeContext: {
      runName: 'labor23',
      runPath,
      brainId: 'brain-abc123',
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
    relaunchImpl: null,
  };
  fixture.sentinel = createRunSentinel({
    getActiveContext: () => fixture.activeContext,
    getIsLaunching: () => fixture.isLaunching,
    getProcessStatus: () => ({ running: fixture.processRunning, count: fixture.processRunning.length }),
    readHeartbeat: async () => fixture.heartbeat,
    readWatchdog: async () => null,
    // NOTE: no readParkFile injection — these tests exercise the DEFAULT
    // reader against real .park.json files in the run dir.
    stopEngine: async (info) => {
      fixture.stopCalls.push(info);
      fixture.activeContext = null;
      fixture.processRunning = [];
    },
    relaunch: async (info) => {
      fixture.relaunchCalls.push(info);
      if (fixture.relaunchImpl) return fixture.relaunchImpl(info);
      fixture.activeContext = {
        runName: info.runName,
        runPath: info.runPath,
        brainId: info.brainId,
        startedAt: '2026-07-22T11:00:00.000Z',
      };
      fixture.processRunning = [{ name: 'cosmo-main', pid: 4243, killed: false }];
      return { success: true };
    },
    log: (level, message) => fixture.logs.push({ level, message }),
    now: () => fixture.nowMs,
    config: {
      checkIntervalMs: MINUTE,
      wedgeThresholdMs: 15 * MINUTE,
      launchGraceMs: 5 * MINUTE,
      maxAttempts: 2,
      breakerStuckMs: 30 * MINUTE,
    },
  });
  return fixture;
}

test('sentinel skips a parked run instead of remediating engine death', async (t) => {
  const runPath = await makeRunDir(t);
  const fixture = makeSentinelFixture(t, runPath);
  fixture.processRunning = []; // engine exited (park exit) — context still set
  await writePark(runPath);

  const result = await fixture.sentinel.check();
  assert.equal(result.outcome, 'parked');
  assert.equal(result.reason, 'run_parked');
  assert.equal(fixture.stopCalls.length, 0, 'no stop for a parked run');
  assert.equal(fixture.relaunchCalls.length, 0, 'no relaunch for a parked run');
  assert.match(fixture.logs.map((entry) => entry.message).join('\n'), /is parked/);

  // Repeat checks stay quiet (log-once) and still stand down.
  const logCount = fixture.logs.length;
  assert.equal((await fixture.sentinel.check()).outcome, 'parked');
  assert.equal(fixture.logs.length, logCount, 'parked skip logs once');

  // Control: with the park file archived (resume path), the SAME state is a
  // real death and remediation proceeds.
  await archiveParkFile(runPath);
  const remediated = await fixture.sentinel.check();
  assert.equal(remediated.outcome, 'remediated');
  assert.equal(fixture.relaunchCalls.length, 1);
});

test('sentinel skips a parked run instead of remediating a progress-stale wedge', async (t) => {
  const runPath = await makeRunDir(t);
  const fixture = makeSentinelFixture(t, runPath);
  // Progress stalled 20 minutes ago; liveness ts fresh (park save in flight).
  fixture.heartbeat = {
    ...fixture.heartbeat,
    ts: new Date(fixture.nowMs - 5 * 1000).toISOString(),
    lastCycleStartTs: new Date(fixture.nowMs - 21 * MINUTE).toISOString(),
    lastCycleEndTs: new Date(fixture.nowMs - 20 * MINUTE).toISOString(),
  };
  await writePark(runPath, { reason: 'progress_stalled_park', lane: 'progress', at: '2026-07-22T11:40:00.000Z', resumable: true });

  const result = await fixture.sentinel.check();
  assert.equal(result.outcome, 'parked');
  assert.equal(fixture.stopCalls.length, 0);
  assert.equal(fixture.relaunchCalls.length, 0);

  await archiveParkFile(runPath);
  const remediated = await fixture.sentinel.check();
  assert.equal(remediated.outcome, 'remediated', 'control: same wedge remediates once unparked');
});

test('a park cancels a pending sentinel relaunch retry', async (t) => {
  const runPath = await makeRunDir(t);
  const fixture = makeSentinelFixture(t, runPath);
  fixture.processRunning = [];
  fixture.relaunchImpl = async () => {
    throw new Error('relaunch transport failed');
  };

  const failed = await fixture.sentinel.check();
  assert.equal(failed.outcome, 'remediation_failed');
  assert.equal(fixture.sentinel.getPublicState().pendingRelaunch, true, 'retry owed');

  // The engine parked (e.g. governance landed the park during the window).
  fixture.activeContext = null;
  await writePark(runPath);
  const parked = await fixture.sentinel.check();
  assert.equal(parked.outcome, 'parked');
  assert.equal(fixture.sentinel.getPublicState().pendingRelaunch, false, 'retry cancelled');
  assert.equal(fixture.relaunchCalls.length, 1, 'no second relaunch attempt');
});

function makeResumeFixture(t, parkedRun) {
  const fixture = {
    activeContext: null,
    isLaunching: false,
    launchCalls: [],
    resumedCalls: [],
    logs: [],
    launchImpl: null,
  };
  const relauncher = createContinuationRelauncher({
    getActiveContext: () => fixture.activeContext,
    getIsLaunching: () => fixture.isLaunching,
    setIsLaunching: (value) => { fixture.isLaunching = value; },
    launchPreparedResearch: async (brain, payload, req) => {
      fixture.launchCalls.push({ brain, payload, req });
      if (fixture.launchImpl) return fixture.launchImpl(brain, payload, req);
      fixture.activeContext = { runName: brain.name, runPath: brain.path, brainId: brain.id };
      return {
        success: true,
        runName: brain.name,
        brainId: brain.id,
        brainPath: brain.path,
        brainSourceType: brain.sourceType,
        isContinuation: brain.hasState,
      };
    },
  });
  fixture.handler = createResumeHandler({
    getActiveContext: () => fixture.activeContext,
    getIsLaunching: () => fixture.isLaunching,
    resolveParkedRun: async () => (typeof parkedRun === 'function' ? parkedRun() : parkedRun),
    relaunch: relauncher,
    onResumed: (resumed) => fixture.resumedCalls.push(resumed),
    log: (level, message) => fixture.logs.push({ level, message }),
  });
  return fixture;
}

test('POST /api/resume: archives the park file and relaunches via the metadata replay continuation', async (t) => {
  const runPath = await makeRunDir(t);
  await writePark(runPath);
  await fs.writeFile(path.join(runPath, 'metadata.json'), JSON.stringify({
    topic: 'labor parity',
    maxCycles: 42,
    explorationMode: 'guided',
  }), 'utf8');

  const parkedRun = { runPath, runName: 'labor23', brainId: null, park: SAMPLE_PARK };
  const fixture = makeResumeFixture(t, parkedRun);
  const res = createFakeRes();
  await fixture.handler({ body: {} }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.equal(res.body.resumed, true);
  assert.equal(res.body.runName, 'labor23');
  assert.equal(res.body.park.reason, 'spend_budget_critical');
  assert.equal(res.body.brainPath, undefined, 'internal paths stripped like /api/launch');
  assert.equal(res.body.brainSourceType, undefined);

  // Park file archived BEFORE the relaunch, evidence preserved.
  assert.equal(await readParkFile(runPath), null);
  const archived = JSON.parse(await fs.readFile(
    path.join(runPath, `${PARK_STATE_FILENAME}${PARK_ARCHIVE_SUFFIX}`), 'utf8'));
  assert.equal(archived.reason, 'spend_budget_critical');

  // The REAL continuation relauncher replayed metadata.json (Patch 71 path).
  assert.equal(fixture.launchCalls.length, 1);
  const { brain, payload } = fixture.launchCalls[0];
  assert.equal(brain.path, runPath);
  assert.equal(brain.name, 'labor23');
  assert.equal(brain.hasState, true, 'resume is a continuation');
  assert.match(brain.id, /^[0-9a-f]{16}$/, 'sha1 run-path id convention');
  assert.equal(payload.topic, 'labor parity');
  assert.equal(payload.maxCycles, 42);
  assert.equal(payload.brainId, brain.id);
  assert.equal(fixture.resumedCalls.length, 1);
});

test('POST /api/resume: 409 not_parked when nothing is parked', async (t) => {
  const fixture = makeResumeFixture(t, null);
  const res = createFakeRes();
  await fixture.handler({ body: {} }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'not_parked');
  assert.equal(fixture.launchCalls.length, 0);
});

test('POST /api/resume: 409 not_parked when the park file vanished after resolve (concurrent resume)', async (t) => {
  const runPath = await makeRunDir(t);
  // Resolver claims parked, but no .park.json exists on disk — the archive
  // step loses the race and must 409 instead of relaunching.
  const fixture = makeResumeFixture(t, { runPath, runName: 'labor23', brainId: null, park: SAMPLE_PARK });
  const res = createFakeRes();
  await fixture.handler({ body: {} }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'not_parked');
  assert.equal(fixture.launchCalls.length, 0, 'no relaunch without winning the archive');
});

test('POST /api/resume: 409 already_running while a run is active or launching', async (t) => {
  const runPath = await makeRunDir(t);
  await writePark(runPath);
  const fixture = makeResumeFixture(t, { runPath, runName: 'labor23', brainId: null, park: SAMPLE_PARK });

  fixture.activeContext = { runName: 'other', runPath: '/elsewhere' };
  const resActive = createFakeRes();
  await fixture.handler({ body: {} }, resActive);
  assert.equal(resActive.statusCode, 409);
  assert.equal(resActive.body.code, 'already_running');

  fixture.activeContext = null;
  fixture.isLaunching = true;
  const resLaunching = createFakeRes();
  await fixture.handler({ body: {} }, resLaunching);
  assert.equal(resLaunching.statusCode, 409);
  assert.equal(resLaunching.body.code, 'already_running');
  assert.equal(await readParkFile(runPath) !== null, true, 'park file untouched');
});

test('POST /api/resume: a failed relaunch restores the park file so the run stays parked', async (t) => {
  const runPath = await makeRunDir(t);
  await writePark(runPath);
  await fs.writeFile(path.join(runPath, 'metadata.json'), JSON.stringify({ topic: 'labor' }), 'utf8');
  const fixture = makeResumeFixture(t, { runPath, runName: 'labor23', brainId: null, park: SAMPLE_PARK });
  fixture.launchImpl = async () => {
    throw new Error('provider exploded');
  };

  const res = createFakeRes();
  await fixture.handler({ body: {} }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.success, false);
  assert.match(res.body.error, /provider exploded/);
  assert.equal(fixture.resumedCalls.length, 0);
  const restored = await readParkFile(runPath);
  assert.equal(restored.reason, 'spend_budget_critical', 'park state restored');
  assert.equal(fixture.isLaunching, false, 'relauncher cleared its launching bracket');
});

test('POST /api/resume: explicit body.runPath resumes that run dir directly', async (t) => {
  const runPath = await makeRunDir(t);
  await writePark(runPath, { ...SAMPLE_PARK, runName: 'named-in-park' });
  await fs.writeFile(path.join(runPath, 'metadata.json'), JSON.stringify({ topic: 'x' }), 'utf8');
  const fixture = makeResumeFixture(t, null); // resolver sees nothing
  const res = createFakeRes();
  await fixture.handler({ body: { runPath } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.runName, 'named-in-park');
  assert.equal(fixture.launchCalls[0].brain.path, runPath);
});

test('status contract: parked/park/intents are additive and default-compatible', () => {
  const processStatus = { running: [], count: 0 };

  const before = buildStatusContract({ activeContext: null, processStatus, heartbeat: null });
  assert.equal(before.parked, false);
  assert.equal(before.park, null);
  assert.deepEqual(before.intents, [], 'absent inputs keep compat defaults');

  const park = {
    runPath: '/runs/labor23', runName: 'labor23', brainId: null,
    reason: 'spend_budget_critical', lane: 'spend', at: SAMPLE_PARK.at, resumable: true,
  };
  const intents = deriveOperatorIntents({
    parked: { runPath: '/runs/labor23', runName: 'labor23', brainId: null, park: SAMPLE_PARK },
  });

  const idleParked = buildStatusContract({ activeContext: null, processStatus, park, intents, heartbeat: null });
  assert.equal(idleParked.parked, true, 'no active run + park detail = parked');
  assert.equal(idleParked.park.reason, 'spend_budget_critical');
  assert.equal(idleParked.intents.length, 1);
  assert.equal(idleParked.lifecycle, 'idle', 'lifecycle value set unchanged (additive rule)');

  const otherRunActive = buildStatusContract({
    activeContext: { runName: 'other', runPath: '/runs/other', startedAt: SAMPLE_PARK.at },
    processStatus: { running: [{ name: 'cosmo-main', pid: 1 }], count: 1 },
    park,
    intents,
    heartbeat: null,
  });
  assert.equal(otherRunActive.parked, false, 'a DIFFERENT active run supersedes the parked flag');
  assert.equal(otherRunActive.intents.length, 1, 'but the Needs-You intent persists');

  const parkingActiveRun = buildStatusContract({
    activeContext: { runName: 'labor23', runPath: '/runs/labor23', startedAt: SAMPLE_PARK.at },
    processStatus,
    park,
    intents,
    heartbeat: null,
  });
  assert.equal(parkingActiveRun.parked, true, 'park of the tracked run itself reads parked');
});

test('normalizeParkDetail tolerates sparse park payloads', () => {
  assert.equal(normalizeParkDetail(null), null);
  assert.equal(normalizeParkDetail({}), null);
  const detail = normalizeParkDetail({ runPath: '/runs/x', park: {} });
  assert.equal(detail.runName, 'x', 'falls back to the dir basename');
  assert.equal(detail.reason, null);
  assert.equal(detail.resumable, true, 'resumable defaults true per R2');
});

```

## API NOTES

VALIDATION EVIDENCE: full proposal applied to byte-identical scratch copies at /private/tmp/claude-501/-Users-jtr--JTR23--release-home23/a403bbd0-d1fd-461a-91bc-9cc077611c0c/scratchpad/p45/ (apply-lib-edits.py, apply-index-edits.py, apply-test-edit.py enforce exactly-once anchors — all 24 anchors matched exactly once against current repo bytes). node --check clean on all four touched JS files. Test run: 61/61 pass (19 new operator-intents + 34 run-sentinel including the UPDATED pin + 8 status-contract). No trailing whitespace in any emitted code. Repo files were never modified by this session. Concurrent-tree caveat: another session was editing cosmo23/server/config/model-catalog.js and package.json at validation time — re-verify the package.json anchor substring at apply time (it is inside the single-line scripts.test string, present exactly once as of 2026-07-22).

APPLY ORDER: (1) create cosmo23/server/lib/operator-intents.js FIRST — run-sentinel.js edit 1/5 requires it; (2) run-sentinel.js edits; (3) status-contract.js edits; (4) index.js edits (13, any internal order — anchors are disjoint); (5) run-sentinel.test.cjs pin replacement — MANDATORY with edit C1/C2, the old pin fails otherwise; (6) package.json + registration list; (7) patch-log entry; (8) test file.

CROSS-COMPONENT CONTRACTS (for the 4.1/4.2/4.3 implementers and the parent orchestrator):
- Park file: <logsDir>/.park.json where logsDir == the run dir (same path resolution as .heartbeat — the sentinel and this server half read path.join(runPath, '.park.json')). Payload minimum per R2: { reason, lane, at, resumable: true }; OPTIONAL runName and brainId fields are honored by the scan resolver if 4.1 writes them. Server treats any parseable JSON object as parked (corrupt/torn file = not parked — write it tmp+rename). RECOMMENDATION to 4.1: write .park.json BEFORE the guarded save (intent-first, like the sentinel's own attempt recording) — the server-side sentinel guard then covers the entire park sequence including a slow save; exit code MUST be 81 (verified free: watchdog uses 86). Exit 81 without the file is treated as a normal death (S1 preserved).
- Spend meter (.spend.json at the run dir, component 4.3): the advisory intent probes totals.tokens (fallback flat totalTokens) vs budget.maxTokens (fallback flat maxTokens), and totals.usd/totalUsd vs budget.maxUsd/maxUsd. Anything absent = no advisory (honest, never estimated). If 4.3 lands a different shape, only summarizeSpendPressure() in operator-intents.js needs updating (single probe point, unit-tested).
- Resume relaunch payload: { runPath, runName, brainId } into createContinuationRelauncher — identical to the sentinel's; brainId null lets the relauncher derive sha1(runPath).slice(0,16). Parking must leave metadata.json intact (R2) — resume replays it verbatim.

API SURFACE (Patch 72): GET /api/status and GET /api/health gain additive health.parked (bool), health.park (runPath/runName/brainId/reason/lane/at/resumable or null), health.intents[] ({id,type:'run_parked'|'run_wedged_escalated'|'spend_warning',severity:'action'|'advisory',actions[],...}); /api/status also flattens parked/park/intents beside wedged. /api/watch/logs deliberately NOT wired (high-frequency poll, keeps its lean contract). POST /api/resume (new): 200 {success,resumed:true,park,...launch payload minus brainPath/brainSourceType}; 409 {code:'already_running'} | {code:'not_parked'}; 500 with park file restored on relaunch failure; optional body {runPath}. POST /api/stop responses gain parkCleared (not_running branch) and both branches archive .park.json -> .park.json.last (evidence never deleted; an idle /api/stop dismissing a parked run is intentional 'stop'-action semantics, documented in Patch 72 — the run remains resumable as a plain continuation via /api/launch, whose launchPreparedResearch now defensively archives stale park files so a live engine can never sit beside a .park.json that would blind the sentinel). Parked-flag semantics: health.parked is true only when the parked run is the tracked (active-or-last) run and not superseded by a DIFFERENT active run; the run_parked intent persists regardless until resumed or dismissed. Config: intents.spendWarnRatio (default 0.8), intents.scanTtlMs (default 30000) in ~/.cosmo2.3/config.json; env COSMO23_INTENT_SPEND_WARN_RATIO, COSMO23_INTENT_SCAN_TTL_MS. Sentinel getPublicState/lastOutcome can now read 'parked' (additive outcome string). R1 compliance: this component deletes nothing (archives only), expands no budget, and adds no engine writes; ledger receipts for park/resume actions are the engine half's duty (4.1) — the server half logs through processManager.recordLog as all launcher events do. New file for implementer reference (validated copy): scratchpad/p45/cosmo23/server/lib/operator-intents.js; patched references for diffing: scratchpad/p45/cosmo23/server/{index.js,lib/run-sentinel.js,lib/status-contract.js} and scratchpad/p45/tests/cosmo23/{operator-intents.test.cjs,run-sentinel.test.cjs}.
