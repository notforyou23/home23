'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { GracefulShutdownHandler } = require('../../cosmo23/engine/src/core/graceful-shutdown-handler');
const { Orchestrator } = require('../../cosmo23/engine/src/core/orchestrator');

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

function stubProcessExit(t) {
  const original = process.exit;
  const codes = [];
  process.exit = (code) => { codes.push(code ?? 0); };
  t.after(() => { process.exit = original; });
  return codes;
}

function makeFakeOrchestrator(saveResult) {
  const calls = { saveState: 0, markCleanShutdown: 0, stop: 0 };
  return {
    calls,
    async stop() { calls.stop += 1; },
    async saveState() {
      calls.saveState += 1;
      return saveResult;
    },
    crashRecovery: {
      async markCleanShutdown() { calls.markCleanShutdown += 1; },
    },
  };
}

test('shutdown does NOT mark clean when saveState reports saved:false', async (t) => {
  const exitCodes = stubProcessExit(t);
  const orchestrator = makeFakeOrchestrator({
    saved: false,
    reason: 'catastrophic_node_drop',
    currentNodes: 0,
    existingNodes: 65000,
  });
  const handler = new GracefulShutdownHandler(orchestrator, quietLogger, { shutdownTimeoutMs: 5000 });

  await handler.shutdown('test');

  assert.equal(orchestrator.calls.saveState, 1);
  assert.equal(orchestrator.calls.markCleanShutdown, 0, 'refused save must leave shutdown dirty');
  assert.deepEqual(exitCodes, [0]);
  assert.equal(handler.shutdownComplete, true);
});

test('shutdown DOES mark clean when saveState reports saved:true', async (t) => {
  const exitCodes = stubProcessExit(t);
  const orchestrator = makeFakeOrchestrator({
    saved: true,
    reason: null,
    currentNodes: 65000,
    existingNodes: null,
  });
  const handler = new GracefulShutdownHandler(orchestrator, quietLogger, { shutdownTimeoutMs: 5000 });

  await handler.shutdown('test');

  assert.equal(orchestrator.calls.saveState, 1);
  assert.equal(orchestrator.calls.markCleanShutdown, 1);
  assert.deepEqual(exitCodes, [0]);
});

test('shutdown does not save again or mark clean when stop() already handled a refused save', async (t) => {
  const exitCodes = stubProcessExit(t);
  const orchestrator = makeFakeOrchestrator({ saved: true, reason: null });
  orchestrator.stop = async function stop() {
    orchestrator.calls.stop += 1;
    orchestrator.shutdownStateHandled = true;
    orchestrator.shutdownStateResult = { saved: false, reason: 'shutdown_save_timeout_no_state' };
  };
  const handler = new GracefulShutdownHandler(orchestrator, quietLogger, { shutdownTimeoutMs: 5000 });

  await handler.shutdown('test');

  assert.equal(orchestrator.calls.stop, 1);
  assert.equal(orchestrator.calls.saveState, 0, 'handler must not save a second time after stop() handled state');
  assert.equal(orchestrator.calls.markCleanShutdown, 0);
  assert.deepEqual(exitCodes, [0]);
});

test('shutdown does not re-mark clean when stop() already marked it', async (t) => {
  stubProcessExit(t);
  const orchestrator = makeFakeOrchestrator({ saved: true, reason: null });
  orchestrator.stop = async function stop() {
    orchestrator.calls.stop += 1;
    orchestrator.calls.markCleanShutdown += 1; // stop() wrote the marker itself
    orchestrator.shutdownStateHandled = true;
    orchestrator.shutdownStateResult = { saved: true, reason: null };
    orchestrator.shutdownCleanMarked = true;
  };
  const handler = new GracefulShutdownHandler(orchestrator, quietLogger, { shutdownTimeoutMs: 5000 });

  await handler.shutdown('test');

  assert.equal(orchestrator.calls.saveState, 0);
  assert.equal(orchestrator.calls.markCleanShutdown, 1, 'clean marker written exactly once');
});

test('concurrent saveState calls coalesce into one underlying save', async () => {
  let underlyingSaves = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fake = {
    logger: quietLogger,
    _saveStatePromise: null,
    async _saveStateUnlocked() {
      underlyingSaves += 1;
      await gate;
      return { saved: true, reason: null, currentNodes: 42, existingNodes: null };
    },
  };

  const first = Orchestrator.prototype.saveState.call(fake);
  const second = Orchestrator.prototype.saveState.call(fake);
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(underlyingSaves, 1, 'two concurrent saveState calls must produce one underlying save');
  assert.equal(a, b, 'joined save returns the same result object');
  assert.equal(a.saved, true);

  const third = await Orchestrator.prototype.saveState.call(fake);
  assert.equal(underlyingSaves, 2, 'lock releases after the save completes');
  assert.equal(third.saved, true);
});

test('saveStateForShutdown bounds a hung in-progress save and never fakes saved:true', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo23-shutdown-save-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'state.json.gz'), 'durable');

  const fake = {
    logger: quietLogger,
    logsDir: dir,
    config: { shutdownSaveTimeoutMs: 60000, shutdownInProgressSaveTimeoutMs: 40 },
    _saveStatePromise: new Promise(() => {}),
    saveState: () => new Promise(() => {}),
    hasDurableStateArtifact: Orchestrator.prototype.hasDurableStateArtifact,
  };

  const result = await Orchestrator.prototype.saveStateForShutdown.call(fake);

  assert.equal(result.saved, 'existing');
  assert.equal(result.reason, 'shutdown_save_timeout_existing_state');
  assert.notEqual(result.saved, true, 'timeout with durable state must not report a confirmed save');
});

test('saveStateForShutdown surfaces save errors as saved:false', async () => {
  const fake = {
    logger: quietLogger,
    logsDir: path.join(os.tmpdir(), 'cosmo23-shutdown-missing-' + process.pid),
    config: {},
    _saveStatePromise: null,
    saveState: async () => { throw new Error('disk full'); },
    hasDurableStateArtifact: Orchestrator.prototype.hasDurableStateArtifact,
  };

  const result = await Orchestrator.prototype.saveStateForShutdown.call(fake);

  assert.equal(result.saved, false);
  assert.equal(result.reason, 'shutdown_save_failed');
});
