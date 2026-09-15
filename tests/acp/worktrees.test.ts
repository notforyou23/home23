import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createCheckpoint,
  createJobWorktree,
  detectGitRepo,
  diffStat,
  formatDependencyProvisioning,
  removeWorktree,
  sanitizeSlug,
} from '../../src/acp/worktrees.js';
import type { WorktreeInfo } from '../../src/acp/types.js';

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'home23-acp-repo-')));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@home23.local']);
  git(dir, ['config', 'user.name', 'Home23 Test']);
  writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function seedDependencyTree(repo: string, rel: string, mode?: number): void {
  const dir = path.join(repo, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '.home23-dep-marker'), `${rel}\n`);
  if (mode !== undefined) chmodSync(dir, mode);
}

function restoreWritable(dir: string): void {
  try {
    execFileSync('chmod', ['-R', 'u+w', dir], { stdio: 'ignore' });
  } catch {
    /* test cleanup only */
  }
}

function treeRecord(info: WorktreeInfo, rel: string) {
  const rec = info.dependencyProvisioning?.trees.find(t => t.path === rel);
  assert.ok(rec, `missing dependency-provisioning record for ${rel}`);
  return rec;
}

test('sanitizeSlug bounds and normalizes', () => {
  assert.equal(sanitizeSlug('Fix The BUG!! now'), 'fix-the-bug-now');
  assert.equal(sanitizeSlug('___'), 'job');
  assert.ok(sanitizeSlug('x'.repeat(120)).length <= 40);
  assert.equal(sanitizeSlug('--edge--'), 'edge');
});

