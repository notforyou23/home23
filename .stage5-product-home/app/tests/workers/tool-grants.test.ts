import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createSeededToolRegistry, createToolRegistry, resolveWorkerTools } from '../../src/agent/tools/index.js';
import type { ToolContext } from '../../src/agent/types.js';

function workerCtx(workspacePath: string, chatId = 'worker:systems:wr_test'): ToolContext {
  return { chatId, workspacePath } as ToolContext;
}

test('worker tool grants resolve only enabled capability groups', () => {
  const tools = resolveWorkerTools({ shell: true, files: true, cron: false, brain: false, web: false });
  const names = tools.map(tool => tool.name);

  assert.deepEqual(names, ['shell', 'read_file', 'write_file', 'edit_file', 'list_files', 'search_files']);
  assert.equal(createSeededToolRegistry(tools).get('shell')?.name, 'shell');
  assert.equal(createSeededToolRegistry(tools).get('cron_list'), undefined);
});

test('worker tool grants reject unknown capability groups', () => {
  assert.throws(
    () => resolveWorkerTools({ shell: true, root_everything: true }),
    /Unknown worker tool grant group\(s\): root_everything/,
  );
});

test('seeded worker registry executes granted tools for worker chat ids', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'home23-worker-grants-'));
  const notePath = path.join(workspace, 'note.txt');
  writeFileSync(notePath, 'granted-worker-read');

  const registry = createSeededToolRegistry(resolveWorkerTools({ files: true }));
  const result = await registry.execute('read_file', { path: notePath }, workerCtx(workspace));

  assert.equal(result.is_error, undefined);
  assert.match(result.content, /granted-worker-read/);
});

test('seeded worker registry denies ungranted tools even for worker chat ids', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'home23-worker-deny-'));
  const registry = createSeededToolRegistry(resolveWorkerTools({ files: true }));

  assert.equal(registry.get('cron_list'), undefined);
  assert.equal(registry.get('shell'), undefined);

  const missing = await registry.execute('cron_list', {}, workerCtx(workspace));
  assert.equal(missing.is_error, true);
  assert.match(missing.content, /Unknown tool: cron_list/);
});

test('generic registry refuses worker chat ids before a granted-looking tool can run', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'home23-worker-generic-'));
  const notePath = path.join(workspace, 'secret.txt');
  writeFileSync(notePath, 'must-not-be-read');

  const generic = createToolRegistry();
  const refused = await generic.execute('read_file', { path: notePath }, workerCtx(workspace));

  assert.equal(refused.is_error, true);
  assert.match(refused.content, /refused: generic tool 'read_file' is unavailable to restricted chat 'worker:systems:wr_test'/);
  assert.doesNotMatch(refused.content, /must-not-be-read/);
});
