'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { duplicateLockMode } = require('../../scripts/home23-pm2-watchdog-daemon.cjs');

test('pm2-managed duplicate watchdog waits for the lock instead of exiting into an autorestart loop', () => {
  assert.equal(duplicateLockMode({ pm_id: '11' }), 'retry');
  assert.equal(duplicateLockMode({ NODE_APP_INSTANCE: '0' }), 'retry');
});

test('manual duplicate watchdog exits when another process owns the lock', () => {
  assert.equal(duplicateLockMode({}), 'exit');
});
