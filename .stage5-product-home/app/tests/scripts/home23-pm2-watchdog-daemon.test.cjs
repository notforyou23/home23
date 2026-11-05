'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { duplicateLockMode, watchdogDaemonDisabled, shouldReplaceLockHolderWithCommand } = require('../../scripts/home23-pm2-watchdog-daemon.cjs');

test('pm2-managed duplicate watchdog exits instead of accumulating lock waiters', () => {
  assert.equal(duplicateLockMode({ pm_id: '11' }), 'exit');
  assert.equal(duplicateLockMode({ NODE_APP_INSTANCE: '0' }), 'exit');
});

test('manual duplicate watchdog exits when another process owns the lock', () => {
  assert.equal(duplicateLockMode({}), 'exit');
});

test('watchdog daemon disabled flag recognizes PM2 ecosystem values', () => {
  assert.equal(watchdogDaemonDisabled({ HOME23_WATCHDOG_DAEMON_DISABLED: 'true' }), true);
  assert.equal(watchdogDaemonDisabled({ HOME23_WATCHDOG_DAEMON_DISABLED: '1' }), true);
  assert.equal(watchdogDaemonDisabled({ HOME23_WATCHDOG_DAEMON_DISABLED: 'false' }), false);
  assert.equal(watchdogDaemonDisabled({}), false);
});

test('pm2-managed watchdog replaces an older same-name lock holder', () => {
  const replace = shouldReplaceLockHolderWithCommand(
    { pmId: '18', pmName: 'home23-watchdog' },
    1234,
    'node /Users/jtr/_JTR23_/release/home23/scripts/home23-pm2-watchdog-daemon.cjs',
    { pm_id: '22', name: 'home23-watchdog' }
  );

  assert.equal(replace, true);
});
