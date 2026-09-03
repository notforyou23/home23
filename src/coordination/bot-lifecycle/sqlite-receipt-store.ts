import { createHash } from "node:crypto";

import type {
  CoordinationDatabase,
  CoordinationMutation,
  CoordinationTransaction,
  SqliteValue,
} from "../db/index.js";
import { generateCoordinationId, validateCoordinationId } from "../ids/index.js";
import type {
  BotLifecycleOperation,
  BotLifecyclePhase,
  BotLifecycleReceipt,
  BotLifecycleReceiptStore,
} from "./types.js";

const OPERATIONS = new Set<BotLifecycleOperation>(["create", "archive", "restore"]);
const PHASES = new Set<BotLifecyclePhase>([
  "authorized", "mailbox_bound", "mailbox_archived", "mailbox_restored",
]);
const FAILURE_PHASES = new Set(["mailbox_bind", "mailbox_transition"]);
const REQUEST_KEY = /^[\x20-\x7e]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RESIDENT = /^[a-z0-9][a-z0-9-]{0,62}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function botLifecycleRequestKeyDigest(requestId: string): string {
  if (!REQUEST_KEY.test(requestId)) {
    throw new TypeError("Bot lifecycle idempotency key is invalid");
  }
  return createHash("sha256")
    .update("home23-bot-lifecycle-idempotency:v1\0", "utf8")
    .update(requestId, "utf8")
    .digest("hex");
}

function parseReceipt(requestId: string, value: unknown): BotLifecycleReceipt {
  if (
    !isRecord(value) || !SHA256.test(String(value.requestDigest ?? "")) ||
    typeof value.correlationId !== "string" ||
    !validateCoordinationId("correlation", value.correlationId) ||
    !OPERATIONS.has(value.operation as BotLifecycleOperation) ||
    !(value.residentBinding === null ||
      (typeof value.residentBinding === "string" && RESIDENT.test(value.residentBinding))) ||
    !(value.botId === null ||
      (typeof value.botId === "string" && validateCoordinationId("bot", value.botId))) ||
    !(value.mailboxId === null ||
      (typeof value.mailboxId === "string" &&
       validateCoordinationId("conversation", value.mailboxId))) ||
    !Number.isSafeInteger(value.authorityEpoch) || Number(value.authorityEpoch) < 1 ||
    (value.outcome !== "succeeded" && value.outcome !== "failed") ||
    !Array.isArray(value.completedPhases) ||
    value.completedPhases.some((phase) => !PHASES.has(phase as BotLifecyclePhase)) ||
    typeof value.createdAt !== "string"
  ) {
    throw new Error("stored Bot lifecycle receipt is malformed");
  }
  const createdAt = new Date(value.createdAt);
  if (Number.isNaN(createdAt.valueOf()) || createdAt.toISOString() !== value.createdAt) {
    throw new Error("stored Bot lifecycle receipt timestamp is malformed");
  }
  const policy = value.policyDecision;
  if (
    !isRecord(policy) || policy.policyVersion !== 1 || policy.decision !== "allow" ||
    typeof policy.actionDigest !== "string" || !SHA256.test(policy.actionDigest) ||
    typeof policy.policyContextDigest !== "string" ||
    !SHA256.test(policy.policyContextDigest) ||
    policy.reasonCode !== "allow.standing_authority"
  ) {
    throw new Error("stored Bot lifecycle policy receipt is malformed");
  }
  const failure = value.failure;
  if (!(failure === null || (
    isRecord(failure) && FAILURE_PHASES.has(String(failure.phase)) &&
    typeof failure.code === "string" && failure.code.length >= 1 &&
    failure.code.length <= 128
  ))) {
    throw new Error("stored Bot lifecycle failure receipt is malformed");
  }
  if ((value.outcome === "succeeded") !== (failure === null)) {
    throw new Error("stored Bot lifecycle outcome is inconsistent");
  }
  return Object.freeze({
    requestId,
    requestDigest: value.requestDigest as string,
    correlationId: value.correlationId,
    operation: value.operation as BotLifecycleOperation,
    residentBinding: value.residentBinding as string | null,
    botId: value.botId as string | null,
    mailboxId: value.mailboxId as string | null,
    authorityEpoch: value.authorityEpoch as number,
    policyDecision: Object.freeze({
      policyVersion: 1 as const,
      actionDigest: policy.actionDigest,
      policyContextDigest: policy.policyContextDigest,
      decision: "allow" as const,
      reasonCode: "allow.standing_authority" as const,
    }),
    outcome: value.outcome,
    completedPhases: Object.freeze([...(value.completedPhases as BotLifecyclePhase[])]),
    failure: failure === null ? null : Object.freeze({
      phase: failure.phase as NonNullable<BotLifecycleReceipt["failure"]>["phase"],
      code: failure.code as string,
    }),
    createdAt: value.createdAt,
  });
}

