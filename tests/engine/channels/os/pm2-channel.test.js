import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pm2Channel } from '../../../../engine/src/channels/os/pm2-channel.js';

test('Pm2Channel seeds on first poll then emits on state change', async () => {
  let list = [{ name: 'home23-jerry', pm2_env: { status: 'online', restart_time: 0 } }];
  const ch = new Pm2Channel({ intervalMs: 10, listProcesses: async () => list });
  // First poll seeds baseline, no emission
  assert.equal((await ch.poll()).length, 0);
  // Same state — no emit
  assert.equal((await ch.poll()).length, 0);
  // State change -> emit
  list = [{ name: 'home23-jerry', pm2_env: { status: 'stopped', restart_time: 1 } }];
  const changed = await ch.poll();
  assert.equal(changed.length, 1);
  assert.equal(changed[0].status, 'stopped');
  assert.equal(changed[0].restartCount, 1);
});
