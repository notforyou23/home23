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
import { existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type {
  CheckpointInfo,
  DependencyProvisioning,
  DependencyTreeProvision,
  WorktreeInfo,
} from './types.js';

/** Documented default: root and engine dependency trees. Absent trees are skipped, not invented. */
export const DEFAULT_DEPENDENCY_TREES = ['node_modules', 'engine/node_modules'] as const;

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
  const dependencyProvisioning = provisionWorktreeDependencies(opts.repoRoot, dir);
  return { repoRoot: opts.repoRoot, path: dir, branch, baseCommit, dependencyProvisioning };
}

function execReason(err: unknown): string {
  if (err && typeof err === 'object') {
    const rec = err as { stderr?: unknown; message?: unknown };
    const stderr = typeof rec.stderr === 'string'
      ? rec.stderr.trim()
      : Buffer.isBuffer(rec.stderr)
        ? rec.stderr.toString('utf8').trim()
        : '';
    if (stderr) return stderr;
    if (typeof rec.message === 'string' && rec.message.trim()) return rec.message;
  }
  return String(err);
}

function lstatOrNull(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function provisionDependencyTree(repoRoot: string, worktreePath: string, rel: string): DependencyTreeProvision {
  const src = path.join(repoRoot, rel);
  const dest = path.join(worktreePath, rel);
  const srcStat = lstatOrNull(src);
  if (!srcStat) {
    return { path: rel, strategy: 'skipped', ok: false, reason: `source tree absent: ${rel}` };
  }
  if (srcStat.isSymbolicLink()) {
    return { path: rel, strategy: 'skipped', ok: false, reason: `source is a symbolic link: ${rel}` };
  }
  if (!srcStat.isDirectory()) {
    return { path: rel, strategy: 'skipped', ok: false, reason: `source is not a directory: ${rel}` };
  }
  const destStat = lstatOrNull(dest);
  if (destStat) {
    if (destStat.isSymbolicLink()) {
      return { path: rel, strategy: 'apfs-clonefile', ok: false, reason: `destination is a symbolic link: ${rel}` };
    }
    return { path: rel, strategy: 'apfs-clonefile', ok: false, reason: `destination already exists: ${rel}` };
  }
  try {
    execFileSync('cp', ['-Rc', src, dest], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const leftover = lstatOrNull(dest);
    if (leftover?.isSymbolicLink()) {
      try { unlinkSync(dest); } catch { /* still report the clone failure */ }
    }
    return { path: rel, strategy: 'apfs-clonefile', ok: false, reason: execReason(err) };
  }
  const after = lstatOrNull(dest);
  if (!after) {
    return { path: rel, strategy: 'apfs-clonefile', ok: false, reason: `clone reported success but destination is absent: ${rel}` };
  }
  if (after.isSymbolicLink()) {
    try {
      unlinkSync(dest);
    } catch (unlinkErr) {
      return {
        path: rel,
        strategy: 'apfs-clonefile',
        ok: false,
        reason: `clone produced a symlink at ${rel} and removal failed: ${execReason(unlinkErr)}`,
      };
    }
    return { path: rel, strategy: 'apfs-clonefile', ok: false, reason: `clone produced a symlink at ${rel}; removed` };
  }
  if (!after.isDirectory()) {
    return { path: rel, strategy: 'apfs-clonefile', ok: false, reason: `clone destination is not a directory: ${rel}` };
  }
  return { path: rel, strategy: 'apfs-clonefile', ok: true };
}

export function provisionWorktreeDependencies(repoRoot: string, worktreePath: string): DependencyProvisioning {
  const trees = DEFAULT_DEPENDENCY_TREES.map(rel => provisionDependencyTree(repoRoot, worktreePath, rel));
  return { trees, ok: trees.every(tree => tree.ok) };
}

/** Human-readable provisioning outcome. Returns undefined when the record is absent (unknown). */
export function formatDependencyProvisioning(info: Pick<WorktreeInfo, 'dependencyProvisioning'>): string | undefined {
  const record = info.dependencyProvisioning;
  if (!record) return undefined;
  const lines = [`Dependencies: ${record.ok ? 'provisioned' : 'not fully provisioned'}`];
  for (const tree of record.trees) {
    if (tree.ok) {
      lines.push(`- ${tree.path}: ${tree.strategy} ok`);
      continue;
    }
    if (tree.strategy === 'skipped') {
      lines.push(tree.reason ? `- ${tree.path}: skipped (${tree.reason})` : `- ${tree.path}: skipped`);
    } else {
      lines.push(tree.reason ? `- ${tree.path}: ${tree.strategy} failed (${tree.reason})` : `- ${tree.path}: ${tree.strategy} failed`);
    }
  }
  return lines.join('\n');
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

function restoreWritePermission(dir: string): void {
  const st = lstatOrNull(dir);
  if (!st) return;
  if (st.isSymbolicLink()) {
    throw new Error(`refusing to chmod through a symlink: ${dir}`);
  }
  if (!st.isDirectory()) return;
  try {
    execFileSync('chmod', ['-R', 'u+w', dir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(`could not restore write permissions on ${dir}: ${execReason(err)}`);
  }
}

export function removeWorktree(info: WorktreeInfo): void {
  try {
    if (info.dependencyProvisioning) {
      for (const tree of info.dependencyProvisioning.trees) {
        restoreWritePermission(path.join(info.path, tree.path));
      }
    }
    git(info.repoRoot, ['worktree', 'remove', '--force', info.path]);
  } catch (err) {
    throw new Error(`worktree teardown failed for ${info.path}: ${execReason(err)}`);
  }
}
