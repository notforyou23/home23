import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { workspaceStatus, formatStatus } from '../../scripts/development/status.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23 workspace '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['backend', 'apple']) {
    const dir = path.join(root, name); fs.mkdirSync(dir);
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base']);
    execFileSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
  }
  return { root, backend: path.join(root, 'backend'), apple: path.join(root, 'apple') };
}

test('reports dirty source and independent main comparisons without altering files or HEAD', t => {
  const f = fixture(t);
  const draft = path.join(f.apple, 'unfinished.swift'); fs.writeFileSync(draft, 'keep my draft');
  const head = execFileSync('git', ['-C', f.apple, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const report = workspaceStatus(f);
  assert.equal(report.repositories.apple.changedFiles.length, 1);
  assert.deepEqual(report.repositories.backend.main, { ref: 'origin/main', localOnly: 0, remoteOnly: 0 });
  assert.equal(fs.readFileSync(draft, 'utf8'), 'keep my draft');
  assert.equal(execFileSync('git', ['-C', f.apple, 'rev-parse', 'HEAD'], { encoding: 'utf8' }), head);
  assert.match(formatStatus(report), /preserve 1/);
  assert.equal(report.runtime, null);
});

test('marks stale release baseline and mismatched phone selection without reading private state', t => {
  const f = fixture(t); const installation = path.join(f.root, 'live');
  const house = path.join(installation, 'instances/.house'); fs.mkdirSync(path.join(house, 'coordination'), { recursive: true });
  const write = (p, x) => fs.writeFileSync(path.join(house, p), JSON.stringify(x));
  write('coordination/active-release.json', { releaseId: 'new' });
  write('source-authority.json', { deployedReleaseId: 'old' });
  write('home23-ios.json', { installedBuild: 135, sourceRoot: '/different/source', receipt: '/private/receipt', secret: 'never-report' });
  const report = workspaceStatus({ ...f, installation });
  assert.equal(report.selected.phone.build, 135);
  assert.equal(report.concerns.length, 2);
  assert.ok(!JSON.stringify(report).includes('never-report'));
  assert.equal(report.selected.phone.evidence, 'installation record');
});

test('missing repository is unavailable rather than clean, and remote credentials are omitted', t => {
  const f = fixture(t);
  execFileSync('git', ['-C', f.backend, 'remote', 'add', 'origin', 'https://user:private-token@example.invalid/home23.git']);
  const report = workspaceStatus({ ...f, apple: path.join(f.root, 'absent') });
  assert.ok(report.repositories.apple.error);
  assert.equal(report.repositories.backend.remote, 'https://example.invalid/home23.git');
  assert.ok(!JSON.stringify(report).includes('private-token'));
});
