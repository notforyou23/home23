import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationHistory } from '../../src/agent/history.js';
import { TaskContextStore } from '../../src/agent/task-context.js';
import { estimateContextChars, measureContextPressure } from '../../src/agent/context-pressure.js';
import { relieveToolPressure } from '../../src/agent/context-window.js';
import { taskContextTool } from '../../src/agent/tools/task-context.js';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'home23-task-context-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, history: new ConversationHistory(dir, 400000, 'test') };
}

test('compaction preserves canonical history, turn records, searchable evidence and reloadable active view', t => {
  const { dir, history } = fixture(t);
  history.append('chat', [{ role: 'user', content: 'Original constraint: do not deploy.' }, { role: 'assistant', content: 'Plan only.' }]);
  history.appendRecord('chat', { type: 'turn', id: 'turn-preserved' });
  const before = readFileSync(join(dir, 'test__chat.jsonl'), 'utf8');
  history.compact('chat', [{ role: 'user', content: 'Checkpoint' }, { role: 'assistant', content: 'Work pending.' }], history.revision('chat'));
  assert.equal(readFileSync(join(dir, 'test__chat.jsonl'), 'utf8'), before);
  assert.equal(history.loadRaw('chat').length, 3);
  history.append('chat', [{ role: 'user', content: 'Continue with the local check.' }]);
  const reopened = new ConversationHistory(dir, 400000, 'test');
  assert.deepEqual(reopened.load('chat').map((m: any) => m.content), ['Checkpoint', 'Work pending.', 'Continue with the local check.']);
  const results = reopened.taskContext.search('chat', 'do not deploy');
  assert.equal(results.matches.length, 1);
  assert.match(reopened.taskContext.read('chat', results.matches[0]!.id).text, /do not deploy/);
});

test('concurrent arrivals fence compaction rather than becoming invisible', t => {
  const { history } = fixture(t);
  history.append('chat', [{ role: 'user', content: 'Old request' }]);
  const revision = history.revision('chat');
  history.append('chat', [{ role: 'user', content: 'Stop now.' }]);
  assert.throws(() => history.compact('chat', [], revision), /changed during compaction/);
  assert.equal(history.load('chat').length, 2);
});

test('damaged checkpoint fails visibly without losing canonical evidence', t => {
  const { dir, history } = fixture(t);
  history.append('chat', [{ role: 'user', content: 'Keep this' }]);
  history.compact('chat', [{ role: 'user', content: 'Summary' }]);
  writeFileSync(join(dir, 'test__chat.jsonl.context.json'), '{}');
  assert.throws(() => history.load('chat'), /checkpoint/);
  assert.equal(history.loadRaw('chat').length, 1);
});

test('task notes and evidence cannot cross chat or reset boundaries', async t => {
  const { history } = fixture(t);
  const id = history.taskContext.save('a', 'tool', 'private result');
  history.taskContext.note('a', 'next', 'Verify the result', [id]);
  assert.throws(() => history.taskContext.read('b', id), /not available/);
  assert.throws(() => history.taskContext.read('a', '../../elsewhere'), /Invalid/);
  const result = await taskContextTool.execute({ action: 'read', id, chatId: 'a' }, { chatId: 'b', conversationHistory: history } as never);
  assert.equal(result.is_error, true);
  history.reset('a');
  assert.deepEqual(history.taskContext.notes('a'), []);
  assert.throws(() => history.taskContext.read('a', id), /not available/);
});

test('search is paginated and detects evidence changes between pages', t => {
  const { history } = fixture(t);
  for (let i = 0; i < 45; i++) history.taskContext.save('chat', 'tool', `needle result ${i}`);
  const first = history.taskContext.search('chat', 'needle');
  assert.equal(first.matches.length, 10);
  assert.equal(first.complete, false);
  assert.ok(first.nextCursor);
  const second = history.taskContext.search('chat', 'needle', first.nextCursor!);
  assert.equal(second.matches.length, 10);
  assert.ok(!second.matches.some(m => first.matches.some(first => first.id === m.id)));
  history.taskContext.save('chat', 'tool', 'new needle result');
  const stale = history.taskContext.search('chat', 'needle', first.nextCursor!);
  assert.equal(stale.complete, false);
  assert.match(stale.reason!, /changed/);
});

