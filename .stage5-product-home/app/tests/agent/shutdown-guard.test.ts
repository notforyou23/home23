import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShutdownGuard } from '../../src/shutdown-guard.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('first begin() returns true and does not exit', async () => {
  const exits: number[] = [];
  const guard = new ShutdownGuard({ watchdogMs: 200, log: () => {}, exit: (code) => { exits.push(code); } });
  assert.equal(guard.begin('SIGINT'), true);
  assert.deepEqual(exits, []);
  guard.disarm();
});

test('second signal force-exits instead of being swallowed', () => {
  const exits: number[] = [];
  const logs: string[] = [];
  const guard = new ShutdownGuard({ watchdogMs: 200, log: (m) => logs.push(m), exit: (code) => { exits.push(code); } });
  assert.equal(guard.begin('SIGINT'), true);
  assert.equal(guard.begin('SIGTERM'), false);
  assert.deepEqual(exits, [130], 'repeated signal must force-exit 130');
  assert.ok(logs.some((l) => l.includes('SIGTERM')), 'forced exit must name the signal');
  guard.disarm();
});

test('watchdog force-exits when graceful shutdown hangs', async () => {
  const exits: number[] = [];
  const guard = new ShutdownGuard({ watchdogMs: 40, log: () => {}, exit: (code) => { exits.push(code); } });
  guard.begin('SIGTERM');
  await sleep(90);
  assert.deepEqual(exits, [1], 'watchdog must fire exit(1) after watchdogMs');
});

test('disarm() cancels the watchdog', async () => {
  const exits: number[] = [];
  const guard = new ShutdownGuard({ watchdogMs: 40, log: () => {}, exit: (code) => { exits.push(code); } });
  guard.begin('SIGTERM');
  guard.disarm();
  await sleep(90);
  assert.deepEqual(exits, []);
});
