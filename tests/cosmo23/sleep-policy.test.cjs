'use strict';

// Component 4.4 (native research governance) — consolidation by policy
// instead of fixed cadence.
//
// governance.sleepPolicy.mode:
//   'legacy' (default) — the Phase 11 sleep trigger is BIT-IDENTICAL to the
//     historical dual-system behavior (pinned here for the full input matrix,
//     including a hydrated instance with no sleepPolicy at all).
//   'policy' — NEW sleep sessions start only on (a) an idle streak (zero new
//     agent spawns AND zero task completions for idleCycles consecutive
//     cycles, default 10) or (b) a milestone completed this cycle
//     (PHASE_ADVANCED / PLAN_COMPLETED); both rate-limited by minGapCycles
//     (default 30) and suppressed while any governance lane is critical
//     (never sleep while parking/starved). Dream mode and already-active
//     sessions always take the legacy path, so the wake machinery
//     (consolidate-once, energy recovery, minimumCycles, 50-cycle safety
//     net, active-plan override) is untouched in both modes.
//
// A consolidate decision writes a durable 'sleep_policy_consolidation'
// ledger receipt (fire-and-forget, never awaited) at the orchestrator
// decision point (_resolveSleepTrigger).

const test = require('node:test');
const assert = require('node:assert/strict');

const { SleepPolicy } = require('../../cosmo23/engine/src/core/sleep-policy');
const { Orchestrator } = require('../../cosmo23/engine/src/core/orchestrator');
const { AgentRegistry } = require('../../cosmo23/engine/src/agents/agent-registry');

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

function policyAt(overrides = {}) {
  return new SleepPolicy({ mode: 'policy', idleCycles: 3, minGapCycles: 5, ...overrides }, quietLogger);
}

