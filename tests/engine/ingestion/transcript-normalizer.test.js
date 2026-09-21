import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeTranscript } = require('../../../engine/src/ingestion/transcript-normalizer.js');
const { DocumentChunker } = require('../../../engine/src/ingestion/document-chunker.js');

const dir = '/home/instances/jerry/workspace/sessions';
const backfill = (body) => `# Conversation Transcript (backfill)\n- **chatId:** x\n---\n- Operational event: response_chunk *(t)*\n\n${body}`;

test('cron run keeps only its final agent outcome', () => {
  const text = backfill([
    '## User *(t)*', '', 'Run the housekeeping script.', '',
    '## Assistant *(t)*', '', '[Used tools: shell]', 'shell: STDOUT: ok', '',
    '## Assistant *(t)*', '', 'Campaign sustained.', '- note: monitor scheduled', '',
  ].join('\n'));
  const result = normalizeTranscript(`${dir}/backfill-cron-agent-1.md`, text, { exists: () => false });
  assert.equal(result.action, 'ingest');
  assert.match(result.text, /Campaign sustained\.\n- note: monitor scheduled/);
  assert.doesNotMatch(result.text, /housekeeping|STDOUT|Operational event|Used tools/);
});

test('backfill is skipped when a live export of the same chat exists', () => {
  const result = normalizeTranscript(`${dir}/backfill-ios_abc.md`, backfill('## User *(t)*\n\nhi'), {
    exists: (candidate) => candidate === `${dir}/session-live-ios_abc.md`,
  });
  assert.deepEqual(result, { action: 'skip', reason: 'live export covers this chat' });
});

test('live session keeps dialogue and drops tool chatter; other files are untouched', () => {
  const text = '# Conversation Session (live)\n---\n**User:** Check sauna.\n**Agent:** [Used tools: read_file]\n**Agent:** Sauna is off.\n- Live: 176°F';
  const result = normalizeTranscript(`${dir}/session-live-ios_abc.md`, text);
  assert.equal(result.text, '# Conversation ios_abc\n\nUser: Check sauna.\n\nAgent: Sauna is off.\n- Live: 176°F');
  assert.deepEqual(normalizeTranscript('/home/instances/jerry/workspace/docs/a.md', text), { action: 'unchanged' });
});

test('chunker merges small blocks without losing, reordering, or crossing code fences', () => {
  const doc = '# Title\n\nShort intro.\n\n## Part\n\nOne line.\n\n```js\nconst x = 1;\n```\n\n' + 'Long paragraph. '.repeat(40) + '\n\nTail.';
  const { chunks } = new DocumentChunker({}).chunk(doc);
  const words = (value) => value.replace(/[#`\s]+/g, ' ').trim();
  assert.equal(words(chunks.map((chunk) => chunk.text).join(' ')), words(doc));
  assert.ok(chunks.some((chunk) => chunk.type === 'code' && chunk.text.trim().startsWith('```')));
  assert.ok(chunks.length < 6, `expected merged chunks, got ${chunks.length}`);
});
