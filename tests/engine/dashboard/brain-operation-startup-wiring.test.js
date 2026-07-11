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

test('dashboard stops coordinator pumps before its local worker registry', async () => {
  const calls = [];
  const server = Object.create(DashboardServer.prototype);
  server.brainOperationsCoordinator = { async stop() { calls.push('coordinator'); } };
  server.brainOperationsWorker = { async stop() { calls.push('worker'); } };
  await server.stopBrainOperations();
  assert.deepEqual(calls, ['coordinator', 'worker']);
});

test('dashboard emergency shutdown budget exceeds coordinator cleanup plus HTTP close', () => {
  const server = Object.create(DashboardServer.prototype);
  server.brainOperationsCoordinator = { stopTimeoutMs: 180_000 };
  server._serverCloseTimeoutMs = 5_000;
  assert.equal(server._shutdownEmergencyTimeoutMs(), 190_000);
});
