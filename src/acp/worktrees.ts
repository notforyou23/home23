/**
 * Git worktree + checkpoint helpers for coding-job isolation (Step 29).
 *
 * Self-modification jobs against the live Home23 checkout run in a disposable
 * worktree under <repoRoot>/.home23-worktrees/ on a home23-agent/<slug>
 * branch — the live checkout is never touched, rollback is branch deletion.
 * In-place jobs in other repos get a checkpoint: `git stash create` mints a
 * dangling commit WITHOUT modifying the working tree, so pre-job state is
 * recoverable via `git stash apply <sha>`.
 *
 * All git invocations use execFileSync argv arrays — user input (slugs, paths)
 * is never shell-interpolated.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { CheckpointInfo, WorktreeInfo } from './types.js';

const SLUG_MAX = 40;
const DIFF_STAT_MAX = 2000;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function detectGitRepo(cwd: string): { repoRoot: string } | null {
  try {
    const root = git(cwd, ['rev-parse', '--show-toplevel']);
    return root ? { repoRoot: root } : null;
  } catch {
    return null;
  }
}

export function sanitizeSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return slug || 'job';
}

function branchExists(repoRoot: string, branch: string): boolean {
  try {
    git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export function createJobWorktree(opts: { repoRoot: string; slug: string }): WorktreeInfo {
  const baseDir = path.join(opts.repoRoot, '.home23-worktrees');
  mkdirSync(baseDir, { recursive: true });
  let slug = sanitizeSlug(opts.slug);
  if (branchExists(opts.repoRoot, `home23-agent/${slug}`) || existsSync(path.join(baseDir, slug))) {
    slug = `${slug.slice(0, SLUG_MAX - 5)}-${Math.random().toString(16).slice(2, 6).padEnd(4, '0')}`;
  }
  const branch = `home23-agent/${slug}`;
  const dir = path.join(baseDir, slug);
  const baseCommit = git(opts.repoRoot, ['rev-parse', 'HEAD']);
  git(opts.repoRoot, ['worktree', 'add', dir, '-b', branch]);
  return { repoRoot: opts.repoRoot, path: dir, branch, baseCommit };
}

/** Record recoverable pre-job state. NEVER modifies the working tree. */
export function createCheckpoint(repoRoot: string): CheckpointInfo {
  const headCommit = git(repoRoot, ['rev-parse', 'HEAD']);
  const status = git(repoRoot, ['status', '--porcelain']);
  const dirty = status.length > 0;
  const info: CheckpointInfo = { repoRoot, headCommit, dirty };
  if (dirty) {
    // `git stash create` can output nothing (e.g. only untracked files) — a
    // dirty tree with no stashable content simply gets no stashCommit.
    const stashCommit = git(repoRoot, ['stash', 'create']);
    if (stashCommit) info.stashCommit = stashCommit;
  }
  return info;
}

export function diffStat(cwd: string, baseCommit?: string): string | undefined {
  try {
    const diffArgs = baseCommit ? ['diff', '--stat', baseCommit] : ['diff', '--stat'];
    const stat = git(cwd, diffArgs);
    const porcelain = git(cwd, ['status', '--porcelain']).split('\n').slice(0, 20).join('\n');
    const combined = [stat, porcelain ? `status:\n${porcelain}` : ''].filter(Boolean).join('\n');
    if (!combined) return undefined;
    return combined.length <= DIFF_STAT_MAX ? combined : `${combined.slice(0, DIFF_STAT_MAX - 1)}…`;
  } catch {
    return undefined;
  }
}

export function removeWorktree(info: WorktreeInfo): void {
  git(info.repoRoot, ['worktree', 'remove', '--force', info.path]);
}
