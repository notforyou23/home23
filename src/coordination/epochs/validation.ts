import {
  API_OPERATION_REGISTRY,
  AUTHORITY_EPOCH_REGISTRY,
  FEATURE_FLAG_REGISTRY,
  isLegalTransition,
  validateContractId,
} from "../schema/contract-registry.js";
import {
  canonicalJson,
  deepFreeze,
  requireCanonicalTimestamp,
  sha256,
} from "../import/canonical.js";
import { authorityReceiptSigningPayload, unsignedAuthorityReceipt } from "./receipt.js";
import type {
  AuthorityEpoch,
  AuthorityEpochValidation,
  AuthorityRolloutReceipt,
  ValidateAuthorityEpochTransitionInput,
} from "./types.js";

function denied(reason: Extract<AuthorityEpochValidation, { decision: "denied" }>["reason"]): AuthorityEpochValidation {
  return deepFreeze({ decision: "denied", reason });
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validEpochRecord(epoch: AuthorityEpoch): boolean {
  return AUTHORITY_EPOCH_REGISTRY.capabilities.includes(epoch.capability)
    && AUTHORITY_EPOCH_REGISTRY.modes.includes(epoch.mode)
    && Number.isSafeInteger(epoch.epoch)
    && epoch.epoch >= 1
    && epoch.writer.length > 0
    && (epoch.effectiveAtEventSequence === null || nonNegativeInteger(epoch.effectiveAtEventSequence))
    && (epoch.mode !== "shadow" || epoch.effectiveAtEventSequence === null)
    && (epoch.rollbackEpoch === null || (Number.isSafeInteger(epoch.rollbackEpoch) && epoch.rollbackEpoch >= 1));
}

export function validateInitialAuthorityEpoch(epoch: AuthorityEpoch): AuthorityEpochValidation {
  if (!validEpochRecord(epoch)) return denied("invalid_epoch_record");
  if (epoch.epoch !== 1) return denied("initial_epoch_must_be_one");
  if (epoch.mode === "canonical") return denied("initial_epoch_must_be_legacy");
  if (epoch.rollbackEpoch !== null) return denied("initial_epoch_cannot_have_rollback");
  if (epoch.effectiveAtEventSequence !== null) {
    return denied("initial_epoch_cannot_have_effective_sequence");
  }
  return deepFreeze({ decision: "valid" });
}

function receiptStructureValid(receipt: AuthorityRolloutReceipt): boolean {
  try {
    if (receipt.receiptVersion !== 1) return false;
    if (!AUTHORITY_EPOCH_REGISTRY.modes.includes(receipt.fromAuthority.mode)) return false;
    if (!AUTHORITY_EPOCH_REGISTRY.modes.includes(receipt.toAuthority.mode)) return false;
    if (!receipt.fromAuthority.writer || !receipt.toAuthority.writer) return false;
    if (!validateContractId("legacySource", receipt.sourceWatermark.sourceId)) return false;
    if (!receipt.sourceWatermark.segmentIdentity) return false;
    if (!nonNegativeInteger(receipt.sourceWatermark.recordIndex)) return false;
    if (!nonNegativeInteger(receipt.sourceWatermark.byteOffset)) return false;
    if (!/^[a-f0-9]{64}$/.test(receipt.sourceWatermark.tailDigest)) return false;
    if (!nonNegativeInteger(receipt.destinationWatermark.eventSequence)) return false;
    if (!nonNegativeInteger(receipt.destinationWatermark.messageCount)) return false;
    if (!/^[a-f0-9]{64}$/.test(receipt.destinationWatermark.orderedDigest)) return false;
    if (!receipt.samePathCanary.operationId || !receipt.samePathCanary.route.startsWith("/")) return false;
    if (!/^[a-f0-9]{64}$/.test(receipt.samePathCanary.requestDigest)) return false;
    if (!nonNegativeInteger(receipt.driftCount)) return false;
    if (!receipt.activeFlags || Array.isArray(receipt.activeFlags)) return false;
    if (Object.values(receipt.activeFlags).some((value) => typeof value !== "boolean")) return false;
    if (!validateContractId("principal", receipt.operator)) return false;
    requireCanonicalTimestamp(receipt.issuedAt, "receipt issuedAt");
    return true;
  } catch {
    return false;
  }
}

const ROUTE_ID_KINDS: Record<string, Parameters<typeof validateContractId>[0]> = {
  botId: "bot",
  channelId: "channel",
  artifactId: "artifact",
  workId: "work",
  pairingSessionId: "pairingSession",
};

function routeMatchesTemplate(template: string, route: string): boolean {
  const expected = template.split("/");
  const actual = route.split("/");
  if (expected.length !== actual.length) return false;
  return expected.every((segment, index) => {
    const placeholder = /^\{([^}]+)\}$/.exec(segment)?.[1];
    if (!placeholder) return segment === actual[index];
    const idKind = ROUTE_ID_KINDS[placeholder];
    return Boolean(idKind && actual[index] && validateContractId(idKind, actual[index]!));
  });
}

