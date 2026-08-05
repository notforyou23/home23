import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createCheckpoint,
  createJobWorktree,
  detectGitRepo,
  diffStat,
  removeWorktree,
  sanitizeSlug,
} from '../../src/acp/worktrees.js';

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
