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
