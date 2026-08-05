/**
 * Identity budgeting (Step 30, Piece 1).
 *
 * The old context loader sliced identity files at arbitrary character offsets
 * (SOUL.md → content.slice(0, 3000)), silently, mid-sentence. Jerry's SOUL is
 * ~4.5k and Forrest's ~5k, so the companion-shape / grounding tail of both was
 * cut off before ever reaching the model — the character was truncated out of
 * existence with no diagnostic.
 *
 * This module replaces blind slicing with SECTION-AWARE budgeting:
 *   - a coherent markdown section is the unit of inclusion, never a partial
 *     sentence;
 *   - whole least-important sections are dropped to fit a configurable budget;
 *   - when anything is omitted, a visible diagnostic is appended to the text
 *     AND returned structurally so the composition is inspectable.
 *
 * Pure and deterministic — no I/O, no clock — so it is directly unit-testable.
 */

/** Six-layer identity composition scheme (Step 30). */
export type IdentityLayer =
  | 'enduring_self'   // 1. who the agent is, independent of task
  | 'relationship'    // 2. the working relationship with jtr
  | 'role'            // 3. agent-specific mission / mandate
  | 'world_state'     // 4. current world / hot state / knowledge
  | 'operational'     // 5. operational + tool rules
  | 'task';           // 6. the current task (the user turn — not a file)

export const IDENTITY_LAYER_ORDER: IdentityLayer[] = [
  'enduring_self', 'relationship', 'role', 'world_state', 'operational', 'task',
];

export const IDENTITY_LAYER_LABEL: Record<IdentityLayer, string> = {
  enduring_self: 'LAYER 1 · ENDURING SELF',
  relationship: 'LAYER 2 · RELATIONSHIP WITH JTR',
  role: 'LAYER 3 · ROLE',
  world_state: 'LAYER 4 · CURRENT WORLD / HOT STATE',
  operational: 'LAYER 5 · OPERATIONAL & TOOL RULES',
  task: 'LAYER 6 · CURRENT TASK',
};

/** Classify an identity filename into one of the six layers. */
export function classifyIdentityLayer(filename: string): IdentityLayer {
  const f = filename.toUpperCase();
  if (f === 'SOUL.MD' || f === 'BOOT.MD' || f === 'BOOTSTRAP.MD') return 'enduring_self';
  if (f === 'PERSONAL.MD' || f.startsWith('RELATIONSHIP') || f === 'FRIENDSHIP_LEDGER.MD') return 'relationship';
  if (f === 'MISSION.MD' || f === 'GOOD_LIFE.MD' || f === 'COSMO_RESEARCH.MD' || f === 'SHAKEDOWN_STATUS.MD') return 'role';
  if (f === 'PLAYBOOK.MD' || f === 'DOCTRINE.MD' || f === 'SKILL_ROUTING.MD' || f === 'ALIASES.JSON' || f === 'INVARIANTS.MD') return 'operational';
  // NOW / TEMPORAL / RECENT / MEMORY / LEARNINGS / HEARTBEAT / briefings / receipts …
  return 'world_state';
}

/** Which end of the file carries the most-important content. */
export type KeepStrategy = 'head' | 'tail';

/**
 * Per-file default budgets (chars) and keep strategy. Chosen to fit the current
 * jerry/forrest identity files whole where they are load-bearing (SOUL, MISSION,
 * GOOD_LIFE, SHAKEDOWN_STATUS) and to bound the genuinely large indexes
 * (MEMORY, LEARNINGS). SOUL's budget is deliberately generous — it is the
 * enduring self and must never be clipped mid-doctrine.
 */
export const DEFAULT_IDENTITY_BUDGETS: Record<string, { budget: number; strategy: KeepStrategy }> = {
  'SOUL.md': { budget: 8000, strategy: 'head' },
  'BOOT.md': { budget: 4000, strategy: 'head' },
  'MISSION.md': { budget: 5000, strategy: 'head' },
  'PERSONAL.md': { budget: 3000, strategy: 'head' },
  'GOOD_LIFE.md': { budget: 4200, strategy: 'head' },
  'COSMO_RESEARCH.md': { budget: 3000, strategy: 'head' },
  'SHAKEDOWN_STATUS.md': { budget: 2600, strategy: 'head' },
  'HEARTBEAT.md': { budget: 1500, strategy: 'head' },
  'MEMORY.md': { budget: 3000, strategy: 'head' },
  'LEARNINGS.md': { budget: 2500, strategy: 'tail' },
  'NOW.md': { budget: 2500, strategy: 'head' },
  'TEMPORAL.md': { budget: 2500, strategy: 'head' },
  'RECENT.md': { budget: 3000, strategy: 'head' },
  'OPEN_PROJECTS.md': { budget: 2600, strategy: 'head' },
  'RECENT_DECISIONS.md': { budget: 2200, strategy: 'head' },
  'AGENT_BRIEFING.md': { budget: 1800, strategy: 'head' },
  'ARTIFACT_RECEIPTS.md': { budget: 2200, strategy: 'head' },
  'ALIASES.json': { budget: 1800, strategy: 'head' },
  'SKILL_ROUTING.md': { budget: 4200, strategy: 'head' },
};

/** Budget applied to any identity file without an explicit entry. */
export const FALLBACK_IDENTITY_BUDGET = 4000;

