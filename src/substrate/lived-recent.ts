/**
 * RECENT, composed from the life — the first Home23 v2 file cutover.
 *
 * v1 keeps "recent memory" in RECENT.md: a digest FILE a curator process
 * rewrites, loaded into prompts. Files are photographs; they rot silently
 * (jerry's said "Recent Activity" for two stale weeks and nothing noticed).
 * v2 composes the RECENT surface at read time from the individual's OWN
 * chain — his conversations (words attached, perceived at contact), the
 * teachings he took, the thoughts his lobe wrote, reality's answers to his
 * predictions, his development, his body changes. A chain cannot rot
 * silently: it is hash-linked to the second, or it refuses.
 *
 * Read-only over the Seed's newest checkpoint + ledger tail; writes
 * nothing. Degraded-honest: too little lived material → null, and the
 * caller falls back to the file. Event-time only — the window is a span of
 * chain seqs, never a wall-clock notion of "today".
 */

import { readSeedCheckpoint, readSeedLedgerTail, type LedgerLine } from './seed-context.js';

const DEFAULT_BUDGET = 3000;
/** Chain-seq window treated as "recent" (~2 days of 5-min heartbeats). */
const WINDOW_SEQS = 600;
const CONTACT_LINES = 6;
const TEACHING_LINES = 3;
const THOUGHT_LINES = 4;
/** Below this many lived items the surface is not worth owning — fall back. */
const MIN_ITEMS = 3;

export function composeLivedRecent(stateDir: string, budget = DEFAULT_BUDGET): string | null {
  const checkpoint = readSeedCheckpoint(stateDir);
  if (checkpoint === null) return null;
  const tail = readSeedLedgerTail(stateDir);
  if (tail.length === 0) return null;

  const headSeq = Math.max(checkpoint.ledgerSeq, ...tail.map((l) => l.seq));
  const windowStart = headSeq - WINDOW_SEQS;
  const window = tail.filter((l) => l.seq >= windowStart);
  const windowOpensAt = window[0]?.issuedAt;

  // ── Contact: his actual conversations, words attached (ref heads) ──
  const refs = checkpoint.cells
    .flatMap((c) => c.realityRefs ?? [])
    .filter((r) => typeof r.head === 'string' && r.head.length > 0)
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const contact = refs
    .filter((r) => r.sourceRef.startsWith('conversation.'))
    .slice(-CONTACT_LINES)
    .map((r) => {
      const voice = r.sourceRef.startsWith('conversation.jtr') ? 'jtr' : 'jerry';
      return `- ${voice}: "${r.head}"`;
    });

  // ── Teachings: corrections/attenuations that carried their words ──
  const teachings = refs
    .filter((r) => r.sourceRef.startsWith('relationship.'))
    .slice(-TEACHING_LINES)
    .map((r) => `- "${r.head}"`);

  // ── Thoughts: what his lobe actually wrote into state in the window ──
  const thoughts: string[] = [];
  for (const line of window) {
    if (line.category !== 'lobe') continue;
    const deltas = line.payload['appliedDeltas'];
    if (!Array.isArray(deltas)) continue;
    for (const d of deltas as Array<{ cellId?: string; field?: string; delta?: Record<string, unknown> }>) {
      const claim = d.delta?.['claim'];
      if (typeof claim !== 'string') continue;
      const verb = d.field === 'predictions.append' ? 'expects' : 'believes';
      thoughts.push(`- [${d.cellId ?? '?'}] ${verb}: ${claim.slice(0, 150)}`);
    }
  }
  const recentThoughts = thoughts.slice(-THOUGHT_LINES);

  // ── Reality's answers: predictions judged within the window's timeframe ──
  const answered: string[] = [];
  for (const cell of checkpoint.cells) {
    for (const p of cell.predictions ?? []) {
      if (p.resolvedAt === undefined || typeof p.error !== 'number') continue;
      if (windowOpensAt !== undefined && p.resolvedAt < windowOpensAt) continue;
      const verdict = p.error <= 0.3 ? 'reality agreed' : p.error >= 0.7 ? 'reality said no' : 'partly right';
      answered.push(`- predicted "${p.claim.slice(0, 120)}" — ${verdict} (error ${p.error.toFixed(2)})`);
    }
  }

  // ── Development + body changes in the window ──
  const byRule = new Map<string, number>();
  const body: string[] = [];
  for (const line of window) {
    if (line.category === 'development') {
      const rule = String(line.payload['rule'] ?? 'other');
      byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
    } else if (line.category === 'act') {
      const p = line.payload;
      if (typeof p['operatorDecision'] === 'string') {
        const who = String(p['authorizedBy'] ?? 'the operator');
        const reason = typeof p['reason'] === 'string' ? ` — "${p['reason']}"` : '';
        body.push(`- ${who} ${String(p['operatorDecision'])} his ${String(p['op'] ?? 'change')}${reason}`);
      } else if (p['growthApplication'] !== undefined || p['organExcision'] !== undefined) {
        body.push(`- his body changed: receipted ${String(p['op'] ?? 'growth')}`);
      }
    }
  }
  const development = byRule.size > 0
    ? [...byRule.entries()].map(([r, n]) => `${r} ×${n}`).join(', ')
    : null;

  const itemCount = contact.length + teachings.length + recentThoughts.length + answered.length + body.length;
  if (itemCount < MIN_ITEMS) return null;

  const sections: string[][] = [];
  sections.push([`RECENT — lived record, composed from the Seed's chain (seq ${Math.max(windowStart, 1)}–${headSeq}) at read time. No file involved; a chain cannot go silently stale.`]);
  if (contact.length > 0) sections.push(['Contact:', ...contact]);
  if (teachings.length > 0) sections.push(['Teachings taken:', ...teachings]);
  if (recentThoughts.length > 0) sections.push(['Thoughts he formed:', ...recentThoughts]);
  if (answered.length > 0) sections.push(["Reality's answers:", ...answered]);
  if (development !== null) sections.push([`Development: ${development}.`]);
  if (body.length > 0) sections.push(['Body:', ...body]);

  // Whole-section budgeting from the tail — never a mid-sentence slice.
  let kept = sections.slice();
  const render = (s: string[][]): string => s.map((sec) => sec.join('\n')).join('\n\n');
  let text = render(kept);
  while (text.length > budget && kept.length > 1) {
    kept = kept.slice(0, -1);
    text = render(kept);
  }
  if (text.length > budget) text = `${text.slice(0, budget - 1)}…`;
  return text;
}

export type { LedgerLine };
