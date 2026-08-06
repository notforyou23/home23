import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAsyncWorkPayload } from '../../src/push/types.ts';

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