export interface BudgetedContent {
  /** The content to inject, including an omission diagnostic when truncated. */
  text: string;
  rawBytes: number;
  includedBytes: number;   // length of retained source content (excludes the diagnostic line)
  budget: number;
  truncated: boolean;
  /** Titles (heading text) of whole sections that were dropped. */
  omittedSections: string[];
  omittedBytes: number;
}

interface Section {
  title: string;   // heading text, or '(preamble)' for content before the first heading
  body: string;    // full section text including its heading line
}

/** Split markdown into ordered coherent sections on ATX headings (# … ######). */
function splitSections(content: string): Section[] {
  const lines = content.split('\n');
  const sections: Section[] = [];
  let current: Section | null = null;
  const headingRe = /^#{1,6}\s+(.*\S)\s*$/;

  for (const line of lines) {
    const m = headingRe.exec(line);
    if (m) {
      if (current) sections.push(current);
      current = { title: (m[1] ?? '').trim() || '(section)', body: line };
    } else if (current) {
      current.body += `\n${line}`;
    } else {
      // Preamble before the first heading (title line, intro paragraph).
      current = { title: '(preamble)', body: line };
    }
  }
  if (current) sections.push(current);
  return sections;
}

/** Truncate a single over-budget block at a paragraph/sentence/word boundary — never mid-word. */
function boundaryTruncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const window = text.slice(0, limit);
  const para = window.lastIndexOf('\n\n');
  if (para >= limit * 0.5) return window.slice(0, para).trimEnd();
  const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('.\n'));
  if (sentence >= limit * 0.5) return window.slice(0, sentence + 1).trimEnd();
  const nl = window.lastIndexOf('\n');
  if (nl >= limit * 0.5) return window.slice(0, nl).trimEnd();
  const sp = window.lastIndexOf(' ');
  return (sp > 0 ? window.slice(0, sp) : window).trimEnd();
}

/**
 * Budget one identity file's content. When the content fits, it is returned
 * whole. When it does not, whole sections are dropped from the low-priority end
 * (tail for 'head' strategy, head for 'tail' strategy) and a visible diagnostic
 * is appended.
 */
export function budgetIdentityContent(
  filename: string,
  rawContent: string,
  budget: number,
  strategy: KeepStrategy = 'head',
): BudgetedContent {
  const content = rawContent.trim();
  const rawBytes = content.length;
  if (rawBytes <= budget) {
    return { text: content, rawBytes, includedBytes: rawBytes, budget, truncated: false, omittedSections: [], omittedBytes: 0 };
  }

  const sections = splitSections(content);
  // Degenerate: a single section (or no headings) larger than budget — keep a
  // boundary-truncated slice from the requested end rather than dropping it all.
  if (sections.length <= 1) {
    const kept = strategy === 'tail'
      ? boundaryTruncate(content.split('').reverse().join(''), budget).split('').reverse().join('')
      : boundaryTruncate(content, budget);
    return {
      text: `${kept}\n\n${diagnostic(filename, kept.length, rawBytes, 1, ['(body truncated)'])}`,
      rawBytes, includedBytes: kept.length, budget, truncated: true,
      omittedSections: ['(body truncated)'], omittedBytes: rawBytes - kept.length,
    };
  }

  const ordered = strategy === 'tail' ? [...sections].reverse() : sections;
  const kept: Section[] = [];
  const omitted: Section[] = [];
  let used = 0;
  const SEP = 2; // '\n' join cost between sections
  for (const section of ordered) {
    const cost = section.body.length + (kept.length ? SEP : 0);
    if (used + cost <= budget) {
      kept.push(section);
      used += cost;
    } else {
      omitted.push(section);
    }
  }
  // Restore document order for the retained sections.
  const keptInOrder = sections.filter(s => kept.includes(s));
  const body = keptInOrder.map(s => s.body).join('\n');
  const includedBytes = body.length;
  const omittedTitles = sections.filter(s => omitted.includes(s)).map(s => s.title);
  const omittedBytes = rawBytes - includedBytes;

  return {
    text: `${body}\n\n${diagnostic(filename, includedBytes, rawBytes, omittedTitles.length, omittedTitles)}`,
    rawBytes, includedBytes, budget, truncated: omittedTitles.length > 0,
    omittedSections: omittedTitles, omittedBytes,
  };
}

function diagnostic(filename: string, kept: number, raw: number, count: number, titles: string[]): string {
  const list = titles.slice(0, 8).join(', ');
  const more = titles.length > 8 ? ` (+${titles.length - 8} more)` : '';
  return `_[identity-budget: kept ${kept}/${raw} chars of ${filename}; omitted ${count} section(s): ${list}${more}. Full file is on disk if needed.]_`;
}

/** Resolve the effective budget + strategy for a filename, honoring config overrides. */
export function resolveBudget(
  filename: string,
  overrides?: Record<string, number>,
): { budget: number; strategy: KeepStrategy } {
  const def = DEFAULT_IDENTITY_BUDGETS[filename];
  const override = overrides?.[filename];
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return { budget: Math.floor(override), strategy: def?.strategy ?? 'head' };
  }
  return def ?? { budget: FALLBACK_IDENTITY_BUDGET, strategy: 'head' };
}
