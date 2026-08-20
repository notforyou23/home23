/**
 * Resident write guard — local house state is writable; tracked repo source is not.
 *
 * Chat-driven edit_file/write_file share the live checkout (usually main).
 * Without this, an agent can dirty portable source the same way Jerry did
 * with the SearXNG fallback. Gitignored paths (instances/, local config)
 * stay allowed.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export const TRACKED_SOURCE_REFUSED = 'tracked_source_refused';

export type ResidentWriteDecision =
  | { allow: true }
  | { allow: false; reason: string; code: typeof TRACKED_SOURCE_REFUSED };

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function canonicalize(declared: string): string {
  const normalized = path.resolve(declared);
  try {
    return realpathSync(normalized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let ancestor = normalized;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return normalized;
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  try {
    return path.join(realpathSync(ancestor), ...missing);
  } catch {
    return normalized;
  }
}

function resolveRepoRoot(projectRoot: string): string | null {
  if (!projectRoot) return null;
  const resolved = path.resolve(projectRoot);
  if (!existsSync(path.join(resolved, '.git'))) return null;
  try {
    return statSync(resolved).isDirectory() ? realpathSync(resolved) : path.dirname(realpathSync(resolved));
  } catch {
    return resolved;
  }
}

function isIgnored(repoRoot: string, target: string): boolean | null {
  const rel = path.relative(repoRoot, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    execFileSync('git', ['-C', repoRoot, 'check-ignore', '-q', '--', rel], {
      stdio: 'ignore',
      timeout: 3000,
    });
    return true;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) return false;
    return null;
  }
}

export function inspectResidentWrite(targetPath: string, projectRoot?: string): ResidentWriteDecision {
  if (!targetPath) {
    return { allow: false, reason: 'write refused: path must be a non-empty string', code: TRACKED_SOURCE_REFUSED };
  }

  let canonical: string;
  try {
    canonical = canonicalize(targetPath);
  } catch (error) {
    return {
      allow: false,
      reason: `write refused: ${error instanceof Error ? error.message : String(error)}`,
      code: TRACKED_SOURCE_REFUSED,
    };
  }

  const repoRoot = resolveRepoRoot(projectRoot ?? '');
  if (!repoRoot) return { allow: true };
  if (!isWithin(repoRoot, canonical)) return { allow: true };

  const gitDir = path.join(repoRoot, '.git');
  if (isWithin(gitDir, canonical) || canonical === gitDir) {
    return {
      allow: false,
      reason: `write refused: git metadata is not writable (${path.relative(repoRoot, canonical) || '.git'})`,
      code: TRACKED_SOURCE_REFUSED,
    };
  }

  const ignored = isIgnored(repoRoot, canonical);
  if (ignored === true) return { allow: true };
  if (ignored === null) {
    return {
      allow: false,
      reason: `write refused: could not classify ${path.relative(repoRoot, canonical)} against git ignore rules`,
      code: TRACKED_SOURCE_REFUSED,
    };
  }

  const rel = path.relative(repoRoot, canonical);
  return {
    allow: false,
    reason: `write refused: tracked repo source (${rel}). Change local house state (instances/, gitignored config such as home.yaml, targets.yaml, .env) or ask the operator to land this on a branch.`,
    code: TRACKED_SOURCE_REFUSED,
  };
}

export function refuseResidentWrite(targetPath: string, projectRoot?: string): { content: string; is_error: true; metadata: { code: typeof TRACKED_SOURCE_REFUSED } } | null {
  const decision = inspectResidentWrite(targetPath, projectRoot);
  if (decision.allow) return null;
  return {
    content: decision.reason,
    is_error: true,
    metadata: { code: decision.code },
  };
}
