import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAsyncWorkPayload,
  buildConnectedAgentsMessagePayload,
} from '../../src/push/types.ts';

test('async_work payload carries chatId + workId and no turnId key', () => {
  const p = buildAsyncWorkPayload({
    agentName: 'jerry',
    chatId: 'ios_conv_42',
    workId: 'aw_t_ab12',
    status: 'completed',
    body: 'Work finished: scheduler fix',
  });
  assert.equal(p.kind, 'async_work');
  assert.equal(p.chatId, 'ios_conv_42');
  assert.equal(p.workId, 'aw_t_ab12');
  assert.equal(p.status, 'completed');
  assert.equal(p.aps.alert.title, 'jerry');
  assert.equal(p.aps.alert.body, 'Work finished: scheduler fix');
  assert.ok(!('turnId' in p));
});

const connectedAgentsIds = {
  conversationId: 'cnv_0198d95f-6c00-7000-8000-000000000911',
  channelId: 'chn_0198d95f-6c00-7000-8000-000000000911',
  messageId: 'msg_0198d95f-6c00-7000-8000-000000000911',
};

test('connected agents alert names the agent, thread, and a truncated preview', () => {
  const remainder = ' and this remainder must not enter APNs';
  const preview = `${'The plumber can come Thursday morning.'.padEnd(100, 'x')}${remainder}`;
  const p = buildConnectedAgentsMessagePayload({
    ...connectedAgentsIds,
    displayName: 'Forrest',
    conversationTitle: 'Kitchen remodel',
    preview,
  });
  assert.equal(p.aps.alert.title, 'Forrest');
  assert.equal(p.aps.alert.subtitle, 'Kitchen remodel');
  assert.equal(p.aps.alert.body.length, 100);
  assert.equal(p.aps.alert.body.endsWith('…'), true);
  assert.equal(p.aps.alert.body.includes(remainder.trim()), false);
  assert.equal('preview' in p, false);
  assert.equal('conversationTitle' in p, false);
  assert.equal('text' in p, false);
  assert.equal(JSON.stringify(p).includes(remainder.trim()), false);
});

test('connected agents alert omits subtitle when the thread title is the agent name', () => {
  const p = buildConnectedAgentsMessagePayload({
    ...connectedAgentsIds,
    displayName: 'Forrest',
    conversationTitle: 'Forrest',
    preview: 'Short reply',
  });
  assert.equal(p.aps.alert.title, 'Forrest');
  assert.equal('subtitle' in p.aps.alert, false);
  assert.equal(p.aps.alert.body, 'Short reply');
});

test('connected agents alert falls back to an attachment line, then Reply ready', () => {
  const attachment = buildConnectedAgentsMessagePayload({
    ...connectedAgentsIds,
    displayName: 'Forrest',
    hasAttachments: true,
  });
  assert.equal(attachment.aps.alert.body, 'Sent an attachment');
  const empty = buildConnectedAgentsMessagePayload({
    ...connectedAgentsIds,
    displayName: 'Forrest',
  });
  assert.equal(empty.aps.alert.body, 'Reply ready');
});
