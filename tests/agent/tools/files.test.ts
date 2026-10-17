import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test, after } from 'node:test';

import {
  resolvePath,
  refuseWorkspaceEscape,
  readFileTool,
  writeFileTool,
  WORKSPACE_ESCAPE_REFUSED,
} from '../../../src/agent/tools/files.js';
import * as fileTools from '../../../src/agent/tools/files.js';
import type { ToolContext } from '../../../src/agent/types.js';
import { compileProjectWriteRoots } from '../../../src/agent/tools/project-write-roots.js';
import { taskContextTool } from '../../../src/agent/tools/task-context.js';
import { ToolRegistry } from '../../../src/agent/tools/index.js';
import { TaskContextStore } from '../../../src/agent/task-context.js';
import { executeAndFormatTool } from '../../../src/agent/tool-result.js';

const execFileAsync = promisify(execFile);

const fixtures: string[] = [];
after(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
});

function makeWorkspace(): { root: string; workspace: string; ctx: ToolContext } {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-files-'));
  fixtures.push(root);
  const workspace = path.join(root, 'instances', 'scout', 'workspace');
  mkdirSync(path.join(workspace, 'stress'), { recursive: true });
  writeFileSync(path.join(workspace, 'stress', 'hello.mjs'), 'console.log("scout-ok");\n');
  const ctx = {
    workspacePath: workspace,
    projectRoot: root,
  } as unknown as ToolContext;
  return { root, workspace, ctx };
}

test('resolvePath strips redundant workspace/ prefix to avoid double-join', () => {
  const workspace = '/home/box/home23-test/instances/scout/workspace';
  assert.equal(
    resolvePath('workspace/stress/hello.mjs', workspace),
    path.join(workspace, 'stress/hello.mjs'),
  );
  assert.equal(
    resolvePath('stress/hello.mjs', workspace),
    path.join(workspace, 'stress/hello.mjs'),
  );
  // Basename match (same as workspace when basename is "workspace")
  assert.equal(
    resolvePath('workspace/foo.txt', workspace),
    path.join(workspace, 'foo.txt'),
  );
  // Absolute paths under workspace stay absolute
  assert.equal(
    resolvePath(path.join(workspace, 'stress/hello.mjs'), workspace),
    path.join(workspace, 'stress/hello.mjs'),
  );
  // Empty after strip → workspace root
  assert.equal(resolvePath('workspace', workspace), workspace);
  assert.equal(resolvePath('workspace/', workspace), workspace);
});

test('resolvePath strips first segment matching workspace basename', () => {
  const workspace = '/tmp/agent-home/sandbox';
  assert.equal(
    resolvePath('sandbox/notes/a.md', workspace),
    path.join(workspace, 'notes/a.md'),
  );
  assert.equal(
    resolvePath('notes/a.md', workspace),
    path.join(workspace, 'notes/a.md'),
  );
});

test('read_file succeeds for relative workspace/… paths after strip', async () => {
  const { ctx, workspace } = makeWorkspace();
  const result = await readFileTool.execute({ path: 'workspace/stress/hello.mjs' }, ctx);
  assert.equal(result.is_error, undefined, result.content);
  assert.match(result.content, /scout-ok/);
  // Sanity: the bogus double-join path must not be what we read
  assert.equal(existsSync(path.join(workspace, 'workspace', 'stress', 'hello.mjs')), false);
});

test('write_file refuses absolute paths outside the workspace', async () => {
  const { ctx } = makeWorkspace();
  const target = '/tmp/scout-escape2.txt';
  rmSync(target, { force: true });
  const result = await writeFileTool.execute({ path: target, content: 'escaped\n' }, ctx);
  assert.equal(result.is_error, true);
  assert.equal(result.metadata?.code, WORKSPACE_ESCAPE_REFUSED);
  assert.match(result.content, /escapes workspace/);
  assert.equal(existsSync(target), false);
});

test('write_file allows paths inside the workspace', async () => {
  const { ctx, workspace } = makeWorkspace();
  const rel = 'stress/ok.txt';
  const result = await writeFileTool.execute({ path: rel, content: 'inside\n' }, ctx);
  assert.equal(result.is_error, undefined, result.content);
  assert.equal(readFileSync(path.join(workspace, rel), 'utf-8'), 'inside\n');
});

