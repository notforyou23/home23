import { isExternalEvidenceRef, type FeedbackClaim, type FeedbackRef } from '../../shared/prediction-feedback.cjs';
import type { LedgerLine } from './seed-context.js';

export type OwnerClaimKind = 'owner.said' | 'owner.wants' | 'owner.decided';

export function isOwnerClaim(claim: FeedbackClaim): boolean {
  return ['owner.said', 'owner.wants', 'owner.decided'].includes(claim.claimKind ?? '');
}

/** Admission pins original contact on the accepted typed delta. The model
 * cannot supply these witnesses. Support survives the cell's rolling window,
 * but it establishes reported speech, not the truth of the interpretation. */
export function ownerClaimMessageIds(claim: FeedbackClaim): string[] {
  if (!isOwnerClaim(claim) || !Array.isArray(claim.ownerEvidence)) return [];
  const ids = new Set(Array.isArray(claim.evidenceRefs) ? claim.evidenceRefs : []);
  const createdAt = Date.parse(claim.createdAt ?? '');
  if (!Number.isFinite(createdAt)) return [];
  return [...new Set(claim.ownerEvidence.filter((ref: FeedbackRef) =>
    ref.principal === 'owner' && typeof ref.messageId === 'string' && ids.has(ref.messageId)
    && /^conversation\.jtr(?::|$)/.test(ref.sourceRef ?? '') && isExternalEvidenceRef(ref)
    && Date.parse(ref.observedAt ?? '') <= createdAt,
  ).map((ref: FeedbackRef) => ref.messageId as string))];
}

/** Chain receipt clocks describe persistence, not lived time. Current
 * receipts carry their deterministic event time explicitly; legacy event
 * records can fall back to issuedAt. Checkpoints and shutdown never age life. */
export function livedEventTime(record: LedgerLine): string | undefined {
  if (['checkpoint', 'stop'].includes(record.category)) return undefined;
  const time = record.payload?.['asOf'] ?? record.payload?.['producedAt'] ?? record.issuedAt;
  return typeof time === 'string' && Number.isFinite(Date.parse(time)) ? time : undefined;
}

export function latestLivedEventTime(records: LedgerLine[]): string | undefined {
  return records.map(livedEventTime).filter((time): time is string => time !== undefined)
    .sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
}
