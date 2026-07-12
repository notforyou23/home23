import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.OPENAI_API_KEY ||= 'test-key';
const { parseConversationLines } = require('../../../engine/src/dashboard/server');

test('dashboard history ignores turn transport records and keeps canonical messages once', () => {
  const full = 'Targeting: full canonical answer';
  const lines = [
    JSON.stringify({ type: 'turn', turn_id: 't1', status: 'pending', role: 'assistant' }),
    JSON.stringify({ type: 'event', turn_id: 't1', seq: 1, kind: 'response_chunk', data: { chunk: 'Targeting:' } }),
    JSON.stringify({ role: 'user', content: 'question', ts: '2026-07-12T16:00:00.000Z' }),
    JSON.stringify({ role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1' }], ts: '2026-07-12T16:00:00.500Z' }),
    JSON.stringify({ role: 'assistant', content: full, ts: '2026-07-12T16:00:01.000Z' }),
    JSON.stringify({ type: 'turn', turn_id: 't1', status: 'complete', role: 'assistant' }),
  ];

  assert.deepEqual(parseConversationLines(lines, 100), [
    { role: 'user', content: 'question', timestamp: '2026-07-12T16:00:00.000Z' },
    { role: 'assistant', content: full, timestamp: '2026-07-12T16:00:01.000Z' },
  ]);
});
