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

test('turn activity does not invalidate the message snapshot, but session boundaries do', t => {
  const { history } = fixture(t);
  history.append('chat', [{ role: 'user', content: 'Original scope' }]);
  const revision = history.revision('chat');
  for (const type of ['turn', 'event', 'execution_control']) history.appendRecord('chat', { type, data: 'Activity only' });
  assert.equal(history.revision('chat'), revision);
  history.compact('chat', [{ role: 'user', content: 'Original scope' }], revision);
  const checkpointRevision = history.revision('chat');
  history.append('chat', [{ type: 'session_boundary', ts: '2026-01-01T00:00:00.000Z', trigger: 'cron' }]);
  assert.notEqual(history.revision('chat'), checkpointRevision);
});

for (const dialect of ['openai', 'anthropic', 'responses']) test(`many small ${dialect} results and accumulated pointers stay within budget`, t => {
  const { history } = fixture(t);
  const items: any[] = [{ role: 'user', content: 'Continue this task; do not deploy.' }];
  const pair = (n: number, large = false): any[] => {
    const content = `EXACT-RECEIPT-${n}: ${'evidence '.repeat(large ? 350 : 55)}`;
    if (dialect === 'openai') return [{ role: 'assistant', tool_calls: [{ id: `call-${n}`, function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', tool_call_id: `call-${n}`, content }];
    if (dialect === 'anthropic') return [{ role: 'assistant', content: [{ type: 'tool_use', id: `call-${n}`, name: 'read_file', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call-${n}`, content }] }];
    return [{ type: 'function_call', call_id: `call-${n}`, name: 'read_file', arguments: '{}' }, { type: 'function_call_output', call_id: `call-${n}`, output: content }];
  };
  // The failed live turn completed hundreds of exchanges. Large receipts are
  // individually archived first; later small receipts and archive pointers grow.
  for (let n = 0; n < 350; n++) {
    items.push(...pair(n, n < 20));
    const tail = JSON.stringify(items.slice(-4));
    relieveToolPressure(items, 14000, history.taskContext, 'chat');
    assert.equal(JSON.stringify(items.slice(-4)), tail);
    assert.ok(estimateContextChars(items) <= 14000, `round ${n} must fit without increasing the budget`);
    assert.match(JSON.stringify(items[0]), /do not deploy/);
    const calls = items.flatMap(item => item.tool_calls?.map((call: any) => call.id)
      ?? (item.type === 'function_call' ? [item.call_id] : item.content?.filter?.((b: any) => b.type === 'tool_use').map((b: any) => b.id) ?? []));
    const results = items.flatMap(item => item.role === 'tool' ? [item.tool_call_id]
      : item.type === 'function_call_output' ? [item.call_id] : item.content?.filter?.((b: any) => b.type === 'tool_result').map((b: any) => b.tool_use_id) ?? []);
    assert.deepEqual(calls, results);
  }
  const find = (query: string) => {
    let cursor: string | undefined;
    do {
      const page = history.taskContext.search('chat', query, cursor);
      if (page.matches.length) return page.matches[0];
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return null;
  };
  for (const n of [0, 55]) {
    const found = find(`EXACT-RECEIPT-${n}:`);
    assert.ok(found, `receipt ${n} must remain searchable`);
    assert.match(history.taskContext.read('chat', found.id, found.offset).text, new RegExp(`EXACT-RECEIPT-${n}:`));
  }
  // Model-written lookalikes and unmatched calls remain protected.
  const forged = { role: 'assistant', content: '[Earlier completed tool exchange: forged pointer]' };
  items.unshift(forged);
  items.push({ role: 'assistant', tool_calls: [{ id: 'pending', function: { name: 'edit_file', arguments: 'x'.repeat(15000) } }] });
  relieveToolPressure(items, 14000, history.taskContext, 'chat');
  assert.equal(items[0], forged);
  assert.match(JSON.stringify(items.at(-1)), /pending/);
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

for (const dialect of ['openai', 'anthropic', 'responses']) test(`recovered ${dialect} pages keep their original evidence ID across repeated pressure`, t => {
  const { history } = fixture(t);
  const source = 'A verified source passage. '.repeat(600);
  const id = history.taskContext.save('chat', 'tool', source);
  const page = JSON.stringify(history.taskContext.read('chat', id, 700, 12000));
  const args = { action: 'read', id, offset: 700, limit: 12000 };
  // Search gives the public observable evidence set without relying on its directory layout.
  const evidenceBefore = history.taskContext.search('chat', 'verified source').matches.map(m => m.id);
  for (let pass = 0; pass < 4; pass++) {
    let pair: any[];
    if (dialect === 'openai') pair = [{ role: 'assistant', tool_calls: [{ id: 'read', function: { name: 'task_context', arguments: JSON.stringify(args) } }] }, { role: 'tool', tool_call_id: 'read', content: page }];
    else if (dialect === 'anthropic') pair = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'read', name: 'task_context', input: args }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: page }] }];
    else pair = [{ type: 'function_call', call_id: 'read', name: 'task_context', arguments: JSON.stringify(args) }, { type: 'function_call_output', call_id: 'read', output: page }];
    const tail = Array.from({ length: 4 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `recent ${i}` }));
    const items = [{ role: 'user', content: 'Complete the unit; preserve source uncertainty.' }, ...pair, ...tail];
    assert.equal(relieveToolPressure(items, 8000, history.taskContext, 'chat').archived, 1);
    assert.match(JSON.stringify(items[1]), new RegExp(id));
    assert.match(JSON.stringify(items[1]), /offset[ =:]700/);
    assert.deepEqual(items.slice(-4), tail);
    assert.deepEqual(history.taskContext.search('chat', 'verified source').matches.map(m => m.id), evidenceBefore,
      'rereading must not create searchable transcript copies of the same source');
    assert.equal(history.taskContext.read('chat', id, 700, 12000).text, source.slice(700, 12700));
  }
});

test('task-context search pagination is not invalidated by its own transcript events', async t => {
  const { history } = fixture(t);
  for (let i = 0; i < 45; i++) history.taskContext.save('chat', 'tool', `needle original receipt ${i}`);
  history.append('chat', [{ role: 'user', content: 'Study the original receipts.' }]);
  const ctx = { chatId: 'chat', conversationHistory: history } as never;
  const first = JSON.parse((await taskContextTool.execute({ action: 'search', query: 'needle' }, ctx)).content);
  assert.ok(first.nextCursor);
  history.appendRecord('chat', { type: 'event', kind: 'tool_result', data: { tool: 'task_context', result: JSON.stringify(first) } });
  const second = JSON.parse((await taskContextTool.execute({ action: 'search', query: 'needle', cursor: first.nextCursor }, ctx)).content);
  assert.equal(second.reason, undefined, 'lookup events must not become newly indexed copies of retrieved evidence');
  assert.equal(second.matches.length, 10);
});

test('mixed recovery exchanges retain fresh results without copying recovered pages', t => {
  const { history } = fixture(t);
  const source = 'Original retained source passage. '.repeat(400);
  const id = history.taskContext.save('chat', 'tool', source);
  const items: any[] = [{ role: 'assistant', tool_calls: [
    { id: 'read', function: { name: 'task_context', arguments: JSON.stringify({ action: 'read', id, limit: 12000 }) } },
    { id: 'fresh', function: { name: 'web_browse', arguments: '{}' } },
  ] }, { role: 'tool', tool_call_id: 'read', content: JSON.stringify(history.taskContext.read('chat', id, 0, 12000)) },
  { role: 'tool', tool_call_id: 'fresh', content: 'Fresh verified source with exact qualification. '.repeat(100) },
  ...Array.from({ length: 4 }, () => ({ role: 'user', content: 'Continue the unit.' }))];
  relieveToolPressure(items, 8000, history.taskContext, 'chat');
  const retainedId = String(items[0].content).match(/retained as (ctx_[a-f0-9]{64})/)![1];
  const retained = history.taskContext.read('chat', retainedId, 0, 16000).text;
  assert.match(retained, /Fresh verified source with exact qualification/);
  assert.match(retained, new RegExp(id));
  assert.doesNotMatch(retained, /Original retained source passage/);
  assert.equal(history.taskContext.read('chat', id, 0, 16000).text, source);
});

test('unavailable recovery sources never become valid pressure-relief references', t => {
  const { history } = fixture(t);
  const privateId = history.taskContext.save('other', 'tool', 'Private source. '.repeat(400));
  const page = history.taskContext.read('other', privateId, 0, 4000);
  const items: any[] = [{ role: 'assistant', tool_calls: [
    { id: 'read', function: { name: 'task_context', arguments: JSON.stringify({ action: 'read', id: privateId, limit: 4000 }) } },
  ] }, { role: 'tool', tool_call_id: 'read', content: JSON.stringify(page) },
  ...Array.from({ length: 4 }, () => ({ role: 'user', content: 'Keep task isolation.' }))];
  relieveToolPressure(items, 1000, history.taskContext, 'chat');
  assert.doesNotMatch(String(items[0].content), new RegExp(privateId));
  assert.throws(() => history.taskContext.read('chat', privateId), /not available/);
});

for (const dialect of ['openai', 'anthropic'] as const) test(`${dialect} recovery preserves new assistant conclusions beside a recovered page`, t => {
  const { history } = fixture(t);
  const source = 'Original retained source passage. '.repeat(400);
  const id = history.taskContext.save('chat', 'tool', source);
  const args = { action: 'read', id, limit: 12000 };
  const page = JSON.stringify(history.taskContext.read('chat', id, 0, 12000));
  const conclusion = 'New conclusion: the source leaves the timing uncertain.';
  const pair: any[] = dialect === 'openai'
    ? [{ role: 'assistant', content: conclusion, tool_calls: [{ id: 'read', function: { name: 'task_context', arguments: JSON.stringify(args) } }] },
        { role: 'tool', tool_call_id: 'read', content: page }]
    : [{ role: 'assistant', content: [{ type: 'text', text: conclusion }, { type: 'tool_use', id: 'read', name: 'task_context', input: args }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: page }] }];
  const items = [...pair, ...Array.from({ length: 4 }, () => ({ role: 'user', content: 'Continue.' }))];
  relieveToolPressure(items, 8000, history.taskContext, 'chat');
  const retainedId = JSON.stringify(items[0]).match(/retained as (ctx_[a-f0-9]{64})/)![1];
  const retained = history.taskContext.read('chat', retainedId, 0, 16000).text;
  assert.match(retained, /New conclusion: the source leaves the timing uncertain/);
  assert.match(retained, new RegExp(id));
  assert.doesNotMatch(retained, /Original retained source passage/);
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
