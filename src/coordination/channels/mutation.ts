import type {
  CoordinationTransaction,
  JsonValue,
  StoredCoordinationEvent,
} from "../db/index.js";
import { MessagingError } from "./errors.js";
import type { MessagingDatabase } from "./database.js";
import type {
  MessagingIdempotencyClaim,
  MessagingMutationReceipt,
  ResolvedMessagingActor,
} from "./types.js";

export interface MessagingIdempotencyRow {
  requestDigest: string;
  resultRefJson: string;
  requestId: string;
  correlationId: string;
}

export interface MessagingEventReference extends Record<string, JsonValue> {
  aggregateKind: string;
  aggregateId: string;
  aggregateVersion: number;
}

export function parseMessagingEventReference(
  value: unknown,
  malformedMessage: string,
): MessagingEventReference {
  const reference = value as Partial<MessagingEventReference> | null;
  if (
    !reference ||
    typeof reference.aggregateKind !== "string" ||
    reference.aggregateKind.length < 1 ||
    typeof reference.aggregateId !== "string" ||
    reference.aggregateId.length < 1 ||
    !Number.isSafeInteger(reference.aggregateVersion) ||
    (reference.aggregateVersion ?? 0) < 1
  ) {
    throw new Error(malformedMessage);
  }
  return Object.freeze({
    aggregateKind: reference.aggregateKind,
    aggregateId: reference.aggregateId,
    aggregateVersion: reference.aggregateVersion!,
  });
}

export function readMessagingIdempotency(
  reader: Pick<MessagingDatabase, "readOne"> | Pick<CoordinationTransaction, "readOne">,
  principalId: string,
  claim: MessagingIdempotencyClaim,
): MessagingIdempotencyRow | null {
  const row = reader.readOne<MessagingIdempotencyRow>(
    `SELECT request_digest AS requestDigest,
            result_ref_json AS resultRefJson,
            request_id AS requestId,
            correlation_id AS correlationId
     FROM idempotency_records
     WHERE principal_id = ? AND operation = ? AND idempotency_key_digest = ?`,
    principalId,
    claim.operation,
    claim.keyDigest,
  );
  if (!row) return null;
  if (row.requestDigest !== claim.requestDigest) {
    throw new MessagingError("idempotency_conflict");
  }
  return row;
}

export function insertMessagingIdempotency(
  transaction: CoordinationTransaction,
  input: {
    actor: ResolvedMessagingActor;
    claim: MessagingIdempotencyClaim;
    resultKind: "channel" | "message" | "read_cursor";
    resultRef: Record<string, JsonValue>;
    createdAt: string;
  },
): void {
  transaction.run(
    `INSERT INTO idempotency_records (
      principal_id, operation, idempotency_key_digest, request_digest,
      result_kind, result_ref_json, request_id, correlation_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.actor.principalId,
    input.claim.operation,
    input.claim.keyDigest,
    input.claim.requestDigest,
    input.resultKind,
    JSON.stringify(input.resultRef),
    input.actor.requestId,
    input.actor.correlationId,
    input.createdAt,
  );
}

export function assertStoredActorBinding(
  reader: Pick<MessagingDatabase, "readOne"> | Pick<CoordinationTransaction, "readOne">,
  actor: ResolvedMessagingActor,
): void {
  if (actor.kind === "owner") {
    if (
      actor.principalId !== "user_owner" ||
      actor.displayName !== "Owner" ||
      actor.residentCredential !== null
    ) {
      throw new MessagingError("identity_context_mismatch");
    }
    return;
  }
  const credential = actor.residentCredential;
  if (!credential) {
    const processless = reader.readOne<{
      name: string;
      requiredCapabilitiesJson: string;
    }>(
      `SELECT name, required_capabilities_json AS requiredCapabilitiesJson
       FROM bots
       WHERE id = ? AND principal_id = ? AND resident_binding LIKE 'bot-%'
         AND lifecycle = 'active' AND continuing_identity = 1 AND durable_mailbox = 1
         AND conversation_id IS NOT NULL
         AND active_instance_id IS NULL AND active_key_version IS NULL
         AND resident_protocol_version IS NULL AND resident_registered_at IS NULL
         AND json_array_length(resident_capabilities_json) = 0`,
      actor.principalId,
      actor.principalId,
    );
    let requiredCapabilities: unknown;
    try {
      requiredCapabilities = processless
        ? JSON.parse(processless.requiredCapabilitiesJson)
        : null;
    } catch {
      throw new MessagingError("identity_context_mismatch");
    }
    if (
      !processless || actor.displayName !== processless.name ||
      !Array.isArray(requiredCapabilities) ||
      !requiredCapabilities.includes("messages")
    ) {
      throw new MessagingError("identity_context_mismatch");
    }
    return;
  }
  const row = reader.readOne<{
    id: string;
    name: string;
    requiredCapabilitiesJson: string;
    residentCapabilitiesJson: string;
  }>(
    `SELECT id, name,
            required_capabilities_json AS requiredCapabilitiesJson,
            resident_capabilities_json AS residentCapabilitiesJson
     FROM bots
     WHERE id = ? AND principal_id = ? AND resident_binding = ?
       AND lifecycle = 'active' AND continuing_identity = 1 AND durable_mailbox = 1
       AND active_instance_id = ? AND active_key_version = ?
       AND resident_protocol_version = 1`,
    actor.principalId,
    actor.principalId,
    credential.residentBinding,
    credential.instanceId,
    credential.keyVersion,
  );
  if (!row || actor.displayName !== row.name) {
    throw new MessagingError("identity_context_mismatch");
  }
  let requiredCapabilities: unknown;
  let capabilities: unknown;
  try {
    requiredCapabilities = JSON.parse(row.requiredCapabilitiesJson);
    capabilities = JSON.parse(row.residentCapabilitiesJson);
  } catch {
    throw new MessagingError("identity_context_mismatch");
  }
  if (
    !Array.isArray(requiredCapabilities) ||
    !requiredCapabilities.includes("messages") ||
    !Array.isArray(capabilities) ||
    !capabilities.includes("messages")
  ) {
    throw new MessagingError("identity_context_mismatch");
  }
}

export function mutationReceipt(
  event: StoredCoordinationEvent,
  resourceVersion: number,
): MessagingMutationReceipt {
  return Object.freeze({
    resourceVersion,
    eventSequence: event.sequence,
    requestId: event.requestId,
    correlationId: event.correlationId,
  });
}

export function replayReceipt(
  database: Pick<MessagingDatabase, "readOne">,
  row: MessagingIdempotencyRow,
  reference: MessagingEventReference,
  resourceVersion: number,
): MessagingMutationReceipt {
  const event = database.readOne<{
    sequence: number;
    requestId: string;
    correlationId: string;
  }>(
    `SELECT sequence, request_id AS requestId, correlation_id AS correlationId
     FROM events
     WHERE aggregate_kind = ? AND aggregate_id = ? AND aggregate_version = ?`,
    reference.aggregateKind,
    reference.aggregateId,
    reference.aggregateVersion,
  );
  if (
    !event ||
    event.requestId !== row.requestId ||
    event.correlationId !== row.correlationId
  ) {
    throw new Error("messaging idempotency result has no exact committed event");
  }
  return Object.freeze({
    resourceVersion,
    eventSequence: event.sequence,
    requestId: event.requestId,
    correlationId: event.correlationId,
  });
}
