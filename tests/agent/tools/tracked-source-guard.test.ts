import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
const fixtures: string[] = [];
after(() => { for (const root of fixtures) rmSync(root, { recursive: true, force: true }); });

import { editFileTool, writeFileTool } from '../../../src/agent/tools/files.js';
import { extractShellWriteTargets, refuseShellWrite } from '../../../src/agent/tools/shell-write-guard.js';
import { inspectResidentWrite, TRACKED_SOURCE_REFUSED } from '../../../src/agent/tools/tracked-source-guard.js';
import { shellTool } from '../../../src/agent/tools/shell.js';
import type { ToolContext } from '../../../src/agent/types.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
}

function houseFixture() {
  const scratch = tmpdir();
  const root = mkdtempSync(path.join(scratch, 'home23-write-guard-'));
  fixtures.push(root);
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

test('selected Home23 checkout refuses tracked source and allows ignored house files', () => {
  const root = process.env.HOME23_TEST_PRIMARY_CHECKOUT ?? houseFixture().root;
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

  // Tracked source lives outside the resident workspace, so workspace
  // confinement refuses first. Tracked-source guard still covers in-workspace
  // edge cases (see symlink test / inspectResidentWrite).
  const write = await writeFileTool.execute({ path: tracked, content: 'pwn\n' }, ctx);
  assert.equal(write.is_error, true);
  assert.match(write.content, /escapes workspace|tracked repo source/);
  assert.equal(readFileSync(tracked, 'utf-8'), before);

  const edit = await editFileTool.execute({
    path: tracked,
    old_string: 'http://localhost:8888',
    new_string: 'http://192.168.4.63:8888',
  }, ctx);
  assert.equal(edit.is_error, true);
  assert.match(edit.content, /escapes workspace|tracked repo source/);
  assert.equal(readFileSync(tracked, 'utf-8'), before);
});

test('write_file updates workspace house state and refuses escapes', async () => {
  const { root, ctx } = houseFixture();
  const envPath = path.join(root, 'engine/.env');
  const notePath = path.join(root, 'instances/jerry/workspace/NOTE.md');
  const beforeEnv = readFileSync(envPath, 'utf-8');

  // Mutating file tools are workspace-confined; gitignored house files outside
  // the workspace stay writable via shell (still guarded for tracked source).
  const env = await writeFileTool.execute({ path: envPath, content: 'SEARXNG_URL=http://192.168.4.63:8888\n' }, ctx);
  assert.equal(env.is_error, true);
  assert.match(env.content, /escapes workspace/);
  assert.equal(readFileSync(envPath, 'utf-8'), beforeEnv);

  const escape = await writeFileTool.execute({ path: '/tmp/scout-escape-test.txt', content: 'nope\n' }, ctx);
  assert.equal(escape.is_error, true);
  assert.match(escape.content, /escapes workspace/);
  assert.equal(existsSync('/tmp/scout-escape-test.txt'), false);

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
  // Symlink realpath leaves the workspace, so confinement refuses first; tracked
  // source guard remains a second line of defense for non-escaping cases.
  assert.match(write.content, /escapes workspace|tracked repo source/);
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

test('shell write detector covers dd, curl, wget, ln, sort, tar, unzip', () => {
  const { root } = houseFixture();
  const tracked = path.join(root, 'src/agent/tools/web.ts');
  const trackedDir = path.join(root, 'src/agent/tools');
  assert.deepEqual(extractShellWriteTargets(`dd if=/dev/zero of=src/agent/tools/web.ts bs=1 count=1`, root), [tracked]);
  assert.deepEqual(extractShellWriteTargets(`curl -fsS https://example.com -o src/agent/tools/web.ts`, root), [tracked]);
  assert.deepEqual(extractShellWriteTargets(`curl https://example.com --output src/agent/tools/web.ts`, root), [tracked]);
  assert.deepEqual(extractShellWriteTargets(`wget https://example.com -O src/agent/tools/web.ts`, root), [tracked]);
  assert.deepEqual(extractShellWriteTargets(`ln -sf /tmp/x src/agent/tools/web.ts`, root), [tracked]);
  assert.deepEqual(extractShellWriteTargets(`sort /tmp/in -o src/agent/tools/web.ts`, root), [tracked]);
  assert.deepEqual(extractShellWriteTargets(`tar -xf archive.tar -C src/agent/tools`, root), [trackedDir]);
  assert.deepEqual(extractShellWriteTargets(`tar cf archive.tar -C src/agent/tools .`, root), [], 'create mode reads -C, does not write it');
  assert.deepEqual(extractShellWriteTargets(`unzip archive.zip -d src/agent/tools`, root), [trackedDir]);
  // split with only an input positional reads that file; it does not write it.
  assert.deepEqual(extractShellWriteTargets(`split src/agent/tools/web.ts`, root), []);
});

test('shell write detector reads a diff’s destinations for patch and git apply', () => {
  const { root } = houseFixture();
  const tracked = path.join(root, 'src/agent/tools/web.ts');
  const diffPath = path.join(root, 'fix.diff');
  writeFileSync(diffPath, [
    '--- a/src/agent/tools/web.ts',
    '+++ b/src/agent/tools/web.ts',
    '@@ -1 +1 @@',
    "-const url = 'http://localhost:8888';",
    "+const url = 'http://192.168.4.63:8888';",
    '',
  ].join('\n'));
  assert.deepEqual(extractShellWriteTargets(`git apply fix.diff`, root), [tracked]);
  assert.deepEqual(extractShellWriteTargets(`patch -p1 < fix.diff`, root), [tracked]);
  assert.deepEqual(extractShellWriteTargets(`git diff fix.diff`, root), [], 'git diff is read-only');
});

test('shell write detector does not scan heredoc bodies as shell syntax', () => {
  const { root } = houseFixture();
  const probe = path.join(root, 'probe.sh');
  const command = [
    `cat <<'EOF' > probe.sh`,
    'sample: echo hi > src/agent/tools/web.ts',
    'cp /tmp/x src/agent/tools/web.ts',
    'EOF',
  ].join('\n');
  assert.deepEqual(extractShellWriteTargets(command, root), [probe]);
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

test('refusal wording distinguishes tracked source from a new untracked file, and names the scratch path', () => {
  const { root } = houseFixture();
  const instanceDir = path.join(root, 'instances/jerry');

  const trackedDecision = inspectResidentWrite(path.join(root, 'src/agent/tools/web.ts'), root, instanceDir);
  assert.equal(trackedDecision.allow, false);
  assert.match((trackedDecision as { reason: string }).reason, /tracked repo source/);
  assert.match((trackedDecision as { reason: string }).reason, /coding_run/);

  const untrackedDecision = inspectResidentWrite(path.join(root, 'src/agent/tools/new.ts'), root, instanceDir);
  assert.equal(untrackedDecision.allow, false);
  assert.match((untrackedDecision as { reason: string }).reason, /untracked file in the working tree/);
  assert.match((untrackedDecision as { reason: string }).reason, /instances\/jerry\/scratch/);
  assert.doesNotMatch((untrackedDecision as { reason: string }).reason, /coding_run/);
});

test('house state under instances/ and tmp/ allows even when git is unusable', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-write-guard-broken-git-'));
  fixtures.push(root);
  // A .git directory that is not an actual repository: resolveRepoRoot only
  // checks for its existence, so every classification git call below fails.
  mkdirSync(path.join(root, '.git'));
  mkdirSync(path.join(root, 'instances/jerry/workspace'), { recursive: true });
  mkdirSync(path.join(root, 'tmp'), { recursive: true });
  mkdirSync(path.join(root, 'engine'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'instances/jerry/workspace/NOTE.md'), 'local\n');
  writeFileSync(path.join(root, 'tmp/scratch-file.txt'), 'x\n');
  writeFileSync(path.join(root, 'engine/.env'), 'SEARXNG_URL=http://localhost:8888\n');
  writeFileSync(path.join(root, 'src/new.ts'), 'x\n');

  // The static allowlist never touches git, so these stay allowed.
  assert.equal(inspectResidentWrite(path.join(root, 'instances/jerry/workspace/NOTE.md'), root).allow, true);
  assert.equal(inspectResidentWrite(path.join(root, 'tmp/scratch-file.txt'), root).allow, true);
  assert.equal(inspectResidentWrite(path.join(root, 'engine/.env'), root).allow, true);

  // A path outside the allowlist still needs git, and refuses (fails
  // closed) when git can't classify it — the pre-existing, still-correct
  // behavior for the long tail of paths not in the static allowlist.
  const outside = inspectResidentWrite(path.join(root, 'src/new.ts'), root);
  assert.equal(outside.allow, false);
  assert.match((outside as { reason: string }).reason, /could not classify/);
});
