import { createPublicKey, verify } from "node:crypto";

import { openCoordinationDatabase } from "../db/index.js";
import {
  COORDINATION_BOT_LIFECYCLE_WRITER,
  validateAuthorityEpochTransition,
  validateInitialAuthorityEpoch,
  type AuthorityEpoch,
  type AuthorityRolloutReceipt,
} from "../epochs/index.js";
import { assertCoordinationId } from "../ids/index.js";
import { FEATURE_FLAG_REGISTRY } from "../schema/contract-registry.js";

export const FEATURE_OFF_BOT_LIFECYCLE_WRITER =
  "feature-off-bot-lifecycle-disabled" as const;

export interface BotLifecycleBaselineEvidence {
  approved: true;
  kind: "bot-lifecycle-feature-off-baseline";
  operator: "user_owner";
  botLifecycleEnabled: false;
  noExistingBotLifecycleWriter: true;
}

export interface BotLifecycleBaselineInput {
  databasePath: string;
  evidence?: BotLifecycleBaselineEvidence;
  requestId: string;
  correlationId: string;
  apply?: boolean;
  liveAuthorized?: boolean;
  now?: () => Date;
}

export interface BotLifecycleAuthorityInput {
  databasePath: string;
  receipt: AuthorityRolloutReceipt;
  publicKeyPem: string;
  activeCanonicalWriters: readonly string[];
  /** Authority changes happen only while the product route remains disabled. */
  botLifecycleEnabled: false;
  requestId: string;
  correlationId: string;
  apply?: boolean;
  liveAuthorized?: boolean;
}

function exactBaselineEvidence(
  value: BotLifecycleBaselineEvidence | undefined,
): value is BotLifecycleBaselineEvidence {
  return value?.approved === true &&
    value.kind === "bot-lifecycle-feature-off-baseline" &&
    value.operator === "user_owner" &&
    value.botLifecycleEnabled === false &&
    value.noExistingBotLifecycleWriter === true;
}

function canonicalTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("bot lifecycle authority clock returned an invalid date");
  }
  return new Date(value.getTime()).toISOString();
}

