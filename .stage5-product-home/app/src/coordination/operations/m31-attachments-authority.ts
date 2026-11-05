import { createPublicKey, verify } from "node:crypto";

import { openCoordinationDatabase } from "../db/index.js";
import {
  COORDINATION_ATTACHMENTS_WRITER,
  validateAuthorityEpochTransition,
  validateInitialAuthorityEpoch,
  type AuthorityEpoch,
  type AuthorityRolloutReceipt,
} from "../epochs/index.js";
import { assertCoordinationId } from "../ids/index.js";
import { FEATURE_FLAG_REGISTRY } from "../schema/contract-registry.js";

export const FEATURE_OFF_ATTACHMENTS_WRITER =
  "feature-off-attachments-disabled" as const;

export interface M31AttachmentBaselineEvidence {
  approved: true;
  kind: "m31-attachments-feature-off-baseline";
  operator: "user_owner";
  attachmentAdmissionEnabled: false;
  noExistingAttachmentWriter: true;
}

export interface M31AttachmentBaselineInput {
  databasePath: string;
  evidence?: M31AttachmentBaselineEvidence;
  requestId: string;
  correlationId: string;
  apply?: boolean;
  liveAuthorized?: boolean;
  now?: () => Date;
}

export interface M31AttachmentAuthorityInput {
  databasePath: string;
  receipt: AuthorityRolloutReceipt;
  publicKeyPem: string;
  activeCanonicalWriters: readonly string[];
  /** Rollback and authority changes happen only after this kill switch is off. */
  attachmentAdmissionEnabled: false;
  requestId: string;
  correlationId: string;
  apply?: boolean;
  liveAuthorized?: boolean;
}

function exactBaselineEvidence(
  value: M31AttachmentBaselineEvidence | undefined,
): value is M31AttachmentBaselineEvidence {
  return value?.approved === true &&
    value.kind === "m31-attachments-feature-off-baseline" &&
    value.operator === "user_owner" &&
    value.attachmentAdmissionEnabled === false &&
    value.noExistingAttachmentWriter === true;
}

function canonicalTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("attachment authority clock returned an invalid date");
  }
  return new Date(value.getTime()).toISOString();
}

/**
 * Establishes only the feature-off epoch-1 baseline. It cannot activate a
 * route or name the coordination process as canonical authority.
 */
