import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRootChatId,
  newWorkId,
  isHumanOrigin,
  TERMINAL_WORK_STATUSES,
} from '../../src/work/types.ts';

test('resolveRootChatId returns non-subagent ids unchanged', () => {
  assert.equal(resolveRootChatId('ios_3d1c6ad844c1_jerry_tj_67482f5e'), 'ios_3d1c6ad844c1_jerry_tj_67482f5e');
  assert.equal(resolveRootChatId('123456789'), '123456789');
  assert.equal(resolveRootChatId('cron-agent-daily'), 'cron-agent-daily');
});

test('resolveRootChatId unwraps one subagent layer', () => {
  assert.equal(resolveRootChatId('subagent:ios_abc_jerry_x_ff00:ab12'), 'ios_abc_jerry_x_ff00');
  assert.equal(resolveRootChatId('subagent:123456789:ab12'), '123456789');
});

test('resolveRootChatId unwraps nested subagent layers', () => {
  assert.equal(resolveRootChatId('subagent:subagent:123456789:ab12:cd34'), '123456789');
});

test('resolveRootChatId leaves malformed subagent ids alone', () => {
  assert.equal(resolveRootChatId('subagent:'), 'subagent:');
  assert.equal(resolveRootChatId('subagent:x'), 'subagent:x');
});

test('newWorkId shape', () => {
  const id = newWorkId();
  assert.match(id, /^aw_[a-z0-9]+_[0-9a-f]{4}$/);
  assert.notEqual(newWorkId(), id);
});

test('isHumanOrigin', () => {
  assert.equal(isHumanOrigin('123456789'), true);       // Telegram
  assert.equal(isHumanOrigin('-100987'), true);          // Telegram group
  assert.equal(isHumanOrigin('ios_abc_jerry_x_ff'), true);
  assert.equal(isHumanOrigin('mac_abc_jerry_x_ff'), true);
  assert.equal(isHumanOrigin('cron-agent-daily'), false);
  assert.equal(isHumanOrigin('subagent:123:ab12'), false);
  assert.equal(isHumanOrigin('worker:shakedown'), false);
});

test('terminal statuses', () => {
  for (const s of ['completed', 'failed', 'cancelled', 'interrupted']) {
    assert.equal(TERMINAL_WORK_STATUSES.has(s as never), true);
  }
  for (const s of ['queued', 'running', 'blocked']) {
    assert.equal(TERMINAL_WORK_STATUSES.has(s as never), false);
  }
});
