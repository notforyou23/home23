import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUSY_REPLY_TEXT,
  ForegroundTurnHeld,
  admitForegroundTurn,
  assertCanStartSpeaking,
  isForegroundConversation,
  isSpeakingConversationRun,
} from '../../src/agent/foreground-admission.js';

test('active Work never blocks a new speaking turn or emits the busy reply', () => {
  const decision = admitForegroundTurn({ speakingActive: false, workActive: true });
  assert.equal(decision.accepted, true);
  assert.equal(decision.action, 'start_speaking');
  assert.equal(decision.startSpeaking, true);
  assert.equal(decision.busyReply, null);
  assert.notEqual(decision.busyReply, BUSY_REPLY_TEXT);
});

test('a live speaking turn accepts the Message but does not start a second completion', () => {
  const decision = admitForegroundTurn({ speakingActive: true, workActive: true });
  assert.equal(decision.accepted, true);
  assert.equal(decision.action, 'hold_for_speaking');
  assert.equal(decision.startSpeaking, false);
  assert.equal(decision.busyReply, null);
  assert.throws(() => assertCanStartSpeaking({ speakingActive: true }), ForegroundTurnHeld);
});

test('coordination and synthetic chats are not conversation speaking locks', () => {
  assert.equal(isSpeakingConversationRun({
    chatId: 'ios_abc',
    coordinationOrigin: { kind: 'coordination' },
  }), false);
  assert.equal(isSpeakingConversationRun({ chatId: 'coordination:ch:w1' }), false);
  assert.equal(isSpeakingConversationRun({ chatId: 'ios_abc' }), true);
  assert.equal(isForegroundConversation({ chatId: 'ios_abc' }), true);
  assert.equal(isForegroundConversation({ chatId: 'subagent:ios_abc:ffff' }), false);
  assert.equal(isForegroundConversation({ chatId: '' }), false);
});
