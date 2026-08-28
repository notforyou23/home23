import type { AuthorityEpoch } from "./types.js";

export const COORDINATION_CANONICAL_WRITER = "home23-coordination" as const;
export const COORDINATION_MESSAGES_WRITER = COORDINATION_CANONICAL_WRITER;
export const COORDINATION_ATTACHMENTS_WRITER = COORDINATION_CANONICAL_WRITER;
export const COORDINATION_ACTIVITY_WRITER = COORDINATION_CANONICAL_WRITER;

function isCanonicalCoordinationAuthority(
  epoch: AuthorityEpoch | null | undefined,
  capability: "messages" | "attachments" | "activity",
): boolean {
  return epoch?.capability === capability &&
    epoch.mode === "canonical" &&
    epoch.writer === COORDINATION_CANONICAL_WRITER &&
    Number.isSafeInteger(epoch.epoch) &&
    epoch.epoch > 1 &&
    Number.isSafeInteger(epoch.effectiveAtEventSequence) &&
    epoch.effectiveAtEventSequence !== null &&
    epoch.effectiveAtEventSequence >= 0 &&
    Number.isSafeInteger(epoch.rollbackEpoch) &&
    epoch.rollbackEpoch !== null &&
    epoch.rollbackEpoch >= 1 &&
    epoch.rollbackEpoch < epoch.epoch;
}

/**
 * Public message mutation is available only after an append-only authority
 * epoch names this process as the sole canonical writer. Feature flags can
 * remove this capability, but they cannot manufacture this proof.
 */
export function isCanonicalMessagesAuthority(
  epoch: AuthorityEpoch | null | undefined,
): boolean {
  return isCanonicalCoordinationAuthority(epoch, "messages");
}

/**
 * Attachment admission and Message linking require their own append-only
 * authority epoch. The message epoch cannot manufacture this capability.
 */
export function isCanonicalAttachmentsAuthority(
  epoch: AuthorityEpoch | null | undefined,
): boolean {
  return isCanonicalCoordinationAuthority(epoch, "attachments");
}

/**
 * Activity is a rebuildable projection, but serving it as product truth still
 * requires its own append-only authority epoch. This keeps Activity rollback
 * independent from Messages and every other connected surface.
 */
export function isCanonicalActivityAuthority(
  epoch: AuthorityEpoch | null | undefined,
): boolean {
  return isCanonicalCoordinationAuthority(epoch, "activity");
}
