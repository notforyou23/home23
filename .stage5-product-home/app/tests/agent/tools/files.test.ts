import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

import {
  resolvePath,
  refuseWorkspaceEscape,
  readFileTool,
  writeFileTool,
  WORKSPACE_ESCAPE_REFUSED,
} from '../../../src/agent/tools/files.js';
import type { ToolContext } from '../../../src/agent/types.js';

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
