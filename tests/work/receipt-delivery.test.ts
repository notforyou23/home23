import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverWorkReceipt, workPushBody, type ReceiptSinks } from '../../src/work/receipt-delivery.ts';
import type { AsyncWorkRecord } from '../../src/work/types.ts';

const SECRET_TAIL = 'API_KEY=sk-secret-123 private diff content that must never hit the lock screen';

function makeWork(overrides: Partial<AsyncWorkRecord> = {}): AsyncWorkRecord {
  return {
    schema: 'home23.async-work.v1',
    workId: 'aw_t_ab12',
    kind: 'coding',
    agent: 'jerry',
    originChatId: 'ios_conv_42',
    label: 'scheduler fix',
    status: 'completed',
    startedAt: '2026-08-06T12:00:00.000Z',
    updatedAt: '2026-08-06T12:05:00.000Z',
    resultHandle: { type: 'coding_job', jobId: 'cj_x_1111' },
    verification: 'none',
    ...overrides,
  };
}

function capture() {
  const calls: {
    history: Array<{ chatId: string; text: string }>;
    telegram: Array<{ chatId: string; text: string }>;
    push: Array<{ chatId: string; workId: string; status: string; body: string }>;
  } = { history: [], telegram: [], push: [] };
  const sinks: ReceiptSinks = {
    appendHistory: (chatId, text) => calls.history.push({ chatId, text }),
    sendTelegram: (chatId, text) => calls.telegram.push({ chatId, text }),
    pushWork: (input) => calls.push.push(input),
  };
  return { calls, sinks };
}

test('ios origin: history + one async_work push carrying workId, tail never on lock screen', async () => {
  const { calls, sinks } = capture();
  const route = await deliverWorkReceipt(makeWork(), `[Async work completed] scheduler fix\n${SECRET_TAIL}`, sinks);
  assert.equal(route, 'ios');
  assert.equal(calls.history.length, 1);
  assert.equal(calls.history[0].chatId, 'ios_conv_42');
  assert.equal(calls.push.length, 1);
  assert.equal(calls.push[0].workId, 'aw_t_ab12');
  assert.equal(calls.push[0].chatId, 'ios_conv_42');
  assert.ok(!calls.push[0].body.includes('sk-secret-123'));
  assert.equal(calls.telegram.length, 0);
});

test('mac origin routes like ios', async () => {
  const { calls, sinks } = capture();
  const route = await deliverWorkReceipt(makeWork({ originChatId: 'mac_dev_jerry_a_b' }), 'text', sinks);
  assert.equal(route, 'ios');
  assert.equal(calls.push[0].chatId, 'mac_dev_jerry_a_b');
});

test('numeric origin: history + telegram, no push', async () => {
  const { calls, sinks } = capture();
  const route = await deliverWorkReceipt(makeWork({ originChatId: '-100123' }), 'full text', sinks);
  assert.equal(route, 'telegram');
  assert.equal(calls.telegram.length, 1);
  assert.equal(calls.push.length, 0);
});

test('other origins (cron, worker) are history-only', async () => {
  const { calls, sinks } = capture();
  const route = await deliverWorkReceipt(makeWork({ originChatId: 'cron-agent-daily' }), 'text', sinks);
  assert.equal(route, 'none');
  assert.equal(calls.history.length, 1);
  assert.equal(calls.telegram.length, 0);
  assert.equal(calls.push.length, 0);
});

test('missing sinks degrade to history-only without throwing', async () => {
  const history: string[] = [];
  const route = await deliverWorkReceipt(makeWork(), 'text', { appendHistory: (_c, t) => history.push(t) });
  assert.equal(route, 'none');
  assert.equal(history.length, 1);
});

test('canonical coordination origin uses only the exact completion callback', async () => {
  const history: string[] = [];
  const commits: unknown[] = [];
  const work = makeWork({
    kind: 'subagent',
    workId: 'aw_child_1',
    agent: 'jerry',
    originChatId: 'coordination:chn_1:wrk_parent_1',
    parentWorkId: 'wrk_parent_1',
    deliveryMode: 'detached',
    finishedAt: '2026-08-06T12:05:00.000Z',
    resultHandle: { type: 'subagent_chat', chatId: 'subagent:coordination:chn_1:wrk_parent_1:abcd' },
    coordinationDestination: {
      kind: 'coordination', parentWorkId: 'wrk_parent_1', channelId: 'chn_1',
      conversationId: 'cnv_1', originMessageId: 'msg_origin_1',
      attemptId: 'att_1', leaseId: 'lse_1', fencingToken: 1,
      targetPrincipalId: 'bot_jerry', residentBinding: 'jerry',
      residentInstanceId: 'resident-jerry-1', authorityReference: 'resident:jerry',
    },
  });
  const route = await deliverWorkReceipt(work, {
    receiptText: '[Sub-agent complete] hidden evidence',
    resultText: 'Here is the result you asked for.',
    artifacts: [{ type: 'document', path: '/tmp/result.txt', mimeType: 'text/plain' }],
  }, {
    appendHistory: (_chatId, text) => history.push(text),
    commitCoordinationCompletion: (input) => { commits.push(input); },
  });
  assert.equal(route, 'coordination');
  assert.equal(history.length, 0, 'hidden worker receipt never enters chat history');
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0], {
    parentWorkId: 'wrk_parent_1', childWorkId: 'aw_child_1', childKind: 'subagent',
    childResultHandle: { type: 'subagent_chat', chatId: 'subagent:coordination:chn_1:wrk_parent_1:abcd' },
    status: 'completed', finishedAt: '2026-08-06T12:05:00.000Z',
    channelId: 'chn_1', conversationId: 'cnv_1', originMessageId: 'msg_origin_1',
    attemptId: 'att_1', leaseId: 'lse_1', fencingToken: 1,
    targetPrincipalId: 'bot_jerry', residentBinding: 'jerry',
    residentInstanceId: 'resident-jerry-1', authorityReference: 'resident:jerry',
    terminalText: 'Here is the result you asked for.',
    artifacts: [{ type: 'document', path: '/tmp/result.txt', mimeType: 'text/plain' }],
  });
});

test('push body is a concise status line per status', () => {
  assert.equal(workPushBody(makeWork()), 'Work finished: scheduler fix');
  assert.equal(workPushBody(makeWork({ status: 'failed' })), 'Work failed: scheduler fix');
  assert.equal(workPushBody(makeWork({ status: 'interrupted', label: '' })), 'Work interrupted.');
});
