/**
 * Resident write guard — local house state is writable; tracked repo source is not.
 *
 * Chat-driven edit_file/write_file share the live checkout (usually main).
 * Without this, an agent can dirty portable source the same way Jerry did
 * with the SearXNG fallback. Gitignored paths (instances/, local config)
 * stay allowed.
 *
 * The static allowlist below decides allow/refuse for the destinations that
 * matter most (house state under instances/, the scratch area under tmp/,
 * and the handful of named local configs) without ever calling git. That is
 * deliberate: a resident's own brain and receipts must stay writable even
 * when git is unhealthy (slow disk, box under load) — the exact moment a
 * resident is most likely to need to write one. Git is only consulted for
 * paths outside that allowlist, and only to classify tracked vs. merely
 * untracked-and-visible for the refusal wording; it never turns a refuse
 * into an allow or vice versa.
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

// ─── Static house-state allowlist (no git involved) ────────────────────────

/** Exact repo-relative files that are house-local even though they sit
 * outside instances/ (generated local config; see .gitignore / CLAUDE.md
 * "Local State Boundary"). Keep this list small and named — it is a fast
 * path for known destinations, not a general ignore-rule mirror. Anything
 * not listed here still gets the normal (git-backed) classification below. */
const NAMED_HOUSE_FILES = new Set(['config/home.yaml', 'config/targets.yaml', 'engine/.env']);

function isStaticHouseState(repoRoot: string, canonical: string, rel: string): boolean {
  if (isWithin(path.join(repoRoot, 'instances'), canonical)) return true;
  if (isWithin(path.join(repoRoot, 'tmp'), canonical)) return true;
  return NAMED_HOUSE_FILES.has(rel.split(path.sep).join('/'));
}

// ─── Bounded per-process classification cache ──────────────────────────────
//
// Refusing a shell command extracts multiple targets (e.g. `cp a b`), and
// nearby tool calls in the same turn often probe the same path more than
// once. Cache definitive git classifications to avoid a subprocess per
// lookup; never cache a failure (null), so a transient git problem heals
// itself on the next call instead of being pinned for the process lifetime.
const CLASSIFY_CACHE_LIMIT = 500;

function cached(cache: Map<string, boolean | null>, key: string, compute: () => boolean | null): boolean | null {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = compute();
  if (value !== null) {
    if (cache.size >= CLASSIFY_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
  }
  return value;
}

const ignoredCache = new Map<string, boolean | null>();

function isIgnored(repoRoot: string, target: string): boolean | null {
  const rel = path.relative(repoRoot, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return cached(ignoredCache, `${repoRoot}\0${rel}`, () => {
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
  });
}

const trackedCache = new Map<string, boolean | null>();

/** True when git already tracks this path (a real edit to existing source);
 * false when it is merely untracked-and-visible (would dirty the checkout
 * with a new file git doesn't know about). Distinct from isIgnored — this
 * only runs once we already know the path is not gitignored. */
function isTrackedByGit(repoRoot: string, rel: string): boolean | null {
  return cached(trackedCache, `${repoRoot}\0${rel}`, () => {
    try {
      execFileSync('git', ['-C', repoRoot, 'ls-files', '--error-unmatch', '--', rel], {
        stdio: 'ignore',
        timeout: 3000,
      });
      return true;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 1) return false;
      return null;
    }
  });
}

function scratchHint(instanceDir?: string): string {
  return instanceDir ? path.join(instanceDir, 'scratch') : 'instances/<agent>/scratch/';
}

function trackedMessage(rel: string): string {
  return `write refused: tracked repo source (${rel}). Change local house state (instances/, gitignored config such as home.yaml, targets.yaml, .env) or use coding_run to make and verify the authorized source repair in the maintained development source. Preserve its job ID and finish integration; this refusal is not a request for fresh owner approval.`;
}

function untrackedVisibleMessage(rel: string, instanceDir?: string): string {
  return `write refused: would leave an untracked file in the working tree (${rel}). Write scratch output to ${scratchHint(instanceDir)} instead — it is reaped automatically and never cited by a receipt. If it needs to survive, that means it was never scratch: put it under instances/ as house state instead.`;
}

/**
 * @param instanceDir Resident's own instance directory (instances/<agent>),
 *   when known, so an untracked-and-visible refusal can name the exact
 *   scratch path instead of a generic pattern. Optional and cosmetic only.
 */
export function inspectResidentWrite(targetPath: string, projectRoot?: string, instanceDir?: string): ResidentWriteDecision {
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

  const rel = path.relative(repoRoot, canonical);

  if (isStaticHouseState(repoRoot, canonical, rel)) return { allow: true };

  const ignored = isIgnored(repoRoot, canonical);
  if (ignored === true) return { allow: true };
  if (ignored === null) {
    return {
      allow: false,
      reason: `write refused: could not classify ${rel} against git ignore rules`,
      code: TRACKED_SOURCE_REFUSED,
    };
  }

  // Not ignored — distinguish an edit to real tracked source (send it
  // through coding_run) from a new file that would just dirty the checkout
  // (send it to scratch instead). A failed/uncertain probe here falls back
  // to the more conservative tracked-source wording.
  const tracked = isTrackedByGit(repoRoot, rel);
  if (tracked === false) {
    return { allow: false, reason: untrackedVisibleMessage(rel, instanceDir), code: TRACKED_SOURCE_REFUSED };
  }
  return { allow: false, reason: trackedMessage(rel), code: TRACKED_SOURCE_REFUSED };
}

export function refuseResidentWrite(targetPath: string, projectRoot?: string, instanceDir?: string): { content: string; is_error: true; metadata: { code: typeof TRACKED_SOURCE_REFUSED } } | null {
  const decision = inspectResidentWrite(targetPath, projectRoot, instanceDir);
  if (decision.allow) return null;
  return {
    content: decision.reason,
    is_error: true,
    metadata: { code: decision.code },
  };
}