test('detectGitRepo finds the repo root and returns null outside repos', (t) => {
  if (!gitAvailable()) return t.skip('git unavailable');
  const repo = makeRepo();
  const plain = mkdtempSync(path.join(tmpdir(), 'home23-acp-norepo-'));
  try {
    const sub = path.join(repo, 'src');
    execFileSync('mkdir', ['-p', sub]);
    assert.equal(detectGitRepo(repo)?.repoRoot, repo);
    assert.equal(detectGitRepo(sub)?.repoRoot, repo);
    // A bare temp dir is not a repo (guard against test env nesting surprises).
    const detected = detectGitRepo(plain);
    if (detected) assert.notEqual(detected.repoRoot, repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

test('createJobWorktree creates branch + dir from HEAD; removeWorktree cleans up', (t) => {
  if (!gitAvailable()) return t.skip('git unavailable');
  const repo = makeRepo();
  try {
    const head = git(repo, ['rev-parse', 'HEAD']);
    const info = createJobWorktree({ repoRoot: repo, slug: 'Test Job!' });
    assert.equal(info.repoRoot, repo);
    assert.equal(info.branch, 'home23-agent/test-job');
    assert.equal(info.baseCommit, head);
    assert.ok(info.path.startsWith(path.join(repo, '.home23-worktrees')));
    assert.ok(existsSync(path.join(info.path, 'README.md')));
    assert.equal(git(repo, ['rev-parse', `refs/heads/${info.branch}`]), head);

    // Same slug again gets uniquified rather than colliding.
    const second = createJobWorktree({ repoRoot: repo, slug: 'Test Job!' });
    assert.notEqual(second.branch, info.branch);
    assert.match(second.branch, /^home23-agent\/test-job-[0-9a-f]{4}$/);

    removeWorktree(info);
    assert.equal(existsSync(info.path), false);
    removeWorktree(second);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('createCheckpoint records state without touching the working tree', (t) => {
  if (!gitAvailable()) return t.skip('git unavailable');
  const repo = makeRepo();
  try {
    const clean = createCheckpoint(repo);
    assert.equal(clean.dirty, false);
    assert.equal(clean.stashCommit, undefined);
    assert.equal(clean.headCommit, git(repo, ['rev-parse', 'HEAD']));

    writeFileSync(path.join(repo, 'README.md'), 'hello\nmodified\n');
    const before = git(repo, ['status', '--porcelain']);
    const dirty = createCheckpoint(repo);
    assert.equal(dirty.dirty, true);
    assert.ok(dirty.stashCommit && dirty.stashCommit.length >= 7, 'stashCommit populated on dirty tree');
    // Working tree untouched: same porcelain status, same file content on disk.
    assert.equal(git(repo, ['status', '--porcelain']), before);
    assert.match(git(repo, ['diff']), /modified/);
    // The stash commit is a real recoverable object.
    assert.equal(git(repo, ['cat-file', '-t', dirty.stashCommit!]), 'commit');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('diffStat summarizes changes and returns undefined outside git', (t) => {
  if (!gitAvailable()) return t.skip('git unavailable');
  const repo = makeRepo();
  const plain = mkdtempSync(path.join(tmpdir(), 'home23-acp-norepo-'));
  try {
    const base = git(repo, ['rev-parse', 'HEAD']);
    writeFileSync(path.join(repo, 'README.md'), 'hello\nchanged\n');
    const stat = diffStat(repo, base);
    assert.ok(stat);
    assert.match(stat!, /README\.md/);
    assert.match(stat!, /status:/);

    // In a worktree, diff against baseCommit reflects the job's commits/edits.
    const info = createJobWorktree({ repoRoot: repo, slug: 'stat-check' });
    writeFileSync(path.join(info.path, 'new-file.txt'), 'added\n');
    git(info.path, ['add', '.']);
    git(info.path, ['commit', '-q', '-m', 'job work']);
    const wtStat = diffStat(info.path, info.baseCommit);
    assert.match(wtStat!, /new-file\.txt/);
    removeWorktree(info);

    if (!detectGitRepo(plain)) assert.equal(diffStat(plain), undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

test('formatDependencyProvisioning leaves a missing record as unknown', () => {
  const info: WorktreeInfo = {
    repoRoot: '/tmp/repo',
    path: '/tmp/repo/.home23-worktrees/job',
    branch: 'home23-agent/job',
    baseCommit: 'abc',
  };
  assert.equal(formatDependencyProvisioning(info), undefined);
});

test('createJobWorktree clones present dependency trees and records a real directory, not a symlink', (t) => {
  if (!gitAvailable()) return t.skip('git unavailable');
  const repo = makeRepo();
  try {
    mkdirSync(path.join(repo, 'engine'), { recursive: true });
    writeFileSync(path.join(repo, 'engine', '.gitkeep'), '');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'engine dir']);
    seedDependencyTree(repo, 'node_modules');
    seedDependencyTree(repo, 'engine/node_modules');

    const info = createJobWorktree({ repoRoot: repo, slug: 'deps-present' });
    const rootDest = path.join(info.path, 'node_modules');
    const engineDest = path.join(info.path, 'engine', 'node_modules');
    const rootStat = lstatSync(rootDest);
    const engineStat = lstatSync(engineDest);
    assert.equal(rootStat.isSymbolicLink(), false);
    assert.equal(engineStat.isSymbolicLink(), false);
    assert.equal(rootStat.isDirectory(), true);
    assert.equal(engineStat.isDirectory(), true);
    assert.equal(existsSync(path.join(rootDest, '.home23-dep-marker')), true);
    assert.equal(existsSync(path.join(engineDest, '.home23-dep-marker')), true);

    const record = info.dependencyProvisioning;
    assert.ok(record);
    const rootTree = treeRecord(info, 'node_modules');
    const engineTree = treeRecord(info, 'engine/node_modules');
    assert.equal(rootTree.strategy, 'apfs-clonefile');
    assert.equal(rootTree.ok, true);
    assert.equal(rootTree.reason, undefined);
    assert.equal(engineTree.strategy, 'apfs-clonefile');
    assert.equal(engineTree.ok, true);
    assert.equal(engineTree.reason, undefined);
    assert.equal(record.ok, true);

    const text = formatDependencyProvisioning(info);
    assert.ok(text);
    assert.match(text, /node_modules/);
    assert.match(text, /apfs-clonefile/);

    removeWorktree(info);
    assert.equal(existsSync(info.path), false);
  } finally {
    restoreWritable(path.join(repo, 'node_modules'));
    restoreWritable(path.join(repo, 'engine', 'node_modules'));
    rmSync(repo, { recursive: true, force: true });
  }
});

test('createJobWorktree skips absent dependency trees with a recorded reason, not a fake success', (t) => {
  if (!gitAvailable()) return t.skip('git unavailable');
  const repo = makeRepo();
  try {
    const info = createJobWorktree({ repoRoot: repo, slug: 'deps-absent' });
    assert.equal(existsSync(path.join(info.path, 'node_modules')), false);
    assert.equal(existsSync(path.join(info.path, 'engine', 'node_modules')), false);

    const record = info.dependencyProvisioning;
    assert.ok(record);
    const rootTree = treeRecord(info, 'node_modules');
    const engineTree = treeRecord(info, 'engine/node_modules');
    assert.equal(rootTree.ok, false);
    assert.equal(rootTree.strategy, 'skipped');
    assert.ok(rootTree.reason);
    assert.match(rootTree.reason, /absent/i);
    assert.equal(engineTree.ok, false);
    assert.equal(engineTree.strategy, 'skipped');
    assert.ok(engineTree.reason);
    assert.match(engineTree.reason, /absent/i);
    assert.equal(record.ok, false);

    const text = formatDependencyProvisioning(info);
    assert.ok(text);
    assert.match(text, /skipped/);
    assert.match(text, /node_modules/);

    removeWorktree(info);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a clone failure records ok:false with a reason and never produces a symlink', (t) => {
  if (!gitAvailable()) return t.skip('git unavailable');
  const repo = makeRepo();
  try {
    // Source exists in the main checkout but `engine/` is untracked, so the
    // worktree has no parent directory for dest. cp -Rc must fail closed.
    seedDependencyTree(repo, 'engine/node_modules');
    const info = createJobWorktree({ repoRoot: repo, slug: 'deps-clone-fail' });
    const dest = path.join(info.path, 'engine', 'node_modules');
    if (existsSync(dest)) {
      assert.equal(lstatSync(dest).isSymbolicLink(), false);
    }

    const engineTree = treeRecord(info, 'engine/node_modules');
    assert.equal(engineTree.ok, false);
    assert.equal(engineTree.strategy, 'apfs-clonefile');
    assert.ok(engineTree.reason);
    assert.notEqual(engineTree.reason.trim(), '');
    assert.equal(info.dependencyProvisioning?.ok, false);

    const text = formatDependencyProvisioning(info);
    assert.ok(text);
    assert.match(text, /engine\/node_modules/);
    assert.doesNotMatch(text, /symlink/i);

    removeWorktree(info);
  } finally {
    restoreWritable(path.join(repo, 'engine', 'node_modules'));
    rmSync(repo, { recursive: true, force: true });
  }
});

test('removeWorktree tears down a read-only provisioned dependency tree', (t) => {
  if (!gitAvailable()) return t.skip('git unavailable');
  const repo = makeRepo();
  try {
    seedDependencyTree(repo, 'node_modules', 0o555);
    const info = createJobWorktree({ repoRoot: repo, slug: 'deps-readonly' });
    const dest = path.join(info.path, 'node_modules');
    assert.equal(lstatSync(dest).isDirectory(), true);
    chmodSync(dest, 0o555);
    removeWorktree(info);
    assert.equal(existsSync(info.path), false);
  } finally {
    restoreWritable(path.join(repo, 'node_modules'));
    rmSync(repo, { recursive: true, force: true });
  }
});