function samePathCanaryValid(
  receipt: AuthorityRolloutReceipt,
  capability: AuthorityEpoch["capability"],
): boolean {
  const operation = API_OPERATION_REGISTRY[
    receipt.samePathCanary.operationId as keyof typeof API_OPERATION_REGISTRY
  ];
  return Boolean(
    operation
    && operation.authorityCapability === capability
    && routeMatchesTemplate(operation.path, receipt.samePathCanary.route),
  );
}

function activeFlagsValid(flags: Readonly<Record<string, boolean>>): boolean {
  const expected = Object.keys(FEATURE_FLAG_REGISTRY).sort();
  const actual = Object.keys(flags).sort();
  return canonicalJson(expected) === canonicalJson(actual)
    && actual.every((key) => typeof flags[key] === "boolean");
}

function transitionBound(
  current: AuthorityEpoch,
  proposed: AuthorityEpoch,
  receipt: AuthorityRolloutReceipt,
): boolean {
  return receipt.capability === proposed.capability
    && receipt.fromEpoch === current.epoch
    && receipt.toEpoch === proposed.epoch
    && receipt.fromAuthority.mode === current.mode
    && receipt.fromAuthority.writer === current.writer
    && receipt.toAuthority.mode === proposed.mode
    && receipt.toAuthority.writer === proposed.writer
    && receipt.rollbackTarget === proposed.rollbackEpoch
    && receipt.effectiveAtEventSequence === proposed.effectiveAtEventSequence;
}