test('pressure accounts for instructions, tools, incoming text, output reserve and configured model limits', () => {
  const policy = { triggerThreshold: .8, targetFraction: .55, reserveChars: 8000, modelContextTokens: { 'test/small': 32000 } };
  const base = { historyChars: 50000, systemChars: 10000, toolSchemaChars: 10000, incomingChars: 1000, outputTokens: 4000, historyBudget: 400000, provider: 'test' };
  assert.equal(measureContextPressure(base, policy).shouldCompact, false);
  const small = measureContextPressure({ ...base, model: 'small' }, policy);
  assert.equal(small.shouldCompact, true);
  assert.equal(small.totalBudgetChars, 96000);
  assert.ok(small.targetHistoryChars < small.triggerChars);
  assert.equal(small.estimated, true);
});

for (const dialect of ['openai', 'anthropic', 'responses']) test(`tool growth preserves complete ${dialect} exchange evidence and recent tail`, t => {
  const { history } = fixture(t);
  const result = 'exact tool evidence '.repeat(2000);
  let pair: any[];
  if (dialect === 'openai') pair = [{ role: 'assistant', tool_calls: [{ id: 'one', function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'one', content: result }];
  else if (dialect === 'anthropic') pair = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'one', name: 'read_file', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', content: result }] }];
  else pair = [{ type: 'function_call', call_id: 'one', name: 'read_file', arguments: '{}' }, { type: 'function_call_output', call_id: 'one', output: result }];
  const tail = Array.from({ length: 4 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `recent ${i}` }));
  const items = [{ role: 'user', content: 'Only inspect; do not deploy.' }, ...pair, ...tail];
  const relief = relieveToolPressure(items, 16000, history.taskContext, 'chat');
  assert.equal(relief.archived, 1);
  assert.deepEqual(items.slice(-4), tail);
  assert.match(JSON.stringify(items[0]), /do not deploy/);
  const id = JSON.stringify(items[1]).match(/ctx_[a-f0-9]{64}/)![0];
  const page = history.taskContext.read('chat', id, 0, 16000);
  assert.match(page.text, /exact tool evidence/);
  assert.ok(page.nextOffset);
});

test('unmatched or current tool calls are never compacted away', t => {
  const { history } = fixture(t);
  const items = [{ role: 'assistant', tool_calls: [{ id: 'missing', function: { name: 'edit_file', arguments: 'x'.repeat(10000) } }] }, ...Array.from({ length: 5 }, () => ({ role: 'user', content: 'Protected' }))];
  const original = JSON.stringify(items);
  assert.equal(relieveToolPressure(items, 1000, history.taskContext, 'chat').archived, 0);
  assert.equal(JSON.stringify(items), original);
});


test('image transport size is excluded from the estimate without changing the image', () => {
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(2000000) } };
  const before = image.image_url.url;
  assert.ok(estimateContextChars([image]) < 17000);
  assert.equal(image.image_url.url, before);
});

test('reset also clears a checkpoint created before a canonical file exists', t => {
  const { history } = fixture(t);
  history.compact('empty', [{ role: 'user', content: 'stale checkpoint' }]);
  history.reset('empty');
  history.append('empty', [{ role: 'user', content: 'fresh request' }]);
  assert.deepEqual(history.load('empty').map((r: any) => r.content), ['fresh request']);
});

test('search cursor is bound to its query', t => {
  const { history } = fixture(t);
  for (let i = 0; i < 41; i++) history.taskContext.save('q', 'tool', `needle and other ${i}`);
  const page = history.taskContext.search('q', 'needle');
  assert.ok(page.nextCursor);
  const changed = history.taskContext.search('q', 'other', page.nextCursor!);
  assert.equal(changed.complete, false);
  assert.equal(changed.nextCursor, null);
  assert.match(changed.reason!, /query changed/);
});


test('malformed checkpoint records fail visibly instead of becoming an empty active history', t => {
  const { dir, history } = fixture(t);
  history.append('bad-record', [{ role: 'user', content: 'Original evidence' }]);
  history.compact('bad-record', [{ role: 'user', content: 'Valid checkpoint' }]);
  const file = join(dir, 'test__bad-record.jsonl.context.json');
  const checkpoint = JSON.parse(readFileSync(file, 'utf8'));
  checkpoint.records = [null];
  writeFileSync(file, JSON.stringify(checkpoint));
  assert.throws(() => history.load('bad-record'), /checkpoint/);
  assert.equal(history.loadRaw('bad-record').length, 1);
});
