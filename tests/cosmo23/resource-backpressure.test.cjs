'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ResourceMonitor } = require('../../cosmo23/engine/src/core/resource-monitor');
const { AgentExecutor } = require('../../cosmo23/engine/src/agents/agent-executor');
const COSMO_ROOT = path.resolve(__dirname, '../../cosmo23');

const MB = 1024 * 1024;

function captureLogger() {
  const entries = [];
  const push = (level) => (message, detail) => entries.push({ level, message, detail });
  return {
    entries,
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    levelChanges() {
      return entries.filter((e) => e.message === '[ResourceMonitor] Backpressure level change');
    },
  };
}

function makeMonitor(overrides = {}) {
  const logger = captureLogger();
  const monitor = new ResourceMonitor({
    resources: {
      rssBudgetMb: 1000,
      backpressure: { intervalMs: 10 },
      ...overrides,
    },
  }, logger);
  return { monitor, logger };
}

// Heap-driven reading: heapUsed = pct of a 1024MB heap_size_limit (heapUsed
// 563-921MB across the walk — above the 512MB floor), low RSS.
function heapReading(pct) {
  return { heapUsed: 1024 * pct * MB, heapTotal: 1024 * MB, heapSizeLimit: 1024 * MB, rss: 100 * MB };
}

// RSS-driven reading: tiny heap (below floor, ignored), rss = mb against the 1000MB budget.
function rssReading(mb) {
  return { heapUsed: 40 * MB, heapTotal: 50 * MB, heapSizeLimit: 4096 * MB, rss: mb * MB };
}

test('backpressure hysteresis: elevated 70/60, critical 85/75, exit-critical lands in elevated band', () => {
  const { monitor, logger } = makeMonitor();
  assert.equal(monitor.backpressure.level, 'none');

  assert.equal(monitor.evaluateBackpressure(heapReading(0.65)), 'none');
  assert.equal(monitor.evaluateBackpressure(heapReading(0.72)), 'elevated'); // enter at >= 0.70
  assert.equal(monitor.evaluateBackpressure(heapReading(0.64)), 'elevated'); // hysteresis: no exit until < 0.60
  assert.equal(monitor.evaluateBackpressure(heapReading(0.59)), 'none');     // exit below 0.60
  assert.equal(monitor.evaluateBackpressure(heapReading(0.86)), 'critical'); // enter at >= 0.85
  assert.equal(monitor.evaluateBackpressure(heapReading(0.80)), 'critical'); // hysteresis: no exit until < 0.75
  assert.equal(monitor.evaluateBackpressure(heapReading(0.74)), 'elevated'); // exits critical INTO elevated
  assert.equal(monitor.evaluateBackpressure(heapReading(0.55)), 'none');     // clears elevated exit too

  // Loud logs on level change ONLY: none->elevated, elevated->none, none->critical,
  // critical->elevated, elevated->none = 5 changes for 8 evaluations.
  assert.equal(logger.levelChanges().length, 5);
});

test('rss vs rssBudgetMb drives backpressure even when heap is below the floor', () => {
  const { monitor } = makeMonitor();
  assert.equal(monitor.evaluateBackpressure(rssReading(500)), 'none');      // 50% of budget
  assert.equal(monitor.evaluateBackpressure(rssReading(720)), 'elevated');  // 72%
  assert.equal(monitor.evaluateBackpressure(rssReading(880)), 'critical');  // 88%
  assert.equal(monitor.evaluateBackpressure(rssReading(760)), 'critical');  // 76% — still >= exit 75%
  assert.equal(monitor.evaluateBackpressure(rssReading(740)), 'elevated');  // exits critical
  assert.equal(monitor.evaluateBackpressure(rssReading(100)), 'none');
});

test('heap fraction is ignored below heapMinTotalMb floor (tiny heaps do not flap)', () => {
  const { monitor } = makeMonitor();
  // heapUsed 90MB is below the 512MB floor: even at 90% of a tiny 100MB
  // heap_size_limit the heap leg must contribute 0; rss well under budget → none
  const level = monitor.evaluateBackpressure({ heapUsed: 90 * MB, heapTotal: 100 * MB, heapSizeLimit: 100 * MB, rss: 100 * MB });
  assert.equal(level, 'none');
});

test('healthy large heap is not false-flagged: GC slack (heapUsed/heapTotal) must not read as pressure', () => {
  const { monitor } = makeMonitor();
  // 1.2GB live set in a 1.5GB heapTotal looks like 80% under the old
  // heapUsed/heapTotal metric, but the real OOM boundary is heap_size_limit
  // 4.3GB → 27.9% headroom used. Low RSS. Must be level none.
  const level = monitor.evaluateBackpressure({
    heapUsed: 1200 * MB,
    heapTotal: 1500 * MB,
    heapSizeLimit: 4300 * MB,
    rss: 100 * MB,
  });
  assert.equal(level, 'none');
  assert.equal(monitor.backpressure.level, 'none');
});

