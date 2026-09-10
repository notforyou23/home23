import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  extractSimpleReadPathOperands,
  refuseShellFsAuthority,
  resolveShellFsAuthority,
  SHELL_FS_REFUSED,
} from '../../../src/agent/tools/shell-fs-authority.js';
import { shellTool } from '../../../src/agent/tools/shell.js';
import { readFileTool, refuseWorkspaceEscape, WORKSPACE_ESCAPE_REFUSED } from '../../../src/agent/tools/files.js';
import type { ToolContext } from '../../../src/agent/types.js';

const fixtures: string[] = [];
after(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
});

function makeTree() {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-shell-fs-'));
  fixtures.push(root);
  const projectRoot = path.join(root, 'home23');
  const instanceDir = path.join(projectRoot, 'instances', 'scout');
  const workspace = path.join(instanceDir, 'workspace');
  const sibling = path.join(root, 'sibling-home');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  writeFileSync(path.join(workspace, 'ok.txt'), 'inside\n');
  writeFileSync(path.join(sibling, 'private.txt'), 'private\n');
  return { root, projectRoot, instanceDir, workspace, sibling };
}

test('legacy config omission preserves full-machine access', () => {
  const { projectRoot, instanceDir } = makeTree();
  const auth = resolveShellFsAuthority(undefined, { projectRoot, instanceDir });
  assert.equal(auth.machineAccess, true);
  assert.deepEqual(auth.roots, []);
});

test('explicitly scoped homes default to projectRoot + instanceDir', () => {
  const { projectRoot, instanceDir } = makeTree();
  const auth = resolveShellFsAuthority({ machineAccess: false }, { projectRoot, instanceDir });
  assert.equal(auth.machineAccess, false);
  assert.deepEqual(auth.roots, [projectRoot, instanceDir].map((p) => realpathSync(p)));
});

test('extractSimpleReadPathOperands catches ls/cat path args', () => {
  const cwd = '/srv/home23';
  assert.deepEqual(
    extractSimpleReadPathOperands('ls /srv/sibling-home', cwd),
    ['/srv/sibling-home'],
  );
  assert.ok(
    extractSimpleReadPathOperands('cat ../sibling-home/private.txt', cwd).some((p) => p.includes('sibling-home')),
  );
});

test('shell refuses an ungranted sibling tree under scoped roots', async () => {
  const { projectRoot, instanceDir, sibling } = makeTree();
  const authority = resolveShellFsAuthority({ machineAccess: false }, { projectRoot, instanceDir });
  const ctx = {
    projectRoot,
    instanceDir,
    shellFsAuthority: authority,
    workspacePath: path.join(instanceDir, 'workspace'),
  } as unknown as ToolContext;

  const refused = await shellTool.execute({ command: `ls ${sibling}` }, ctx);
  assert.equal(refused.is_error, true);
  assert.equal(refused.metadata?.code, SHELL_FS_REFUSED);
  assert.match(refused.content, /outside granted roots|shell refused/i);

  const ok = await shellTool.execute({ command: 'ls', cwd: instanceDir }, ctx);
  assert.equal(Boolean(ok.is_error), false, ok.content);
});

test('shell refuses cwd outside roots; machineAccess allows a sibling tree', async () => {
  const { projectRoot, instanceDir, sibling } = makeTree();
  const limited = resolveShellFsAuthority({ machineAccess: false }, { projectRoot, instanceDir });
  const ctxLimited = {
    projectRoot,
    instanceDir,
    shellFsAuthority: limited,
    workspacePath: path.join(instanceDir, 'workspace'),
  } as unknown as ToolContext;
  const badCwd = await shellTool.execute({ command: 'pwd', cwd: sibling }, ctxLimited);
  assert.equal(badCwd.is_error, true);
  assert.equal(badCwd.metadata?.code, SHELL_FS_REFUSED);

  const open = resolveShellFsAuthority({ machineAccess: true }, { projectRoot, instanceDir });
  const ctxOpen = { ...ctxLimited, shellFsAuthority: open } as unknown as ToolContext;
  const allowed = refuseShellFsAuthority({ cwd: sibling, command: `ls ${sibling}`, authority: open });
  assert.equal(allowed, null);
  assert.equal(open.machineAccess, true);
});

test('read_file refuses sibling trees and symlink escape; write stays workspace-bound', async () => {
  const { projectRoot, instanceDir, workspace, sibling } = makeTree();
  const escapeLink = path.join(workspace, 'escape-sibling');
  symlinkSync(sibling, escapeLink);
  const authority = resolveShellFsAuthority({ machineAccess: false }, { projectRoot, instanceDir });
  const ctx = {
    projectRoot,
    instanceDir,
    shellFsAuthority: authority,
    workspacePath: workspace,
  } as unknown as ToolContext;

  const siblingRead = await readFileTool.execute({ path: path.join(sibling, 'private.txt') }, ctx);
  assert.equal(siblingRead.is_error, true);

  // Symlink that points outside workspace must fail write confinement
  const writeEscape = refuseWorkspaceEscape(path.join(escapeLink, 'planted.txt'), workspace, {
    allowMissingLeaf: true,
  });
  assert.ok(writeEscape);
  assert.equal(writeEscape?.metadata?.code, WORKSPACE_ESCAPE_REFUSED);

  // .. traversal outside workspace
  const traversal = refuseWorkspaceEscape(path.join(workspace, '..', '..', '..', 'sibling-home', 'x'), workspace, {
    allowMissingLeaf: true,
  });
  assert.ok(traversal);
  assert.equal(traversal?.metadata?.code, WORKSPACE_ESCAPE_REFUSED);
});
