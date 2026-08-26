import type { AuthorityEpoch } from "./types.js";

export const COORDINATION_MESSAGES_WRITER = "home23-coordination" as const;

/**
 * Public message mutation is available only after an append-only authority
 * epoch names this process as the sole canonical writer. Feature flags can
 * remove this capability, but they cannot manufacture this proof.
 */
export function isCanonicalMessagesAuthority(
  epoch: AuthorityEpoch | null | undefined,
): boolean {
  return epoch?.capability === "messages" &&
    epoch.mode === "canonical" &&
    epoch.writer === COORDINATION_MESSAGES_WRITER &&
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
