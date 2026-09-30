import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileProjectWriteRoots } from '../../../src/agent/tools/project-write-roots.js';
import { loadConfig } from '../../../src/config.js';

function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'home23-project-roots-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const instance = join(root, 'instances/scout');
  for (const dir of ['projects/topic', 'conversations', 'brain']) mkdirSync(join(instance, dir), { recursive: true });
  mkdirSync(join(root, 'instances/.house/projects'), { recursive: true });
  mkdirSync(join(root, 'instances/forrest/projects'), { recursive: true });
  writeFileSync(join(instance, 'config.yaml'), '{}');
  return { root, instance };
}

test('project grants accept resident-wide or individual existing projects with relative denials', t => {
  const { instance } = fixture(t);
  assert.deepEqual(compileProjectWriteRoots({ projectWriteRoots: [{ path: 'projects', deny: ['projects/topic/bin'] }] }, instance),
    [{ path: join(instance, 'projects'), deny: [join(instance, 'projects/topic/bin')] }]);
  assert.deepEqual(compileProjectWriteRoots({ projectWriteRoots: [{ path: 'projects/topic' }] }, instance),
    [{ path: join(instance, 'projects/topic'), deny: [] }]);
  assert.deepEqual(compileProjectWriteRoots(undefined, instance), []);
});

test('project grants reject other resident state, house/foreign projects, missing roots and symlinks', t => {
  const { root, instance } = fixture(t);
  symlinkSync(join(instance, 'projects/topic'), join(instance, 'projects/link'));
  for (const path of ['.', 'conversations', 'config.yaml', 'brain', '../.house/projects', '../forrest/projects',
    'projects/missing', 'projects/link', join(root, 'instances/forrest/projects')]) {
    assert.throws(() => compileProjectWriteRoots({ projectWriteRoots: [{ path }] }, instance), /Invalid files.projectWriteRoots/, path);
  }
  rmSync(join(instance, 'projects'), { recursive: true });
  symlinkSync(join(root, 'instances/forrest/projects'), join(instance, 'projects'));
  assert.throws(() => compileProjectWriteRoots({ projectWriteRoots: [{ path: 'projects' }] }, instance), /symlink/);
});

test('malformed grants and denials fail closed', t => {
  const { instance } = fixture(t);
  for (const files of [null, [], { projectWriteRoots: 'projects' }, { projectWriteRoots: [null] },
    { projectWriteRoots: [{ path: '' }] }, { projectWriteRoots: [{ path: 'projects', deny: 'bin' }] },
    { projectWriteRoots: [{ path: 'projects', deny: ['conversations'] }] }]) {
    assert.throws(() => compileProjectWriteRoots(files, instance), /Invalid files.projectWriteRoots/);
  }
});

test('resident configuration loader rejects an invalid file grant before the resident starts', t => {
  const { root, instance } = fixture(t);
  mkdirSync(join(root, 'config'));
  writeFileSync(join(root, 'config/home.yaml'), 'chat:\n  identityFiles: []\n');
  writeFileSync(join(instance, 'config.yaml'), 'files:\n  projectWriteRoots:\n    - path: conversations\n');
  const prior = process.env.HOME23_ROOT;
  process.env.HOME23_ROOT = root;
  try {
    assert.throws(() => loadConfig('scout'), /Invalid files.projectWriteRoots/);
    writeFileSync(join(instance, 'config.yaml'), 'files:\n  projectWriteRoots:\n    - path: projects\n');
    assert.equal(loadConfig('scout').files?.projectWriteRoots?.[0]?.path, 'projects');
  } finally {
    if (prior === undefined) delete process.env.HOME23_ROOT; else process.env.HOME23_ROOT = prior;
  }
});