interface ReceiptRow {
  requestKeyDigest: string;
  requestDigest: string;
  correlationId: string;
  operation: string;
  receiptJson: string;
}

function receiptFromRow(requestId: string, row: ReceiptRow): BotLifecycleReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.receiptJson);
  } catch {
    throw new Error("stored Bot lifecycle receipt JSON is malformed");
  }
  const receipt = parseReceipt(requestId, parsed);
  if (
    row.requestKeyDigest !== botLifecycleRequestKeyDigest(requestId) ||
    row.requestDigest !== receipt.requestDigest ||
    row.correlationId !== receipt.correlationId ||
    row.operation !== receipt.operation
  ) {
    throw new Error("stored Bot lifecycle receipt columns disagree");
  }
  return receipt;
}

const SELECT_RECEIPT = `SELECT request_key_digest AS requestKeyDigest,
  request_digest AS requestDigest, correlation_id AS correlationId,
  operation, receipt_json AS receiptJson
  FROM bot_lifecycle_receipts WHERE request_key_digest = ?`;

interface ReceiptReader {
  readOne<T>(sql: string, ...parameters: SqliteValue[]): T | undefined;
}

export function readBotLifecycleReceipt(
  reader: ReceiptReader,
  requestId: string,
): BotLifecycleReceipt | null {
  const keyDigest = botLifecycleRequestKeyDigest(requestId);
  const row = reader.readOne<ReceiptRow>(SELECT_RECEIPT, keyDigest);
  return row ? receiptFromRow(requestId, row) : null;
}

export function insertBotLifecycleReceipt(
  transaction: CoordinationTransaction,
  receipt: BotLifecycleReceipt,
): Readonly<{ receipt: BotLifecycleReceipt; keyDigest: string; inserted: boolean }> {
  const canonical = parseReceipt(receipt.requestId, receipt);
  const keyDigest = botLifecycleRequestKeyDigest(canonical.requestId);
  const prior = transaction.readOne<ReceiptRow>(SELECT_RECEIPT, keyDigest);
  if (prior) {
    return Object.freeze({
      receipt: receiptFromRow(canonical.requestId, prior),
      keyDigest,
      inserted: false,
    });
  }
  const { requestId: _rawIdempotencyKey, ...persisted } = canonical;
  transaction.run(
    `INSERT INTO bot_lifecycle_receipts
       (request_key_digest, request_digest, correlation_id, operation,
        receipt_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    keyDigest,
    canonical.requestDigest,
    canonical.correlationId,
    canonical.operation,
    JSON.stringify(persisted),
    canonical.createdAt,
  );
  return Object.freeze({ receipt: canonical, keyDigest, inserted: true });
}

export class SqliteBotLifecycleReceiptStore implements BotLifecycleReceiptStore {
  constructor(private readonly database: CoordinationDatabase) {}

  async get(requestId: string): Promise<BotLifecycleReceipt | null> {
    return readBotLifecycleReceipt(this.database, requestId);
  }

  async putIfAbsent(receipt: BotLifecycleReceipt): Promise<BotLifecycleReceipt> {
    const canonical = parseReceipt(receipt.requestId, receipt);
    const prior = readBotLifecycleReceipt(this.database, canonical.requestId);
    if (prior) return prior;
    return this.database.mutateWithEvent<BotLifecycleReceipt>(
      (transaction): CoordinationMutation<BotLifecycleReceipt> => {
        const stored = insertBotLifecycleReceipt(transaction, canonical);
        if (!stored.inserted) {
          const aggregateVersion = (transaction.readOne<{ version: number | null }>(
            `SELECT max(aggregate_version) AS version FROM events
             WHERE aggregate_kind = 'botLifecycleReceipt' AND aggregate_id = ?`,
            stored.keyDigest,
          )?.version ?? 0) + 1;
          return {
            value: stored.receipt,
            event: {
              type: "bot_lifecycle.receipt_replayed",
              aggregateKind: "botLifecycleReceipt",
              aggregateId: stored.keyDigest,
              aggregateVersion,
              channelId: null,
              actorPrincipalId: "user_owner",
              requestId: generateCoordinationId("request"),
              correlationId: canonical.correlationId,
              payload: {
                requestKeyDigest: stored.keyDigest,
                operation: stored.receipt.operation,
              },
              createdAt: canonical.createdAt,
            },
          };
        }
        return {
          value: stored.receipt,
          event: {
            type: "bot_lifecycle.receipt_recorded",
            aggregateKind: "botLifecycleReceipt",
            aggregateId: stored.keyDigest,
            aggregateVersion: 1,
            channelId: null,
            actorPrincipalId: "user_owner",
            requestId: generateCoordinationId("request"),
            correlationId: canonical.correlationId,
            payload: {
              requestKeyDigest: stored.keyDigest,
              requestDigest: canonical.requestDigest,
              operation: canonical.operation,
              outcome: canonical.outcome,
            },
            createdAt: canonical.createdAt,
          },
        };
      },
    ).value;
  }
}
