import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  const keep = path.join(root, 'keep');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(keep, { recursive: true });
  writeFileSync(path.join(workspace, 'ok.txt'), 'inside\n');
  writeFileSync(path.join(keep, 'secret.txt'), 'keep-secret\n');
  return { root, projectRoot, instanceDir, workspace, keep };
}

test('default roots are projectRoot + instanceDir (not whole machine)', () => {
  const { projectRoot, instanceDir } = makeTree();
  const auth = resolveShellFsAuthority(null, { projectRoot, instanceDir });
  assert.equal(auth.machineAccess, false);
  assert.deepEqual(auth.roots, [projectRoot, instanceDir].map((p) => path.resolve(p)));
});

test('extractSimpleReadPathOperands catches ls/cat path args', () => {
  const cwd = '/home/box/home23-test';
  assert.deepEqual(
    extractSimpleReadPathOperands('ls /home/box/keep', cwd),
    ['/home/box/keep'],
  );
  assert.ok(
    extractSimpleReadPathOperands('cat ../../keep/secret.txt', cwd).some((p) => p.includes('keep')),
  );
});

test('shell refuses ls Keep under default roots', async () => {
  const { projectRoot, instanceDir, keep } = makeTree();
  const authority = resolveShellFsAuthority(null, { projectRoot, instanceDir });
  const ctx = {
    projectRoot,
    instanceDir,
    shellFsAuthority: authority,
    workspacePath: path.join(instanceDir, 'workspace'),
  } as unknown as ToolContext;

  const refused = await shellTool.execute({ command: `ls ${keep}` }, ctx);
  assert.equal(refused.is_error, true);
  assert.equal(refused.metadata?.code, SHELL_FS_REFUSED);
  assert.match(refused.content, /outside granted roots|shell refused/i);

  const ok = await shellTool.execute({ command: 'ls', cwd: instanceDir }, ctx);
  assert.equal(Boolean(ok.is_error), false, ok.content);
});

test('shell refuses cwd outside roots; machineAccess allows Keep', async () => {
  const { projectRoot, instanceDir, keep } = makeTree();
  const limited = resolveShellFsAuthority(null, { projectRoot, instanceDir });
  const ctxLimited = {
    projectRoot,
    instanceDir,
    shellFsAuthority: limited,
    workspacePath: path.join(instanceDir, 'workspace'),
  } as unknown as ToolContext;
  const badCwd = await shellTool.execute({ command: 'pwd', cwd: keep }, ctxLimited);
  assert.equal(badCwd.is_error, true);
  assert.equal(badCwd.metadata?.code, SHELL_FS_REFUSED);

  const open = resolveShellFsAuthority({ machineAccess: true }, { projectRoot, instanceDir });
  const ctxOpen = { ...ctxLimited, shellFsAuthority: open } as unknown as ToolContext;
  const allowed = refuseShellFsAuthority({ cwd: keep, command: `ls ${keep}`, authority: open });
  assert.equal(allowed, null);
  assert.equal(open.machineAccess, true);
});

test('read_file refuses Keep and symlink escape; write still workspace-bound', async () => {
  const { projectRoot, instanceDir, workspace, keep } = makeTree();
  const escapeLink = path.join(workspace, 'escape-keep');
  symlinkSync(keep, escapeLink);
  const authority = resolveShellFsAuthority(null, { projectRoot, instanceDir });
  const ctx = {
    projectRoot,
    instanceDir,
    shellFsAuthority: authority,
    workspacePath: workspace,
  } as unknown as ToolContext;

  const keepRead = await readFileTool.execute({ path: path.join(keep, 'secret.txt') }, ctx);
  assert.equal(keepRead.is_error, true);

  // Symlink that points outside workspace must fail write confinement
  const writeEscape = refuseWorkspaceEscape(path.join(escapeLink, 'planted.txt'), workspace, {
    allowMissingLeaf: true,
  });
  assert.ok(writeEscape);
  assert.equal(writeEscape?.metadata?.code, WORKSPACE_ESCAPE_REFUSED);

  // .. traversal outside workspace
  const traversal = refuseWorkspaceEscape(path.join(workspace, '..', '..', '..', 'keep', 'x'), workspace, {
    allowMissingLeaf: true,
  });
  assert.ok(traversal);
  assert.equal(traversal?.metadata?.code, WORKSPACE_ESCAPE_REFUSED);
});
