import { createHash } from "node:crypto";

import type { JsonValue } from "../db/index.js";
import { assertCoordinationId } from "../ids/index.js";
import type {
  EventCursorReset,
  EventEnvelope,
  EventReadDatabase,
  EventResetReason,
  EventResumeResult,
} from "./types.js";

interface EventBatchRow {
  currentSequence: number;
  retentionFloorSequence: number;
  retainedEventCount: number;
  cursorRetained: number;
  sequence: number | null;
  id: string | null;
  schemaVersion: number | null;
  type: string | null;
  durability: "durable" | null;
  aggregateKind: string | null;
  aggregateId: string | null;
  aggregateVersion: number | null;
  channelId: string | null;
  actorPrincipalId: string | null;
  requestId: string | null;
  correlationId: string | null;
  payloadJson: string | null;
  payloadDigest: string | null;
  createdAt: string | null;
}

const EVENT_BATCH_SQL = `
WITH boundary AS (
  SELECT
    coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0)
      AS current_sequence,
    coalesce(
      (SELECT min(sequence) FROM events),
      coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0) + 1
    ) AS retention_floor_sequence,
    (SELECT count(*) FROM events) AS retained_event_count,
    EXISTS (SELECT 1 FROM events WHERE sequence = ?) AS cursor_retained
), page AS (
  SELECT * FROM events
  WHERE sequence > ? AND sequence <= (SELECT current_sequence FROM boundary)
  ORDER BY sequence ASC
  LIMIT ?
)
SELECT
  boundary.current_sequence AS currentSequence,
  boundary.retention_floor_sequence AS retentionFloorSequence,
  boundary.retained_event_count AS retainedEventCount,
  boundary.cursor_retained AS cursorRetained,
  page.sequence,
  page.id,
  page.schema_version AS schemaVersion,
  page.type,
  page.durability,
  page.aggregate_kind AS aggregateKind,
  page.aggregate_id AS aggregateId,
  page.aggregate_version AS aggregateVersion,
  page.channel_id AS channelId,
  page.actor_principal_id AS actorPrincipalId,
  page.request_id AS requestId,
  page.correlation_id AS correlationId,
  page.payload_json AS payloadJson,
  page.payload_digest AS payloadDigest,
  page.created_at AS createdAt
FROM boundary
LEFT JOIN page ON 1 = 1
ORDER BY page.sequence ASC`;

function reset(
  requestedAfterSequence: number,
  retentionFloorSequence: number,
  currentSequence: number,
  reason: EventResetReason,
  requestId: string,
): { kind: "reset" } & EventCursorReset {
  return Object.freeze({
    kind: "reset" as const,
    error: Object.freeze({
      code: "cursor_expired" as const,
      message: "The event cursor is no longer resumable. Bootstrap is required.",
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

function parsePayload(row: EventBatchRow): { [key: string]: JsonValue } {
  const digest = createHash("sha256")
    .update(row.payloadJson!, "utf8")
    .digest("hex");
  if (digest !== row.payloadDigest) {
    throw new Error(`coordination event payload digest mismatch at sequence ${row.sequence}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(row.payloadJson!);
  } catch {
    throw new Error(`coordination event payload is malformed at sequence ${row.sequence}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`coordination event payload is not an object at sequence ${row.sequence}`);
  }
  return value as { [key: string]: JsonValue };
}

function envelope(row: EventBatchRow): EventEnvelope {
  if (
    row.sequence === null || row.id === null || row.schemaVersion === null ||
    row.type === null || row.durability !== "durable" ||
    row.aggregateKind === null || row.aggregateId === null ||
    row.aggregateVersion === null || row.requestId === null ||
    row.correlationId === null || row.payloadJson === null ||
    row.payloadDigest === null || row.createdAt === null
  ) {
    throw new Error("coordination event row is incomplete");
  }
  return Object.freeze({
    id: row.id,
    sequence: row.sequence,
    schemaVersion: row.schemaVersion,
    type: row.type,
    durability: "durable" as const,
    aggregate: Object.freeze({
      kind: row.aggregateKind,
      id: row.aggregateId,
      version: row.aggregateVersion,
    }),
    channelId: row.channelId,
    actorPrincipalId: row.actorPrincipalId,
    requestId: row.requestId,
    correlationId: row.correlationId,
    createdAt: row.createdAt,
    payload: Object.freeze(parsePayload(row)),
  });
}

export class SqliteEventRepository {
  constructor(private readonly database: EventReadDatabase) {}

  resumeAfter(afterSequence: number, limit: number, requestId: string): EventResumeResult {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new TypeError("event resume cursor must be a nonnegative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError("event replay limit must be an integer from 1 through 1000");
    }
    assertCoordinationId("request", requestId);
    const rows = this.database.readAll<EventBatchRow>(
      EVENT_BATCH_SQL,
      afterSequence,
      afterSequence,
      limit,
    );
    const boundary = rows[0];
    if (!boundary) throw new Error("coordination event boundary query returned no row");
    const { currentSequence, retentionFloorSequence } = boundary;
    if (afterSequence > currentSequence) {
      return reset(
        afterSequence,
        retentionFloorSequence,
        currentSequence,
        "cursor_ahead",
        requestId,
      );
    }
    if (afterSequence + 1 < retentionFloorSequence) {
      return reset(
        afterSequence,
        retentionFloorSequence,
        currentSequence,
        "cursor_expired",
        requestId,
      );
    }
    const retainedSpan = currentSequence - retentionFloorSequence + 1;
    if (boundary.retainedEventCount !== retainedSpan) {
      return reset(
        afterSequence,
        retentionFloorSequence,
        currentSequence,
        "sequence_gap",
        requestId,
      );
    }
    if (
      afterSequence > 0 &&
      boundary.cursorRetained !== 1 && afterSequence + 1 !== retentionFloorSequence
    ) {
      return reset(
        afterSequence,
        retentionFloorSequence,
        currentSequence,
        "sequence_gap",
        requestId,
      );
    }
    const events = rows
      .filter((row) => row.sequence !== null)
      .map(envelope);
    let expected = afterSequence + 1;
    for (const event of events) {
      if (event.sequence !== expected) {
        return reset(
          afterSequence,
          retentionFloorSequence,
          currentSequence,
          "sequence_gap",
          requestId,
        );
      }
      expected += 1;
    }
    if (events.length === 0 && afterSequence < currentSequence) {
      return reset(
        afterSequence,
        retentionFloorSequence,
        currentSequence,
        "sequence_gap",
        requestId,
      );
    }
    const throughSequence = events.at(-1)?.sequence ?? afterSequence;
    return Object.freeze({
      kind: "events" as const,
      events: Object.freeze(events),
      throughSequence,
      currentSequence,
      retentionFloorSequence,
      hasMore: throughSequence < currentSequence,
    });
  }
}
