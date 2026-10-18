/**
 * Home23 — Session Bootstrap
 *
 * Refresh the files listed under `situationalAwareness.bootstrap.reads`
 * in each resident turn's dynamic system context. This context is not
 * conversation history: replaying a cached startup packet would both lose
 * it after reload/compaction and keep old operational claims alive.
 *
 * Resident turns, including scheduled runs, receive a current workspace map.
 * Specialists use their explicit delegated handoff, not resident history.
 */
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { composeSeedNow } from '../substrate/seed-now.js';

export interface SituationalAwarenessConfig {
  bootstrap?: {
    reads?: string[];          // relative to workspacePath, e.g. ['NOW.md', 'PLAYBOOK.md']
    maxBytesPerFile?: number;  // UTF-8 preview bytes per file; complete source remains readable; default 4000
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
    stateDir?: string;
    budget?: number;
  };
}

export const DEFAULT_BOOTSTRAP_READS = ['NOW.md', 'PLAYBOOK.md'];
const DEFAULT_MAX_BYTES = 4000;

/** Keep both the map's beginning and later corrections, never a split code point. */
function sourcePreview(content: string, maxBytes: number): { head: string; tail: string; omittedStart: number; omittedEnd: number } {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length <= maxBytes) return { head: content, tail: '', omittedStart: content.length, omittedEnd: content.length };
  let headEnd = Math.ceil(maxBytes / 2);
  while (headEnd > 0 && (bytes[headEnd]! & 0xc0) === 0x80) headEnd--;
  let tailStart = bytes.length - Math.floor(maxBytes / 2);
  while (tailStart < bytes.length && (bytes[tailStart]! & 0xc0) === 0x80) tailStart++;
  const head = bytes.subarray(0, headEnd).toString('utf8');
  const tail = bytes.subarray(tailStart).toString('utf8');
  return { head, tail, omittedStart: head.length, omittedEnd: content.length - tail.length };
}

/** Match the biography's Seed location without requiring an unwritten config setting. */
export function resolveSubstrateStateDir(
  workspacePath: string,
  cfg?: SituationalAwarenessConfig,
): string | undefined {
  if (cfg?.substrate) return cfg.substrate.stateDir || undefined;
  const derived = resolve(workspacePath, '..', 'substrate', 'seed-01');
  try {
    return statSync(derived).isDirectory() ? derived : undefined;
  } catch {
    return undefined;
  }
}

const GENERATOR_CONTRACT = [
  '[GENERATOR CONTRACT]',
  'Scoreboard is finished work for jtr — not yellow chronics.',
  'Finish inside your dedication (receipts beat status theater). Jerry: life ops · ship Home23 · research→artifacts · make things. Forrest: health companion surfaces (8092 full read, ledgers, shelf/analyses, protocols).',
  'Act and close within current and standing authority. Ask for destructive filesystem/git, spend, public post, credentials, irreversible brain-risk, or sensitive personal/health actions only when the specific action is not already authorized; honor tool-enforced confirmations.',
  'Self-health is scenery. Quiet house keep-alive (disk/cron/MCP) may run without asking.',
  'Do not midwife the midwife. Prefer one finished artifact over another status narrative.',
  '[/GENERATOR CONTRACT]',
].join('\n');

/**
 * Build fresh [SESSION BOOTSTRAP] context without changing source or history.
 * A bounded preview is explicitly partial and supplies exact recovery offsets.
 */
export function buildBootstrapBlock(
  workspacePath: string,
  cfg: SituationalAwarenessConfig | undefined,
): string | null {
  const reads = cfg?.bootstrap?.reads ?? DEFAULT_BOOTSTRAP_READS;
  const configuredBytes = cfg?.bootstrap?.maxBytesPerFile;
  const maxBytes = typeof configuredBytes === 'number' && Number.isFinite(configuredBytes)
    ? Math.max(0, Math.floor(configuredBytes)) : DEFAULT_MAX_BYTES;

  const sections: string[] = [];

  // Home23 v2 cutover, function 2: the session opens on the INDIVIDUAL's
  // lived now — composed from his chain at this instant (last contact,
  // identity events since, freshest thought, open expectations) — with the
  // machine-snapshot files following as telemetry. Young/absent seed →
  // files-only, exactly as before.
  const substrateStateDir = resolveSubstrateStateDir(workspacePath, cfg);
  if (substrateStateDir) {
    try {
      const lived = composeSeedNow(substrateStateDir);
      if (lived) sections.push(`— NOW@seed (lived, from your chain) —\n${lived}`);
    } catch {
      // bootstrap never blocks a turn; absence over fabrication
    }
  }

  const seenPaths = new Set<string>();
  for (const filename of reads) {
    const filePath = resolve(workspacePath, filename);
    if (seenPaths.has(filePath)) continue;
    seenPaths.add(filePath);
    try {
      const source = readFileSync(filePath);
      const content = source.toString('utf8');
      if (!content.trim()) continue;
      const preview = sourcePreview(content, maxBytes);
      const metadata = `Source: ${JSON.stringify(filePath)}; sha256=${createHash('sha256').update(source).digest('hex')}; original bytes=${source.length}; UTF-16 characters=${content.length}.`;
      if (preview.omittedStart === preview.omittedEnd) {
        sections.push(`— ${filename} —\n${metadata}\n${content}`);
      } else {
        const recovery = { path: filePath, offset_chars: preview.omittedStart, limit_chars: preview.omittedEnd - preview.omittedStart };
        sections.push([
          `— ${filename} —`, metadata,
          `PARTIAL workspace preview: ${Buffer.byteLength(preview.head + preview.tail, 'utf8')} of ${Buffer.byteLength(content, 'utf8')} UTF-8 bytes shown; the middle is omitted, not read evidence.`,
          preview.head,
          `[Omitted UTF-16 character interval [${preview.omittedStart}, ${preview.omittedEnd}). Recover with read_file(${JSON.stringify(recovery)}); follow any tool continuation to completion. Verify the source hash if the file changed.]`,
          preview.tail,
        ].join('\n'));
      }
    } catch (error) {
      // Unavailability must be visible, but it must not block a turn.
      const reason = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'read failed';
      sections.push(`Workspace context unavailable: ${JSON.stringify(filePath)} (${reason}). No contents from this source were supplied.`);
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
    'Current-turn workspace context, refreshed from source files; not stored in conversation history. Dated telemetry and historical procedures may be stale; they do not override the current task or authenticated runtime authority.',
    'Use relevant background context silently. Mention it only when it changes the answer or the user asks.',
    'Read omitted material when relevant. A preview is not complete evidence. Verify operational claims against current runtime state before treating them as unfinished work.',
    '',
    body,
    '[/SESSION BOOTSTRAP]',
  ].join('\n');
}