test('write_file refuses symlink escape out of workspace', async () => {
  const { ctx, workspace, root } = makeWorkspace();
  const outside = path.join(root, 'outside.txt');
  writeFileSync(outside, 'safe\n');
  const link = path.join(workspace, 'escape.txt');
  symlinkSync(outside, link);
  const result = await writeFileTool.execute({ path: link, content: 'pwn\n' }, ctx);
  assert.equal(result.is_error, true);
  assert.equal(result.metadata?.code, WORKSPACE_ESCAPE_REFUSED);
  assert.equal(readFileSync(outside, 'utf-8'), 'safe\n');
});

test('refuseWorkspaceEscape helper rejects /tmp and accepts workspace files', () => {
  const { workspace } = makeWorkspace();
  const bad = refuseWorkspaceEscape('/tmp/nope.txt', workspace);
  assert.ok(bad);
  assert.equal(bad!.metadata?.code, WORKSPACE_ESCAPE_REFUSED);
  const good = refuseWorkspaceEscape(path.join(workspace, 'stress/hello.mjs'), workspace);
  assert.equal(good, null);
});

function makeProjectWorkspace() {
  const made = makeWorkspace();
  const instance = path.dirname(made.workspace);
  const projects = path.join(instance, 'projects');
  mkdirSync(path.join(projects, 'topic/bin'), { recursive: true });
  made.ctx.instanceDir = instance;
  made.ctx.projectWriteRoots = compileProjectWriteRoots({ projectWriteRoots: [
    { path: 'projects', deny: ['projects/topic/bin', 'projects/topic/HOLD.md'] },
    { path: 'projects/topic' },
  ] }, instance);
  return { ...made, instance, projects };
}

test('write_file and edit_file use an explicit resident project grant outside the current workspace', async () => {
  const { ctx, projects } = makeProjectWorkspace();
  const file = path.join(projects, 'topic/state/STATE.json');
  assert.equal((await writeFileTool.execute({ path: file, content: '{"active_topic":null}' }, ctx)).is_error, undefined);
  const edit = await fileTools.editFileTool.execute({ path: file, old_string: 'null', new_string: '"listening"' }, ctx);
  assert.equal(edit.is_error, undefined, edit.content);
  assert.equal(readFileSync(file, 'utf8'), '{"active_topic":"listening"}');
  ctx.projectWriteRoots = undefined;
  assert.equal((await writeFileTool.execute({ path: file, content: 'no grant' }, ctx)).is_error, true);
});

test('project denials precede all allow roots, including overlapping grants and symlink aliases', async () => {
  const { ctx, projects } = makeProjectWorkspace();
  const denied = path.join(projects, 'topic/bin/run.sh');
  writeFileSync(denied, 'protected');
  symlinkSync(path.join(projects, 'topic/bin'), path.join(projects, 'alias'));
  for (const file of [denied, path.join(projects, 'alias/run.sh'), path.join(projects, 'topic/HOLD.md')]) {
    const write = await writeFileTool.execute({ path: file, content: 'changed' }, ctx);
    assert.equal(write.is_error, true); assert.match(write.content, /denied project path/);
  }
  const edit = await fileTools.editFileTool.execute({ path: denied, old_string: 'protected', new_string: 'changed' }, ctx);
  assert.equal(edit.is_error, true);
  ctx.workspacePath = path.join(projects, 'topic/bin');
  assert.equal((await writeFileTool.execute({ path: 'run.sh', content: 'workspace bypass' }, ctx)).is_error, true);
  assert.equal(readFileSync(denied, 'utf8'), 'protected');
});

test('project writes refuse symlink escapes and traversal to other resident state', async () => {
  const { ctx, root, projects, instance } = makeProjectWorkspace();
  const outside = path.join(root, 'outside.txt');
  writeFileSync(outside, 'protected');
  symlinkSync(outside, path.join(projects, 'escape.txt'));
  for (const file of [path.join(projects, 'escape.txt'), path.join(projects, '../brain/private.md'),
    path.join(instance, '../forrest/projects/private.md')]) {
    const write = await writeFileTool.execute({ path: file, content: 'changed' }, ctx);
    assert.equal(write.is_error, true); assert.match(write.content, /allowed roots/);
  }
  assert.equal(readFileSync(outside, 'utf8'), 'protected');
});

