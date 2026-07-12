import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DashboardServer } = require('../../../engine/src/dashboard/server.js');

test('dashboard waits for provider migration before durable operation reconciliation', async () => {
  const calls = [];
  let releaseMigration;
  const server = Object.create(DashboardServer.prototype);
  server.brainOperationsProviderRuntime = {
    settled: new Promise((resolve) => { releaseMigration = resolve; }).then(() => {
      calls.push('migration');
    }),
  };
  server.brainOperationsCoordinator = {
    async reconcile() { calls.push('reconcile'); },
  };
  const pending = server.prepareBrainOperationsForListen();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);
  releaseMigration();
  await pending;
  assert.deepEqual(calls, ['migration', 'reconcile']);
});

test('dashboard does not delay listen readiness for long operation reconciliation', async () => {
  let releaseReconcile;
  const server = Object.create(DashboardServer.prototype);
  server.logger = { error() {} };
  server.brainOperationsProviderRuntime = { settled: Promise.resolve() };
  server.brainOperationsSynthesisRuntime = { settled: Promise.resolve() };
  server.brainOperationsCoordinator = {
    async reconcile() {
      await new Promise((resolve) => { releaseReconcile = resolve; });
    },
  };

  const prepared = server.prepareBrainOperationsForListen();
  const outcome = await Promise.race([
    prepared.then(() => 'ready'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 50)),
  ]);
  releaseReconcile?.();
  await prepared;

  assert.equal(outcome, 'ready');
});

test('dashboard owns startup reconciliation between coordinator and worker shutdown', async () => {
  const calls = [];
  let releaseReconciliation;
  const server = Object.create(DashboardServer.prototype);
  server._brainOperationsReconciliationPromise = new Promise((resolve) => {
    releaseReconciliation = resolve;
  }).then(() => { calls.push('reconciliation'); });
  server.brainOperationsCoordinator = {
    async stop() {
      calls.push('coordinator');
      setTimeout(releaseReconciliation, 10);
    },
  };
  server.brainOperationsWorker = { async stop() { calls.push('worker'); } };
  await server.stopBrainOperations();
  assert.deepEqual(calls, ['coordinator', 'reconciliation', 'worker']);
});

test('dashboard emergency shutdown budget exceeds coordinator cleanup plus HTTP close', () => {
  const server = Object.create(DashboardServer.prototype);
  server.brainOperationsCoordinator = { stopTimeoutMs: 180_000 };
  server._serverCloseTimeoutMs = 5_000;
  assert.equal(server._shutdownEmergencyTimeoutMs(), 190_000);
});
