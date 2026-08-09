/**
 * Home23 — Session Bootstrap
 *
 * When an agent starts a fresh session (first turn, or after idle-gap),
 * inject the files listed under `situationalAwareness.bootstrap.reads`
 * into that turn's system prompt. Turns 2+ in the same session see none
 * of this — the content lives in conversation history from turn 1 onward.
 *
 * Purpose: give every agent (including subagents and scheduled cron runs)
 * a consistent "where am I, what's current, what's the map" wake-up ritual
 * grounded in live files — not cached identity.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { composeSeedNow } from '../substrate/seed-now.js';

export interface SituationalAwarenessConfig {
  bootstrap?: {
    reads?: string[];          // relative to workspacePath, e.g. ['NOW.md', 'PLAYBOOK.md']
    maxBytesPerFile?: number;  // per-file cap; default 4000
  };
  /** Keyword-gated workspace files loaded into situational awareness on match (Step 30 cleanup #4). */
  triggeredSurfaces?: Array<{
    file: string;
    label?: string;
    keywords?: string[];
    domains?: string[];
    budget?: number;
  }>;
  /** Seed → situational awareness: the agent's Seed (persistent developmental
   * substrate; causality proven under ablation 2026-08-08) grounds every turn
   * with its carried situations, earned trust, and open expectations. The
   * stateDir may be a live mirror; reads are torn-tolerant and read-only. */
  substrate?: {
    stateDir: string;
    budget?: number;
  };
}

const DEFAULT_READS = ['NOW.md', 'PLAYBOOK.md'];
const DEFAULT_MAX_BYTES = 4000;

const GENERATOR_CONTRACT = [
  '[GENERATOR CONTRACT]',
  'Scoreboard is finished work for jtr — not yellow chronics.',
  'Finish inside your dedication (receipts beat status theater). Jerry: life ops · ship Home23 · research→artifacts · make things. Forrest: health companion surfaces (8092 full read, ledgers, shelf/analyses, protocols).',
  'Act and close by default. Ask only for: destructive filesystem/git, spend, public post, credentials, irreversible brain-risk, sensitive personal/health.',
  'Self-health is scenery. Quiet house keep-alive (disk/cron/MCP) may run without asking.',
  'Do not midwife the midwife. Prefer one finished artifact over another status narrative.',
  '[/GENERATOR CONTRACT]',
].join('\n');

/**
 * Build the [SESSION BOOTSTRAP] block to inject into the first turn
 * of a fresh session. Returns null if disabled or no files resolvable.
 */
export function buildBootstrapBlock(
  workspacePath: string,
  cfg: SituationalAwarenessConfig | undefined,
): string | null {
  const reads = cfg?.bootstrap?.reads ?? DEFAULT_READS;
  const maxBytes = cfg?.bootstrap?.maxBytesPerFile ?? DEFAULT_MAX_BYTES;

  const sections: string[] = [];

  // Home23 v2 cutover, function 2: the session opens on the INDIVIDUAL's
  // lived now — composed from his chain at this instant (last contact,
  // identity events since, freshest thought, open expectations) — with the
  // machine-snapshot files following as telemetry. Young/absent seed →
  // files-only, exactly as before.
  if (cfg?.substrate?.stateDir) {
    try {
      const lived = composeSeedNow(cfg.substrate.stateDir);
      if (lived) sections.push(`— NOW@seed (lived, from your chain) —\n${lived}`);
    } catch {
      // bootstrap never blocks a turn; absence over fabrication
    }
  }

  for (const filename of reads) {
    const filePath = join(workspacePath, filename);
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, 'utf-8').trim().slice(0, maxBytes);
      if (!content) continue;
      sections.push(`— ${filename} —\n${content}`);
    } catch {
      // skip unreadable files; never block a turn on bootstrap
    }
  }

  // Always inject the generator contract so finish-rights outrank chronics,
  // even when NOW/PLAYBOOK are thin or stale.
  const body = [
    GENERATOR_CONTRACT,
    sections.length ? sections.join('\n\n') : null,
  ].filter(Boolean).join('\n\n');

  if (!body) return null;

  return [
    '[SESSION BOOTSTRAP]',
    'Fresh session. The files below are your live operational ground truth.',
    'You MUST reference and use their content in your first response. Do not skip them.',
    'Do not re-request these files on later turns; they remain in history.',
    '',
    body,
    '[/SESSION BOOTSTRAP]',
  ].join('\n');
}