test('project grants refuse relative instances paths instead of creating workspace shadow copies', async () => {
  const { ctx, workspace } = makeProjectWorkspace();
  for (const file of ['instances/scout/projects/topic/STATE.json', './instances/scout/projects/topic/STATE.json',
    'workspace/instances/scout/projects/topic/STATE.json']) {
    const write = await writeFileTool.execute({ path: file, content: 'shadow' }, ctx);
    assert.equal(write.is_error, true); assert.match(write.content, /shadow tree/);
  }
  assert.equal(existsSync(path.join(workspace, 'instances')), false);
  ctx.projectWriteRoots = undefined;
  const file = 'instances/scout/projects/topic/STATE.json';
  assert.equal((await writeFileTool.execute({ path: file, content: 'legacy workspace file' }, ctx)).is_error, undefined);
});

test('a compiled project grant fails closed if its root becomes a symlink', async () => {
  const { ctx, projects, root } = makeProjectWorkspace();
  const outside = path.join(root, 'other-projects');
  mkdirSync(outside);
  rmSync(projects, { recursive: true });
  symlinkSync(outside, projects);
  const result = await writeFileTool.execute({ path: path.join(projects, 'new.md'), content: 'changed' }, ctx);
  assert.equal(result.is_error, true); assert.match(result.content, /root changed|invalid project/);
  assert.equal(existsSync(path.join(outside, 'new.md')), false);
});

test('a dangling symlink in a project root cannot create a new file outside the grant', async () => {
  const { ctx, projects, root } = makeProjectWorkspace();
  const outside = path.join(root, 'not-created.md');
  const link = path.join(projects, 'dangling.md');
  symlinkSync(outside, link);
  const result = await writeFileTool.execute({ path: link, content: 'escaped' }, ctx);
  assert.equal(result.is_error, true); assert.equal(existsSync(outside), false);
});

// The Home23 Host runs residents with PATH = <home>/bin:<pm2 bin>:/usr/bin:/bin:/usr/sbin:/sbin,
// so an owner-installed (Homebrew) ripgrep is not on PATH.
const HOST_SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

async function withPath<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = value;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

function makeCurriculum() {
  const made = makeWorkspace();
  const gateA = path.join(made.workspace, 'curriculum', 'unit-a', 'QUALITY_GATE.json');
  const gateB = path.join(made.workspace, 'curriculum', 'unit-b', 'QUALITY_GATE.json');
  const notes = path.join(made.workspace, 'notes', 'publication.md');
  const vendored = path.join(made.workspace, 'node_modules', 'dep', 'package.json');
  for (const file of [gateA, gateB, notes, vendored]) mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(gateA, '{"quality_hold": false}\n');
  writeFileSync(gateB, '{"quality_hold": true}\n');
  writeFileSync(notes, 'publication_decision: publish\n');
  writeFileSync(vendored, '{"quality_hold": "vendored"}\n');
  return { ...made, gateA, gateB, notes, vendored };
}

test('search_files finds matches when ripgrep is not on the Host PATH', async () => {
  const { ctx, workspace, gateA, gateB, notes } = makeCurriculum();
  const result = await withPath(HOST_SYSTEM_PATH, () =>
    fileTools.searchFilesTool.execute({ pattern: 'quality_hold|publication_decision', path: workspace }, ctx));
  assert.equal(result.is_error, undefined, result.content);
  for (const file of [gateA, gateB, notes]) assert.ok(result.content.includes(file), `missing ${file} in:\n${result.content}`);
});

test('list_files finds nested files when ripgrep is not on the Host PATH', async () => {
  const { ctx, workspace, gateA, gateB } = makeCurriculum();
  const result = await withPath(HOST_SYSTEM_PATH, () =>
    fileTools.listFilesTool.execute({ pattern: 'curriculum/*/QUALITY_GATE.json', cwd: workspace }, ctx));
  assert.deepEqual(result.content.split('\n').filter(Boolean).sort(), [gateA, gateB].sort());
});

test('list_files matches a slash-free glob at any depth when ripgrep is not on the Host PATH', async () => {
  const { ctx, workspace, gateA, gateB } = makeCurriculum();
  const result = await withPath(HOST_SYSTEM_PATH, () =>
    fileTools.listFilesTool.execute({ pattern: '*.json', cwd: workspace }, ctx));
  for (const file of [gateA, gateB]) assert.ok(result.content.includes(file), `missing ${file} in:\n${result.content}`);
});

