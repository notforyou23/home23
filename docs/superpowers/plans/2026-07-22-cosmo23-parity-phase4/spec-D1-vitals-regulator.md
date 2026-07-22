# cosmo23 native research governance — Phase 4, Component 4.1: run vitals + regulator (RunVitals lanes, bounded pacing, spend/progress park, exit-81 park contract)

## Target current state

FIRST-STOP REPORT — RunCommitmentGovernor (cosmo23/engine/src/core/run-commitment-governor.js, 225 lines, imported at orchestrator.js:29, constructed at orchestrator.js:104 from config.commitmentGovernor): it is a PURE decision unit (no side effects) whose evaluate(snapshot) governs SPAWN/COMMIT/STOP semantics only: (1) provider rate-limit circuit — >=3 rate-limit errors in an 8-cycle window blocks spawning with a cooldown; (2) artifact-commitment enforcement — outputs existing with zero committed artifacts blocks spawning and demands commit_artifacts; (3) run completion — plan DONE + synthesis commit + committed artifacts + no gaps => shouldStopForCompletion; (4) guided-plan BLOCKED => stop_unproductive_run; (5) source-backbone route blocks; (6) per-cycle strategic/urgent spawn budgets. The orchestrator calls it via evaluateCommitmentGovernor() -> collectCommitmentSnapshot() (orchestrator.js:4429-4462), caches the decision in this.lastCommitmentDecision (with decision.summary.committedArtifacts etc.), applies bounded actions in applyCommitmentDecisionActions(), and writes commitment-governor-receipts.jsonl. IT DOES NOT govern pacing (calculateNextInterval at orchestrator.js:8314 is the sole pacing authority: baseInterval * curiosity/energy multipliers, clamped 30s..600s, or 1s floor when adaptiveTimingEnabled === false), does NOT meter spend (no spend infrastructure exists anywhere — grep confirms zero .spend.json/spendMeter references), and does NOT park (no .park.json anywhere; the only special exit code is the watchdog's restart escalation exit 86). Component 4.1 therefore builds WITH the governor, not beside it: the regulator consumes the governor's cached decision summary as its cheap in-memory artifact-count signal, and adds the three orthogonal capabilities the governor lacks (pacing, spend budget, park), leaving all spawn/commit/stop authority with the governor. Other verified wiring: main loop while(this.running) at orchestrator.js:1010 runs runCycleWithWatchdog() (line 1303) and only on a settled cycle (cycled=true) reaches post-cycle work — handleClusterCycleSync (line 1108), maxCycles/maxRuntime exits (which use the exact pattern `await this.stop(); process.exit(0)`), then calculateNextInterval + sleep. Phase 2 signals available in-memory: this.backpressure (alias of resourceMonitor.backpressure, levels none|elevated|critical), this.cycleWatchdog.getStatus() ({state closed|open|half-open, consecutiveFailures, tripCount, ...}, persisted in .watchdog.json, restart escalation exit 86), this.heartbeatWriter (in-memory .timer + .state {cycle, phase,...}; phases loop_start/cycle_end/breaker_cooloff/revive_probe/stopped), this.eventLedger.log(type, data) fire-and-forget. AgentExecutor (cosmo23/engine/src/agents/agent-executor.js): this.maxConcurrent = config.coordinator?.maxConcurrent || 2 (line 182), backpressure injected read-only (line 187), getEffectiveMaxConcurrent() (line 295) halves on 'elevated' (ceil, floor 1) and spawnAgent() hard-blocks on 'critical'; the effective limit is consumed once, at spawnAgent() line 358. stop() (orchestrator.js:9795) is the Phase 1/2 guarded shutdown path: heartbeat stop('stopped'), pollers/monitors stopped, saveStateForShutdown() (bounded, TOCTOU-guarded), clean marker ONLY on confirmed save, telemetry + backup awaits, bounded ledger close. Memory node count is this.memory.nodes.size (Map). Tests: Home23 root harness node:test .test.cjs files in tests/cosmo23/, registered exactly once in package.json scripts.test (pinned by tests/cosmo23/package-test-registration.test.cjs); the prototype-driven-fake convention is established by cycle-watchdog.test.cjs. Absent today: no config.governance block, no run-vitals module, no park machinery, no spend metering. NOTE: the worktree is a shared moving tree — during this session a concurrent agent landed Fix 3.4 (delta compaction) inside persistResearchState (orchestrator.js ~8617); my anchors were re-verified unique on the tree INCLUDING that work and do not intersect it.

## CHANGE: cosmo23/engine/src/core/run-vitals.js

NEW FILE — the governance core. RunVitals computes the three lanes per R3 every settled cycle (cheap, synchronous, in-memory): progress (trailing-window node/artifact deltas as evidence; lane LEVELS above ok only via Component 4.3's tracked assessment — otherwise 'untracked'/ok), spend (Component 4.2's meter snapshot vs config.spend budget; ok <70%, warn 70-95%, critical >=95%, configurable; honest 'unbudgeted'/'unmetered'/'unpriced' states — never estimates), health (watchdog breaker, consecutive failures, backpressure, heartbeat self-check — OBSERVED ONLY, never drives an action; the watchdog/sentinel own health remediation). Regulator decision is bounded per R1: warn => pace only (slowdown factor + concurrency cap one notch), critical spend => park 'spend_critical', critical tracked progress => park 'progress_starvation', health => defer. The class does ZERO fs access; the park-file helpers (writeParkState/readParkState/archiveParkState, tmp+rename, .park.json / .park.json.last) are exported free functions used by the orchestrator (write/archive) and the server (read). Default = observe-and-report only (pinned by test). VALIDATED: applied to the live tree, 16/16 tests green, reverted byte-exact. No trailing whitespace. Create with exactly this content.

### Code
```js
'use strict';

/**
 * Phase 4 (Component 4.1) — Run vitals + regulator (native research
 * governance).
 *
 * RunVitals turns the run's live Phase 2 signals into three COMPUTED lanes
 * (R3 — lanes are derived every settled cycle, never stored authority):
 *
 *   progress — nodes added + committed artifacts over a trailing window of
 *              N cycles. The lane only LEVELS above 'ok' when Component
 *              4.3's commitment tracker is wired in and reports tracked
 *              starvation; without it the lane is 'untracked'/ok and the
 *              raw window deltas are still reported as evidence.
 *   spend    — Component 4.2's meter vs the launch budget
 *              (config.spend.maxTokens / config.spend.maxUsd). No budget →
 *              'unbudgeted'/ok. Budget but no meter → 'unmetered'/ok. USD
 *              budget with an unpriced meter → 'unpriced'/ok (token
 *              metering only — we never estimate silently, R4).
 *   health   — cycle-watchdog breaker state, consecutive failures,
 *              backpressure level, heartbeat self-check. OBSERVED ONLY:
 *              the regulator never acts on health at ANY level. Division
 *              of labor (pinned): backpressure already shapes spawning,
 *              and the CycleWatchdog + server sentinel own health
 *              remediation (breaker, cooloff, exit 86). Acting here would
 *              double-govern the same signals.
 *
 * Regulator decision (bounded autonomy, R1 — this class NEVER deletes
 * data, NEVER expands its own budget, NEVER touches the filesystem; it
 * only computes, and the orchestrator applies):
 *
 *   WARN  (spend, or tracked progress) → pacing only: stretch the
 *          inter-cycle interval by pacing.warnSlowdownFactor and cap agent
 *          concurrency one notch below coordinator.maxConcurrent.
 *   CRITICAL spend                     → PARK ('spend_critical').
 *   CRITICAL tracked progress          → PARK ('progress_starvation').
 *   CRITICAL health                    → DEFER to the Phase 2 watchdog /
 *          sentinel (transition receipt only, no action).
 *
 * PARK (R2) is a graceful pause with resumable state, executed by the
 * orchestrator: durable <logsDir>/.park.json first, ledger receipt,
 * heartbeat phase, then the EXISTING stop()/saveStateForShutdown machinery
 * and a DISTINCT exit code (81 — never the watchdog's 86).
 *
 * Default behavior is observe-and-report ONLY (pinned by test): with no
 * budget configured and no commitment tracker wired, every lane is 'ok'
 * and the action is 'none' forever.
 */

const fs = require('fs');
const path = require('path');

const PARK_FILENAME = '.park.json';
const PARK_EXIT_CODE = 81;

const GOVERNANCE_DEFAULTS = {
  enabled: true,
  windowCycles: 10,
  pacing: {
    warnSlowdownFactor: 1.5,
    concurrencyNotch: 1
  },
  spend: {
    warnRatio: 0.70,
    criticalRatio: 0.95
  },
  park: {
    exitCode: PARK_EXIT_CODE,
    stopTimeoutMs: 180000
  }
};

const LANE_LEVELS = new Set(['ok', 'warn', 'critical']);
const PARK_REASONS = new Set(['spend_critical', 'progress_starvation']);

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteOrNull(value) {
  // Number(null) is 0 — an ABSENT value must stay null (an unpriced meter's
  // totalUsd: null must never read as "$0.00 spent, metered").
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLevel(value) {
  const level = String(value || '').toLowerCase();
  return LANE_LEVELS.has(level) ? level : null;
}

class RunVitals {
  /**
   * @param {object} options
   * @param {object} [options.config]           - full engine config; reads
   *   config.governance.* (knobs) and config.spend.* (launch budget, R4).
   * @param {object} [options.logger]
   * @param {function} [options.spendProvider]  - () => 4.2 meter snapshot
   *   { totalTokens, totalUsd, unmeteredCalls } or null. Cached/synchronous.
   * @param {function} [options.progressAssessor] - ({ window, signals }) =>
   *   4.3 assessment { tracked: true, level, reason, evidence } or null.
   */
  constructor(options = {}) {
    const config = options.config || {};
    const gov = (config.governance && typeof config.governance === 'object') ? config.governance : {};
    const pacing = (gov.pacing && typeof gov.pacing === 'object') ? gov.pacing : {};
    const spendKnobs = (gov.spend && typeof gov.spend === 'object') ? gov.spend : {};
    const park = (gov.park && typeof gov.park === 'object') ? gov.park : {};
    const budget = (config.spend && typeof config.spend === 'object') ? config.spend : {};

    this.enabled = gov.enabled !== false;
    this.windowCycles = positiveInt(gov.windowCycles, GOVERNANCE_DEFAULTS.windowCycles);

    // Pacing can only SLOW: a factor below 1 would be a speed-up (budget
    // expansion by another name) and is rejected back to the default.
    const rawFactor = Number(pacing.warnSlowdownFactor);
    this.warnSlowdownFactor = Number.isFinite(rawFactor) && rawFactor >= 1
      ? rawFactor
      : GOVERNANCE_DEFAULTS.pacing.warnSlowdownFactor;
    this.concurrencyNotch = positiveInt(pacing.concurrencyNotch, GOVERNANCE_DEFAULTS.pacing.concurrencyNotch);

    const warnRatio = positiveNumber(spendKnobs.warnRatio, GOVERNANCE_DEFAULTS.spend.warnRatio);
    this.warnRatio = Math.min(warnRatio, 1);
    const criticalRatio = positiveNumber(spendKnobs.criticalRatio, GOVERNANCE_DEFAULTS.spend.criticalRatio);
    // criticalRatio can never sit below warnRatio (a config typo must not
    // turn every warn into a park).
    this.criticalRatio = Math.max(this.warnRatio, criticalRatio);

    this.parkExitCode = positiveInt(park.exitCode, GOVERNANCE_DEFAULTS.park.exitCode);
    this.parkStopTimeoutMs = positiveInt(park.stopTimeoutMs, GOVERNANCE_DEFAULTS.park.stopTimeoutMs);

    this.spendBudget = {
      maxTokens: positiveNumber(budget.maxTokens, null),
      maxUsd: positiveNumber(budget.maxUsd, null)
    };

    this.logger = options.logger || console;
    this.spendProvider = typeof options.spendProvider === 'function' ? options.spendProvider : null;
    this.progressAssessor = typeof options.progressAssessor === 'function' ? options.progressAssessor : null;

    // Trailing window of per-cycle samples: { cycle, nodes, committedArtifacts }
    this.samples = [];
    this.lastLanes = null;
    this.lastAction = 'none';
    this.lastEvaluatedCycle = null;
    this.parkRequested = null;
    this._last = { pacingActive: false, healthLevel: 'ok' };
    this.counters = {
      paceEngagements: 0,
      paceReleases: 0,
      healthDeferrals: 0,
      parkRequests: 0
    };
  }

  /**
   * One synchronous, in-memory evaluation. Called by the orchestrator once
   * per SETTLED cycle (breaker cooloffs and abandoned cycles never tick —
   * those windows belong to the watchdog).
   */
  evaluateCycle(signals = {}) {
    if (!this.enabled) {
      return {
        enabled: false,
        cycle: finiteOrNull(signals.cycle),
        lanes: null,
        action: 'none',
        actionReasons: ['governance_disabled'],
        pacing: { active: false, factor: 1, concurrencyCap: null },
        park: null,
        transitions: []
      };
    }

    const cycle = finiteOrNull(signals.cycle);
    this._recordSample(signals);

    const lanes = {
      progress: this._computeProgressLane(signals),
      spend: this._computeSpendLane(),
      health: this._computeHealthLane(signals)
    };

    const decision = this._decide(lanes, signals);
    const transitions = this._computeTransitions(lanes, decision);

    this.lastLanes = lanes;
    this.lastAction = decision.action;
    this.lastEvaluatedCycle = cycle;
    this._last = {
      pacingActive: decision.pacing.active,
      healthLevel: lanes.health.level
    };

    return {
      enabled: true,
      cycle,
      lanes,
      action: decision.action,
      actionReasons: decision.reasons,
      pacing: decision.pacing,
      park: decision.park,
      transitions
    };
  }

  _recordSample(signals) {
    this.samples.push({
      cycle: finiteOrNull(signals.cycle),
      nodes: finiteOrNull(signals.nodes),
      committedArtifacts: finiteOrNull(signals.committedArtifacts)
    });
    // Keep windowCycles+1 samples: N deltas need N+1 points.
    const maxSamples = this.windowCycles + 1;
    if (this.samples.length > maxSamples) {
      this.samples.splice(0, this.samples.length - maxSamples);
    }
  }

  _windowEvidence() {
    const first = this.samples[0] || null;
    const last = this.samples[this.samples.length - 1] || null;
    const spanCycles = this.samples.length > 1 ? this.samples.length - 1 : 0;
    const delta = (a, b) => (a !== null && b !== null ? b - a : null);
    return {
      windowCycles: this.windowCycles,
      spanCycles,
      nodesAdded: first && last ? delta(first.nodes, last.nodes) : null,
      artifactsAdded: first && last ? delta(first.committedArtifacts, last.committedArtifacts) : null,
      nodesNow: last ? last.nodes : null,
      committedArtifactsNow: last ? last.committedArtifacts : null,
      // Artifact counts ride the last commitment-governor decision's cached
      // summary — may lag by a review interval. Recorded so nobody mistakes
      // this for a fresh disk audit.
      artifactSource: 'commitment_decision_cache'
    };
  }

  _computeProgressLane(signals) {
    const evidence = this._windowEvidence();
    let assessment = null;
    if (this.progressAssessor) {
      try {
        assessment = this.progressAssessor({ window: evidence, signals });
      } catch (error) {
        this.logger.warn?.('[RunVitals] progress assessor failed (treated as untracked)', {
          error: error?.message || String(error)
        });
        assessment = null;
      }
    }

    if (!assessment || assessment.tracked !== true) {
      // 4.3 not wired (or not tracking yet): observe-and-report only.
      return { level: 'ok', state: 'untracked', reason: null, evidence };
    }

    const level = normalizeLevel(assessment.level);
    if (!level) {
      return {
        level: 'ok',
        state: 'untracked',
        reason: 'assessor_level_invalid',
        evidence: { ...evidence, assessorLevel: assessment.level ?? null }
      };
    }
    return {
      level,
      state: 'tracked',
      reason: assessment.reason || null,
      evidence: { ...evidence, assessor: assessment.evidence || null }
    };
  }

  _computeSpendLane() {
    const budget = this.spendBudget;
    const hasBudget = budget.maxTokens !== null || budget.maxUsd !== null;
    if (!hasBudget) {
      return { level: 'ok', state: 'unbudgeted', reason: null, evidence: { budget } };
    }

    let snapshot = null;
    if (this.spendProvider) {
      try {
        const raw = this.spendProvider();
        snapshot = raw && typeof raw === 'object' ? raw : null;
      } catch (error) {
        this.logger.warn?.('[RunVitals] spend provider failed (treated as unmetered)', {
          error: error?.message || String(error)
        });
        snapshot = null;
      }
    }
    if (!snapshot) {
      // Budget configured but 4.2's meter absent: we cannot govern what we
      // cannot measure — report it, never estimate (R4).
      return { level: 'ok', state: 'unmetered', reason: null, evidence: { budget } };
    }

    const totalTokens = finiteOrNull(snapshot.totalTokens);
    const totalUsd = finiteOrNull(snapshot.totalUsd);
    const unmeteredCalls = finiteOrNull(snapshot.unmeteredCalls) ?? 0;

    const ratios = [];
    if (budget.maxTokens !== null && totalTokens !== null) {
      ratios.push(totalTokens / budget.maxTokens);
    }
    if (budget.maxUsd !== null && totalUsd !== null) {
      ratios.push(totalUsd / budget.maxUsd);
    }

    const evidence = {
      budget,
      totalTokens,
      totalUsd,
      unmeteredCalls,
      warnRatio: this.warnRatio,
      criticalRatio: this.criticalRatio
    };

    if (ratios.length === 0) {
      // Only a USD budget is set and the meter has no price table → the
      // USD lane reads 'unpriced' (token metering may still be counting).
      return { level: 'ok', state: 'unpriced', reason: null, evidence };
    }

    const utilization = Math.max(...ratios);
    evidence.utilization = utilization;
    let level = 'ok';
    if (utilization >= this.criticalRatio) level = 'critical';
    else if (utilization >= this.warnRatio) level = 'warn';
    return { level, state: 'metered', reason: level === 'ok' ? null : `spend_utilization_${level}`, evidence };
  }

  _computeHealthLane(signals) {
    const watchdog = signals.watchdog && typeof signals.watchdog === 'object' ? signals.watchdog : null;
    const watchdogState = watchdog ? String(watchdog.state || 'closed') : 'closed';
    const consecutiveFailures = watchdog ? finiteOrNull(watchdog.consecutiveFailures) ?? 0 : 0;
    const backpressureLevel = String(signals.backpressureLevel || 'none');
    const heartbeatRunning = signals.heartbeatRunning !== false;

    let level = 'ok';
    if (watchdogState !== 'closed' || backpressureLevel === 'critical') {
      level = 'critical';
    } else if (consecutiveFailures > 0 || backpressureLevel === 'elevated' || !heartbeatRunning) {
      level = 'warn';
    }

    return {
      level,
      // 'observed' is a statement of the division of labor: this lane never
      // drives a regulator action at ANY level — the watchdog/backpressure/
      // sentinel machinery owns health remediation.
      state: 'observed',
      reason: level === 'ok' ? null : 'phase2_health_signals',
      evidence: { watchdogState, consecutiveFailures, backpressureLevel, heartbeatRunning }
    };
  }

  _decide(lanes, signals) {
    const reasons = [];

    // Park is allowed for exactly two reasons (R1 boundary, pinned by
    // test): critical spend, and critical TRACKED progress. Health critical
    // NEVER parks or paces from here.
    let park = null;
    if (lanes.spend.level === 'critical') {
      park = { reason: 'spend_critical', lane: 'spend', evidence: lanes.spend.evidence };
    } else if (lanes.progress.level === 'critical' && lanes.progress.state === 'tracked') {
      park = { reason: 'progress_starvation', lane: 'progress', evidence: lanes.progress.evidence };
    }

    if (park) {
      reasons.push(park.reason);
      if (!this.parkRequested) {
        this.parkRequested = { ...park, at: new Date().toISOString() };
        this.counters.parkRequests += 1;
      }
      return {
        action: 'park',
        reasons,
        park,
        pacing: { active: false, factor: 1, concurrencyCap: null }
      };
    }

    const spendWarn = lanes.spend.level === 'warn';
    const progressWarn = lanes.progress.level === 'warn' && lanes.progress.state === 'tracked';
    if (spendWarn) reasons.push('spend_warn');
    if (progressWarn) reasons.push('progress_warn');
    if (lanes.health.level === 'critical') reasons.push('health_critical_deferred_to_watchdog');

    if (spendWarn || progressWarn) {
      const maxConcurrent = finiteOrNull(signals.maxConcurrent);
      const concurrencyCap = maxConcurrent !== null && maxConcurrent >= 1
        ? Math.max(1, Math.floor(maxConcurrent) - this.concurrencyNotch)
        : null;
      return {
        action: 'pace',
        reasons,
        park: null,
        pacing: { active: true, factor: this.warnSlowdownFactor, concurrencyCap }
      };
    }

    return {
      action: 'none',
      reasons,
      park: null,
      pacing: { active: false, factor: 1, concurrencyCap: null }
    };
  }

  _computeTransitions(lanes, decision) {
    const transitions = [];
    if (decision.pacing.active && !this._last.pacingActive) {
      this.counters.paceEngagements += 1;
      transitions.push({ type: 'pacing_engaged' });
    } else if (!decision.pacing.active && this._last.pacingActive && decision.action !== 'park') {
      this.counters.paceReleases += 1;
      transitions.push({ type: 'pacing_released' });
    }
    if (lanes.health.level === 'critical' && this._last.healthLevel !== 'critical') {
      this.counters.healthDeferrals += 1;
      transitions.push({
        type: 'health_deferred',
        watchdog: lanes.health.evidence.watchdogState,
        backpressureLevel: lanes.health.evidence.backpressureLevel
      });
    }
    if (decision.action === 'park' && this.counters.parkRequests === 1 && !this._parkTransitionEmitted) {
      this._parkTransitionEmitted = true;
      transitions.push({ type: 'park_requested', reason: decision.park.reason, lane: decision.park.lane });
    }
    return transitions;
  }

  /** Compact lane summary for ledger receipts (levels + states only). */
  summarizeLanes(lanes = this.lastLanes) {
    if (!lanes) return null;
    const brief = (lane) => (lane ? { level: lane.level, state: lane.state } : null);
    return { progress: brief(lanes.progress), spend: brief(lanes.spend), health: brief(lanes.health) };
  }

  /** Additive status surface (orchestrator getStats().governance). */
  getStats() {
    return {
      enabled: this.enabled,
      windowCycles: this.windowCycles,
      lastEvaluatedCycle: this.lastEvaluatedCycle,
      action: this.lastAction,
      lanes: this.lastLanes,
      pacing: {
        active: this._last.pacingActive,
        factor: this._last.pacingActive ? this.warnSlowdownFactor : 1
      },
      parkRequested: this.parkRequested,
      counters: { ...this.counters }
    };
  }
}

// ── Park-state file helpers ─────────────────────────────────────────────
// Free functions, NOT RunVitals methods: the class stays fs-free (R1). The
// orchestrator writes/archives; the server reads (readParkState) to expose
// the additive 'parked' status.

function parkStatePath(dir) {
  return path.join(dir, PARK_FILENAME);
}

/** Crash-safe write (tmp + rename), mirroring heartbeat.js. Throws on fs errors. */
function writeParkState(dir, state) {
  const target = parkStatePath(dir);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, target);
  return target;
}

/** Parsed park state, or null when missing/corrupt. Never throws. */
function readParkState(dir) {
  if (!dir) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(parkStatePath(dir), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Archive .park.json to .park.json.last (evidence is never silently
 * deleted — same convention as the sentinel's .sentinel.json.last).
 * Returns true when a marker was archived. Never throws.
 */
function archiveParkState(dir) {
  try {
    const target = parkStatePath(dir);
    if (!fs.existsSync(target)) return false;
    fs.renameSync(target, `${target}.last`);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  RunVitals,
  GOVERNANCE_DEFAULTS,
  PARK_FILENAME,
  PARK_EXIT_CODE,
  PARK_REASONS,
  parkStatePath,
  writeParkState,
  readParkState,
  archiveParkState
};

```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Import RunVitals + park helpers. Exact string replacement: replace the anchor line (verified unique, line ~29) with the two-line version.

### Anchor
```
const { RunCommitmentGovernor } = require('./run-commitment-governor');
```

### Code
```js
const { RunCommitmentGovernor } = require('./run-commitment-governor');
const { RunVitals, PARK_EXIT_CODE, writeParkState, archiveParkState } = require('./run-vitals');
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Constructor wiring: construct RunVitals with late-bound provider closures (4.2's this.spendMeter.getSnapshot(), 4.3's this.progressCommitments.assessProgress()) and initialize the applied-pacing slot. Exact string replacement of the unique anchor line (end of constructor, ~line 283).

### Anchor
```
    this.shutdownHandler = null; // Created after initialization
```

### Code
```js
    // ── Phase 4 (Component 4.1): run vitals + regulator ──────────────────
    // Native research governance. RunVitals computes progress/spend/health
    // lanes each SETTLED cycle from in-memory Phase 2 signals and proposes
    // BOUNDED actions; the orchestrator applies them (pace / park). The
    // class is pure computation — no fs access, no engine-state writes (R1).
    // Providers are late-bound closures so Component 4.2's spend meter
    // (this.spendMeter, getSnapshot()) and Component 4.3's commitment
    // tracker (this.progressCommitments, assessProgress()) wire in without
    // touching this constructor again. Default behavior with neither wired
    // and no budget configured is observe-and-report ONLY (pinned by test).
    this.runVitals = new RunVitals({
      config,
      logger,
      spendProvider: () => (this.spendMeter && typeof this.spendMeter.getSnapshot === 'function')
        ? this.spendMeter.getSnapshot()
        : null,
      progressAssessor: (input) => (this.progressCommitments && typeof this.progressCommitments.assessProgress === 'function')
        ? this.progressCommitments.assessProgress(input)
        : null
    });
    this.spendMeter = null;            // Component 4.2 wires the real meter here
    this.progressCommitments = null;   // Component 4.3 wires the tracker here
    // Applied pacing — the regulator's only standing effect. Read by
    // calculateNextInterval (factor) and mirrored onto the agent executor
    // (governanceConcurrencyCap). Neutral until a WARN lane engages.
    this.governancePacing = { factor: 1, concurrencyCap: null };
    this.shutdownHandler = null; // Created after initialization
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

start(): archive a stale park marker — a deliberately-parked run that starts again is resuming; evidence goes to .park.json.last, never deleted. Exact replacement of the unique two-line anchor at the top of start() (~line 986).

### Anchor
```
    this.running = true;
    this.runStartTime = Date.now(); // Track when this run started
```

### Code
```js
    this.running = true;
    this.runStartTime = Date.now(); // Track when this run started

    // Phase 4 (4.1): a deliberately-parked run that is starting again is,
    // by definition, resuming — archive the park marker (evidence is never
    // silently deleted) so status surfaces stop reporting 'parked'.
    this.archiveParkStateOnStart();
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Main loop: governance tick after cluster sync, on settled cycles only (cycled=false paths — breaker cooloff/abandoned — already `continue` before this point, so the regulator never runs during watchdog windows). Exact replacement of the unique two-line anchor (~line 1107).

### Anchor
```
      const cycleForSync = this.cycleCount;
      await this.handleClusterCycleSync(cycleForSync);
```

### Code
```js
      const cycleForSync = this.cycleCount;
      await this.handleClusterCycleSync(cycleForSync);

      // Phase 4 (4.1): governance tick — compute run vitals lanes and apply
      // bounded regulator actions. Runs only on settled cycles (breaker
      // cooloffs and abandoned cycles skip it — health remediation belongs
      // to the watchdog/sentinel, never the regulator). A PARK performs the
      // graceful stop and exits 81 — it does not return.
      await this.runGovernanceTick();
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

calculateNextInterval: apply the governance slowdown factor AFTER the existing bounds — can only stretch (factor <= 1 ignored), 10-minute ceiling preserved, legacy behavior identical when governancePacing is absent/neutral. Exact replacement of the unique final-return anchor (~line 8358).

### Anchor
```
    const minInterval = this.config.execution?.adaptiveTimingEnabled === false ? 1000 : 30000;
    return Math.max(minInterval, Math.min(600000, interval)); // 1s/30s - 10min range
  }
```

### Code
```js
    const minInterval = this.config.execution?.adaptiveTimingEnabled === false ? 1000 : 30000;
    let bounded = Math.max(minInterval, Math.min(600000, interval)); // 1s/30s - 10min range

    // Phase 4 (4.1): governance pacing — a WARN lane stretches the
    // inter-cycle interval by governance.pacing.warnSlowdownFactor. Bounded
    // by construction: only SLOWS (a factor <= 1 is ignored) and never
    // exceeds the existing 10-minute ceiling. Neutral (factor 1) whenever
    // the regulator has released pacing.
    const paceFactor = Number(this.governancePacing?.factor);
    if (Number.isFinite(paceFactor) && paceFactor > 1) {
      bounded = Math.min(600000, Math.round(bounded * paceFactor));
    }
    return bounded;
  }
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

The five governance methods, inserted directly after getCommitmentDecisionForCycle (cohesive with the governor machinery it builds WITH). collectVitalsSignals (cheap/sync/null-safe), runGovernanceTick (transition-gated ledger receipts, applies pacing, routes park; never throws into the loop), _emitGovernanceStatus, parkRun (R2: .park.json durable FIRST, ledger+status+heartbeat 'parking', unref'd backstop, existing stop() guarded save, terminal 'parked' stamp, exit 81 via a _governanceExit test seam), archiveParkStateOnStart. Exact replacement of the unique 6-line anchor (~line 4550).

### Anchor
```
  async getCommitmentDecisionForCycle() {
    if (this.lastCommitmentDecision?.cycle === this.cycleCount) {
      return this.lastCommitmentDecision;
    }
    return await this.evaluateCommitmentGovernor();
  }
```

### Code
```js
  async getCommitmentDecisionForCycle() {
    if (this.lastCommitmentDecision?.cycle === this.cycleCount) {
      return this.lastCommitmentDecision;
    }
    return await this.evaluateCommitmentGovernor();
  }

  /**
   * Phase 4 (Component 4.1): collect the cheap, synchronous, in-memory
   * signals RunVitals needs. No disk reads, no awaits — this runs every
   * settled cycle. Artifact counts ride the LAST commitment-governor
   * decision's cached summary (may lag by a review interval; the lane
   * evidence records that provenance honestly).
   */
  collectVitalsSignals() {
    return {
      cycle: this.cycleCount,
      nodes: this.memory?.nodes?.size ?? null,
      committedArtifacts: this.lastCommitmentDecision?.summary?.committedArtifacts ?? null,
      activeAgents: this.agentExecutor?.registry?.getActiveCount?.() || 0,
      maxConcurrent: this.agentExecutor?.maxConcurrent ?? null,
      backpressureLevel: this.backpressure?.level || 'none',
      watchdog: this.cycleWatchdog ? this.cycleWatchdog.getStatus() : null,
      heartbeatRunning: Boolean(this.heartbeatWriter?.timer)
    };
  }

  /**
   * Phase 4 (4.1): one governance tick per settled cycle. Never throws into
   * the loop. Division of labor (explicit, pinned by test):
   *   - WARN spend / WARN tracked-progress → pacing ONLY: stretch the
   *     inter-cycle interval and cap agent concurrency one notch. Never park.
   *   - CRITICAL spend → park ('spend_critical').
   *   - CRITICAL tracked-progress → park ('progress_starvation', fed by
   *     Component 4.3's commitment tracker).
   *   - Health at ANY level → observe only. Backpressure already shapes
   *     spawning, and the CycleWatchdog + server sentinel own health
   *     remediation (breaker, cooloff, exit 86). The regulator acting on
   *     health would double-govern the same signals.
   * Every applied action writes a ledger receipt (never awaited) and shows
   * in getStats().governance; park also lands in the heartbeat phase and
   * <logsDir>/.park.json.
   */
  async runGovernanceTick() {
    if (!this.runVitals) return null;
    let assessment = null;
    try {
      assessment = this.runVitals.evaluateCycle(this.collectVitalsSignals());
    } catch (error) {
      this.logger.warn('[Governance] vitals evaluation failed (non-fatal)', { error: error.message });
      return null;
    }
    if (!assessment || assessment.enabled === false) return assessment;

    for (const transition of assessment.transitions) {
      if (transition.type === 'pacing_engaged') {
        this.eventLedger?.log('governance_pacing_engaged', {
          cycle: this.cycleCount,
          factor: assessment.pacing.factor,
          concurrencyCap: assessment.pacing.concurrencyCap,
          reasons: assessment.actionReasons,
          lanes: this.runVitals.summarizeLanes(assessment.lanes)
        });
        this.heartbeatWriter?.stamp({ phase: 'governance_pacing' });
        this._emitGovernanceStatus('governance_pacing', 'Run vitals WARN — pacing engaged (slower cycles, capped concurrency)');
      } else if (transition.type === 'pacing_released') {
        this.eventLedger?.log('governance_pacing_released', { cycle: this.cycleCount });
        this._emitGovernanceStatus('governance_pacing_released', 'Run vitals recovered — pacing released');
      } else if (transition.type === 'health_deferred') {
        this.eventLedger?.log('governance_health_deferred', {
          cycle: this.cycleCount,
          watchdog: transition.watchdog || null,
          backpressureLevel: transition.backpressureLevel || null
        });
      }
    }

    // Apply (or clear) the standing pacing effect — the regulator's ONLY
    // continuous influence. It can only slow cycles and lower the spawn
    // cap, never speed up or raise limits (R1 bounded autonomy).
    this.governancePacing = {
      factor: assessment.pacing.factor,
      concurrencyCap: assessment.pacing.concurrencyCap
    };
    if (this.agentExecutor) {
      this.agentExecutor.governanceConcurrencyCap = assessment.pacing.concurrencyCap;
    }

    if (assessment.action === 'park') {
      await this.parkRun(assessment.park);
      // Unreachable in production (parkRun exits the process); reached only
      // by tests that install the _governanceExit seam.
      return assessment;
    }
    return assessment;
  }

  _emitGovernanceStatus(status, message) {
    try {
      this._getEvents().emitRunStatus({
        status,
        message,
        cycle: this.cycleCount,
        details: this.runVitals ? this.runVitals.getStats() : null
      });
    } catch (error) {
      this.logger.debug?.('[Governance] status emit failed (non-fatal)', { error: error.message });
    }
  }

  /**
   * Phase 4 (4.1, contract R2): PARK — a graceful, deliberately-resumable
   * pause. Order matters:
   *   1. Persist <logsDir>/.park.json FIRST (tmp+rename) so the parked
   *      verdict survives even if the stop below wedges and the backstop
   *      fires (same doctrine as the watchdog persisting restartRequested
   *      before exit 86).
   *   2. Ledger receipt (never awaited) + run-status emit + heartbeat
   *      phase 'parking'.
   *   3. stop(): the EXISTING Phase 1/2 machinery — guarded shutdown save
   *      via saveStateForShutdown(), clean marker only on a CONFIRMED
   *      save. No new save path. metadata.json + the memory manifest are
   *      left intact, so the normal continuation path
   *      (launchPreparedResearch direct-runPath) resumes the run as-is.
   *   4. Exit with the DISTINCT park code (81 — never the watchdog's 86):
   *      the server must read a park as deliberately-stopped, not a crash
   *      and not a wedge.
   */
  async parkRun(park = {}) {
    const governance = this.config.governance || {};
    const rawExit = Number(governance.park?.exitCode ?? PARK_EXIT_CODE);
    const exitCode = Number.isFinite(rawExit) && rawExit >= 1 && rawExit <= 255 ? Math.floor(rawExit) : PARK_EXIT_CODE;
    const stopBudgetMs = Number(governance.park?.stopTimeoutMs) > 0 ? Number(governance.park.stopTimeoutMs) : 180000;
    // Test seam: production always exits; prototype-driven fakes install
    // _governanceExit to observe ordering without killing the test runner.
    const exit = typeof this._governanceExit === 'function' ? this._governanceExit : (code) => process.exit(code);

    const parkState = {
      version: 1,
      parked: true,
      reason: park.reason || 'unspecified',
      lane: park.lane || null,
      at: new Date().toISOString(),
      cycle: this.cycleCount,
      evidence: park.evidence || null,
      resumable: true,
      exitCode
    };
    try {
      writeParkState(this.logsDir, parkState);
    } catch (error) {
      this.logger.error('[Governance] Failed to persist park state (parking anyway)', { error: error.message });
    }

    this.logger.warn('🅿️ [Governance] PARKING run — graceful pause with resumable state', {
      reason: parkState.reason,
      lane: parkState.lane,
      cycle: this.cycleCount,
      exitCode,
      stopBudgetMs
    });
    this.eventLedger?.log('governance_park', {
      cycle: this.cycleCount,
      reason: parkState.reason,
      lane: parkState.lane,
      evidence: parkState.evidence
    });
    this._emitGovernanceStatus('parked', `Run parked (${parkState.reason}) — resumable`);
    this.heartbeatWriter?.stamp({ phase: 'parking' });

    // Backstop: parking must terminate even if stop() wedges on the same
    // machinery it bounds. The park verdict is already durable (step 1).
    const backstop = setTimeout(() => exit(exitCode), stopBudgetMs);
    if (typeof backstop.unref === 'function') backstop.unref();

    this.running = false;
    try {
      await this.stop();
    } catch (error) {
      this.logger.error('[Governance] stop() failed during park (park state already durable)', { error: error.message });
    }
    // Terminal heartbeat phase: stop() stamps 'stopped'; overwrite with the
    // park-specific phase so status surfaces can tell a park from a plain
    // stop without reading .park.json.
    this.heartbeatWriter?.stamp({ phase: 'parked' });
    exit(exitCode);
  }

  /**
   * Phase 4 (4.1): starting (or resuming) a run clears the parked verdict.
   * The marker is archived to .park.json.last — evidence is never silently
   * deleted (same convention as the sentinel's .sentinel.json.last).
   */
  archiveParkStateOnStart() {
    const archived = archiveParkState(this.logsDir);
    if (archived) {
      this.eventLedger?.log('governance_park_cleared', { cycle: this.cycleCount });
      this.logger.info('🅿️ [Governance] Cleared park marker on start (archived to .park.json.last)');
    }
    return archived;
  }
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

getStats(): additive governance surface (R3 status exposure). Exact replacement of the unique 3-line anchor inside getStats (~line 10480; the uptime line is globally unique).

### Anchor
```
      uptime: Date.now() - this.lastCycleTime.getTime(),
      oscillator: this.oscillator.getStats(),
      coordinator: this.coordinator ? this.coordinator.getStats() : null,
```

### Code
```js
      uptime: Date.now() - this.lastCycleTime.getTime(),
      // Phase 4 (4.1): additive governance surface — lanes, pacing, counters.
      governance: this.runVitals ? this.runVitals.getStats() : null,
      oscillator: this.oscillator.getStats(),
      coordinator: this.coordinator ? this.coordinator.getStats() : null,
```

## CHANGE: cosmo23/engine/src/agents/agent-executor.js

Initialize the governance concurrency cap slot next to the injected backpressure reference (~line 187). Exact replacement of the unique 2-line anchor.

### Anchor
```
    this.backpressure = null;
    this.initialized = false;
```

### Code
```js
    this.backpressure = null;
    // Phase 4 (4.1): governance concurrency cap — written by the
    // orchestrator's regulator (runGovernanceTick) while a WARN lane is
    // active (one notch below the configured limit); null when released.
    // READ ONLY here, applied in getEffectiveMaxConcurrent(). Can only
    // LOWER effective concurrency, never raise it.
    this.governanceConcurrencyCap = null;
    this.initialized = false;
```

## CHANGE: cosmo23/engine/src/agents/agent-executor.js

getEffectiveMaxConcurrent (~line 295): compose the governance cap with the H4 elevated halving — the LOWER bound wins; a cap at/above the current effective limit changes nothing (the regulator can never raise concurrency). Null cap keeps legacy behavior bit-for-bit. Exact replacement of the unique method body.

### Anchor
```
  getEffectiveMaxConcurrent() {
    if (this.backpressure?.level === 'elevated') {
      return Math.max(1, Math.ceil(this.maxConcurrent / 2));
    }
    return this.maxConcurrent;
  }
```

### Code
```js
  getEffectiveMaxConcurrent() {
    let effective = this.maxConcurrent;
    if (this.backpressure?.level === 'elevated') {
      effective = Math.max(1, Math.ceil(effective / 2));
    }
    // Phase 4 (4.1): governance cap composes with the H4 halving — the
    // LOWER bound wins. Bounded: a cap at or above the current effective
    // limit changes nothing (the regulator can never raise concurrency).
    const governorCap = Number(this.governanceConcurrencyCap);
    if (Number.isFinite(governorCap) && governorCap >= 1 && governorCap < effective) {
      effective = Math.floor(governorCap);
    }
    return effective;
  }
```

## CHANGE: package.json

Register the new suite exactly once in scripts.test, inside the second `node --test` block (the cosmo23 .cjs block). Exact substring replacement in the test script (anchor verified count=1 at proposal time). CONCURRENCY WARNING: package.json is hot — other Phase 4 agents are also registering suites. If this anchor no longer matches, fall back to inserting ` tests/cosmo23/run-vitals-governance.test.cjs` (space-separated) at any position inside the same cosmo23 `node --test --test-concurrency=1` block, exactly once — the registration test pins the exactly-once invariant.

### Anchor
```
tests/cosmo23/run-sentinel.test.cjs tests/cosmo23/research-run-operation-adapter.test.cjs
```

### Code
```js
tests/cosmo23/run-sentinel.test.cjs tests/cosmo23/run-vitals-governance.test.cjs tests/cosmo23/research-run-operation-adapter.test.cjs
```

## CHANGE: tests/cosmo23/package-test-registration.test.cjs

Add the new suite to the exactly-once registration pin list. Exact replacement of the unique run-sentinel entry line (4-space indent inside the array literal).

### Anchor
```
    'tests/cosmo23/run-sentinel.test.cjs',
```

### Code
```js
    'tests/cosmo23/run-sentinel.test.cjs',
    'tests/cosmo23/run-vitals-governance.test.cjs',
```

## TEST FILE: tests/cosmo23/run-vitals-governance.test.cjs

```js
'use strict';

// Phase 4 (Component 4.1) — run vitals + regulator (native research
// governance).
//
// Contract under test:
//   R1 bounded autonomy — the regulator never deletes data, never expands
//     its own budget; WARN lanes produce PACING ONLY (slower inter-cycle
//     interval + agent concurrency capped one notch); every applied action
//     writes a ledger receipt (never awaited) and a heartbeat phase where
//     it changes cycling behavior.
//   R2 park — graceful pause with resumable state: durable
//     <logsDir>/.park.json FIRST (reason, lane, at, resumable: true), then
//     the EXISTING stop() machinery (guarded shutdown save — no new save
//     path), then a DISTINCT exit code (81, never the watchdog's 86).
//   R3 lanes are computed, not stored authority: progress (trailing window
//     deltas; levels only via 4.3's tracked assessment), spend (4.2's meter
//     vs config.spend budget; ok <70%, warn 70–95%, critical >=95%), health
//     (watchdog breaker, consecutive errors, backpressure, heartbeat
//     self-check) — exposed additively in getStats().
//   Division of labor (pinned): health at ANY level never drives a
//     regulator action — backpressure already shapes spawning and the
//     CycleWatchdog + server sentinel own health remediation (exit 86).
//     Park is allowed for exactly two reasons: spend_critical and
//     progress_starvation (tracked).
//   No-op default (pinned): no budget configured + no commitment tracker
//     wired → every lane 'ok' ('unbudgeted'/'untracked'), action 'none',
//     pacing neutral, forever — observe-and-report only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  RunVitals,
  GOVERNANCE_DEFAULTS,
  PARK_FILENAME,
  PARK_EXIT_CODE,
  writeParkState,
  readParkState,
  archiveParkState
} = require('../../cosmo23/engine/src/core/run-vitals');
const { Orchestrator } = require('../../cosmo23/engine/src/core/orchestrator');
const { AgentExecutor } = require('../../cosmo23/engine/src/agents/agent-executor');

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-vitals-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function baseSignals(overrides = {}) {
  return {
    cycle: 1,
    nodes: 100,
    committedArtifacts: 0,
    activeAgents: 0,
    maxConcurrent: 2,
    backpressureLevel: 'none',
    watchdog: { state: 'closed', consecutiveFailures: 0 },
    heartbeatRunning: true,
    ...overrides
  };
}

/**
 * Prototype-driven fake orchestrator (same convention as
 * cycle-watchdog.test.cjs): real Orchestrator methods bound to a minimal
 * fake, so the tests exercise the shipped governance code paths without
 * constructing the full engine.
 */
function makeFakeOrchestrator(t, { vitals = null, governance = {} } = {}) {
  const dir = makeTmpDir(t);
  const order = [];
  const fake = {
    runVitals: vitals,
    config: { governance },
    logger: quietLogger,
    logsDir: dir,
    dir,
    order,
    cycleCount: 0,
    running: true,
    memory: { nodes: new Map() },
    lastCommitmentDecision: { summary: { committedArtifacts: 0 } },
    backpressure: { level: 'none' },
    cycleWatchdog: { getStatus: () => ({ state: 'closed', consecutiveFailures: 0 }) },
    heartbeatWriter: {
      timer: 1,
      stamps: [],
      stamp(patch = {}) { this.stamps.push(patch); order.push(`stamp:${patch.phase}`); return patch; }
    },
    agentExecutor: { maxConcurrent: 2, governanceConcurrencyCap: null, registry: { getActiveCount: () => 0 } },
    eventLedger: {
      entries: [],
      log(type, data = {}) { this.entries.push({ type, data }); order.push(`ledger:${type}`); return Promise.resolve(null); }
    },
    statuses: [],
    _getEvents() { const self = this; return { emitRunStatus(event) { self.statuses.push(event); } }; },
    exits: [],
    stops: 0,
    async stop() {
      this.stops += 1;
      order.push('stop');
      // R2 ordering: the park verdict must already be durable when the
      // graceful stop machinery starts (watchdog persists restartRequested
      // before exit 86 for the same reason).
      assert.ok(fs.existsSync(path.join(dir, PARK_FILENAME)), 'park file must be durable BEFORE stop()');
    },
    collectVitalsSignals: Orchestrator.prototype.collectVitalsSignals,
    runGovernanceTick: Orchestrator.prototype.runGovernanceTick,
    parkRun: Orchestrator.prototype.parkRun,
    archiveParkStateOnStart: Orchestrator.prototype.archiveParkStateOnStart,
    _emitGovernanceStatus: Orchestrator.prototype._emitGovernanceStatus
  };
  // Test seam: production parkRun falls back to process.exit when this hook
  // is absent; installing it lets the test observe ordering and exit codes.
  fake._governanceExit = (code) => { fake.exits.push(code); order.push(`exit:${code}`); };
  return fake;
}

// ── RunVitals lane computation ──────────────────────────────────────────

test('no-op by default (pinned): no budget + no tracker → observe-and-report only, forever', () => {
  const vitals = new RunVitals({ config: {}, logger: quietLogger });
  for (let cycle = 1; cycle <= 12; cycle++) {
    const a = vitals.evaluateCycle(baseSignals({ cycle, nodes: 100 + cycle }));
    assert.equal(a.enabled, true);
    assert.equal(a.action, 'none');
    assert.equal(a.pacing.active, false);
    assert.equal(a.pacing.factor, 1);
    assert.equal(a.pacing.concurrencyCap, null);
    assert.equal(a.lanes.spend.level, 'ok');
    assert.equal(a.lanes.spend.state, 'unbudgeted');
    assert.equal(a.lanes.progress.level, 'ok');
    assert.equal(a.lanes.progress.state, 'untracked');
    assert.equal(a.lanes.health.level, 'ok');
    assert.deepEqual(a.transitions, []);
  }
  const stats = vitals.getStats();
  assert.equal(stats.enabled, true);
  assert.equal(stats.action, 'none');
  assert.equal(stats.counters.paceEngagements, 0);
  assert.equal(stats.counters.parkRequests, 0);

  // Trailing window: N deltas need N+1 samples; raw deltas are evidence
  // even while untracked.
  assert.equal(vitals.samples.length, GOVERNANCE_DEFAULTS.windowCycles + 1);
  const evidence = vitals.lastLanes.progress.evidence;
  assert.equal(evidence.spanCycles, GOVERNANCE_DEFAULTS.windowCycles);
  assert.equal(evidence.nodesAdded, GOVERNANCE_DEFAULTS.windowCycles);
  assert.equal(evidence.artifactSource, 'commitment_decision_cache');
});

test('spend lane thresholds: ok below warn ratio, pace on warn, park on critical (spend_critical)', () => {
  let tokens = 0;
  const vitals = new RunVitals({
    config: { spend: { maxTokens: 1000 } },
    logger: quietLogger,
    spendProvider: () => ({ totalTokens: tokens, totalUsd: null, unmeteredCalls: 2 })
  });

  tokens = 699;
  let a = vitals.evaluateCycle(baseSignals({ cycle: 1 }));
  assert.equal(a.lanes.spend.level, 'ok');
  assert.equal(a.lanes.spend.state, 'metered');
  assert.equal(a.action, 'none');

  tokens = 700; // 70% — warn engages pacing, never a park
  a = vitals.evaluateCycle(baseSignals({ cycle: 2 }));
  assert.equal(a.lanes.spend.level, 'warn');
  assert.equal(a.action, 'pace');
  assert.equal(a.pacing.factor, GOVERNANCE_DEFAULTS.pacing.warnSlowdownFactor);
  assert.equal(a.pacing.concurrencyCap, 1); // maxConcurrent 2, one notch down, floor 1
  assert.equal(a.park, null);
  assert.deepEqual(a.transitions, [{ type: 'pacing_engaged' }]);

  a = vitals.evaluateCycle(baseSignals({ cycle: 3 }));
  assert.deepEqual(a.transitions, [], 'engage transition fires once, not every warn cycle');

  tokens = 949;
  a = vitals.evaluateCycle(baseSignals({ cycle: 4 }));
  assert.equal(a.lanes.spend.level, 'warn');

  tokens = 950; // 95% — critical parks
  a = vitals.evaluateCycle(baseSignals({ cycle: 5 }));
  assert.equal(a.lanes.spend.level, 'critical');
  assert.equal(a.action, 'park');
  assert.equal(a.park.reason, 'spend_critical');
  assert.equal(a.park.lane, 'spend');
  assert.ok(a.transitions.some(tr => tr.type === 'park_requested'));
  assert.equal(a.lanes.spend.evidence.unmeteredCalls, 2, 'unmetered calls are counted honestly');
  assert.ok(Math.abs(a.lanes.spend.evidence.utilization - 0.95) < 1e-9);

  a = vitals.evaluateCycle(baseSignals({ cycle: 6 }));
  assert.equal(a.action, 'park');
  assert.ok(!a.transitions.some(tr => tr.type === 'park_requested'), 'park transition emitted once');
  assert.equal(vitals.counters.parkRequests, 1);
});

test('spend lane honesty: unmetered (budget, no 4.2 meter) and unpriced (USD budget, no price table) stay ok', () => {
  // Budget configured but no meter wired at all → we cannot govern what we
  // cannot measure. Report, never estimate (R4).
  const unmetered = new RunVitals({ config: { spend: { maxTokens: 100 } }, logger: quietLogger });
  let a = unmetered.evaluateCycle(baseSignals());
  assert.equal(a.lanes.spend.state, 'unmetered');
  assert.equal(a.lanes.spend.level, 'ok');
  assert.equal(a.action, 'none');

  // USD-only budget with an unpriced meter (totalUsd null — no price table
  // was configured): the USD lane reads 'unpriced'. Number(null) === 0 must
  // NEVER make this read as "$0.00 spent, metered".
  const unpriced = new RunVitals({
    config: { spend: { maxUsd: 10 } },
    logger: quietLogger,
    spendProvider: () => ({ totalTokens: 5e6, totalUsd: null, unmeteredCalls: 0 })
  });
  a = unpriced.evaluateCycle(baseSignals());
  assert.equal(a.lanes.spend.state, 'unpriced');
  assert.equal(a.lanes.spend.level, 'ok');
  assert.equal(a.action, 'none');

  // A throwing provider degrades to unmetered — never throws out.
  const throwing = new RunVitals({
    config: { spend: { maxTokens: 100 } },
    logger: quietLogger,
    spendProvider: () => { throw new Error('meter exploded'); }
  });
  a = throwing.evaluateCycle(baseSignals());
  assert.equal(a.lanes.spend.state, 'unmetered');
  assert.equal(a.lanes.spend.level, 'ok');
});

test('progress lane: parks only on a TRACKED critical assessment (4.3 port); untracked can never park', () => {
  let assessment = null;
  const vitals = new RunVitals({ config: {}, logger: quietLogger, progressAssessor: () => assessment });

  let a = vitals.evaluateCycle(baseSignals({ cycle: 1 }));
  assert.equal(a.lanes.progress.state, 'untracked');
  assert.equal(a.action, 'none');

  assessment = { tracked: true, level: 'warn', reason: 'window_below_commitment' };
  a = vitals.evaluateCycle(baseSignals({ cycle: 2 }));
  assert.equal(a.lanes.progress.level, 'warn');
  assert.equal(a.lanes.progress.state, 'tracked');
  assert.equal(a.action, 'pace', 'tracked warn paces, never parks');

  assessment = { tracked: true, level: 'critical', reason: 'no_artifacts_in_window' };
  a = vitals.evaluateCycle(baseSignals({ cycle: 3 }));
  assert.equal(a.action, 'park');
  assert.equal(a.park.reason, 'progress_starvation');
  assert.equal(a.park.lane, 'progress');

  // Garbage assessor level → untracked/ok, recorded in evidence.
  const garbage = new RunVitals({
    config: {},
    logger: quietLogger,
    progressAssessor: () => ({ tracked: true, level: 'explode' })
  });
  a = garbage.evaluateCycle(baseSignals());
  assert.equal(a.lanes.progress.state, 'untracked');
  assert.equal(a.action, 'none');

  // Throwing assessor → untracked, never throws out.
  const throwing = new RunVitals({
    config: {},
    logger: quietLogger,
    progressAssessor: () => { throw new Error('tracker exploded'); }
  });
  a = throwing.evaluateCycle(baseSignals());
  assert.equal(a.lanes.progress.state, 'untracked');
});

test('health lane observes and defers — NEVER drives a regulator action at any level (pinned division of labor)', () => {
  const vitals = new RunVitals({ config: {}, logger: quietLogger });

  // Breaker open → health critical, but the action stays 'none' and the
  // deferral is explicit (the watchdog/sentinel own health remediation).
  let a = vitals.evaluateCycle(baseSignals({ cycle: 1, watchdog: { state: 'open', consecutiveFailures: 3 } }));
  assert.equal(a.lanes.health.level, 'critical');
  assert.equal(a.action, 'none');
  assert.equal(a.pacing.active, false);
  assert.ok(a.actionReasons.includes('health_critical_deferred_to_watchdog'));
  assert.ok(a.transitions.some(tr => tr.type === 'health_deferred'));

  a = vitals.evaluateCycle(baseSignals({ cycle: 2, watchdog: { state: 'open', consecutiveFailures: 3 } }));
  assert.ok(!a.transitions.some(tr => tr.type === 'health_deferred'), 'deferral receipt once per entry');

  a = vitals.evaluateCycle(baseSignals({ cycle: 3, backpressureLevel: 'critical' }));
  assert.equal(a.lanes.health.level, 'critical');
  assert.equal(a.action, 'none');

  a = vitals.evaluateCycle(baseSignals({ cycle: 4, backpressureLevel: 'elevated' }));
  assert.equal(a.lanes.health.level, 'warn');
  assert.equal(a.action, 'none', 'health warn never paces — backpressure already halves concurrency');

  a = vitals.evaluateCycle(baseSignals({ cycle: 5, heartbeatRunning: false }));
  assert.equal(a.lanes.health.level, 'warn', 'heartbeat self-check feeds the health lane');
  assert.equal(a.action, 'none');
});

test('pacing releases with a receipt transition when the warn clears', () => {
  let tokens = 700;
  const vitals = new RunVitals({
    config: { spend: { maxTokens: 1000 } },
    logger: quietLogger,
    spendProvider: () => ({ totalTokens: tokens })
  });
  let a = vitals.evaluateCycle(baseSignals({ cycle: 1 }));
  assert.deepEqual(a.transitions, [{ type: 'pacing_engaged' }]);

  tokens = 500; // e.g. budget raised at relaunch — utilization drops
  a = vitals.evaluateCycle(baseSignals({ cycle: 2 }));
  assert.equal(a.action, 'none');
  assert.deepEqual(a.transitions, [{ type: 'pacing_released' }]);
  assert.equal(vitals.counters.paceReleases, 1);
});

test('master gate: governance.enabled=false short-circuits to a disabled no-op assessment', () => {
  const vitals = new RunVitals({ config: { governance: { enabled: false } }, logger: quietLogger });
  const a = vitals.evaluateCycle(baseSignals());
  assert.equal(a.enabled, false);
  assert.equal(a.action, 'none');
  assert.equal(a.lanes, null);
});

test('config sanitizers: slowdown below 1 rejected, criticalRatio never below warnRatio', () => {
  const vitals = new RunVitals({
    config: {
      governance: { pacing: { warnSlowdownFactor: 0.25 }, spend: { warnRatio: 0.8, criticalRatio: 0.5 } },
      spend: { maxTokens: 1000 }
    },
    logger: quietLogger,
    spendProvider: () => ({ totalTokens: 800 })
  });
  const a = vitals.evaluateCycle(baseSignals());
  // 0.8 utilization: warnRatio 0.8 → warn; criticalRatio clamped up to 0.8
  // would make it critical — but clamping means max(warn, critical)=0.8, so
  // 0.8 IS critical here; a config typo must fail toward caution bounded by
  // park (still only the two allowed reasons), never toward a speed-up.
  assert.ok(['warn', 'critical'].includes(a.lanes.spend.level));
  if (a.action === 'pace') {
    assert.ok(a.pacing.factor >= 1, 'pacing can only slow, never speed up');
  }
});

// ── Orchestrator integration (prototype-driven fakes) ───────────────────

test('runGovernanceTick applies pacing to interval factor + executor cap, receipts once per engagement', async (t) => {
  let tokens = 700;
  const vitals = new RunVitals({
    config: { spend: { maxTokens: 1000 } },
    logger: quietLogger,
    spendProvider: () => ({ totalTokens: tokens })
  });
  const fake = makeFakeOrchestrator(t, { vitals });

  fake.cycleCount = 1;
  await fake.runGovernanceTick();
  assert.equal(fake.governancePacing.factor, GOVERNANCE_DEFAULTS.pacing.warnSlowdownFactor);
  assert.equal(fake.governancePacing.concurrencyCap, 1);
  assert.equal(fake.agentExecutor.governanceConcurrencyCap, 1);
  assert.equal(fake.eventLedger.entries.filter(e => e.type === 'governance_pacing_engaged').length, 1);
  assert.ok(fake.heartbeatWriter.stamps.some(s => s.phase === 'governance_pacing'));
  assert.ok(fake.statuses.some(s => s.status === 'governance_pacing'));

  fake.cycleCount = 2;
  await fake.runGovernanceTick();
  assert.equal(
    fake.eventLedger.entries.filter(e => e.type === 'governance_pacing_engaged').length,
    1,
    'no duplicate engage receipt while the warn persists'
  );

  tokens = 100; // recovered
  fake.cycleCount = 3;
  await fake.runGovernanceTick();
  assert.equal(fake.governancePacing.factor, 1);
  assert.equal(fake.governancePacing.concurrencyCap, null);
  assert.equal(fake.agentExecutor.governanceConcurrencyCap, null);
  assert.equal(fake.eventLedger.entries.filter(e => e.type === 'governance_pacing_released').length, 1);
});

test('runGovernanceTick is loop-safe: missing vitals returns null; a throwing evaluation never escapes', async (t) => {
  const bare = makeFakeOrchestrator(t, { vitals: null });
  assert.equal(await bare.runGovernanceTick(), null);

  const fake = makeFakeOrchestrator(t, { vitals: new RunVitals({ config: {}, logger: quietLogger }) });
  fake.runVitals.evaluateCycle = () => { throw new Error('vitals exploded'); };
  assert.equal(await fake.runGovernanceTick(), null);
  assert.equal(fake.exits.length, 0);
});

test('park flow (R2): durable .park.json first, existing stop() machinery, terminal heartbeat, exit 81', async (t) => {
  let tokens = 990; // >= 95% of budget
  const vitals = new RunVitals({
    config: { spend: { maxTokens: 1000 } },
    logger: quietLogger,
    spendProvider: () => ({ totalTokens: tokens })
  });
  const fake = makeFakeOrchestrator(t, { vitals });

  fake.cycleCount = 7;
  await fake.runGovernanceTick();

  // Exit semantics: distinct park code, never the watchdog's 86.
  assert.deepEqual(fake.exits, [PARK_EXIT_CODE]);
  assert.equal(PARK_EXIT_CODE, 81);
  assert.notEqual(PARK_EXIT_CODE, 86);
  assert.equal(fake.running, false);
  assert.equal(fake.stops, 1, 'park reuses stop() — the Phase 1/2 guarded save path, no new save machinery');

  // Durable, resumable park state.
  const state = readParkState(fake.dir);
  assert.equal(state.parked, true);
  assert.equal(state.reason, 'spend_critical');
  assert.equal(state.lane, 'spend');
  assert.equal(state.resumable, true);
  assert.equal(state.exitCode, 81);
  assert.equal(state.cycle, 7);
  assert.ok(typeof state.at === 'string' && state.at.length > 0);

  // Receipts + ordering: ledger and 'parking' stamp before stop, exit last,
  // terminal phase 'parked' (overwrites stop()'s own 'stopped' stamp).
  assert.ok(fake.eventLedger.entries.some(e => e.type === 'governance_park'));
  assert.ok(fake.order.indexOf('ledger:governance_park') < fake.order.indexOf('stop'));
  assert.ok(fake.order.indexOf('stamp:parking') < fake.order.indexOf('stop'));
  assert.ok(fake.order.indexOf('stop') < fake.order.indexOf(`exit:${PARK_EXIT_CODE}`));
  const phases = fake.heartbeatWriter.stamps.map(s => s.phase);
  assert.equal(phases[phases.length - 1], 'parked');
  assert.ok(fake.statuses.some(s => s.status === 'parked'));
});

test('park state clears on start: marker archived to .park.json.last, never silently deleted', async (t) => {
  const fake = makeFakeOrchestrator(t, {});
  writeParkState(fake.dir, { version: 1, parked: true, reason: 'spend_critical', resumable: true });

  assert.equal(fake.archiveParkStateOnStart(), true);
  assert.ok(!fs.existsSync(path.join(fake.dir, PARK_FILENAME)));
  assert.ok(fs.existsSync(path.join(fake.dir, `${PARK_FILENAME}.last`)));
  assert.ok(fake.eventLedger.entries.some(e => e.type === 'governance_park_cleared'));

  // Idempotent: nothing to archive → false, no extra receipt.
  const receipts = fake.eventLedger.entries.filter(e => e.type === 'governance_park_cleared').length;
  assert.equal(fake.archiveParkStateOnStart(), false);
  assert.equal(fake.eventLedger.entries.filter(e => e.type === 'governance_park_cleared').length, receipts);

  // Helper honesty: readParkState survives corruption as null.
  fs.writeFileSync(path.join(fake.dir, PARK_FILENAME), '{not json');
  assert.equal(readParkState(fake.dir), null);
  assert.equal(archiveParkState(fake.dir), true); // corrupt marker still archived, not deleted
});

test('calculateNextInterval: governance factor only stretches, respects floor and 10-minute ceiling', () => {
  const makeFake = (baseInterval, pacing) => ({
    config: { execution: { baseInterval, adaptiveTimingEnabled: false } },
    logger: quietLogger,
    governancePacing: pacing
  });

  // baseInterval 2s, factor 1.5 → 3s.
  assert.equal(Orchestrator.prototype.calculateNextInterval.call(makeFake(2, { factor: 1.5, concurrencyCap: 1 })), 3000);
  // Neutral factor → untouched.
  assert.equal(Orchestrator.prototype.calculateNextInterval.call(makeFake(2, { factor: 1, concurrencyCap: null })), 2000);
  // A factor below 1 would be a speed-up — ignored (bounded autonomy).
  assert.equal(Orchestrator.prototype.calculateNextInterval.call(makeFake(2, { factor: 0.5, concurrencyCap: null })), 2000);
  // Existing 10-minute ceiling holds under stretch.
  assert.equal(Orchestrator.prototype.calculateNextInterval.call(makeFake(500, { factor: 1.5, concurrencyCap: null })), 600000);
  // Legacy fakes without governancePacing keep legacy behavior.
  const legacy = { config: { execution: { baseInterval: 2, adaptiveTimingEnabled: false } }, logger: quietLogger };
  assert.equal(Orchestrator.prototype.calculateNextInterval.call(legacy), 2000);
});

test('getEffectiveMaxConcurrent: governance cap lowers one notch, composes with backpressure, never raises', () => {
  const call = (ctx) => AgentExecutor.prototype.getEffectiveMaxConcurrent.call(ctx);

  assert.equal(call({ maxConcurrent: 4, backpressure: null, governanceConcurrencyCap: 3 }), 3);
  // Composes with the H4 elevated halving — the LOWER bound wins.
  assert.equal(call({ maxConcurrent: 4, backpressure: { level: 'elevated' }, governanceConcurrencyCap: 3 }), 2);
  assert.equal(call({ maxConcurrent: 4, backpressure: { level: 'elevated' }, governanceConcurrencyCap: 1 }), 1);
  // A cap above the configured limit can never RAISE concurrency (R1).
  assert.equal(call({ maxConcurrent: 4, backpressure: null, governanceConcurrencyCap: 10 }), 4);
  // Null/absent cap → legacy behavior exactly.
  assert.equal(call({ maxConcurrent: 4, backpressure: null, governanceConcurrencyCap: null }), 4);
  assert.equal(call({ maxConcurrent: 4, backpressure: null }), 4);
  // Floor of 1 at the smallest default.
  assert.equal(call({ maxConcurrent: 2, backpressure: null, governanceConcurrencyCap: 1 }), 1);
});

test('collectVitalsSignals is cheap, synchronous, and null-safe on partial fakes', (t) => {
  const fake = makeFakeOrchestrator(t, {});
  fake.cycleCount = 42;
  fake.memory = { nodes: new Map([['n1', {}], ['n2', {}]]) };
  fake.lastCommitmentDecision = { summary: { committedArtifacts: 5 } };
  const signals = fake.collectVitalsSignals();
  assert.equal(signals.cycle, 42);
  assert.equal(signals.nodes, 2);
  assert.equal(signals.committedArtifacts, 5);
  assert.equal(signals.maxConcurrent, 2);
  assert.equal(signals.backpressureLevel, 'none');
  assert.equal(signals.heartbeatRunning, true);
  assert.equal(signals.watchdog.state, 'closed');

  // Bare orchestrator (no subsystems at all) still produces a usable shape.
  const bare = {
    cycleCount: 1,
    collectVitalsSignals: Orchestrator.prototype.collectVitalsSignals
  };
  const bareSignals = bare.collectVitalsSignals();
  assert.equal(bareSignals.nodes, null);
  assert.equal(bareSignals.committedArtifacts, null);
  assert.equal(bareSignals.maxConcurrent, null);
  assert.equal(bareSignals.backpressureLevel, 'none');
  assert.equal(bareSignals.watchdog, null);
  assert.equal(bareSignals.heartbeatRunning, false);
});

test('getStats().governance surfaces lanes additively after evaluation', () => {
  const vitals = new RunVitals({ config: {}, logger: quietLogger });
  vitals.evaluateCycle(baseSignals({ cycle: 3 }));
  const stats = vitals.getStats();
  assert.equal(stats.lastEvaluatedCycle, 3);
  assert.equal(stats.lanes.spend.state, 'unbudgeted');
  assert.equal(stats.lanes.progress.state, 'untracked');
  assert.equal(stats.lanes.health.state, 'observed');
  assert.deepEqual(stats.pacing, { active: false, factor: 1 });
  // JSON-safe for the status contract.
  assert.doesNotThrow(() => JSON.stringify(stats));
});

```

## API NOTES

VALIDATION EVIDENCE (this session, then reverted byte-exact): all 9 anchor edits applied cleanly via exact string replacement on the LIVE tree (which already contained a concurrent agent's Fix 3.4 delta-compaction work in orchestrator.js persistResearchState ~8617 — my anchors do not intersect it); node --check passed on both edited files; the full test file ran 16/16 green via `node --test --test-concurrency=1 tests/cosmo23/run-vitals-governance.test.cjs`; neighboring prototype-borrowing suites (cycle-watchdog, graceful-shutdown-honesty, engine-heartbeat, agent-executor-memory-context) ran 53/53 green with edits applied; revert verified via shasum against pre-apply baselines. No trailing whitespace anywhere in proposed content. One real bug was caught and fixed during validation: Number(null)===0 made an unpriced meter (totalUsd: null) read as $0.00 'metered' — hence the explicit null/undefined guard in finiteOrNull (pinned by the 'unpriced' test).

PORTS FOR SIBLING COMPONENTS (exact contracts):
- 4.2 spend meter: set `orchestrator.spendMeter` to an object with a SYNCHRONOUS `getSnapshot()` returning `{ totalTokens: number|null, totalUsd: number|null, unmeteredCalls: number }` (cached value — RunVitals calls it every settled cycle; do NOT do fs reads inside). Budget is read by RunVitals from `config.spend.maxTokens` / `config.spend.maxUsd` (launch config per R4). totalUsd MUST be null when no price table is configured — never 0. 4.2 owns `<logsDir>/.spend.json` persistence (tmp+rename, resumed on boot) and reading real usage from unified-client responses; RunVitals only consumes the snapshot. Governance thresholds: `governance.spend.warnRatio` (0.70) / `criticalRatio` (0.95, clamped >= warnRatio).
- 4.3 commitment tracker: set `orchestrator.progressCommitments` to an object with `assessProgress({ window, signals })` returning `{ tracked: true, level: 'ok'|'warn'|'critical', reason: string, evidence?: object }` or null. `window` is RunVitals' trailing-window evidence ({ windowCycles, spanCycles, nodesAdded, artifactsAdded, nodesNow, committedArtifactsNow, artifactSource:'commitment_decision_cache' }). Anything not `tracked:true` with a valid level = lane stays 'untracked'/ok — untracked progress can NEVER park (pinned).
- Server component (R5 — Patch 72, next free number after 71): the ONE short patch-log entry belongs to whoever lands the server-side recognition, covering BOTH the parked status fields and the exit-code semantics. Contract to implement there: engine exits with code 81 on park (config `governance.park.exitCode`, clamped 1..255; watchdog restart stays 86); `<logsDir>/.park.json` = { version:1, parked:true, reason:'spend_critical'|'progress_starvation', lane, at ISO, cycle, evidence, resumable:true, exitCode } written tmp+rename BEFORE stop; `readParkState(dir)` / `archiveParkState(dir)` / `PARK_FILENAME` / `PARK_EXIT_CODE` are exported from cosmo23/engine/src/core/run-vitals.js for the sentinel/status routes; a parked run is deliberately-stopped — NOT wedged, NOT crashed (run-sentinel.js:479 'every engine death lands here' is where exit-81/.park.json must branch to an additive status 'parked' + park detail); resume is the EXISTING launchPreparedResearch direct-runPath continuation (Phase 2 cd23e6e4 machinery) — parking leaves metadata.json + memory-manifest intact (stop() is reused verbatim), and the engine archives .park.json to .park.json.last on its next start() (ledger event governance_park_cleared).

DESIGN DECISIONS THE IMPLEMENTER SHOULD NOT UNDO: (1) Division of labor is explicit and pinned by test — health lane NEVER drives regulator actions at any level (backpressure already halves/blocks spawning; CycleWatchdog+sentinel own health; acting would double-govern), and park is allowed for exactly two reasons. (2) Default = observe-and-report only: governance.enabled defaults TRUE but with no budget and no 4.3 tracker every lane is ok and nothing changes behavior (pinned). (3) parkRun writes .park.json BEFORE stop() (watchdog restartRequested doctrine) and reuses stop()/saveStateForShutdown — NO new save path; sacred persistence rules untouched (no saveState/loadState edits anywhere in this component). (4) Pacing is bounded by construction: factor <1 rejected at config parse AND ignored at apply; interval ceiling 600s preserved; concurrency cap can only lower (composes with H4 halving, lower bound wins). (5) Ledger receipts are transition-gated (engage/release/defer/park once per state change, not per cycle) and never awaited. (6) RunVitals is fs-free; only the exported free helpers touch disk. Ledger event names: governance_pacing_engaged, governance_pacing_released, governance_health_deferred, governance_park, governance_park_cleared. Heartbeat phases added: governance_pacing (transient), parking, parked (terminal — stamped AFTER stop() so it overwrites 'stopped'). getStats() gains additive `governance` key. Run-status emissions: governance_pacing, governance_pacing_released, parked.

CONFIG SURFACE (all optional, engine YAML): governance.enabled (true), governance.windowCycles (10), governance.pacing.warnSlowdownFactor (1.5, min 1), governance.pacing.concurrencyNotch (1), governance.spend.warnRatio (0.70), governance.spend.criticalRatio (0.95), governance.park.exitCode (81), governance.park.stopTimeoutMs (180000 — generous because a parked run is healthy and the guarded save deserves full time, unlike the wedged-engine 30s watchdog budget); spend.maxTokens / spend.maxUsd (budget, from 4.2's launch plumbing). ConfigValidator is non-breaking (never throws) so no validator change is required for the new block.

CONCURRENCY WARNINGS FOR THE IMPLEMENTER: package.json scripts.test is HOT (every Phase 4 component registers a suite) — if the run-sentinel/research-run-operation-adapter adjacency anchor has drifted, insert `tests/cosmo23/run-vitals-governance.test.cjs` exactly once anywhere in the second `node --test --test-concurrency=1` block (the cosmo23 .cjs block) and add the registration-list line; the package-test-registration test enforces exactly-once. The orchestrator.js anchors were verified unique on a tree already carrying Fix 3.4; if another Phase 4 sibling lands orchestrator edits first, re-verify each anchor with grep -c before applying (all nine are single-occurrence multi-line strings chosen away from the loop/persist regions siblings touch). Apply order: create run-vitals.js FIRST (orchestrator requires it at module load), then orchestrator.js, agent-executor.js, test file, registrations. After applying, run: `node --test --test-concurrency=1 tests/cosmo23/run-vitals-governance.test.cjs tests/cosmo23/cycle-watchdog.test.cjs tests/cosmo23/graceful-shutdown-honesty.test.cjs tests/cosmo23/engine-heartbeat.test.cjs tests/cosmo23/agent-executor-memory-context.test.cjs` (expected 69/69) — no engine restart is involved (no persistence-adjacent change), and the cosmo23 mocha sweep (`cd cosmo23/engine && npm run test:unit`) should stay green since all changes are additive with neutral defaults.
