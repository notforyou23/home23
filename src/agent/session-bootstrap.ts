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

export interface SituationalAwarenessConfig {
  bootstrap?: {
    reads?: string[];          // relative to workspacePath, e.g. ['NOW.md', 'PLAYBOOK.md']
    maxBytesPerFile?: number;  // per-file cap; default 4000
  };
}

const DEFAULT_READS = ['NOW.md', 'PLAYBOOK.md'];
const DEFAULT_MAX_BYTES = 4000;

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
  if (!reads.length) return null;

  const sections: string[] = [];
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

  if (sections.length === 0) return null;

  return [
    '[SESSION BOOTSTRAP]',
    'Fresh session. The files below are your live operational ground truth.',
    'You MUST reference and use their content in your first response. Do not skip them.',
    'Do not re-request these files on later turns; they remain in history.',
    '',
    sections.join('\n\n'),
    '[/SESSION BOOTSTRAP]',
  ].join('\n');
}