test('search_files never runs shell syntax found in the pattern', async () => {
  const { ctx, workspace, root } = makeCurriculum();
  const marker = path.join(root, 'pwned');
  for (const pattern of [`\`touch ${marker}\``, `$(touch ${marker})`]) {
    await withPath(HOST_SYSTEM_PATH, () => fileTools.searchFilesTool.execute({ pattern, path: workspace }, ctx));
  }
  assert.equal(existsSync(marker), false);
});

test('resolveRipgrep finds an executable rg on PATH or at an owner-install location, else null', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'home23-rg-'));
  fixtures.push(dir);
  const ownerRg = path.join(dir, 'owner', 'rg');
  const notExecutable = path.join(dir, 'plain', 'rg');
  mkdirSync(path.dirname(ownerRg), { recursive: true });
  mkdirSync(path.dirname(notExecutable), { recursive: true });
  writeFileSync(ownerRg, '#!/bin/sh\nexit 0\n');
  chmodSync(ownerRg, 0o755);
  writeFileSync(notExecutable, '#!/bin/sh\nexit 0\n');
  chmodSync(notExecutable, 0o644);
  const missing = path.join(dir, 'missing', 'rg');
  assert.equal(fileTools.resolveRipgrep(HOST_SYSTEM_PATH, [missing, ownerRg]), ownerRg);
  assert.equal(fileTools.resolveRipgrep(path.dirname(ownerRg), []), ownerRg);
  assert.equal(fileTools.resolveRipgrep(path.dirname(notExecutable), [missing]), null);
});

test('without ripgrep, the search command matches alternations and skips dependency trees', async () => {
  const { workspace, gateA, gateB, notes, vendored } = makeCurriculum();
  const command = fileTools.buildSearchCommand(null, 'quality_hold|publication_decision', workspace, undefined, 50);
  const { stdout } = await execFileAsync('/bin/bash', ['-c', command], { env: { ...process.env, PATH: HOST_SYSTEM_PATH } });
  for (const file of [gateA, gateB, notes]) assert.ok(stdout.includes(file), `missing ${file} in:\n${stdout}`);
  assert.equal(stdout.includes(vendored), false);
});

test('without ripgrep, the glob fallback lists files only, at any depth, without dependency trees, up to the limit', async () => {
  const { workspace, gateA, gateB } = makeCurriculum();
  assert.deepEqual((await fileTools.listFilesWithGlob('*.json', workspace, 200)).sort(), [gateA, gateB].sort());
  assert.deepEqual(await fileTools.listFilesWithGlob('curriculum/*', workspace, 200), []);
  assert.equal((await fileTools.listFilesWithGlob('**/*', workspace, 2)).length, 2);
});

test('without ripgrep, the glob fallback never lists outside its folder', async () => {
  const { workspace, root } = makeCurriculum();
  writeFileSync(path.join(root, 'outside.txt'), 'outside\n');
  for (const pattern of ['../*', '../../../*', `${root}/*`]) {
    assert.deepEqual(await fileTools.listFilesWithGlob(pattern, workspace, 200), [], pattern);
  }
});


