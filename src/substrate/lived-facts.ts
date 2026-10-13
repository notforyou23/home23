// Character targets are advisory: never shorten a selected claim or owner statement.
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
 *   evidence   — operational conclusions need ≥2 reality refs. Typed owner
 *                reports need ≥1 captured original owner message id; support
 *                establishes what was said, not truth of the interpretation.
 *   age        — created before the recent event window opened: the belief
 *                has STOOD while ≥AGE_WINDOW_SEQS of life flowed past it.
 *                (Event-time, never wall clock.) A fresh conclusion — even
 *                a brilliant one — waits until it has survived living.
 *                Owner reports have no age delay: they describe speech,
 *                wants or decisions rather than a tested regularity.
 *   liveness   — not expired.
 *
 * The composed surface says what it is and what gated it — the agent knows
 * these are his own lived conclusions meeting fact gates, with provenance,
 * not gospel handed down. TOPOLOGY.md (infrastructure facts: ports, URLs)
 * stays file-owned by design until his estimates carry that domain at
 * parity — same doctrine as the machine snapshot.
 *
 * Read-only; degraded-honest: fewer than MIN_FACTS operational estimates and
 * no supported typed owner reports → null.
 */

import { readSeedCheckpoint, readSeedLedgerTail } from './seed-context.js';
import { projectFeedbackState } from '../../shared/seed-feedback-view.cjs';
import { getClaimFeedback, isExternalEvidenceRef } from '../../shared/prediction-feedback.cjs';
import { isOwnerClaim, ownerClaimMessageIds, latestLivedEventTime, livedEventTime } from './owner-claims.js';
import type { FeedbackClaim } from '../../shared/prediction-feedback.cjs';

const DEFAULT_BUDGET = 1600;
const MIN_CONFIDENCE = 0.75;
const MIN_EVIDENCE_REFS = 2;
/** The belief must predate the newest AGE_WINDOW_SEQS chain records. */
const AGE_WINDOW_SEQS = 200;
const MIN_FACTS = 2;
const MAX_FACTS = 8;

interface EstimateWithRefs extends FeedbackClaim {
  claim: string;
  confidence: number;
  createdAt?: string;
  expiresAt?: string;
  evidenceRefs?: string[];
}

export function composeLivedFacts(stateDir: string, budget = DEFAULT_BUDGET): string | null {
  const snapshot = readSeedCheckpoint(stateDir);
  if (snapshot === null) return null;
  const tail = readSeedLedgerTail(stateDir);
  const checkpoint = projectFeedbackState(snapshot, tail);
  if (tail.length === 0) return null;

  const headSeq = Math.max(checkpoint.ledgerSeq, ...tail.map((l) => l.seq));
  const windowStart = headSeq - AGE_WINDOW_SEQS;
  const windowOpensAt = tail.filter(l => l.seq >= windowStart).map(livedEventTime).find(time => time !== undefined);
  const latestEventAt = latestLivedEventTime(tail);
  if (!latestEventAt) return null;

  const facts: Array<{ cell: string; claim: string; confidence: number; refs: number; createdAt: string;
    claimKind?: string; messageIds?: string[] }> = [];
  for (const cell of checkpoint.cells) {
    for (const e of (cell.estimates ?? []) as EstimateWithRefs[]) {
      if (typeof e.claim !== 'string' || e.claim.trim().length === 0) continue;
      if (typeof e.confidence !== 'number' || e.confidence < MIN_CONFIDENCE) continue;
      if (getClaimFeedback(cell, e).failedHypothesis) continue;
      if (typeof e.createdAt !== 'string') continue;
      if (typeof e.expiresAt === 'string' && e.expiresAt <= latestEventAt) continue;
      if (isOwnerClaim(e)) {
        const messageIds = ownerClaimMessageIds(e);
        if (messageIds.length === 0) continue;
        facts.push({ cell: cell.id, claim: e.claim, confidence: e.confidence, refs: messageIds.length,
          createdAt: e.createdAt, claimKind: e.claimKind, messageIds });
        continue;
      }
      const evidenceIds = new Set(Array.isArray(e.evidenceRefs) ? e.evidenceRefs : []);
      const refs = new Set((cell.realityRefs ?? [])
        .filter((r) => r.refId && evidenceIds.has(r.refId) && isExternalEvidenceRef(r))
        .map((r) => r.refId)).size;
      if (refs < MIN_EVIDENCE_REFS) continue;
      if (windowOpensAt === undefined || e.createdAt > windowOpensAt) continue; // too young — has not stood through lived time
      facts.push({ cell: cell.id, claim: e.claim, confidence: e.confidence, refs, createdAt: e.createdAt });
    }
  }
  if (facts.length < MIN_FACTS && !facts.some(f => f.claimKind)) return null;

  facts.sort((a, b) => Number(Boolean(b.claimKind)) - Number(Boolean(a.claimKind)) || b.confidence - a.confidence);
  const chosen = facts.slice(0, MAX_FACTS);

  const render = (rows: typeof chosen): string => [
    `FACTS (lived) — still revisable. Operational conclusions require confidence ≥${MIN_CONFIDENCE}, ≥${MIN_EVIDENCE_REFS} distinct traceable reality refs, no unrevised failed hypothesis, and have stood while ≥${AGE_WINDOW_SEQS} chain events flowed past. Typed owner claims require confidence ≥${MIN_CONFIDENCE} and ≥1 original owner message retained at admission; they report what the owner said, wanted or decided as a revisable Seed interpretation. Neither support nor age proves truth. (chain seq ${headSeq})`,
    '',
    ...rows.map((f) => f.claimKind
      ? `- [${f.cell}] ${f.claimKind}: ${f.claim} (${f.confidence}; reported owner claim, revisable Seed interpretation; messages: ${f.messageIds?.join(', ')})`
      : `- [${f.cell}] ${f.claim} (${f.confidence}, ${f.refs} refs, held since ${f.createdAt.slice(0, 10)})`),
  ].join('\n');

  return render(chosen);
}
