import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAsyncWorkPayload,
  buildConnectedAgentsMessagePayload,
  buildConnectedAgentsWorkPayload,
  selectConnectedAgentsAlertDevices,
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
  assert.equal(p.aps['mutable-content'], 1);
  assert.equal(p.aps.sound, 'default');
  assert.equal(p.aps['thread-id'], 'work:aw_t_ab12');
  assert.equal(p.aps.category, 'CA_WORK');
  assert.equal(p.aps['interruption-level'], 'time-sensitive');
  assert.equal('collapse-id' in p.aps, false);
  assert.ok(!('turnId' in p));
});

const connectedAgentsIds = {
  conversationId: 'cnv_0198d95f-6c00-7000-8000-000000000911',
  channelId: 'chn_0198d95f-6c00-7000-8000-000000000911',
  messageId: 'msg_0198d95f-6c00-7000-8000-000000000911',
};

test('connected agents aps groups by conversation and channel as time-sensitive CA_MESSAGE', () => {
  const p = buildConnectedAgentsMessagePayload({
    ...connectedAgentsIds,
    displayName: 'Forrest',
    conversationTitle: 'Kitchen remodel',
    preview: 'Short reply',
    badge: 2,
  });
  assert.equal(p.aps.alert.title, 'Forrest');
  assert.equal(p.aps.alert.subtitle, 'Kitchen remodel');
  assert.equal(p.aps.alert.body, 'Short reply');
  assert.equal(p.aps['mutable-content'], 1);
  assert.equal(p.aps.sound, 'default');
  assert.equal(p.aps.badge, 2);
  assert.equal(
    p.aps['thread-id'],
    `ca:${connectedAgentsIds.conversationId}:${connectedAgentsIds.channelId}`,
  );
  assert.equal(p.aps.category, 'CA_MESSAGE');
  assert.equal(p.aps['interruption-level'], 'time-sensitive');
  assert.equal('collapse-id' in p.aps, false);
});

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

test('connected agents skips Mac alerts when an iPhone is already current', () => {
  const ios = {
    device_token: 'a'.repeat(64),
    bundle_id: 'com.regina6.home23.connectedagents.canary',
    env: 'sandbox' as const,
    chat_ids: [],
    registered_at: '2026-09-10T00:00:00.000Z',
    last_seen_at: '2026-09-10T00:00:00.000Z',
    platform: 'ios',
    connected_agents_notifications: true,
    coordination_device_id: 'dev_ios',
    coordination_session_id: 'ses_ios',
  };
  const macos = {
    device_token: 'b'.repeat(64),
    bundle_id: 'com.regina6.home23.mac',
    env: 'sandbox' as const,
    chat_ids: [],
    registered_at: '2026-09-10T00:00:00.000Z',
    last_seen_at: '2026-09-10T00:00:00.000Z',
    platform: 'macos',
    connected_agents_notifications: true,
    coordination_device_id: 'dev_mac',
    coordination_session_id: 'ses_mac',
  };
  assert.deepEqual(
    selectConnectedAgentsAlertDevices([ios, macos]).map((device) => device.platform),
    ['ios'],
  );
  assert.deepEqual(
    selectConnectedAgentsAlertDevices([macos]).map((device) => device.bundle_id),
    ['com.regina6.home23.mac'],
  );
});

test('connected agents work wake is time-sensitive CA_WORK with a silent content-available', () => {
  const workId = 'wrk_0198d95f-6c00-7000-8000-000000000911';
  const p = buildConnectedAgentsWorkPayload({
    workId,
    conversationId: connectedAgentsIds.conversationId,
    channelId: connectedAgentsIds.channelId,
    status: 'running',
    displayName: 'Jerry',
    conversationTitle: 'Kitchen remodel',
  });
  assert.equal(p.kind, 'connected_agents_work');
  assert.equal(p.workId, workId);
  assert.equal(p.conversationId, connectedAgentsIds.conversationId);
  assert.equal(p.channelId, connectedAgentsIds.channelId);
  assert.equal(p.status, 'running');
  assert.equal(p.aps.alert.title, 'Jerry');
  assert.equal(p.aps.alert.subtitle, 'Kitchen remodel');
  assert.equal(p.aps.alert.body, 'Working');
  assert.equal(p.aps['content-available'], 1);
  assert.equal(p.aps['thread-id'], `work:${workId}`);
  assert.equal(p.aps.category, 'CA_WORK');
  assert.equal(p.aps['interruption-level'], 'time-sensitive');
  assert.equal('collapse-id' in p.aps, false);
  assert.equal('title' in p, false);
});
