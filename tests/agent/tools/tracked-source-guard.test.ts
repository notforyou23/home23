import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { editFileTool, writeFileTool } from '../../../src/agent/tools/files.js';
import { extractShellWriteTargets, refuseShellWrite } from '../../../src/agent/tools/shell-write-guard.js';
import { inspectResidentWrite, TRACKED_SOURCE_REFUSED } from '../../../src/agent/tools/tracked-source-guard.js';
import { shellTool } from '../../../src/agent/tools/shell.js';
import type { ToolContext } from '../../../src/agent/types.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
}

function houseFixture() {
  const scratch = path.join(process.cwd(), 'tmp');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, 'home23-write-guard-'));
  git(root, ['init', '--template=', '-b', 'main']);
  git(root, ['config', 'user.email', 'guard@test']);
  git(root, ['config', 'user.name', 'Guard Test']);
  writeFileSync(path.join(root, '.gitignore'), [
    'instances/',
    'config/home.yaml',
    'config/targets.yaml',
    'engine/.env',
    '',
  ].join('\n'));
  mkdirSync(path.join(root, 'src/agent/tools'), { recursive: true });
  mkdirSync(path.join(root, 'instances/jerry/workspace'), { recursive: true });
  mkdirSync(path.join(root, 'config'), { recursive: true });
  mkdirSync(path.join(root, 'engine'), { recursive: true });
  writeFileSync(path.join(root, 'src/agent/tools/web.ts'), "const url = 'http://localhost:8888';\n");
  writeFileSync(path.join(root, 'instances/jerry/workspace/NOTE.md'), 'local\n');
  writeFileSync(path.join(root, 'config/home.yaml'), 'search: {}\n');
  writeFileSync(path.join(root, 'engine/.env'), 'SEARXNG_URL=http://localhost:8888\n');
  git(root, ['add', '.gitignore', 'src/agent/tools/web.ts']);
  git(root, ['commit', '-m', 'seed']);
  const ctx = {
    workspacePath: path.join(root, 'instances/jerry/workspace'),
    projectRoot: root,
  } as unknown as ToolContext;
  return { root, ctx };
}

test('live Home23 checkout refuses tracked source and allows ignored house files', () => {
  const root = process.cwd();
  assert.equal(inspectResidentWrite(path.join(root, 'src/agent/tools/web.ts'), root).allow, false);
  assert.equal(inspectResidentWrite(path.join(root, 'engine/.env'), root).allow, true);
  assert.equal(inspectResidentWrite(path.join(root, 'instances/jerry/workspace/NOTE.md'), root).allow, true);
  assert.equal(inspectResidentWrite(path.join(root, 'config/targets.yaml'), root).allow, true);
});

test('inspect allows gitignored house state and refuses tracked source', () => {
  const { root } = houseFixture();
  assert.equal(inspectResidentWrite(path.join(root, 'instances/jerry/workspace/NOTE.md'), root).allow, true);
  assert.equal(inspectResidentWrite(path.join(root, 'config/home.yaml'), root).allow, true);
  assert.equal(inspectResidentWrite(path.join(root, 'engine/.env'), root).allow, true);
  assert.equal(inspectResidentWrite(path.join(root, 'src/agent/tools/web.ts'), root).allow, false);
  assert.equal(inspectResidentWrite(path.join(root, 'src/agent/tools/new.ts'), root).allow, false);
  assert.equal(inspectResidentWrite(path.join(tmpdir(), 'outside.txt'), root).allow, true);
  assert.equal(inspectResidentWrite(path.join(root, 'src/agent/tools/web.ts'), '/tmp/not-a-repo').allow, true);
});

test('write_file and edit_file refuse tracked source without touching it', async () => {
  const { root, ctx } = houseFixture();
  const tracked = path.join(root, 'src/agent/tools/web.ts');
  const before = readFileSync(tracked, 'utf-8');

  const write = await writeFileTool.execute({ path: tracked, content: 'pwn\n' }, ctx);
  assert.equal(write.is_error, true);
  assert.equal(write.metadata?.code, TRACKED_SOURCE_REFUSED);
  assert.match(write.content, /tracked repo source/);
  assert.equal(readFileSync(tracked, 'utf-8'), before);

  const edit = await editFileTool.execute({
    path: tracked,
    old_string: 'http://localhost:8888',
    new_string: 'http://192.168.4.63:8888',
  }, ctx);
  assert.equal(edit.is_error, true);
  assert.equal(edit.metadata?.code, TRACKED_SOURCE_REFUSED);
  assert.equal(readFileSync(tracked, 'utf-8'), before);
});