/** Establish only the feature-off legacy epoch. This cannot activate Bots. */
export function initializeBotLifecycleAuthority(
  input: BotLifecycleBaselineInput,
) {
  if (!exactBaselineEvidence(input.evidence)) {
    throw new Error(
      "bot lifecycle authority baseline requires explicit feature-off evidence",
    );
  }
  const evidence = input.evidence;
  assertCoordinationId("request", input.requestId);
  assertCoordinationId("correlation", input.correlationId);
  const proposed: AuthorityEpoch = Object.freeze({
    capability: "bot_lifecycle",
    epoch: 1,
    mode: "legacy",
    writer: FEATURE_OFF_BOT_LIFECYCLE_WRITER,
    effectiveAtEventSequence: null,
    rollbackEpoch: null,
  });
  if (validateInitialAuthorityEpoch(proposed).decision !== "valid") {
    throw new Error("initial bot lifecycle authority epoch is invalid");
  }
  const database = openCoordinationDatabase({
    path: input.databasePath,
    applicationVersion: "home23-coordination-bot-lifecycle-baseline",
  });
  try {
    const existing = database.readOne<AuthorityEpoch>(
      `SELECT capability, epoch, mode, writer,
              effective_at_event_sequence AS effectiveAtEventSequence,
              rollback_epoch AS rollbackEpoch
       FROM authority_epochs
       WHERE capability = 'bot_lifecycle'
       ORDER BY epoch DESC LIMIT 1`,
    );
    if (existing) {
      if (
        existing.epoch !== proposed.epoch || existing.mode !== proposed.mode ||
        existing.writer !== proposed.writer ||
        existing.effectiveAtEventSequence !== null ||
        existing.rollbackEpoch !== null
      ) {
        throw new Error(
          "existing bot lifecycle authority is not the feature-off baseline",
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
        "bot lifecycle authority baseline apply requires explicit authorization",
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
          aggregateId: "authority:bot_lifecycle",
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
    return Object.freeze({ ...plan, mutated: true, outcome: "initialized" as const });
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
      "bot lifecycle authority receipt must contain every registered Boolean flag",
    );
  }
  for (const required of [
    "coordination.process.enabled",
    "coordination.public_api.enabled",
    "coordination.resident.jerry.enabled",
    "coordination.resident.forrest.enabled",
    "coordination.channels.enabled",
  ]) {
    if (receipt.activeFlags[required] !== true) {
      throw new Error(
        "bot lifecycle transition must preserve both house-agent conversations",
      );
    }
  }
  if (receipt.activeFlags["coordination.bot_lifecycle.enabled"] !== false) {
    throw new Error(
      "bot lifecycle authority must transition before its product route is enabled",
    );
  }
}

/** Validate and optionally append one signed Bot lifecycle authority epoch. */
export function executeBotLifecycleAuthorityTransition(
  input: BotLifecycleAuthorityInput,
) {
  if (input.botLifecycleEnabled !== false) {
    throw new Error(
      "bot lifecycle authority transition requires the product route disabled",
    );
  }
  assertCoordinationId("request", input.requestId);
  assertCoordinationId("correlation", input.correlationId);
  assertRegisteredFlags(input.receipt);
  const database = openCoordinationDatabase({
    path: input.databasePath,
    applicationVersion: "home23-coordination-bot-lifecycle-authority",
  });
  try {
    const destination = database.readOne<{
      eventSequence: number;
      messageCount: number;
    }>(`
      SELECT
        (SELECT COALESCE(MAX(sequence), 0) FROM events) AS eventSequence,
        (SELECT count(*) FROM messages) AS messageCount
    `);
    if (
      destination?.eventSequence !== input.receipt.destinationWatermark.eventSequence ||
      destination?.messageCount !== input.receipt.destinationWatermark.messageCount
    ) {
      throw new Error(
        "bot lifecycle authority destination watermark no longer matches the database",
      );
    }
    const history = database.readAll<AuthorityEpoch>(
      `SELECT capability, epoch, mode, writer,
              effective_at_event_sequence AS effectiveAtEventSequence,
              rollback_epoch AS rollbackEpoch
       FROM authority_epochs
       WHERE capability = 'bot_lifecycle'
       ORDER BY epoch`,
    );
    if (history.length === 0) {
      throw new Error("bot lifecycle authority history is missing");
    }
    const current = history.at(-1)!;
    const proposed: AuthorityEpoch = Object.freeze({
      capability: "bot_lifecycle",
      epoch: input.receipt.toEpoch,
      mode: input.receipt.toAuthority.mode,
      writer: input.receipt.toAuthority.writer,
      effectiveAtEventSequence: input.receipt.effectiveAtEventSequence,
      rollbackEpoch: input.receipt.rollbackTarget,
    });
    if (
      proposed.mode === "canonical" &&
      proposed.writer !== COORDINATION_BOT_LIFECYCLE_WRITER
    ) {
      throw new Error(
        `bot lifecycle canonical writer must be exactly ${COORDINATION_BOT_LIFECYCLE_WRITER}`,
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
        `bot lifecycle authority transition denied: ${validation.reason}`,
      );
    }
    const plan = Object.freeze({
      mode: input.apply === true ? "apply" as const : "preflight" as const,
      capability: "bot_lifecycle" as const,
      current,
      proposed,
      botLifecycleEnabled: false as const,
      receiptDigest: validation.receiptDigest ?? null,
      transitionDigest: validation.transitionDigest ?? null,
      mutated: false,
    });
    if (input.apply !== true) return plan;
    if (input.liveAuthorized !== true) {
      throw new Error(
        "bot lifecycle authority apply requires explicit authorization and a valid signed receipt",
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
        JSON.stringify({ receipt: input.receipt, botLifecycleEnabled: false }),
        input.receipt.issuedAt,
      );
      return {
        value: undefined,
        event: {
          type: "authority.epoch_changed",
          aggregateKind: "authorityEpoch",
          aggregateId: "authority:bot_lifecycle",
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
