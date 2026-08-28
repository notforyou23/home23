import type { JsonValue } from "../db/index.js";

export const COMMUNICATION_EVENT_SCHEMA_VERSION = 1 as const;
export const COMMUNICATION_EVENT_TYPE = "communication.recorded" as const;

export const COMMUNICATION_EVENT_KINDS = Object.freeze([
  "user_message_committed",
  "assistant_response_delta",
  "assistant_message_committed",
  "reasoning",
  "tool_call_started",
  "tool_call_progress",
  "tool_call_completed",
  "subagent_started",
  "subagent_progress",
  "subagent_completed",
  "worker_started",
  "worker_progress",
  "worker_completed",
  "status",
  "usage",
  "cache",
  "media",
  "artifact",
  "failure",
  "receipt",
  "stop_requested",
  "retry_requested",
  "cancel_requested",
] as const);

export const COMMUNICATION_REASONING_PROVENANCE = Object.freeze([
  "provider_verbatim_reasoning",
  "provider_reasoning_summary",
  "agent_authored_explanation",
] as const);

export interface CommunicationActorInput {
  principalId: string;
  displayName: string;
  kind: string;
  additionalFields?: Readonly<Record<string, JsonValue>>;
}

export interface CommunicationSourceInput {
  system: string;
  provider?: string | null;
  model?: string | null;
  adapter?: string | null;
  sourceEventType?: string | null;
  additionalFields?: Readonly<Record<string, JsonValue>>;
}

/** Trusted-resident input. Core assigns the durable total-order sequence. */
export interface CommunicationEventInput {
  schemaVersion?: 1;
  eventId?: string;
  conversationId: string;
  channelId: string;
  messageId?: string | null;
  workId?: string | null;
  attemptId?: string | null;
  turnId?: string | null;
  parentEventId?: string | null;
  actor: CommunicationActorInput;
  source: CommunicationSourceInput;
  kind: string;
  provenance?: string | null;
  occurredAt: string;
  payload: Readonly<Record<string, JsonValue>>;
  terminal: boolean;
  additionalFields?: Readonly<Record<string, JsonValue>>;
}

export interface AppendCommunicationEventInput {
  event: CommunicationEventInput;
  requestId: string;
  correlationId: string;
}

export interface CommunicationEventEnvelope {
  schemaVersion: 1;
  eventId: string;
  eventSequence: number;
  conversationId: string;
  channelId: string;
  messageId: string | null;
  workId: string | null;
  attemptId: string | null;
  turnId: string | null;
  parentEventId: string | null;
  actor: Readonly<Record<string, JsonValue>>;
  source: Readonly<Record<string, JsonValue>>;
  kind: string;
  provenance: string | null;
  occurredAt: string;
  payload: Readonly<Record<string, JsonValue>>;
  terminal: boolean;
  /** Unknown additive fields, also flattened into encoded evidence. */
  additionalFields: Readonly<Record<string, JsonValue>>;
}

export type EncodedCommunicationEventEnvelope = Readonly<Record<string, JsonValue>>;

export type CommunicationEventAppendResult = Readonly<{
  outcome: "inserted" | "duplicate";
  event: CommunicationEventEnvelope;
}>;

export type CommunicationEventHistoryResult =
  | Readonly<{
      kind: "events";
      events: readonly CommunicationEventEnvelope[];
      throughSequence: number;
      currentSequence: number;
      retentionFloorSequence: number;
      hasMore: boolean;
    }>
  | Readonly<{
      kind: "reset";
      error: Readonly<{
        code: "cursor_expired";
        message: string;
        retryable: true;
        requestId: string;
        details: Readonly<{
          bootstrapRequired: true;
          requestedAfterSequence: number;
          retentionFloorSequence: number;
          currentSequence: number;
          reason: "cursor_expired" | "cursor_ahead" | "sequence_gap";
        }>;
      }>;
    }>;

export class CommunicationEventConflictError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super(`communication event ${eventId} conflicts with durable evidence`);
    this.name = "CommunicationEventConflictError";
    this.eventId = eventId;
  }
}