test('write_file still updates local house state', async () => {
  const { root, ctx } = houseFixture();
  const envPath = path.join(root, 'engine/.env');
  const notePath = path.join(root, 'instances/jerry/workspace/NOTE.md');

  const env = await writeFileTool.execute({ path: envPath, content: 'SEARXNG_URL=http://192.168.4.63:8888\n' }, ctx);
  assert.equal(env.is_error, undefined, env.content);
  assert.match(readFileSync(envPath, 'utf-8'), /192\.168\.4\.63/);

  const note = await writeFileTool.execute({ path: notePath, content: 'updated\n' }, ctx);
  assert.equal(note.is_error, undefined, note.content);
  assert.equal(readFileSync(notePath, 'utf-8'), 'updated\n');
});

test('symlink from an ignored path into tracked source is refused', async () => {
  const { root, ctx } = houseFixture();
  const link = path.join(root, 'instances/jerry/workspace/web.ts');
  symlinkSync(path.join(root, 'src/agent/tools/web.ts'), link);
  const before = readFileSync(path.join(root, 'src/agent/tools/web.ts'), 'utf-8');
  const write = await writeFileTool.execute({ path: link, content: 'pwn\n' }, ctx);
  assert.equal(write.is_error, true);
  assert.equal(write.metadata?.code, TRACKED_SOURCE_REFUSED);
  assert.equal(readFileSync(path.join(root, 'src/agent/tools/web.ts'), 'utf-8'), before);
});

test('shell write detector extracts redirects and common write commands', () => {
  const { root } = houseFixture();
  const tracked = path.join(root, 'src/agent/tools/web.ts');
  const local = path.join(root, 'engine/.env');
  assert.deepEqual(extractShellWriteTargets(`echo hi > src/agent/tools/web.ts`, root), [tracked]);
  assert.deepEqual(extractShellWriteTargets(`echo hi >> "${local}"`, root), [local]);
  assert.deepEqual(extractShellWriteTargets(`sed -i '' 's/localhost/192.168.4.63/' src/agent/tools/web.ts`, root), [tracked]);
  assert.deepEqual(extractShellWriteTargets(`cp /tmp/x src/agent/tools/web.ts`, root), [tracked]);
  assert.deepEqual(extractShellWriteTargets(`python3 -c "open('src/agent/tools/web.ts','w').write('x')"`, root), [tracked]);
  assert.deepEqual(extractShellWriteTargets(`rg localhost src/agent/tools/web.ts`, root), []);
  assert.deepEqual(extractShellWriteTargets(`git diff src/agent/tools/web.ts`, root), []);
  assert.deepEqual(extractShellWriteTargets(`python3 -c "import json,sys; print(json.load(sys.stdin))"`, root), []);
  assert.equal(extractShellWriteTargets(`echo "note > src/agent/tools/web.ts"`, root).length, 0);
});

test('shell tool refuses tracked-source writes and allows local house writes', async () => {
  const { root, ctx } = houseFixture();
  const tracked = path.join(root, 'src/agent/tools/web.ts');
  const local = path.join(root, 'engine/.env');
  const before = readFileSync(tracked, 'utf-8');

  const refused = await shellTool.execute({ command: `echo pwn > src/agent/tools/web.ts`, cwd: root }, ctx);
  assert.equal(refused.is_error, true);
  assert.equal(refused.metadata?.code, TRACKED_SOURCE_REFUSED);
  assert.equal(readFileSync(tracked, 'utf-8'), before);

  const allowed = await shellTool.execute({ command: `printf 'SEARXNG_URL=http://192.168.4.63:8888\\n' > engine/.env`, cwd: root }, ctx);
  assert.equal(allowed.is_error, false, allowed.content);
  assert.match(readFileSync(local, 'utf-8'), /192\.168\.4\.63/);

  assert.equal(refuseShellWrite('rg localhost src/agent/tools/web.ts', root, root), null);
});
