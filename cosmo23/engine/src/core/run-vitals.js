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

    // The 4.2 meter nests usage under snapshot.totals and reports USD as
    // snapshot.usd (null without a price table) — read its real shape, not a
    // flat {totalTokens,totalUsd} guess.
    const totalTokens = finiteOrNull(snapshot.totals?.totalTokens);
    const totalUsd = finiteOrNull(snapshot.usd);
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

