import test from 'node:test';
import assert from 'node:assert/strict';
import { createIsolatedContinuityOffice } from '../../src/coordination-adapter/continuity-office/index.js';

function office() {
  return createIsolatedContinuityOffice({
    now: () => new Date('2026-09-03T17:00:00.000Z'),
    owner: { token: 'owner-token', principalId: 'principal_owner', displayName: 'jtr' },
  });
}

test('rejects unauthenticated ingress and stores nothing', () => {
  const continuity = office();
  const denied = continuity.acceptIngress({
    token: 'wrong-token',
    channelId: 'channel_home',
    clientMessageId: 'client_msg_1',
    text: 'Are you there?',
  });

  assert.equal(denied.accepted, false);
  assert.equal(denied.reason, 'unauthenticated');
  assert.equal(denied.messageId, undefined);
  assert.equal(continuity.messageCount(), 0);
});

test('accepts authenticated ingress and names the continuity office', () => {
  const continuity = office();
  const accepted = continuity.acceptIngress({
    token: 'owner-token',
    channelId: 'channel_home',
    clientMessageId: 'client_msg_1',
    text: 'Are you there?',
  });

  assert.equal(accepted.accepted, true);
  assert.equal(accepted.officeId, 'continuity-office');
  assert.equal(accepted.presentation, 'accepted by a continuity office');
  assert.equal(accepted.kind, 'text');
  assert.ok(accepted.messageId);
  assert.equal(continuity.message(accepted.messageId)?.clientMessageId, 'client_msg_1');
  assert.equal(continuity.message(accepted.messageId)?.channelId, 'channel_home');
});

test('replays the same clientMessageId without duplicating the message', () => {
  const continuity = office();
  const request = {
    token: 'owner-token',
    channelId: 'channel_home',
    clientMessageId: 'client_msg_1',
    text: 'Are you there?',
  } as const;

  const first = continuity.acceptIngress(request);
  const second = continuity.acceptIngress(request);

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(second.messageId, first.messageId);
  assert.equal(second.replayed, true);
  assert.equal(continuity.messageCount(), 1);
});