function idleSnapshot(cycle, extra = {}) {
  return {
    cycleCount: cycle,
    totalAgentsSpawned: 7,
    tasksCompletedThisCycle: 0,
    milestoneCompletedThisCycle: false,
    criticalLanes: [],
    ...extra
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SleepPolicy — pure decision unit
// ═══════════════════════════════════════════════════════════════════════════

test('defaults: legacy mode, idleCycles 10, minGapCycles 30; junk falls back; snake_case accepted', () => {
  const dflt = new SleepPolicy({}, quietLogger);
  assert.equal(dflt.isPolicyMode(), false);
  assert.deepEqual(
    { mode: dflt.config.mode, idleCycles: dflt.config.idleCycles, minGapCycles: dflt.config.minGapCycles },
    { mode: 'legacy', idleCycles: 10, minGapCycles: 30 }
  );
  const junk = new SleepPolicy({ mode: 'POLICY', idle_cycles: '4', min_gap_cycles: -2 }, quietLogger);
  assert.equal(junk.isPolicyMode(), true);
  assert.equal(junk.config.idleCycles, 4);
  assert.equal(junk.config.minGapCycles, 30);
  const unknown = new SleepPolicy({ mode: 'aggressive' }, quietLogger);
  assert.equal(unknown.isPolicyMode(), false);
});

test('policy mode: idleCycles consecutive quiet cycles trigger consolidation', () => {
  const policy = policyAt();
  // Cycle 1 establishes the spawn-counter baseline — conservative, not idle.
  assert.equal(policy.evaluate(idleSnapshot(1)).consolidate, false);
  assert.equal(policy.evaluate(idleSnapshot(2)).consolidate, false);
  assert.equal(policy.evaluate(idleSnapshot(3)).consolidate, false);
  const decision = policy.evaluate(idleSnapshot(4));
  assert.equal(decision.consolidate, true);
  assert.equal(decision.trigger, 'idle');
  assert.equal(decision.reason, 'idle');
  assert.equal(decision.idleStreak, 3);
});

test('policy mode: a spawn or a completion resets the idle streak', () => {
  const policy = policyAt();
  policy.evaluate(idleSnapshot(1));
  policy.evaluate(idleSnapshot(2));
  policy.evaluate(idleSnapshot(3));
  // Spawn counter moved → streak resets on the cycle that would have fired.
  assert.equal(policy.evaluate(idleSnapshot(4, { totalAgentsSpawned: 8 })).consolidate, false);
  assert.equal(policy.idleStreak, 0);
  policy.evaluate(idleSnapshot(5));
  // A task completion also resets.
  policy.evaluate(idleSnapshot(6, { tasksCompletedThisCycle: 2 }));
  assert.equal(policy.idleStreak, 0);
  policy.evaluate(idleSnapshot(7));
  policy.evaluate(idleSnapshot(8));
  assert.equal(policy.evaluate(idleSnapshot(9)).consolidate, true);
});

test('policy mode: milestone completion triggers immediately (consolidate-after-achievement)', () => {
  const policy = policyAt();
  const decision = policy.evaluate(idleSnapshot(1, {
    tasksCompletedThisCycle: 3,
    milestoneCompletedThisCycle: true
  }));
  assert.equal(decision.consolidate, true);
  assert.equal(decision.trigger, 'post_milestone');
  assert.equal(decision.reason, 'post_milestone');
});

test('policy mode: minGapCycles rate-limits successive policy consolidations', () => {
  const policy = policyAt();
  assert.equal(policy.evaluate(idleSnapshot(10, { milestoneCompletedThisCycle: true })).consolidate, true);
  const inGap = policy.evaluate(idleSnapshot(13, { milestoneCompletedThisCycle: true }));
  assert.equal(inGap.consolidate, false);
  assert.equal(inGap.suppressed, true);
  assert.equal(inGap.reason, 'rate_limited');
  const afterGap = policy.evaluate(idleSnapshot(15, { milestoneCompletedThisCycle: true }));
  assert.equal(afterGap.consolidate, true);
});

test('policy mode: any critical lane suppresses (never sleep while parking/starved)', () => {
  const policy = policyAt();
  const decision = policy.evaluate(idleSnapshot(1, {
    milestoneCompletedThisCycle: true,
    criticalLanes: ['spend']
  }));
  assert.equal(decision.consolidate, false);
  assert.equal(decision.suppressed, true);
  assert.equal(decision.reason, 'critical_lane_suppression');
  assert.deepEqual(decision.criticalLanes, ['spend']);
  // Suppression does NOT burn the rate-limit gap: once the lane clears the
  // same trigger consolidates.
  const cleared = policy.evaluate(idleSnapshot(2, { milestoneCompletedThisCycle: true }));
  assert.equal(cleared.consolidate, true);
});

test('policy mode: re-evaluating the same cycle does not double-advance the idle streak', () => {
  const policy = policyAt();
  policy.evaluate(idleSnapshot(1));
  policy.evaluate(idleSnapshot(2));
  policy.evaluate(idleSnapshot(2));
  policy.evaluate(idleSnapshot(2));
  assert.equal(policy.idleStreak, 1);
});

test('policy mode: an unavailable spawn counter never counts as idle (conservative)', () => {
  const policy = policyAt();
  for (let cycle = 1; cycle <= 10; cycle++) {
    assert.equal(policy.evaluate(idleSnapshot(cycle, { totalAgentsSpawned: null })).consolidate, false);
  }
  assert.equal(policy.idleStreak, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// Orchestrator decision point — prototype-driven fakes
// ═══════════════════════════════════════════════════════════════════════════

function makeFakeOrchestrator(overrides = {}) {
  return {
    config: { execution: {} },
    logger: quietLogger,
    cycleCount: 1,
    sleepSession: { active: false },
    sleepPolicy: new SleepPolicy({}, quietLogger),
    agentExecutor: { registry: { totalRegistered: 0 } },
    researchRegulator: null,
    governanceRegulator: null,
    _sleepPolicySignals: null,
    _sleepPolicyEntryReason: null,
    eventLedger: {
      entries: [],
      log(type, data = {}) { this.entries.push({ type, data }); return Promise.resolve(null); }
    },
    _resolveSleepTrigger: Orchestrator.prototype._resolveSleepTrigger,
    _sleepPolicyCompletionsThisCycle: Orchestrator.prototype._sleepPolicyCompletionsThisCycle,
    _governanceCriticalLanes: Orchestrator.prototype._governanceCriticalLanes,
    ...overrides
  };
}

test('LEGACY PIN: trigger decision identical to the dual-system expression for the full matrix', () => {
  const legacyVariants = [
    new SleepPolicy({}, quietLogger),
    new SleepPolicy({ mode: 'legacy' }, quietLogger),
    undefined // hydrated instance without a sleepPolicy at all
  ];
  for (const sleepPolicy of legacyVariants) {
    for (const shouldSleepCognitive of [false, true]) {
      for (const shouldSleepTemporal of [false, true]) {
        for (const dreamMode of [false, true]) {
          const fake = makeFakeOrchestrator({ sleepPolicy });
          const decision = fake._resolveSleepTrigger({
            shouldSleepCognitive,
            shouldSleepTemporal,
            dreamMode,
            planAction: { action: 'ON_TRACK' }
          });
          assert.equal(
            decision.triggered,
            Boolean(shouldSleepCognitive || shouldSleepTemporal || dreamMode),
            `matrix c=${shouldSleepCognitive} t=${shouldSleepTemporal} d=${dreamMode}`
          );
          assert.equal(decision.source, 'legacy');
          assert.equal(decision.policyDecision, null);
          assert.equal(fake.eventLedger.entries.length, 0);
        }
      }
    }
  }
});

test('policy mode: dream mode always takes the legacy path (forced sleep preserved)', () => {
  const fake = makeFakeOrchestrator({ sleepPolicy: new SleepPolicy({ mode: 'policy' }, quietLogger) });
  const decision = fake._resolveSleepTrigger({
    shouldSleepCognitive: false,
    shouldSleepTemporal: false,
    dreamMode: true,
    planAction: null
  });
  assert.deepEqual(
    { triggered: decision.triggered, source: decision.source },
    { triggered: true, source: 'legacy' }
  );
});

test('policy mode: an active sleep session keeps cycling through the existing wake machinery', () => {
  const fake = makeFakeOrchestrator({
    sleepPolicy: new SleepPolicy({ mode: 'policy' }, quietLogger),
    sleepSession: { active: true }
  });
  const decision = fake._resolveSleepTrigger({
    shouldSleepCognitive: false,
    shouldSleepTemporal: false,
    dreamMode: false,
    planAction: null
  });
  assert.deepEqual(
    { triggered: decision.triggered, source: decision.source },
    { triggered: true, source: 'active_session' }
  );
});

test('policy mode: organic fatigue alone does not start a session; policy is the authority', () => {
  const fake = makeFakeOrchestrator({
    sleepPolicy: new SleepPolicy({ mode: 'policy', idleCycles: 3, minGapCycles: 5 }, quietLogger)
  });
  fake.agentExecutor.registry.totalRegistered = 5;
  const decision = fake._resolveSleepTrigger({
    shouldSleepCognitive: true,
    shouldSleepTemporal: true,
    dreamMode: false,
    planAction: null
  });
  assert.equal(decision.triggered, false);
  assert.equal(decision.source, 'policy');
  assert.equal(fake.eventLedger.entries.length, 0);
});

test('policy mode: idle streak triggers at the decision point and writes the ledger receipt', () => {
  const fake = makeFakeOrchestrator({
    sleepPolicy: new SleepPolicy({ mode: 'policy', idleCycles: 3, minGapCycles: 5 }, quietLogger)
  });
  fake.agentExecutor.registry.totalRegistered = 5;
  let decision = null;
  for (let cycle = 1; cycle <= 4; cycle++) {
    fake.cycleCount = cycle;
    decision = fake._resolveSleepTrigger({
      shouldSleepCognitive: false,
      shouldSleepTemporal: false,
      dreamMode: false,
      planAction: { action: 'ON_TRACK' }
    });
    if (cycle < 4) assert.equal(decision.triggered, false, `cycle ${cycle} must not trigger yet`);
  }
  assert.equal(decision.triggered, true);
  assert.equal(decision.source, 'policy');
  assert.equal(decision.policyDecision.trigger, 'idle');
  assert.equal(fake.eventLedger.entries.length, 1);
  assert.equal(fake.eventLedger.entries[0].type, 'sleep_policy_consolidation');
  assert.equal(fake.eventLedger.entries[0].data.trigger, 'idle');
  assert.equal(fake.eventLedger.entries[0].data.cycle, 4);
});

test('policy mode: PHASE_ADVANCED plan action triggers post-milestone consolidation', () => {
  const fake = makeFakeOrchestrator({ sleepPolicy: new SleepPolicy({ mode: 'policy' }, quietLogger) });
  const decision = fake._resolveSleepTrigger({
    shouldSleepCognitive: false,
    shouldSleepTemporal: false,
    dreamMode: false,
    planAction: { action: 'PHASE_ADVANCED', completed: 'Phase 1', next: 'Phase 2' }
  });
  assert.equal(decision.triggered, true);
  assert.equal(decision.policyDecision.trigger, 'post_milestone');
  assert.equal(fake.eventLedger.entries[0].type, 'sleep_policy_consolidation');
});

test('policy mode: critical governance lane suppresses the trigger at the decision point', () => {
  const fake = makeFakeOrchestrator({
    sleepPolicy: new SleepPolicy({ mode: 'policy' }, quietLogger),
    researchRegulator: {
      getLaneStates() {
        return {
          progress: { level: 'ok', evidence: {} },
          spend: { level: 'critical', evidence: { reason: 'budget_exhausted' } },
          health: { level: 'warn', evidence: {} }
        };
      }
    }
  });
  const decision = fake._resolveSleepTrigger({
    shouldSleepCognitive: false,
    shouldSleepTemporal: false,
    dreamMode: false,
    planAction: { action: 'PLAN_COMPLETED' }
  });
  assert.equal(decision.triggered, false);
  assert.equal(decision.policyDecision.suppressed, true);
  assert.equal(decision.policyDecision.reason, 'critical_lane_suppression');
  assert.deepEqual(decision.policyDecision.criticalLanes, ['spend']);
  assert.equal(fake.eventLedger.entries.length, 0);
});

test('completion signals: cycle-stamped Phase 2 counts self-invalidate; plan completions add in', () => {
  const fake = makeFakeOrchestrator({});
  fake.cycleCount = 7;
  fake._sleepPolicySignals = { cycle: 7, tasksCompleted: 2 };
  assert.equal(fake._sleepPolicyCompletionsThisCycle({ action: 'TASK_COMPLETED' }), 3);
  fake.cycleCount = 8; // stale stamp from cycle 7 no longer counts
  assert.equal(fake._sleepPolicyCompletionsThisCycle(null), 0);
});

test('governance lanes: absent regulator or non-critical lanes yield no suppression input', () => {
  const none = makeFakeOrchestrator({});
  assert.deepEqual(none._governanceCriticalLanes(), []);
  const okLanes = makeFakeOrchestrator({
    governanceRegulator: {
      getLanes() { return { progress: { level: 'ok' }, health: { level: 'warn' } }; }
    }
  });
  assert.deepEqual(okLanes._governanceCriticalLanes(), []);
});

// ═══════════════════════════════════════════════════════════════════════════
// AgentRegistry.totalRegistered — the idle signal's spawn counter
// ═══════════════════════════════════════════════════════════════════════════

function makeFakeAgent(id) {
  return {
    agentId: id,
    mission: { goalId: 'goal-' + id },
    status: 'running',
    startTime: new Date(),
    results: [],
    on() {}
  };
}

test('AgentRegistry.totalRegistered is monotonic and survives cleanupOldAgents', () => {
  const registry = new AgentRegistry(quietLogger);
  registry.register(makeFakeAgent('a1'), { spawnCycle: 1 });
  registry.register(makeFakeAgent('a2'), { spawnCycle: 2 });
  assert.equal(registry.totalRegistered, 2);
  assert.equal(registry.getStats().totalRegistered, 2);
  for (const id of ['a1', 'a2']) {
    const state = registry.agents.get(id);
    state.status = 'completed';
    state.endTime = new Date(Date.now() - 7200000);
    registry.activeAgents.delete(id);
    registry.completedAgents.set(id, state);
  }
  registry.cleanupOldAgents(3600000);
  assert.equal(registry.agents.size, 0);
  assert.equal(registry.totalRegistered, 2);
  assert.equal(registry.getStats().totalRegistered, 2);
});

