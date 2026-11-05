import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pm2Channel, _test } from '../../../../engine/src/channels/os/pm2-channel.js';

test('Pm2Channel seeds on first poll then emits on state change with topology metadata', async () => {
  let list = [{
    name: 'home23-jerry',
    pm2_env: {
      status: 'online',
      restart_time: 0,
      pm_exec_path: '/Users/jtr/_JTR23_/release/home23/engine/src/index.js',
    },
  }];
  const ch = new Pm2Channel({ intervalMs: 10, listProcesses: async () => list });
  // First poll seeds baseline, no emission
  assert.equal((await ch.poll()).length, 0);
  // Same state — no emit
  assert.equal((await ch.poll()).length, 0);
  // State change -> emit
  list = [{
    name: 'home23-jerry',
    pm2_env: {
      status: 'stopped',
      restart_time: 1,
      pm_exec_path: '/Users/jtr/_JTR23_/release/home23/engine/src/index.js',
    },
  }];
  const changed = await ch.poll();
  assert.equal(changed.length, 1);
  assert.equal(changed[0].status, 'stopped');
  assert.equal(changed[0].restartCount, 1);
  assert.equal(changed[0].topology.role, 'agent-engine');
  assert.equal(changed[0].topology.agentName, 'jerry');
  assert.equal(changed[0].topology.expectedParallelRole, true);
});

test('Pm2Channel treats unsafe PM2 restart counters as unknown', async () => {
  assert.equal(_test.normalizePm2RestartCount(12), 12);
  assert.equal(_test.normalizePm2RestartCount('12'), 12);
  assert.equal(_test.normalizePm2RestartCount('171111111111111111111111111111111'), null);
  assert.equal(_test.normalizePm2RestartCount('not-a-count'), null);
});
