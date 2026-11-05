import type { AuthorityCapability, AuthorityMode } from "../import/types.js";

export interface AuthorityEpoch {
  readonly capability: AuthorityCapability;
  readonly epoch: number;
  readonly mode: AuthorityMode;
  readonly writer: string;
  readonly effectiveAtEventSequence: number | null;
  readonly rollbackEpoch: number | null;
}

export interface AuthorityReceiptSignature {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly value: string;
}

export interface UnsignedAuthorityRolloutReceipt {
  readonly receiptVersion: 1;
  readonly capability: AuthorityCapability;
  readonly fromEpoch: number;
  readonly toEpoch: number;
  readonly fromAuthority: {
    readonly mode: AuthorityMode;
    readonly writer: string;
  };
  readonly toAuthority: {
    readonly mode: AuthorityMode;
    readonly writer: string;
  };
  readonly sourceWatermark: {
    readonly sourceId: string;
    readonly segmentIdentity: string;
    readonly recordIndex: number;
    readonly byteOffset: number;
    readonly tailDigest: string;
  };
  readonly destinationWatermark: {
    readonly eventSequence: number;
    readonly messageCount: number;
    readonly orderedDigest: string;
  };
  readonly samePathCanary: {
    readonly operationId: string;
    readonly route: string;
    readonly requestDigest: string;
    readonly passed: boolean;
  };
  readonly driftCount: number;
  readonly activeFlags: Readonly<Record<string, boolean>>;
  readonly rollbackTarget: number | null;
  readonly operator: string;
  readonly effectiveAtEventSequence: number | null;
  readonly legacyWriterDisposition:
    | "unchanged_authoritative"
    | "disabled"
    | "strict_proxy"
    | "restored_authoritative";
  readonly issuedAt: string;
}

export interface AuthorityRolloutReceipt extends UnsignedAuthorityRolloutReceipt {
  readonly signature: AuthorityReceiptSignature;
}

export type AuthorityEpochDenialReason =
  | "invalid_epoch_record"
  | "initial_epoch_must_be_one"
  | "initial_epoch_must_be_legacy"
  | "initial_epoch_cannot_have_rollback"
  | "initial_epoch_cannot_have_effective_sequence"
  | "capability_mismatch"
  | "epoch_not_monotonic"
  | "illegal_transition"
  | "shadow_writer_changed"
  | "canonical_writer_unchanged"
  | "rollback_target_invalid"
  | "rollback_writer_mismatch"
  | "receipt_transition_mismatch"
  | "receipt_structure_invalid"
  | "receipt_signature_missing"
  | "receipt_signature_invalid"
  | "current_epoch_not_latest"
  | "same_path_canary_invalid"
  | "active_flags_invalid"
  | "destination_watermark_before_effective_epoch"
  | "canonical_effective_sequence_required"
  | "canonical_drift_present"
  | "same_path_canary_failed"
  | "legacy_writer_still_independent"
  | "dual_canonical_writer"
  | "shadow_must_keep_legacy_authority"
  | "rollback_must_restore_legacy_authority";

export type AuthorityEpochValidation =
  | { readonly decision: "valid"; readonly transitionDigest?: string; readonly receiptDigest?: string }
  | { readonly decision: "denied"; readonly reason: AuthorityEpochDenialReason };

export interface ValidateAuthorityEpochTransitionInput {
  readonly current: AuthorityEpoch;
  readonly proposed: AuthorityEpoch;
  readonly history: readonly AuthorityEpoch[];
  readonly receipt: AuthorityRolloutReceipt;
  readonly activeCanonicalWriters: readonly string[];
  readonly verifySignature: (
    signingPayload: string,
    signature: AuthorityReceiptSignature,
  ) => boolean;
}
