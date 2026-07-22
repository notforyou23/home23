const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStatusContract } = require('./status-contract');

const ports = { app: 43210, websocket: 43240, dashboard: 43244, mcpHttp: 43247 };
const now = new Date('2026-04-24T15:00:00Z');

test('buildStatusContract reports idle API separately from active run', () => {
  const status = buildStatusContract({
    activeContext: null,
    processStatus: { running: [], count: 0 },
    ports,
    now,
    uptimeMs: 1234,
  });

  assert.equal(status.apiReachable, true);
  assert.equal(status.lifecycle, 'idle');
  assert.equal(status.activeRun, false);
  assert.equal(status.processOnline, false);
  assert.equal(status.hasActiveContext, false);
  assert.equal(status.generatedAt, '2026-04-24T15:00:00.000Z');
  assert.deepEqual(status.ports, ports);
});

test('buildStatusContract reports active run only when context and cosmo-main process both exist', () => {
  const status = buildStatusContract({
    activeContext: { runName: 'run-1', brainId: 'brain-1', topic: 'topic', startedAt: '2026-04-24T14:00:00Z', runPath: '/tmp/run-1' },
    processStatus: { running: [{ name: 'cosmo-main', pid: 1234, killed: false }], count: 1 },
    runTruth: {
      artifactInventory: {
        answerSubstrate: 'records_present',
        categories: { rawAnecdotes: { records: 2 } }
      }
    },
    ports,
    now,
  });

  assert.equal(status.lifecycle, 'running');
  assert.equal(status.activeRun, true);
  assert.equal(status.processOnline, true);
  assert.equal(status.hasActiveContext, true);
  assert.equal(status.process.count, 1);
  assert.deepEqual(status.process.runningNames, ['cosmo-main']);
  assert.equal(status.run.runName, 'run-1');
  assert.equal(status.run.artifactInventory.answerSubstrate, 'records_present');
});

test('buildStatusContract distinguishes stale activeContext from live child process', () => {
  const status = buildStatusContract({
    activeContext: { runName: 'orphaned' },
    processStatus: { running: [], count: 0 },
    ports,
    now,
  });

  assert.equal(status.lifecycle, 'context_without_process');
  assert.equal(status.activeRun, false);
  assert.equal(status.processOnline, false);
  assert.equal(status.hasActiveContext, true);
});

test('buildStatusContract distinguishes child process without launcher context', () => {
  const status = buildStatusContract({
    activeContext: null,
    processStatus: { running: [{ name: 'cosmo-main', pid: 1234, killed: false }], count: 1 },
    ports,
    now,
  });

  assert.equal(status.lifecycle, 'process_without_context');
  assert.equal(status.activeRun, false);
  assert.equal(status.processOnline, true);
  assert.equal(status.hasActiveContext, false);
});

test('buildStatusContract reports launching as its own lifecycle', () => {
  const status = buildStatusContract({
    activeContext: null,
    processStatus: { running: [], count: 0 },
    isLaunching: true,
    ports,
    now,
  });

  assert.equal(status.lifecycle, 'launching');
  assert.equal(status.isLaunching, true);
});

test('buildStatusContract reports blocked guided plans ahead of process-running truth', () => {
  const status = buildStatusContract({
    activeContext: { runName: 'blocked-run', runPath: '/tmp/blocked-run' },
    processStatus: { running: [{ name: 'cosmo-main', pid: 1234, killed: false }], count: 1 },
    runTruth: {
      plan: {
        status: 'BLOCKED',
        blockedReason: 'Research contract failed: missing_source_evidence'
      },
      commitmentDecision: {
        shouldStopForBlockedRun: true,
        reasonCodes: ['guided_plan_blocked']
      }
    },
    ports,
    now,
  });

  assert.equal(status.lifecycle, 'blocked');
  assert.equal(status.activeRun, false);
  assert.equal(status.run.status, 'blocked');
  assert.equal(status.run.blockedReason, 'Research contract failed: missing_source_evidence');
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
