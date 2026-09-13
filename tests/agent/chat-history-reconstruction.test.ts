import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  createChatHistoryHandler,
  projectChatHistoryRecords,
} from '../../src/routes/chat-history.js';
// @ts-expect-error — shared browser projection has no declaration file
import { projectHistoryToRows } from '../../engine/src/dashboard/home23-chat-transcript.mjs';

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
      data: {
        type: 'tool_result', tool: 'brain_status', result: 'running', success: true,
        resultHandle: 'brres_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        toolMetadata: {
          operationId: 'brop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          operationType: 'pgs',
          state: 'running',
          attachmentState: 'detached',
          classification: 'detached',
        },
      },
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
  const toolResult = projected.find(record => record?.kind === 'tool_result');
  assert.equal(toolResult?.data?.resultHandle, 'brres_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(toolResult?.data?.toolMetadata?.operationId, 'brop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(toolResult?.data?.toolMetadata?.attachmentState, 'detached');
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

test('child and nested-child deltas coalesce within ownership before bounding display history', () => {
  const progress = (seq: number, subagentId: string, activity: object) => ({
    type: 'event', turn_id: 'parent', seq, ts: '2026-09-13T12:00:00Z', kind: 'subagent_progress',
    data: { type: 'subagent_progress', subagentId, activity },
  });
  const records = [
    progress(1, 'a', { type: 'tool_start', tool: 'read_file', toolCallId: 'call-a', args: {} }),
    ...Array.from({ length: 220 }, (_, index) => progress(index + 2, 'a', { type: 'response_chunk', chunk: `${index},` })),
    progress(222, 'b', { type: 'response_chunk', chunk: 'Other child' }),
    progress(223, 'a', { type: 'subagent_progress', subagentId: 'nested', activity: { type: 'thinking', content: 'First ' } }),
    progress(224, 'a', { type: 'subagent_progress', subagentId: 'nested', activity: { type: 'thinking', content: 'second' } }),
  ];
  const projected = projectChatHistoryRecords(records, 5) as any[];
  assert.equal(projected.length, 4);
  assert.equal(projected[0].data.activity.toolCallId, 'call-a');
  assert.equal(projected[1].data.activity.chunk, Array.from({ length: 220 }, (_, index) => `${index},`).join(''));
  assert.equal(projected[1].seq, 221);
  assert.equal(projected[1].display_start_seq, 2);
  assert.equal(projected[2].data.subagentId, 'b');
  assert.equal(projected[3].data.activity.activity.content, 'First second');
  assert.equal(projected[3].display_start_seq, 223);
});

test('completed history retains interim commentary and deduplicates only its exact final segment', () => {
  const turnId = 't_commentary';
  const event = (kind: string, seq: number, data: object) => ({
    type: 'event', turn_id: turnId, seq, kind, ts: '2026-09-13T12:00:00Z', data: { type: kind, ...data },
  });
  const records = [
    turn(turnId, 'pending'),
    chunk(turnId, 0, 'I am checking the file.'),
    event('tool_start', 1, { tool: 'read_file', toolCallId: 'read1' }),
    event('tool_result', 2, { tool: 'read_file', toolCallId: 'read1', result: 'Found it', success: true }),
    chunk(turnId, 3, 'The file '),
    event('status', 4, { status: 'provider_active' }),
    chunk(turnId, 5, 'is ready.'),
    { role: 'assistant', content: 'The file is ready.' },
    turn(turnId, 'complete', 5),
  ];
  const projected = projectChatHistoryRecords(records, 100) as any[];
  const rows = projectHistoryToRows(projected);
  assert.deepEqual(rows.map((row: any) => row.kind), ['assistant', 'tool', 'assistant']);
  assert.deepEqual(rows.filter((row: any) => row.kind === 'assistant').map((row: any) => row.text), [
    'I am checking the file.', 'The file is ready.',
  ]);
  assert.equal(projected.filter(record => record.kind === 'response_chunk').length, 1);
});

test('completed history preserves partial final text rather than guessing it duplicates the canonical answer', () => {
  const turnId = 't_partial';
  const records = [turn(turnId, 'pending'), chunk(turnId, 0, 'The file'),
    { role: 'assistant', content: 'The file is ready.' }, turn(turnId, 'complete', 0)];
  const projected = projectChatHistoryRecords(records, 100) as any[];
  assert.equal(projected.find(record => record.kind === 'response_chunk')?.data.chunk, 'The file');
  assert.equal(projected.find(record => record.canonical)?.content, 'The file is ready.');
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

test('pending turn envelopes are omitted once complete; blank assistants dropped', () => {
  const turnId = 't_blank';
  const full = 'Final answer text';
  const records = [
    turn(turnId, 'pending'),
    { role: 'user', content: 'hi', ts: '2026-07-12T16:06:00.000Z' },
    { role: 'assistant', content: '   ', ts: '2026-07-12T16:06:30.000Z' },
    { role: 'assistant', content: full, ts: '2026-07-12T16:07:00.000Z' },
    { ...turn(turnId, 'complete', 1), assistant_content: full },
  ];
  const projected = projectChatHistoryRecords(records, 100) as any[];
  assert.equal(
    projected.filter((r) => r?.type === 'turn' && r?.status === 'pending').length,
    0,
    'completed turns must not project their pending envelope',
  );
  assert.equal(
    projected.filter((r) => r?.role === 'assistant' && r?.canonical === true).length,
    1,
  );
  assert.equal(
    projected.filter((r) => r?.role === 'assistant' && typeof r?.content === 'string' && !r?.canonical).length,
    0,
    'whitespace-only assistants must be dropped',
  );
  const terminal = projected.find((r) => r?.type === 'turn' && r?.status === 'complete');
  assert.equal(terminal?.assistant_content, full);
  assert.equal(terminal?.display_assistant, false);
});
