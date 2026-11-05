'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runSafeAction } = require('../../../engine/src/os-kernel/safe-actions.js');
const { EXEC_CATALOG } = require('../../../engine/src/live-problems/remediators.js');

test('safe-actions rejects unknown id and non-home23 pm2 names', async () => {
  await assert.rejects(() => runSafeAction({ id: 'rm_rf', args: {} }, {}), /catalog/i);
  await assert.rejects(
    () => runSafeAction({ id: 'restart_pm2', args: { name: 'nginx' } }, {}),
    /home23/i,
  );
});

test('reclaim_known_safe_disk is registered in EXEC_CATALOG (not dead)', () => {
  assert.ok(
    EXEC_CATALOG.reclaim_known_safe_disk,
    'EXEC_CATALOG must have a reclaim_known_safe_disk entry — safe-actions.js dispatches to it by name',
  );
});

test('runSafeAction reclaim_known_safe_disk does not throw or reject as unknown command', async () => {
  const result = await runSafeAction({ id: 'reclaim_known_safe_disk' }, {});
  assert.notEqual(result.outcome, 'rejected');
  assert.doesNotMatch(String(result.detail || ''), /unknown command/i);
});