test('backpressure object identity is preserved across transitions (H4 mutate-in-place)', () => {
  const { monitor } = makeMonitor();
  const ref = monitor.backpressure;
  monitor.evaluateBackpressure(heapReading(0.90));
  assert.equal(monitor.backpressure, ref);
  assert.equal(ref.level, 'critical');
  assert.ok(ref.reasons.length > 0);
  monitor.evaluateBackpressure(heapReading(0.10));
  assert.equal(monitor.backpressure, ref);
  assert.equal(ref.level, 'none');
  assert.deepEqual(ref.reasons, []);
  monitor.reset();
  assert.equal(monitor.backpressure, ref);
});

test('snapshot() refreshes backpressure with the live memory reading', () => {
  const { monitor } = makeMonitor();
  const calls = [];
  monitor.evaluateBackpressure = (reading) => { calls.push(reading); return 'none'; };
  monitor.snapshot();
  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0].heapUsed, 'number');
  assert.equal(typeof calls[0].heapTotal, 'number');
  assert.equal(typeof calls[0].rss, 'number');
});

test('startBackpressureMonitor ticks on the configured interval, is idempotent, and stop clears it', async () => {
  const { monitor } = makeMonitor();
  let ticks = 0;
  monitor.evaluateBackpressure = () => { ticks += 1; return 'none'; };
  monitor.startBackpressureMonitor();
  const timer = monitor._bpTimer;
  assert.ok(timer);
  monitor.startBackpressureMonitor(); // idempotent — same timer
  assert.equal(monitor._bpTimer, timer);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(ticks >= 1, `expected at least one tick, got ${ticks}`);
  monitor.stopBackpressureMonitor();
  assert.equal(monitor._bpTimer, null);
  const after = ticks;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(ticks, after); // no ticks after stop
});

test('getStats() surfaces the current backpressure level and reasons', () => {
  const { monitor } = makeMonitor();
  monitor.evaluateBackpressure(heapReading(0.90));
  const stats = monitor.getStats();
  assert.equal(stats.backpressure.level, 'critical');
  assert.ok(Array.isArray(stats.backpressure.reasons));
  assert.ok(stats.backpressure.reasons.length > 0);
});

// ---------------------------------------------------------------------------
// AgentExecutor spawn-gate behavior — real prototype methods on a minimal fake
// ---------------------------------------------------------------------------

function makeExecutorFake({ backpressure, maxConcurrent = 4, activeCount = 2 } = {}) {
  const fake = Object.create(AgentExecutor.prototype);
  fake.initialized = true;
  fake.maxConcurrent = maxConcurrent;
  fake.backpressure = backpressure ?? null;
  fake.logger = captureLogger();
  fake.gateCalls = { isGoalBeingPursued: 0 };
  fake.registry = {
    getActiveCount: () => activeCount,
    canSpawnMore: (limit) => activeCount < limit,
    isGoalBeingPursued: () => {
      fake.gateCalls.isGoalBeingPursued += 1;
      return true; // controlled stop: gate passed, spawn halts here deterministically
    },
  };
  return fake;
}

const MISSION = { goalId: 'goal-bp-1', agentType: 'research', description: 'backpressure gate test' };
const STRATEGIC_MISSION = {
  goalId: 'goal-bp-2',
  agentType: 'research',
  description: 'strategic under critical',
  triggerSource: 'system_repair',
  metadata: { systemRepair: true, urgentGoal: true, strategicPriority: true },
};

test('critical backpressure blocks new spawns before any other gate', async () => {
  const fake = makeExecutorFake({ backpressure: { level: 'critical', reasons: ['rss 880MB / 1000MB'] } });
  const result = await AgentExecutor.prototype.spawnAgent.call(fake, { ...MISSION });
  assert.equal(result, null);
  assert.equal(fake.gateCalls.isGoalBeingPursued, 0); // never reached the registry gates
  const warn = fake.logger.entries.find((e) => e.message.includes('Backpressure CRITICAL'));
  assert.ok(warn, 'expected a loud CRITICAL refusal log');
  assert.deepEqual(warn.detail.reasons, ['rss 880MB / 1000MB']);
});

test('critical backpressure blocks strategic-bypass spawns too', async () => {
  const fake = makeExecutorFake({ backpressure: { level: 'critical', reasons: [] } });
  assert.equal(AgentExecutor.prototype.isApprovedStrategicBypass.call(fake, STRATEGIC_MISSION), true);
  const result = await AgentExecutor.prototype.spawnAgent.call(fake, { ...STRATEGIC_MISSION });
  assert.equal(result, null);
  const warn = fake.logger.entries.find((e) => e.message.includes('Backpressure CRITICAL'));
  assert.ok(warn);
  assert.equal(warn.detail.isStrategic, true);
});