function setupReadFileContinuation(t: { after(fn: () => void): void }, content: string) {
  const root = mkdtempSync(join(tmpdir(), 'home23-file-continuation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const file = join(workspace, 'synthesis.md'); writeFileSync(file, content);
  const store = new TaskContextStore(join(root, 'context'));
  const context = { projectRoot: root, workspacePath: workspace, chatId: 'fixture-reading',
    conversationHistory: { taskContext: store } } as unknown as ToolContext;
  const registry = new ToolRegistry(); registry.register(readFileTool); registry.register(taskContextTool);
  const read = (input: Record<string, unknown>) => executeAndFormatTool({ registry, name: 'read_file',
    toolCallId: 'file-reading-fixture', input: { path: file, ...input }, context, modelLimit: 4000, eventLimit: 4000 });
  return { file, store, context, registry, read };
}

function readFilePayload(modelContent: string) {
  return modelContent.split('\n\n[READ_FILE CONTINUES:')[0]!.split('\n[Retained task evidence:')[0]!;
}
function readFileContinuation(modelContent: string): Record<string, unknown> | null {
  const match = /Continue with read_file (\{[^\n]*\})\. This page is incomplete/.exec(modelContent);
  return match ? JSON.parse(match[1]!) : null;
}
function observedShape() {
  const lines = Array.from({ length: 85 }, (_, i) => `line-${String(i).padStart(2, '0')}: ${'x'.repeat(125)}`);
  lines[84] += 'x'.repeat(16);
  return lines.join('\n') + '\n';
}

test('the observed 11491-character synthesis retains complete task evidence and pages without false EOF', async t => {
  const content = observedShape(); assert.equal(content.length, 11_491); assert.equal(content.split('\n').length, 86);
  const { read, store, context } = setupReadFileContinuation(t, content);
  const first = await read({});
  assert.equal(first.result.content, content, 'read_file must retain the entire requested text before model display clipping');
  const archived = store.read(context.chatId, first.result.contextEvidenceId!, 0, 16000);
  assert.equal(JSON.parse(archived.text).content, content, 'task_context must recover the full file, not the clipped first page');
  assert.ok(readFileContinuation(first.modelContent), 'the model must receive a real next read, not offset=86 at EOF');
  let page = first; let reconstructed = ''; let reads = 0;
  for (;;) {
    reconstructed += readFilePayload(page.modelContent); reads++;
    const next = readFileContinuation(page.modelContent); if (!next) break;
    assert.ok(Number(next.offset_chars) < content.length, 'continuation cannot skip unread text to EOF');
    page = await read(next); assert.ok(reads < 20, 'continuation must advance');
  }
  assert.equal(reconstructed, content);
});

test('line-range reads continue inside their actual visible text and preserve the requested end', async t => {
  const content = observedShape(); const { read } = setupReadFileContinuation(t, content);
  const expected = content.split('\n').slice(33, 70).join('\n');
  let page = await read({ offset: 33, limit: 37 }); let reconstructed = '';
  for (let i = 0; i < 20; i++) {
    reconstructed += readFilePayload(page.modelContent);
    const next = readFileContinuation(page.modelContent); if (!next) break;
    assert.ok(Number(next.offset_chars) > content.indexOf('line-33:'));
    page = await read(next);
  }
  assert.equal(reconstructed, expected, 'paging must not include lines outside the original range');
});

test('one long Unicode line reconstructs exactly across model-cap continuations', async t => {
  const content = '🙂𝄞漢字e\u0301'.repeat(3000) + '\nlast line\n';
  const { read } = setupReadFileContinuation(t, content); let page = await read({}); let reconstructed = '';
  for (let i = 0; i < 100; i++) {
    const text = readFilePayload(page.modelContent);
    assert.doesNotMatch(text, /[\uD800-\uDBFF]$/u, 'a page must not end halfway through a surrogate pair');
    assert.equal(Buffer.from(text).toString('utf8'), text, 'each page must remain valid Unicode');
    reconstructed += text;
    const next = readFileContinuation(page.modelContent); if (!next) break;
    page = await read(next);
  }
  assert.equal(reconstructed, content, 'no Unicode characters or newlines may disappear between pages');
});

test('the model continuation survives a tighter loop display cap', async t => {
  const content = observedShape(); const { context, registry, file } = setupReadFileContinuation(t, content);
  const page = await executeAndFormatTool({ registry, name: 'read_file', toolCallId: 'small-loop-cap',
    input: { path: file }, context, modelLimit: 1000, eventLimit: 500 });
  const next = readFileContinuation(page.modelContent); assert.ok(next);
  assert.equal(content.slice(0, Number(next.offset_chars)), readFilePayload(page.modelContent));
  assert.ok(page.eventContent.length <= 500, 'event formatting must obey its own display size');
});

test('recovering complete retained file evidence bypasses display clipping without rereading the file', async t => {
  const content = observedShape(); const { read, file, context, registry } = setupReadFileContinuation(t, content);
  const first = await read({});
  // Recovery must use the original archived result, even if the path changes.
  writeFileSync(file, 'changed after the read');
  const recovered = await executeAndFormatTool({ registry, name: 'task_context', toolCallId: 'recover-file-fixture',
    input: { action: 'read', id: first.result.contextEvidenceId, limit: 16000 }, context, modelLimit: 4000, eventLimit: 4000 });
  const entry = JSON.parse(recovered.modelContent);
  assert.equal(JSON.parse(entry.text).content, content);
  assert.equal(entry.nextOffset, null, 'the complete synthesis should recover in one retained-evidence read');
});
