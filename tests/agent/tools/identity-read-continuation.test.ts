import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../../../src/agent/types.js';
import { selfReadTool } from '../../../src/agent/tools/identity.js';
import { ToolRegistry } from '../../../src/agent/tools/index.js';
import { taskContextTool } from '../../../src/agent/tools/task-context.js';
import { TaskContextStore } from '../../../src/agent/task-context.js';
import { executeAndFormatTool } from '../../../src/agent/tool-result.js';

function fixture(t: { after(fn: () => void): void }, content: string, options: { modelLimit?: number; eventLimit?: number; archive?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'self-read-continuation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspacePath = join(root, 'workspace'); mkdirSync(workspacePath);
  const file = 'CARRY_FORWARD.md'; const path = join(workspacePath, file); writeFileSync(path, content);
  const store = new TaskContextStore(join(root, 'context'));
  const context = { projectRoot: root, workspacePath, chatId: 'identity-reading',
    conversationHistory: { taskContext: store } } as unknown as ToolContext;
  const registry = new ToolRegistry(); registry.register(selfReadTool);
  if (options.archive !== false) registry.register(taskContextTool);
  let counter = 0;
  const read = (input: Record<string, unknown> = {}) => executeAndFormatTool({
    registry, name: 'self_read', toolCallId: `identity-reading-${++counter}`, input: { file, ...input }, context,
    modelLimit: options.modelLimit ?? 4000, eventLimit: options.eventLimit ?? 1000,
  });
  const archive = (id: string) => {
    let text = ''; let offset: number | null = 0;
    while (offset !== null) {
      const page = store.read(context.chatId, id, offset, 16000); text += page.text; offset = page.nextOffset;
    }
    return JSON.parse(text);
  };
  return { file, path, read, archive, store, context, registry };
}

function payload(modelContent: string) {
  return modelContent.split('\n\n[SELF_READ CONTINUES:')[0]!.split('\n[Retained task evidence:')[0]!;
}
function continuation(modelContent: string): Record<string, unknown> | null {
  const match = /Continue with self_read (\{[^\n]*\})\. This page is incomplete/.exec(modelContent);
  return match ? JSON.parse(match[1]!) : null;
}
async function reconstruct(f: ReturnType<typeof fixture>, source: string, input: Record<string, unknown> = {}) {
  let page = await f.read(input); let offset = Number(input.offset ?? 0); let text = ''; let count = 0;
  for (;;) {
    assert.equal(page.success, true);
    const visible = payload(page.modelContent);
    assert.equal(source.slice(offset, offset + visible.length), visible, 'model-visible source must be exact, including whitespace');
    assert.equal(Buffer.from(visible).toString('utf8'), visible, 'visible pages must contain complete Unicode code points');
    text += visible;
    const next = continuation(page.modelContent);
    count++;
    assert.ok(count < 500, 'paging must make progress');
    if (!next) {
      assert.equal(offset + visible.length, source.length, 'absence of continuation must mean actual EOF');
      break;
    }
    assert.equal(next.file, f.file);
    assert.equal(next.offset, offset + visible.length, 'continuation offset must follow displayed source rather than the undisplayed raw request');
    assert.ok(Number(next.offset) > offset, 'every nonfinal page advances');
    assert.doesNotMatch(page.modelContent, /last page|at EOF/i);
    offset = Number(next.offset);
    page = await f.read(next);
  }
  return { text, count };
}

const observed = '\n\n  # Carry forward\n' + 'Read all of the original qualifications. '.repeat(1500) + '\nEND_OF_ORIGINAL\n';

test('self_read default retains the complete original in raw task evidence', async t => {
  const f = fixture(t, observed);
  const first = await f.read();
  assert.equal(first.result.content, observed);
  assert.equal(f.archive(first.result.contextEvidenceId!).content, observed);
  assert.ok(continuation(first.modelContent), 'a bounded display needs a self_read continuation');
  assert.equal((await reconstruct(f, observed)).text, observed);
});

test('an explicit 8000-character request resumes from displayed characters without skipping its undisplayed suffix', async t => {
  const f = fixture(t, observed);
  const first = await f.read({ limit: 8000 });
  assert.equal(first.result.content, observed.slice(0, 8000));
  assert.equal(f.archive(first.result.contextEvidenceId!).content, observed.slice(0, 8000));
  const next = continuation(first.modelContent); assert.ok(next);
  assert.ok(Number(next.offset) < 8000, 'the old formatter skipped directly to the requested 8000');
  assert.equal((await reconstruct(f, observed, { limit: 8000 })).text, observed);
});

test('an explicit page that fits the display still continues while the original file has more source', async t => {
  const source = 'First source paragraph.\n'.repeat(130);
  const f = fixture(t, source);
  const first = await f.read({ limit: 200 });
  assert.ok(continuation(first.modelContent));
  assert.equal((await reconstruct(f, source, { limit: 200 })).text, source);
});

test('self_read-only grants can reconstruct Unicode and leading whitespace without read_file or task_context', async t => {
  const source = '\n\n  \t' + '🙂𝄞漢字e\u0301'.repeat(3500) + '\nComplete original tail.\n';
  const f = fixture(t, source, { archive: false });
  assert.equal(f.registry.get('read_file'), undefined); assert.equal(f.registry.get('task_context'), undefined);
  const first = await f.read();
  assert.doesNotMatch(first.modelContent, /Continue with read_file/);
  assert.equal((await reconstruct(f, source)).text, source);
});

test('small explicit Unicode pages keep whole surrogate pairs and exact continuation offsets', async t => {
  const source = '\n  ' + '🙂𝄞漢字e\u0301'.repeat(150) + '\n';
  const f = fixture(t, source, { archive: false });
  assert.equal((await reconstruct(f, source, { limit: 31 })).text, source);
});

test('nonzero offsets keep their absolute location through tighter model and event display caps', async t => {
  const f = fixture(t, observed, { modelLimit: 1000, eventLimit: 500 });
  const first = await f.read({ offset: 1234 });
  assert.ok(continuation(first.modelContent));
  assert.ok(first.eventContent.length <= 500);
  assert.equal(first.result.content, observed.slice(1234));
  assert.equal((await reconstruct(f, observed, { offset: 1234 })).text, observed.slice(1234));
});

test('the complete retained original remains recoverable after its source changes', async t => {
  const f = fixture(t, observed);
  const first = await f.read();
  writeFileSync(f.path, 'new source written after the read');
  assert.equal(f.archive(first.result.contextEvidenceId!).content, observed);
  let serialized = ''; let offset: number | null = 0;
  while (offset !== null) {
    const recovered = await executeAndFormatTool({ registry: f.registry, name: 'task_context', toolCallId: `recover-original-${offset}`,
      input: { action: 'read', id: first.result.contextEvidenceId, offset, limit: 16000 }, context: f.context, modelLimit: 4000, eventLimit: 1000 });
    const page = JSON.parse(recovered.modelContent);
    serialized += page.text; offset = page.nextOffset;
  }
  assert.equal(JSON.parse(serialized).content, observed, 'the actual retained-evidence tool recovers the original without rereading the changed file');
});

test('actual EOF and an empty source do not invent continuation or source text', async t => {
  for (const source of ['', '\n\n  a complete small note\n']) {
    const f = fixture(t, source);
    const first = await f.read();
    assert.equal(first.result.content, source);
    assert.equal(continuation(first.modelContent), null);
    const eof = await f.read({ offset: source.length });
    assert.equal(eof.result.content, ''); assert.equal(continuation(eof.modelContent), null);
  }
});

test('invalid character indexes fail clearly without coercing a different requested range', async t => {
  const f = fixture(t, observed);
  for (const input of [{ offset: -1 }, { offset: 0.5 }, { offset: NaN }, { offset: '1' }, { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: Infinity }]) {
    const result = await f.read(input);
    assert.equal(result.success, false, JSON.stringify(input));
    assert.match(result.result.content, /integer|offset|limit/i);
  }
});
