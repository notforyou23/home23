const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Orchestrator } = require('../../../engine/src/core/orchestrator');

function makeFakeOrchestrator(overrides = {}) {
  const calls = [];
  const fake = Object.create(Orchestrator.prototype);
  Object.assign(fake, {
    config: { shutdownTelemetryTimeoutMs: 5, shutdownSaveTimeoutMs: 5 },
    logsDir: os.tmpdir(),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    running: true,
    shutdownHandler: {},
    liveProblems: null,
    pulseRemarks: null,
    discoveryEngine: null,
    thinkingMachine: null,
    agendaStore: null,
    clusterOrchestrator: null,
    clusterStateStore: null,
    feeder: null,
    saveState: async () => {
      calls.push('save');
      return { saved: true };
    },
    crashRecovery: {
      markCleanShutdown: async () => {
        calls.push('mark-clean');
      },
    },
    telemetry: {
      cleanup: async () => {
        calls.push('telemetry-cleanup');
      },
    },
  }, overrides);
  return { fake, calls };
}

test('stop marks clean shutdown immediately after successful state save', async () => {
  const { fake, calls } = makeFakeOrchestrator({
    telemetry: {
      cleanup: async () => {
        calls.push('telemetry-cleanup');
        return new Promise(() => {});
      },
    },
  });

  await fake.stop();

  assert.deepEqual(calls, ['save', 'mark-clean', 'telemetry-cleanup']);
});

test('stop leaves crash marker dirty when state save is refused', async () => {
  const { fake, calls } = makeFakeOrchestrator({
    saveState: async () => {
      calls.push('save');
      return { saved: false, reason: 'stale_state_guard' };
    },
  });

  await fake.stop();

  assert.deepEqual(calls, ['save', 'telemetry-cleanup']);
});

test('stop marks clean when final save times out but durable state exists', async () => {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-shutdown-'));
  fs.writeFileSync(path.join(logsDir, 'state.json.gz'), 'durable-state');
  const { fake, calls } = makeFakeOrchestrator({
    logsDir,
    saveState: async () => {
      calls.push('save');
      return new Promise(() => {});
    },
  });

  await fake.stop();

  assert.deepEqual(calls, ['save', 'mark-clean', 'telemetry-cleanup']);
  assert.equal(fake.shutdownStateResult.saved, 'existing');
  assert.equal(fake.shutdownStateResult.reason, 'shutdown_save_timeout_existing_state');
  fs.rmSync(logsDir, { recursive: true, force: true });
});

test('shutdown uses shorter grace when joining an in-progress save with durable state', async () => {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-shutdown-'));
  fs.writeFileSync(path.join(logsDir, 'state.json.gz'), 'durable-state');
  const { fake, calls } = makeFakeOrchestrator({
    config: {
      shutdownTelemetryTimeoutMs: 5,
      shutdownSaveTimeoutMs: 1000,
      shutdownInProgressSaveTimeoutMs: 5,
    },
    logsDir,
    _saveStatePromise: new Promise(() => {}),
    saveState: async () => {
      calls.push('save');
      return new Promise(() => {});
    },
  });

  const startedAt = Date.now();
  const result = await fake.saveStateForShutdown();
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.saved, 'existing');
  assert.equal(result.reason, 'shutdown_save_timeout_existing_state');
  assert.equal(calls.length, 1);
  assert.ok(elapsedMs < 200, `expected short in-progress save grace, got ${elapsedMs}ms`);
  fs.rmSync(logsDir, { recursive: true, force: true });
});
