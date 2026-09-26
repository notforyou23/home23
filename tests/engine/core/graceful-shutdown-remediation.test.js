import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GracefulShutdownHandler } = require('../../../engine/src/core/graceful-shutdown-handler.js');
const remediators = require('../../../engine/src/live-problems/remediators.js');

test('graceful shutdown stops live-problems remediation before waiting for agents', async t => {
  const events = [];
  let polls = 0;
  const registry = {
    getActiveCount() {
      polls += 1;
      events.push(`poll:${polls}`);
      return polls <= 2 ? 1 : 0;
    },
    getActiveAgents: () => [],
  };
  const orchestrator = {
    agentExecutor: { registry },
    liveProblems: { stop() { events.push('liveProblems.stop'); } },
    async stop() { events.push('orchestrator.stop'); },
    shutdownStateHandled: true,
    shutdownCleanMarked: true,
  };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const exit = process.exit;
  let exitCode = null;
  process.exit = code => { exitCode = code; };
  t.after(() => { process.exit = exit; remediators.setShuttingDown(false); });
  const handler = new GracefulShutdownHandler(orchestrator, logger, { shutdownTimeoutMs: 60000, agentWaitTimeoutMs: 30000 });
  const shutdown = handler.shutdown('SIGINT');
  // Remediation is already off while the first active agent is still running.
  assert.equal(events[0], 'liveProblems.stop');
  assert.deepEqual(await remediators.runRemediator({ type: 'pm2_restart', args: { name: 'home23-test-dash' } }),
    { outcome: 'rejected', detail: 'engine shutting down' });
  await shutdown;
  assert.ok(events.indexOf('liveProblems.stop') < events.indexOf('poll:2'));
  assert.ok(events.includes('orchestrator.stop'), 'the orchestrator still stops after the agent wait');
  assert.ok(events.indexOf('orchestrator.stop') > events.lastIndexOf('poll:3'));
  assert.equal(exitCode, 0);
});
