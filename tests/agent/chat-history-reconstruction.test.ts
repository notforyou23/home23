import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  createChatHistoryHandler,
  projectChatHistoryRecords,
} from '../../src/routes/chat-history.js';

function chunk(turnId: string, seq: number, text: string) {
  return {
    type: 'event',
    turn_id: turnId,
    seq,
    ts: `2026-07-12T16:06:${String(seq % 60).padStart(2, '0')}.000Z`,
    kind: 'response_chunk',
    data: { type: 'response_chunk', chunk: text },
  };
}

function turn(turnId: string, status: 'pending' | 'complete', lastSeq?: number) {
  return {
    type: 'turn',
    turn_id: turnId,
    chat_id: 'ios-chat',
    status,
    role: 'assistant',
    started_at: status === 'pending' ? '2026-07-12T16:06:00.000Z' : '',
    ...(status === 'complete'
      ? { ended_at: '2026-07-12T16:07:00.000Z', last_seq: lastSeq, stop_reason: 'end_turn' }
      : {}),
  };
}

test('completed history uses canonical assistant content instead of a bounded chunk suffix', () => {
  const turnId = 't_complete';
  const full = Array.from({ length: 180 }, (_, index) => `word-${index} `).join('');
  const records = [
    turn(turnId, 'pending'),
    {
      type: 'event', turn_id: turnId, seq: 1, ts: '2026-07-12T16:06:01.000Z', kind: 'thinking',
      data: { type: 'thinking', content: 'checking history' },
    },
    {
      type: 'event', turn_id: turnId, seq: 2, ts: '2026-07-12T16:06:02.000Z', kind: 'tool_start',
      data: { type: 'tool_start', tool: 'brain_status', args: {} },
    },
    {
      type: 'event', turn_id: turnId, seq: 3, ts: '2026-07-12T16:06:03.000Z', kind: 'tool_result',
      data: { type: 'tool_result', tool: 'brain_status', result: 'ok', success: true },
    },
    ...full.split(/(?<= )/).map((text, index) => chunk(turnId, index + 4, text)),
    { role: 'user', content: 'show me the whole answer', ts: '2026-07-12T16:06:00.000Z' },
    { role: 'assistant', content: '[Used tools: brain_status]', ts: '2026-07-12T16:06:59.000Z' },
    { role: 'assistant', content: full, ts: '2026-07-12T16:07:00.000Z' },
    turn(turnId, 'complete', 183),
  ];

  const projected = projectChatHistoryRecords(records, 100) as any[];
  const responseChunks = projected.filter(record => record?.type === 'event' && record?.kind === 'response_chunk');
  const canonical = projected.filter(record => record?.canonical === true);

  assert.equal(responseChunks.length, 0, 'completed chunk transport must not compete with canonical content');
  assert.equal(canonical.length, 1, 'canonical assistant must appear exactly once');
  assert.equal(canonical[0].turn_id, turnId);
  assert.equal(canonical[0].content, full);
  assert.deepEqual(
    projected.filter(record => record?.role === 'assistant' && typeof record?.content === 'string'),
    [canonical[0]],
    'stored tool scaffolding must not duplicate preserved tool events as assistant messages',
  );
  assert.ok(projected.some(record => record?.kind === 'thinking'), 'thinking record must remain visible');
  assert.ok(projected.some(record => record?.kind === 'tool_start'), 'tool start must remain visible');
  assert.ok(projected.some(record => record?.kind === 'tool_result'), 'tool result must remain visible');
  const terminal = projected.find(record => record?.type === 'turn' && record?.status === 'complete');
  assert.equal(terminal?.assistant_content, full, 'terminal envelope must carry canonical reconciliation content');
});

test('pending history coalesces response deltas before applying the record limit', () => {
  const turnId = 't_pending';
  const full = Array.from({ length: 180 }, (_, index) => `${index},`).join('');
  const records = [
    turn(turnId, 'pending'),
    ...full.split(/(?<=,)/).map((text, index) => chunk(turnId, index + 1, text)),
  ];

  const projected = projectChatHistoryRecords(records, 5) as any[];
  const responseChunks = projected.filter(record => record?.type === 'event' && record?.kind === 'response_chunk');

  assert.equal(responseChunks.length, 1);
  assert.equal(responseChunks[0].data.chunk, full);
  assert.equal(responseChunks[0].seq, 180, 'coalesced event retains the newest cursor');
});

test('history route limits semantic projection rather than raw JSONL transport records', async () => {
  const turnId = 't_route';
  const full = 'Targeting: ' + 'complete '.repeat(140);
  const records = [
    turn(turnId, 'pending'),
    ...full.split(/(?<= )/).map((text, index) => chunk(turnId, index + 1, text)),
    { role: 'user', content: 'question', ts: '2026-07-12T16:06:00.000Z' },
    { role: 'assistant', content: full, ts: '2026-07-12T16:07:00.000Z' },
    turn(turnId, 'complete', 141),
  ];
  const app = express();
  app.get('/api/chat/history', createChatHistoryHandler({
    agentName: 'jerry',
    history: { loadRaw: () => records } as any,
  }));

  const body = await new Promise<any>((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = (server.address() as { port: number }).port;
        const response = await fetch(`http://127.0.0.1:${port}/api/chat/history?chatId=ios-chat&limit=5`);
        resolve(await response.json());
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });

  assert.equal(body.total, records.length, 'raw total remains available for diagnostics');
  assert.equal(body.records.filter((record: any) => record.canonical === true).length, 1);
  assert.equal(body.records.find((record: any) => record.canonical === true).content, full);
});