export function validateAuthorityEpochTransition(
  input: ValidateAuthorityEpochTransitionInput,
): AuthorityEpochValidation {
  const { current, proposed, history, receipt } = input;
  if (!validEpochRecord(current) || !validEpochRecord(proposed)) {
    return denied("invalid_epoch_record");
  }
  if (current.mode === "canonical" && current.effectiveAtEventSequence === null) {
    return denied("invalid_epoch_record");
  }
  if (!receipt || typeof receipt !== "object") {
    return denied("receipt_signature_missing");
  }
  if (current.capability !== proposed.capability) return denied("capability_mismatch");
  if (proposed.epoch !== current.epoch + 1) return denied("epoch_not_monotonic");
  const capabilityHistory = history
    .filter((epoch) => epoch.capability === current.capability)
    .sort((left, right) => left.epoch - right.epoch);
  const latest = capabilityHistory.at(-1);
  if (!latest || canonicalJson(latest) !== canonicalJson(current)) {
    return denied("current_epoch_not_latest");
  }
  const priorEffectiveAtEventSequence = capabilityHistory.reduce<number | null>(
    (highest, epoch) => epoch.effectiveAtEventSequence === null
      ? highest
      : highest === null
        ? epoch.effectiveAtEventSequence
        : Math.max(highest, epoch.effectiveAtEventSequence),
    null,
  );
  if (!isLegalTransition("authorityEpoch", current.mode, proposed.mode)) {
    return denied("illegal_transition");
  }
  if (proposed.mode === "shadow" && proposed.writer !== current.writer) {
    return denied("shadow_writer_changed");
  }
  if (proposed.mode === "canonical" && proposed.writer === current.writer) {
    return denied("canonical_writer_unchanged");
  }
  const rollbackTarget = proposed.rollbackEpoch === null ? undefined : history.find((epoch) => (
    epoch.capability === proposed.capability && epoch.epoch === proposed.rollbackEpoch
  ));
  if (proposed.mode === "shadow") {
    if (proposed.rollbackEpoch !== null) return denied("rollback_target_invalid");
  } else {
    if (
      !rollbackTarget
      || rollbackTarget.mode !== "legacy"
      || rollbackTarget.epoch >= proposed.epoch
    ) {
      return denied("rollback_target_invalid");
    }
    if (proposed.mode === "legacy" && proposed.writer !== rollbackTarget.writer) {
      return denied("rollback_writer_mismatch");
    }
  }
  if (
    proposed.mode === "legacy"
    && proposed.effectiveAtEventSequence === null
  ) {
    return denied("invalid_epoch_record");
  }
  if (
    proposed.effectiveAtEventSequence !== null
    && priorEffectiveAtEventSequence !== null
    && proposed.effectiveAtEventSequence < priorEffectiveAtEventSequence
  ) {
    return denied("invalid_epoch_record");
  }
  if (!transitionBound(current, proposed, receipt)) {
    return denied("receipt_transition_mismatch");
  }
  if (!receiptStructureValid(receipt)) return denied("receipt_structure_invalid");
  if (!samePathCanaryValid(receipt, proposed.capability)) {
    return denied("same_path_canary_invalid");
  }
  if (!activeFlagsValid(receipt.activeFlags)) return denied("active_flags_invalid");
  if (
    proposed.effectiveAtEventSequence !== null
    && receipt.destinationWatermark.eventSequence < proposed.effectiveAtEventSequence
  ) {
    return denied("destination_watermark_before_effective_epoch");
  }
  if (proposed.mode === "canonical") {
    if (proposed.effectiveAtEventSequence === null) {
      return denied("canonical_effective_sequence_required");
    }
    if (receipt.driftCount !== 0) return denied("canonical_drift_present");
    if (!receipt.samePathCanary.passed) return denied("same_path_canary_failed");
    if (!(["disabled", "strict_proxy"] as const).includes(receipt.legacyWriterDisposition as never)) {
      return denied("legacy_writer_still_independent");
    }
    if (input.activeCanonicalWriters.length > 0) return denied("dual_canonical_writer");
  }
  if (
    proposed.mode === "shadow"
    && receipt.legacyWriterDisposition !== "unchanged_authoritative"
  ) {
    return denied("shadow_must_keep_legacy_authority");
  }
  if (
    proposed.mode === "legacy"
    && receipt.legacyWriterDisposition !== "restored_authoritative"
  ) {
    return denied("rollback_must_restore_legacy_authority");
  }
  if (!receipt.signature) return denied("receipt_signature_missing");
  if (
    receipt.signature.algorithm !== "ed25519"
    || !receipt.signature.keyId
    || !receipt.signature.value
  ) {
    return denied("receipt_signature_invalid");
  }
  const signingPayload = authorityReceiptSigningPayload(unsignedAuthorityReceipt(receipt));
  let signatureValid = false;
  try {
    signatureValid = input.verifySignature(signingPayload, receipt.signature);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return denied("receipt_signature_invalid");
  }
  const receiptDigest = sha256(canonicalJson(receipt));
  const transitionDigest = sha256(canonicalJson({
    current,
    proposed,
    receiptDigest,
  }));
  return deepFreeze({ decision: "valid", transitionDigest, receiptDigest });
}
