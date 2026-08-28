import { createHash } from "node:crypto";

import {
  canonicalCoordinationJson,
  type CoordinationDatabase,
  type JsonValue,
  type SqliteValue,
} from "../db/index.js";
import {
  assertCoordinationId,
  uuidV7,
  validateCoordinationId,
} from "../ids/index.js";
import {
  buildCommunicationEventEnvelope,
  decodeCommunicationEventEnvelope,
  encodeCommunicationEventEnvelope,
  validateCommunicationEventInput,
} from "./validation.js";
import {
  COMMUNICATION_EVENT_TYPE,
  CommunicationEventConflictError,
  type AppendCommunicationEventInput,
  type CommunicationEventAppendResult,
  type CommunicationEventEnvelope,
  type CommunicationEventHistoryResult,
} from "./types.js";

interface CommunicationRow {
  sequence: number;
  payloadJson: string;
  payloadDigest: string;
}

interface BoundaryRow {
  currentSequence: number;
  retentionFloorSequence: number;
  retainedEventCount: number;
}

function parseCommunicationRow(row: CommunicationRow): CommunicationEventEnvelope {
  const digest = createHash("sha256").update(row.payloadJson, "utf8").digest("hex");
  if (digest !== row.payloadDigest) {
    throw new Error(`communication event payload digest mismatch at sequence ${row.sequence}`);
  }
  let outer: unknown;
  try {
    outer = JSON.parse(row.payloadJson);
  } catch {
    throw new Error(`communication event payload is malformed at sequence ${row.sequence}`);
  }
  if (!outer || typeof outer !== "object" || Array.isArray(outer)) {
    throw new Error(`communication event payload is not an object at sequence ${row.sequence}`);
  }
  const value = (outer as Record<string, unknown>).communication;
  const event = decodeCommunicationEventEnvelope(value);
  if (event.eventSequence !== row.sequence) {
    throw new Error(`communication event sequence mismatch at sequence ${row.sequence}`);
  }
  return event;
}

function reset(
  requestId: string,
  requestedAfterSequence: number,
  retentionFloorSequence: number,
  currentSequence: number,
  reason: "cursor_expired" | "cursor_ahead" | "sequence_gap",
): Extract<CommunicationEventHistoryResult, { kind: "reset" }> {
  return Object.freeze({
    kind: "reset" as const,
    error: Object.freeze({
      code: "cursor_expired" as const,
      message: "The communication event cursor is no longer resumable. Bootstrap is required.",
      retryable: true as const,
      requestId,
      details: Object.freeze({
        bootstrapRequired: true as const,
        requestedAfterSequence,
        retentionFloorSequence,
        currentSequence,
        reason,
      }),
    }),
  });
}

/** Durable lossless communication evidence over the canonical global event cursor. */
export class SqliteCommunicationEventRepository {
  constructor(private readonly database: CoordinationDatabase) {}

  append(input: AppendCommunicationEventInput): CommunicationEventAppendResult {
    validateCommunicationEventInput(input.event);
    assertCoordinationId("request", input.requestId);
    assertCoordinationId("correlation", input.correlationId);
    const eventId = input.event.eventId ?? `cevt_${uuidV7()}`;

    const existing = this.findRowByEventId(eventId);
    if (existing) {
      const durable = parseCommunicationRow(existing);
      const candidate = buildCommunicationEventEnvelope({
        event: input.event,
        eventId,
        eventSequence: existing.sequence,
      });
      if (
        canonicalCoordinationJson(encodeCommunicationEventEnvelope(durable)) !==
        canonicalCoordinationJson(encodeCommunicationEventEnvelope(candidate))
      ) {
        throw new CommunicationEventConflictError(eventId);
      }
      return Object.freeze({ outcome: "duplicate" as const, event: durable });
    }

    const result = this.database.mutateWithEvent((transaction) => {
      const eventSequence = transaction.readOne<{ sequence: number }>(
        "SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0) + 1 AS sequence",
      )?.sequence;
      if (!Number.isSafeInteger(eventSequence) || eventSequence! < 1) {
        throw new Error("communication event sequence could not be allocated");
      }
      const aggregateVersion = transaction.readOne<{ version: number }>(
        `SELECT coalesce(max(aggregate_version), 0) + 1 AS version
         FROM events WHERE aggregate_kind = 'communication' AND aggregate_id = ?`,
        input.event.conversationId,
      )?.version;
      if (!Number.isSafeInteger(aggregateVersion) || aggregateVersion! < 1) {
        throw new Error("communication aggregate version could not be allocated");
      }
      const envelope = buildCommunicationEventEnvelope({
        event: input.event,
        eventId,
        eventSequence: eventSequence!,
      });
      return {
        value: envelope,
        event: {
          type: COMMUNICATION_EVENT_TYPE,
          aggregateKind: "communication",
          aggregateId: input.event.conversationId,
          aggregateVersion: aggregateVersion!,
          channelId: input.event.channelId,
          actorPrincipalId: validateCoordinationId("principal", input.event.actor.principalId)
            ? input.event.actor.principalId
            : null,
          requestId: input.requestId,
          correlationId: input.correlationId,
          payload: {
            communication: encodeCommunicationEventEnvelope(envelope) as JsonValue,
          },
          createdAt: input.event.occurredAt,
        },
      };
    });
    if (result.event.sequence !== result.value.eventSequence) {
      throw new Error("communication event allocation diverged from the durable sequence");
    }
    return Object.freeze({ outcome: "inserted" as const, event: result.value });
  }

