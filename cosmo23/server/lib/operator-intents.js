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
