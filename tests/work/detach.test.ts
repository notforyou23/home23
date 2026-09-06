import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationRunLockHeld,
  delegatedAttemptChatId,
  isConversationForegroundChat,
  isDetachedAttemptChat,
  mustDetachLongTool,
  residentAttemptChatId,
} from '../../src/work/detach.ts';

test('conversation foreground chats must detach long tools', () => {
  assert.equal(isConversationForegroundChat('ios_conv_42'), true);
  assert.equal(isConversationForegroundChat('mac_dev_jerry_a_b'), true);
  assert.equal(isConversationForegroundChat('12345'), true);
  assert.equal(isConversationForegroundChat('-100123'), true);
  assert.equal(mustDetachLongTool('ios_conv_42'), true);
  assert.equal(mustDetachLongTool('12345'), true);
});

test('attempt chats are detached and may wait', () => {
  const resident = residentAttemptChatId('chn_1', 'wrk_1');
  const delegated = delegatedAttemptChatId('chn_1', 'wrk_1', 'a'.repeat(32));
  assert.equal(resident, 'coordination:chn_1:wrk_1');
  assert.equal(isDetachedAttemptChat(resident), true);
  assert.equal(isDetachedAttemptChat(delegated), true);
  assert.equal(mustDetachLongTool(resident), false);
  assert.equal(mustDetachLongTool(delegated), false);
  assert.equal(isConversationForegroundChat(resident), false);
});

test('conversation run lock is only the conversation chat', () => {
  const running = new Set<string>(['coordination:chn_1:wrk_1']);
  const isRunning = (chatId: string) => running.has(chatId);
  assert.equal(conversationRunLockHeld('ios_conv_42', isRunning), false);
  running.add('ios_conv_42');
  assert.equal(conversationRunLockHeld('ios_conv_42', isRunning), true);
});
