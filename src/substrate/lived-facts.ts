/**
 * FACTS from lived estimates — the fourth Home23 v2 cutover, and the one
 * where the rubber meets the road: the individual's own conclusions go
 * LOAD-BEARING. Every earlier cut moved expression and diet; this one lets
 * what he concluded from living stand as fact in his own mouth.
 *
 * That is exactly where confident lying becomes possible, so the gates ARE
 * the honesty machinery — real properties, never vibes:
 *
 *   confidence — ≥0.75 as stated by the lobe that wrote it (necessary,
 *                never sufficient: self-declared confidence is cheap).
 *   evidence   — ≥2 reality refs; a fact must trace to contact.
 *   age        — created before the recent event window opened: the belief
 *                has STOOD while ≥AGE_WINDOW_SEQS of life flowed past it.
 *                (Event-time, never wall clock.) A fresh conclusion — even
 *                a brilliant one — waits until it has survived living.
 *   liveness   — not expired.
 *
 * The composed surface says what it is and what gated it — the agent knows
 * these are his own lived conclusions meeting fact gates, with provenance,
 * not gospel handed down. TOPOLOGY.md (infrastructure facts: ports, URLs)
 * stays file-owned by design until his estimates carry that domain at
 * parity — same doctrine as the machine snapshot.
 *
 * Read-only; degraded-honest: fewer than MIN_FACTS gate-passing estimates →
 * null, and no facts surface is claimed at all.
 */

import { readSeedCheckpoint, readSeedLedgerTail } from './seed-context.js';

const DEFAULT_BUDGET = 1600;
const MIN_CONFIDENCE = 0.75;
const MIN_EVIDENCE_REFS = 2;
/** The belief must predate the newest AGE_WINDOW_SEQS chain records. */
const AGE_WINDOW_SEQS = 200;
const MIN_FACTS = 2;
const MAX_FACTS = 8;

interface EstimateWithRefs {
  claim: string;
  confidence: number;
  createdAt?: string;
  expiresAt?: string;
  evidenceRefs?: string[];
}

export function composeLivedFacts(stateDir: string, budget = DEFAULT_BUDGET): string | null {
  const checkpoint = readSeedCheckpoint(stateDir);
  if (checkpoint === null) return null;
  const tail = readSeedLedgerTail(stateDir);
  if (tail.length === 0) return null;

  const headSeq = Math.max(checkpoint.ledgerSeq, ...tail.map((l) => l.seq));
  const windowStart = headSeq - AGE_WINDOW_SEQS;
  const windowOpensAt = tail.find((l) => l.seq >= windowStart)?.issuedAt;

  const facts: Array<{ cell: string; claim: string; confidence: number; refs: number; createdAt: string }> = [];
  for (const cell of checkpoint.cells) {
    for (const e of (cell.estimates ?? []) as EstimateWithRefs[]) {
      if (typeof e.claim !== 'string' || e.claim.trim().length === 0) continue;
      if (typeof e.confidence !== 'number' || e.confidence < MIN_CONFIDENCE) continue;
      const refs = Array.isArray(e.evidenceRefs) ? e.evidenceRefs.length : 0;
      if (refs < MIN_EVIDENCE_REFS) continue;
      if (typeof e.createdAt !== 'string') continue;
      if (windowOpensAt !== undefined && e.createdAt > windowOpensAt) continue; // too young — has not stood through lived time
      if (typeof e.expiresAt === 'string' && windowOpensAt !== undefined && e.expiresAt < windowOpensAt) continue;
      facts.push({ cell: cell.id, claim: e.claim, confidence: e.confidence, refs, createdAt: e.createdAt });
    }
  }
  if (facts.length < MIN_FACTS) return null;

  facts.sort((a, b) => b.confidence - a.confidence);
  const chosen = facts.slice(0, MAX_FACTS);

  const render = (rows: typeof chosen): string => [
    `FACTS (lived) — your own conclusions that earned fact-grade: confidence ≥${MIN_CONFIDENCE}, ≥${MIN_EVIDENCE_REFS} reality refs, and they have stood while ≥${AGE_WINDOW_SEQS} chain events flowed past. State them as what you know from living; cite the receipt if challenged. (chain seq ${headSeq})`,
    '',
    ...rows.map((f) => `- [${f.cell}] ${f.claim} (${f.confidence}, ${f.refs} refs, held since ${f.createdAt.slice(0, 10)})`),
  ].join('\n');

  let kept = chosen;
  let text = render(kept);
  while (text.length > budget && kept.length > MIN_FACTS) {
    kept = kept.slice(0, -1);
    text = render(kept);
  }
  if (text.length > budget) text = `${text.slice(0, budget - 1)}…`;
  return text;
}