  get(eventId: string): CommunicationEventEnvelope | null {
    const row = this.findRowByEventId(eventId);
    return row ? parseCommunicationRow(row) : null;
  }

  history(input: {
    afterSequence: number;
    limit: number;
    requestId: string;
    conversationId?: string;
  }): CommunicationEventHistoryResult {
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
      throw new TypeError("communication event cursor must be a nonnegative safe integer");
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new TypeError("communication event history limit must be from 1 through 1000");
    }
    assertCoordinationId("request", input.requestId);
    if (input.conversationId !== undefined) {
      assertCoordinationId("conversation", input.conversationId);
    }
    const boundary = this.database.readOne<BoundaryRow>(
      `SELECT
         coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0) AS currentSequence,
         coalesce((SELECT min(sequence) FROM events),
           coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0) + 1
         ) AS retentionFloorSequence,
         (SELECT count(*) FROM events) AS retainedEventCount`,
    );
    if (!boundary) throw new Error("communication event boundary query returned no row");
    if (input.afterSequence > boundary.currentSequence) {
      return reset(input.requestId, input.afterSequence, boundary.retentionFloorSequence,
        boundary.currentSequence, "cursor_ahead");
    }
    if (input.afterSequence + 1 < boundary.retentionFloorSequence) {
      return reset(input.requestId, input.afterSequence, boundary.retentionFloorSequence,
        boundary.currentSequence, "cursor_expired");
    }
    const retainedSpan = boundary.currentSequence - boundary.retentionFloorSequence + 1;
    if (boundary.retainedEventCount !== Math.max(0, retainedSpan)) {
      return reset(input.requestId, input.afterSequence, boundary.retentionFloorSequence,
        boundary.currentSequence, "sequence_gap");
    }

    const parameters: SqliteValue[] = [input.afterSequence, boundary.currentSequence];
    const conversation = input.conversationId === undefined
      ? ""
      : " AND json_extract(payload_json, '$.communication.conversationId') = ?";
    if (input.conversationId !== undefined) parameters.push(input.conversationId);
    parameters.push(input.limit + 1);
    const rows = this.database.readAll<CommunicationRow>(
      `SELECT sequence, payload_json AS payloadJson, payload_digest AS payloadDigest
       FROM events
       WHERE sequence > ? AND sequence <= ? AND type = '${COMMUNICATION_EVENT_TYPE}'${conversation}
       ORDER BY sequence ASC LIMIT ?`,
      ...parameters,
    );
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const events = Object.freeze(pageRows.map(parseCommunicationRow));
    const throughSequence = hasMore
      ? events.at(-1)!.eventSequence
      : boundary.currentSequence;
    return Object.freeze({
      kind: "events" as const,
      events,
      throughSequence,
      currentSequence: boundary.currentSequence,
      retentionFloorSequence: boundary.retentionFloorSequence,
      hasMore,
    });
  }

  private findRowByEventId(eventId: string): CommunicationRow | undefined {
    return this.database.readOne<CommunicationRow>(
      `SELECT sequence, payload_json AS payloadJson, payload_digest AS payloadDigest
       FROM events
       WHERE type = ? AND json_extract(payload_json, '$.communication.eventId') = ?
       LIMIT 1`,
      COMMUNICATION_EVENT_TYPE,
      eventId,
    );
  }
}