test('elevated backpressure halves effective concurrency: ceil(4/2)=2 blocks at 2 active', async () => {
  const fake = makeExecutorFake({
    backpressure: { level: 'elevated', reasons: ['heap 72.0%'] },
    maxConcurrent: 4,
    activeCount: 2,
  });
  const result = await AgentExecutor.prototype.spawnAgent.call(fake, { ...MISSION });
  assert.equal(result, null);
  assert.equal(fake.gateCalls.isGoalBeingPursued, 0);
  const warn = fake.logger.entries.find((e) => e.message.includes('Max concurrent agents reached'));
  assert.ok(warn, 'expected the concurrency refusal log');
  assert.equal(warn.detail.limit, 2);
  assert.equal(warn.detail.configuredLimit, 4);
  assert.equal(warn.detail.backpressure, 'elevated');
});

test('same load with level none passes the concurrency gate (proves elevated did the blocking)', async () => {
  const fake = makeExecutorFake({
    backpressure: { level: 'none', reasons: [] },
    maxConcurrent: 4,
    activeCount: 2,
  });
  const result = await AgentExecutor.prototype.spawnAgent.call(fake, { ...MISSION });
  assert.equal(result, null); // halted by the controlled isGoalBeingPursued stop
  assert.equal(fake.gateCalls.isGoalBeingPursued, 1); // gate was passed
});

test('null backpressure reference (standalone/CLI) behaves as level none', async () => {
  const fake = makeExecutorFake({ backpressure: null, maxConcurrent: 4, activeCount: 2 });
  const result = await AgentExecutor.prototype.spawnAgent.call(fake, { ...MISSION });
  assert.equal(result, null);
  assert.equal(fake.gateCalls.isGoalBeingPursued, 1);
});

test('getEffectiveMaxConcurrent: none/critical keep configured limit, elevated halves with ceil and floor 1', () => {
  const eff = (level, maxConcurrent) => AgentExecutor.prototype.getEffectiveMaxConcurrent.call({
    backpressure: level ? { level, reasons: [] } : null,
    maxConcurrent,
  });
  assert.equal(eff('none', 4), 4);
  assert.equal(eff(null, 4), 4);
  assert.equal(eff('critical', 4), 4); // critical is a hard spawn gate, not a limit change
  assert.equal(eff('elevated', 4), 2);
  assert.equal(eff('elevated', 5), 3); // ceil(2.5)
  assert.equal(eff('elevated', 1), 1); // floor 1
});

test('end-to-end: monitor writes, aliased object read by executor gate (H4 composition)', async () => {
  const { monitor } = makeMonitor();
  // Orchestrator wiring: alias the SAME object instance into the executor
  const fake = makeExecutorFake({ maxConcurrent: 4, activeCount: 2 });
  fake.backpressure = monitor.backpressure;

  monitor.evaluateBackpressure(heapReading(0.90)); // → critical
  let result = await AgentExecutor.prototype.spawnAgent.call(fake, { ...MISSION });
  assert.equal(result, null);
  assert.equal(fake.gateCalls.isGoalBeingPursued, 0);

  monitoredRecovery: {
    monitor.evaluateBackpressure(heapReading(0.10)); // → none (same object, no re-injection)
    result = await AgentExecutor.prototype.spawnAgent.call(fake, { ...MISSION });
    assert.equal(result, null);
    assert.equal(fake.gateCalls.isGoalBeingPursued, 1); // gate now passes
  }
});

test('wiring source contract: orchestrator aliases and starts/stops the monitor; saves are not gated', () => {
  const orchestratorSrc = fs.readFileSync(
    path.join(COSMO_ROOT, 'engine/src/core/orchestrator.js'),
    'utf8',
  );
  assert.ok(orchestratorSrc.includes('this.backpressure = this.resourceMonitor.backpressure;'),
    'orchestrator must alias the monitor-owned backpressure object');
  assert.ok(orchestratorSrc.includes('this.agentExecutor.backpressure = this.backpressure;'),
    'orchestrator must inject the shared reference into the agent executor');
  assert.ok(orchestratorSrc.includes('this.resourceMonitor.startBackpressureMonitor();'),
    'orchestrator start() must start the periodic evaluator');
  assert.ok(orchestratorSrc.includes('this.resourceMonitor.stopBackpressureMonitor();'),
    'orchestrator stop() must stop the periodic evaluator');
  const shutdownSrc = fs.readFileSync(
    path.join(COSMO_ROOT, 'engine/src/core/graceful-shutdown-handler.js'),
    'utf8',
  );
  assert.ok(shutdownSrc.includes('stopBackpressureMonitor'),
    'graceful shutdown must stop the backpressure interval');
  // H4 sacred saves: the save path must never consult backpressure
  const compressionSrc = fs.readFileSync(
    path.join(COSMO_ROOT, 'engine/src/core/state-compression.js'),
    'utf8',
  );
  assert.ok(!compressionSrc.includes('backpressure'),
    'state-compression (save path) must not consult backpressure');
});
