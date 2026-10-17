import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeFileTool, editFileTool } from '../../../src/agent/tools/files.js';
import { shellTool } from '../../../src/agent/tools/shell.js';
import { compileProjectWriteRoots } from '../../../src/agent/tools/project-write-roots.js';
import type { ToolContext } from '../../../src/agent/types.js';

test('standing owner machine authority permits local repair through file and shell tools', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'home23-owner-machine-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'instances/scout/workspace');
  mkdirSync(workspace, { recursive: true });
  execFileSync('git', ['init', '--quiet', root]);
  const target = join(root, 'repair.mjs');
  writeFileSync(target, 'before\n');
  execFileSync('git', ['-C', root, 'add', 'repair.mjs']);
  const ctx = { projectRoot: root, workspacePath: workspace, fileMachineAccess: true } as unknown as ToolContext;
  const written = await writeFileTool.execute({ path: target, content: 'fixed\n' }, ctx);
  assert.equal(written.is_error, undefined, written.content);
  const edited = await editFileTool.execute({ path: target, old_string: 'fixed', new_string: 'verified' }, ctx);
  assert.equal(edited.is_error, undefined, edited.content);
  const command = await shellTool.execute({ command: "printf 'shell verified\\n' > repair.mjs", cwd: root }, ctx);
  assert.notEqual(command.is_error, true, command.content);
  assert.equal(readFileSync(target, 'utf8'), 'shell verified\n');
  const restricted = await writeFileTool.execute({ path: target, content: 'unauthorized' }, { ...ctx, fileMachineAccess: false });
  assert.equal(restricted.is_error, true);
  assert.equal(readFileSync(target, 'utf8'), 'shell verified\n');
});

test('machine access must be a boolean, never a truthy configuration accident', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'home23-machine-config-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const machineAccess of ['false', 'true', 1, null, {}]) {
    assert.throws(() => compileProjectWriteRoots({ machineAccess }, root), /machineAccess/);
  }
  assert.deepEqual(compileProjectWriteRoots({ machineAccess: true }, root), []);
  assert.deepEqual(compileProjectWriteRoots({ machineAccess: false }, root), []);
});