export function initializeM31AttachmentAuthority(
  input: M31AttachmentBaselineInput,
) {
  if (!exactBaselineEvidence(input.evidence)) {
    throw new Error(
      "attachment authority baseline requires explicit feature-off evidence",
    );
  }
  const evidence = input.evidence;
  assertCoordinationId("request", input.requestId);
  assertCoordinationId("correlation", input.correlationId);
  const proposed: AuthorityEpoch = Object.freeze({
    capability: "attachments",
    epoch: 1,
    mode: "legacy",
    writer: FEATURE_OFF_ATTACHMENTS_WRITER,
    effectiveAtEventSequence: null,
    rollbackEpoch: null,
  });
  if (validateInitialAuthorityEpoch(proposed).decision !== "valid") {
    throw new Error("initial attachment authority epoch is invalid");
  }
  const database = openCoordinationDatabase({
    path: input.databasePath,
    applicationVersion: "home23-coordination-m31-attachments-baseline",
  });
  try {
    const existing = database.readOne<AuthorityEpoch>(
      `SELECT capability, epoch, mode, writer,
              effective_at_event_sequence AS effectiveAtEventSequence,
              rollback_epoch AS rollbackEpoch
       FROM authority_epochs
       WHERE capability = 'attachments'
       ORDER BY epoch DESC LIMIT 1`,
    );
    if (existing) {
      if (
        existing.epoch !== proposed.epoch ||
        existing.mode !== proposed.mode ||
        existing.writer !== proposed.writer ||
        existing.effectiveAtEventSequence !== null ||
        existing.rollbackEpoch !== null
      ) {
        throw new Error(
          "existing attachment authority is not the feature-off baseline",
        );
      }
      return Object.freeze({
        mode: input.apply === true ? "apply" as const : "preflight" as const,
        proposed,
        mutated: false,
        outcome: "already_present" as const,
      });
    }
    const plan = Object.freeze({
      mode: input.apply === true ? "apply" as const : "preflight" as const,
      proposed,
      mutated: false,
      outcome: "planned" as const,
    });
    if (input.apply !== true) return plan;
    if (input.liveAuthorized !== true) {
      throw new Error(
        "attachment authority baseline apply requires explicit authorization",
      );
    }
    const createdAt = canonicalTimestamp(input.now ?? (() => new Date()));
    database.mutateWithEvent((transaction) => {
      transaction.run(
        `INSERT INTO authority_epochs (
           capability, epoch, mode, writer, effective_at_event_sequence,
           rollback_epoch, receipt_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        proposed.capability,
        proposed.epoch,
        proposed.mode,
        proposed.writer,
        proposed.effectiveAtEventSequence,
        proposed.rollbackEpoch,
        JSON.stringify(evidence),
        createdAt,
      );
      return {
        value: undefined,
        event: {
          type: "authority.epoch_changed",
          aggregateKind: "authorityEpoch",
          aggregateId: "authority:attachments",
          aggregateVersion: proposed.epoch,
          channelId: null,
          actorPrincipalId: evidence.operator,
          requestId: input.requestId,
          correlationId: input.correlationId,
          payload: {
            capability: proposed.capability,
            epoch: proposed.epoch,
            writer: proposed.writer,
            mode: proposed.mode,
          },
          createdAt,
        },
      };
    });
    return Object.freeze({
      ...plan,
      mutated: true,
      outcome: "initialized" as const,
    });
  } finally {
    database.close();
  }
}

function assertRegisteredFlags(receipt: AuthorityRolloutReceipt): void {
  const expected = Object.keys(FEATURE_FLAG_REGISTRY).sort();
  const actual = Object.keys(receipt.activeFlags ?? {}).sort();
  if (
    expected.length !== actual.length ||
    expected.some((flag, index) => actual[index] !== flag) ||
    expected.some((flag) => typeof receipt.activeFlags[flag] !== "boolean")
  ) {
    throw new Error(
      "attachment authority receipt must contain every registered Boolean flag",
    );
  }
  for (const required of [
    "coordination.process.enabled",
    "coordination.public_api.enabled",
    "coordination.resident.jerry.enabled",
  ]) {
    if (receipt.activeFlags[required] !== true) {
      throw new Error(
        "attachment authority transition must preserve stable Jerry direct messaging",
      );
    }
  }
}

/**
 * Validates and optionally appends one signed attachment authority transition.
 * The product-writer lock forces a bounded process drain before apply, and the
 * independent admission switch must already be off for activation or rollback.
 */
export function executeM31AttachmentAuthorityTransition(
  input: M31AttachmentAuthorityInput,
) {
  if (input.attachmentAdmissionEnabled !== false) {
    throw new Error(
      "attachment authority transition requires attachment admission disabled",
    );
  }
  assertCoordinationId("request", input.requestId);
  assertCoordinationId("correlation", input.correlationId);
  assertRegisteredFlags(input.receipt);
  const database = openCoordinationDatabase({
    path: input.databasePath,
    applicationVersion: "home23-coordination-m31-attachments-authority",
  });
  try {
    const history = database.readAll<AuthorityEpoch>(
      `SELECT capability, epoch, mode, writer,
              effective_at_event_sequence AS effectiveAtEventSequence,
              rollback_epoch AS rollbackEpoch
       FROM authority_epochs
       WHERE capability = 'attachments'
       ORDER BY epoch`,
    );
    if (history.length === 0) {
      throw new Error("attachment authority history is missing");
    }
    const current = history.at(-1)!;
    const proposed: AuthorityEpoch = Object.freeze({
      capability: "attachments",
      epoch: input.receipt.toEpoch,
      mode: input.receipt.toAuthority.mode,
      writer: input.receipt.toAuthority.writer,
      effectiveAtEventSequence: input.receipt.effectiveAtEventSequence,
      rollbackEpoch: input.receipt.rollbackTarget,
    });
    if (
      proposed.mode === "canonical" &&
      proposed.writer !== COORDINATION_ATTACHMENTS_WRITER
    ) {
      throw new Error(
        `M31 attachment canonical writer must be exactly ${COORDINATION_ATTACHMENTS_WRITER}`,
      );
    }
    const validation = validateAuthorityEpochTransition({
      current,
      proposed,
      history,
      receipt: input.receipt,
      activeCanonicalWriters: input.activeCanonicalWriters,
      verifySignature: (payload, signature) =>
        signature.algorithm === "ed25519" && verify(
          null,
          Buffer.from(payload),
          createPublicKey(input.publicKeyPem),
          Buffer.from(signature.value, "base64"),
        ),
    });
    if (validation.decision !== "valid") {
      throw new Error(
        `M31 attachment authority transition denied: ${validation.reason}`,
      );
    }
    const plan = Object.freeze({
      mode: input.apply === true ? "apply" as const : "preflight" as const,
      capability: "attachments" as const,
      current,
      proposed,
      attachmentAdmissionEnabled: false as const,
      receiptDigest: validation.receiptDigest ?? null,
      transitionDigest: validation.transitionDigest ?? null,
      mutated: false,
    });
    if (input.apply !== true) return plan;
    if (input.liveAuthorized !== true) {
      throw new Error(
        "M31 attachment authority apply requires explicit authorization and a valid signed receipt",
      );
    }
    database.mutateWithEvent((transaction) => {
      transaction.run(
        `INSERT INTO authority_epochs (
           capability, epoch, mode, writer, effective_at_event_sequence,
           rollback_epoch, receipt_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        proposed.capability,
        proposed.epoch,
        proposed.mode,
        proposed.writer,
        proposed.effectiveAtEventSequence,
        proposed.rollbackEpoch,
        JSON.stringify({
          receipt: input.receipt,
          attachmentAdmissionEnabled: false,
        }),
        input.receipt.issuedAt,
      );
      return {
        value: undefined,
        event: {
          type: "authority.epoch_changed",
          aggregateKind: "authorityEpoch",
          aggregateId: "authority:attachments",
          aggregateVersion: proposed.epoch,
          channelId: null,
          actorPrincipalId: input.receipt.operator,
          requestId: input.requestId,
          correlationId: input.correlationId,
          payload: {
            capability: proposed.capability,
            epoch: proposed.epoch,
            writer: proposed.writer,
            mode: proposed.mode,
          },
          createdAt: input.receipt.issuedAt,
        },
      };
    });
    return Object.freeze({ ...plan, mutated: true });
  } finally {
    database.close();
  }
}
