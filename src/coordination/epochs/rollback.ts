import { deepFreeze } from "../import/canonical.js";
import type { AuthorityEpoch } from "./types.js";

export function planAuthorityRollback(input: {
  readonly current: AuthorityEpoch;
  readonly rollbackTarget: AuthorityEpoch;
  readonly history: readonly AuthorityEpoch[];
  readonly effectiveAtEventSequence: number;
}) {
  const { current, rollbackTarget, history, effectiveAtEventSequence } = input;
  if (current.mode !== "canonical" && current.mode !== "shadow") {
    throw new Error("authority rollback requires a shadow or canonical current epoch");
  }
  const preservedTarget = history.find((epoch) => (
    epoch.capability === rollbackTarget.capability
    && epoch.epoch === rollbackTarget.epoch
    && epoch.mode === rollbackTarget.mode
    && epoch.writer === rollbackTarget.writer
  ));
  if (!preservedTarget || rollbackTarget.capability !== current.capability) {
    throw new Error("rollback target must be a preserved epoch for the same capability");
  }
  if (rollbackTarget.epoch >= current.epoch || rollbackTarget.mode !== "legacy") {
    throw new Error("rollback target must name a prior legacy authority");
  }
  if (!Number.isSafeInteger(effectiveAtEventSequence) || effectiveAtEventSequence < 0) {
    throw new Error("rollback effective event sequence must be a non-negative integer");
  }
  const proposedEpoch: AuthorityEpoch = {
    capability: current.capability,
    epoch: current.epoch + 1,
    mode: "legacy",
    writer: rollbackTarget.writer,
    effectiveAtEventSequence,
    rollbackEpoch: rollbackTarget.epoch,
  };
  return deepFreeze({
    planVersion: 1 as const,
    proposedEpoch,
    historyMutation: "append_new_epoch_only" as const,
    legacySource: {
      action: "preserve_read_only" as const,
      overwriteAllowed: false as const,
      appendAllowed: false as const,
    },
    canonicalHistory: {
      action: "preserve_read_only" as const,
      deleteAllowed: false as const,
    },
    steps: [
      "pause_canonical_admission_and_leases",
      "bounded_drain_current_attempts",
      "compare_last_canonical_and_legacy_projection",
      "identify_missing_suffix_without_writing_legacy_source",
      "validate_attachment_references_and_ordered_digest",
      "append_signed_legacy_authority_epoch",
      "prove_coordination_rejects_or_forwards_new_writes",
    ] as const,
  });
}
