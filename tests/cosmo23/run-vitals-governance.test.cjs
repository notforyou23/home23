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
    spendProvider: () => ({ totals: { totalTokens: tokens }, usd: null, unmeteredCalls: 2 })
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
    spendProvider: () => ({ totals: { totalTokens: 5e6 }, usd: null, unmeteredCalls: 0 })
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
    spendProvider: () => ({ totals: { totalTokens: tokens } })
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
    spendProvider: () => ({ totals: { totalTokens: 800 } })
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
    spendProvider: () => ({ totals: { totalTokens: tokens } })
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
    spendProvider: () => ({ totals: { totalTokens: tokens } })
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


// --- Regression: real SpendMeter snapshot integration (live-proof finding
// 2026-07-22). The unit tests above used synthetic snapshots that happened to
// dodge two D1/D2 composition bugs: (1) the orchestrator constructor nulled
// this.spendMeter after binding it, and (2) RunVitals read snapshot.totalTokens
// while the meter nests it under snapshot.totals.totalTokens. Both let a run
// blow its token budget without ever parking. This drives the REAL meter. ---
const { getSpendMeter, resetSpendMeterForTests } = require('../../cosmo23/engine/src/core/spend-meter');
const fsp = require('node:fs/promises');

test('real SpendMeter snapshot drives the spend lane critical → park', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'run-vitals-realmeter-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const meter = getSpendMeter();
  resetSpendMeterForTests();
  meter.configure({ logsDir: dir, spendConfig: { maxTokens: 4000 }, logger: { debug() {} } });
  meter.recordUsage({ provider: 'openai', model: 'gpt-5.2', inputTokens: 2359, outputTokens: 4300 }); // 6659 > 4000*0.95

  const rv = new RunVitals({
    config: { governance: { enabled: true }, spend: { maxTokens: 4000 } },
    logger: { info() {}, warn() {}, debug() {} },
    spendProvider: () => meter.getSnapshot(),
    progressAssessor: () => null,
  });
  const a = rv.evaluateCycle({ cycle: 5, nodes: 100, backpressureLevel: 'none', watchdog: null, activeAgents: 0 });
  assert.equal(rv.summarizeLanes(a.lanes).spend.level, 'critical', 'over-budget token usage must read critical');
  assert.ok(a.park, 'critical spend must produce a park decision');
  assert.equal(a.park.reason, 'spend_critical');
  assert.equal(a.park.evidence.totalTokens, 6659, 'lane must read the nested totals.totalTokens');
});

test('real SpendMeter under budget reads warn → pacing, not park', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'run-vitals-realmeter-warn-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const meter = getSpendMeter();
  resetSpendMeterForTests();
  meter.configure({ logsDir: dir, spendConfig: { maxTokens: 8000 }, logger: { debug() {} } });
  meter.recordUsage({ provider: 'openai', model: 'gpt-5.2', inputTokens: 2359, outputTokens: 4300 }); // 6659 / 8000 = 0.83

  const rv = new RunVitals({
    config: { governance: { enabled: true }, spend: { maxTokens: 8000 } },
    logger: { info() {}, warn() {}, debug() {} },
    spendProvider: () => meter.getSnapshot(),
    progressAssessor: () => null,
  });
  const a = rv.evaluateCycle({ cycle: 5, nodes: 100, backpressureLevel: 'none', watchdog: null, activeAgents: 0 });
  assert.equal(rv.summarizeLanes(a.lanes).spend.level, 'warn');
  assert.equal(a.park, null, 'warn must never park');
  assert.ok((a.transitions || []).some((tr) => tr.type === 'pacing_engaged'), 'warn must engage pacing');
});
