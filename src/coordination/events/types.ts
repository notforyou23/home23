import type { JsonValue, SqliteValue } from "../db/index.js";

export interface EventEnvelope {
  id: string;
  sequence: number;
  schemaVersion: number;
  type: string;
  durability: "durable" | "transient";
  aggregate: {
    kind: string;
    id: string;
    version: number;
  };
  channelId: string | null;
  actorPrincipalId: string | null;
  requestId: string;
  correlationId: string;
  createdAt: string;
  payload: { [key: string]: JsonValue };
}

export interface EventReadDatabase {
  readAll<T>(sql: string, ...parameters: SqliteValue[]): T[];
}

export type EventResetReason =
  | "cursor_expired"
  | "cursor_ahead"
  | "sequence_gap";

export interface EventCursorReset {
  error: {
    code: "cursor_expired";
    message: string;
    retryable: true;
    requestId: string;
    details: {
      bootstrapRequired: true;
      requestedAfterSequence: number;
      retentionFloorSequence: number;
      currentSequence: number;
      reason: EventResetReason;
    };
  };
}

export type EventResumeResult =
  | {
      kind: "events";
      events: readonly EventEnvelope[];
      throughSequence: number;
      currentSequence: number;
      retentionFloorSequence: number;
      hasMore: boolean;
    }
  | ({ kind: "reset" } & EventCursorReset);

export interface SseSink {
  /** False means the bytes were accepted but the transport must drain before another write. */
  write(chunk: string): boolean;
  waitForDrain(): Promise<void>;
}
