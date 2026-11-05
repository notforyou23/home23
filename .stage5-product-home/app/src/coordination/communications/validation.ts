import type { JsonValue } from "../db/index.js";
import { assertCoordinationId, isUuidV7 } from "../ids/index.js";
import {
  COMMUNICATION_EVENT_SCHEMA_VERSION,
  type CommunicationActorInput,
  type CommunicationEventEnvelope,
  type CommunicationEventInput,
  type CommunicationSourceInput,
  type EncodedCommunicationEventEnvelope,
} from "./types.js";

const COMMUNICATION_EVENT_ID_PATTERN = /^cevt_([0-9a-f-]+)$/;
const EVENT_KEYS = new Set([
  "schemaVersion", "eventId", "eventSequence", "conversationId", "channelId",
  "messageId", "workId", "attemptId", "turnId", "parentEventId", "actor",
  "source", "kind", "provenance", "occurredAt", "payload", "terminal",
]);
const ACTOR_KEYS = new Set(["principalId", "displayName", "kind"]);
const SOURCE_KEYS = new Set([
  "system", "provider", "model", "adapter", "sourceEventType",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCommunicationJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  }
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? value.every((entry) => isCommunicationJsonValue(entry, ancestors))
      : Object.values(value).every((entry) => isCommunicationJsonValue(entry, ancestors));
  } finally {
    ancestors.delete(value);
  }
}

function requiredString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`communication event ${label} must be a nonempty string`);
  }
}

function nullableString(value: unknown, label: string): asserts value is string | null {
  if (value !== null) requiredString(value, label);
}

function exactTimestamp(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError("communication event occurredAt must be a timestamp");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new TypeError("communication event occurredAt must be UTC ISO-8601 with milliseconds");
  }
}

function assertAdditionalFields(
  value: unknown,
  known: ReadonlySet<string>,
  label: string,
): asserts value is Readonly<Record<string, JsonValue>> | undefined {
  if (value === undefined) return;
  if (!isRecord(value) || !isCommunicationJsonValue(value)) {
    throw new TypeError(`communication event ${label} additional fields must be a JSON object`);
  }
  const collision = Object.keys(value).find((key) => known.has(key));
  if (collision) {
    throw new TypeError(`communication event ${label} additional field collides with ${collision}`);
  }
}

function assertActor(value: CommunicationActorInput): void {
  if (!isRecord(value)) throw new TypeError("communication event actor must be an object");
  requiredString(value.principalId, "actor principalId");
  requiredString(value.displayName, "actor displayName");
  requiredString(value.kind, "actor kind");
  assertAdditionalFields(value.additionalFields, ACTOR_KEYS, "actor");
}

function assertSource(value: CommunicationSourceInput): void {
  if (!isRecord(value)) throw new TypeError("communication event source must be an object");
  requiredString(value.system, "source system");
  for (const [name, field] of Object.entries({
    provider: value.provider ?? null,
    model: value.model ?? null,
    adapter: value.adapter ?? null,
    sourceEventType: value.sourceEventType ?? null,
  })) nullableString(field, `source ${name}`);
  assertAdditionalFields(value.additionalFields, SOURCE_KEYS, "source");
}

export function assertCommunicationEventId(value: string): void {
  const match = COMMUNICATION_EVENT_ID_PATTERN.exec(value);
  if (!match?.[1] || !isUuidV7(match[1])) {
    throw new TypeError("communication event eventId must be a canonical cevt_ UUIDv7");
  }
}

export function validateCommunicationEventInput(value: CommunicationEventInput): void {
  if (!isRecord(value)) throw new TypeError("communication event input must be an object");
  if ((value.schemaVersion ?? COMMUNICATION_EVENT_SCHEMA_VERSION) !== 1) {
    throw new TypeError("communication event schemaVersion must be 1");
  }
  if (value.eventId !== undefined) assertCommunicationEventId(value.eventId);
  assertCoordinationId("conversation", value.conversationId);
  assertCoordinationId("channel", value.channelId);
  if (value.messageId != null) assertCoordinationId("message", value.messageId);
  if (value.workId != null) assertCoordinationId("work", value.workId);
  if (value.attemptId != null) assertCoordinationId("attempt", value.attemptId);
  if (value.turnId != null) requiredString(value.turnId, "turnId");
  if (value.parentEventId != null) assertCommunicationEventId(value.parentEventId);
  assertActor(value.actor);
  assertSource(value.source);
  requiredString(value.kind, "kind");
  if (value.kind.includes("\n") || value.kind.includes("\r")) {
    throw new TypeError("communication event kind cannot contain line breaks");
  }
  if (value.kind === "reasoning") {
    requiredString(value.provenance, "reasoning provenance");
  } else if (value.provenance != null) {
    requiredString(value.provenance, "provenance");
  }
  exactTimestamp(value.occurredAt);
  if (!isRecord(value.payload) || !isCommunicationJsonValue(value.payload)) {
    throw new TypeError("communication event payload must be a lossless JSON object");
  }
  if (typeof value.terminal !== "boolean") {
    throw new TypeError("communication event terminal must be boolean");
  }
  assertAdditionalFields(value.additionalFields, EVENT_KEYS, "envelope");
}

function flattened(
  known: Readonly<Record<string, JsonValue>>,
  additional: Readonly<Record<string, JsonValue>> | undefined,
): Readonly<Record<string, JsonValue>> {
  return Object.freeze({ ...(additional ?? {}), ...known });
}

export function buildCommunicationEventEnvelope(input: {
  event: CommunicationEventInput;
  eventId: string;
  eventSequence: number;
}): CommunicationEventEnvelope {
  validateCommunicationEventInput(input.event);
  assertCommunicationEventId(input.eventId);
  if (!Number.isSafeInteger(input.eventSequence) || input.eventSequence < 1) {
    throw new TypeError("communication event eventSequence must be a positive safe integer");
  }
  const event = input.event;
  const additionalFields = Object.freeze({ ...(event.additionalFields ?? {}) });
  const actor = flattened({
    principalId: event.actor.principalId,
    displayName: event.actor.displayName,
    kind: event.actor.kind,
  }, event.actor.additionalFields);
  const source = flattened({
    system: event.source.system,
    provider: event.source.provider ?? null,
    model: event.source.model ?? null,
    adapter: event.source.adapter ?? null,
    sourceEventType: event.source.sourceEventType ?? null,
  }, event.source.additionalFields);
  return Object.freeze({
    schemaVersion: COMMUNICATION_EVENT_SCHEMA_VERSION,
    eventId: input.eventId,
    eventSequence: input.eventSequence,
    conversationId: event.conversationId,
    channelId: event.channelId,
    messageId: event.messageId ?? null,
    workId: event.workId ?? null,
    attemptId: event.attemptId ?? null,
    turnId: event.turnId ?? null,
    parentEventId: event.parentEventId ?? null,
    actor,
    source,
    kind: event.kind,
    provenance: event.provenance ?? null,
    occurredAt: event.occurredAt,
    payload: Object.freeze({ ...event.payload }),
    terminal: event.terminal,
    additionalFields,
  });
}

export function encodeCommunicationEventEnvelope(
  event: CommunicationEventEnvelope,
): EncodedCommunicationEventEnvelope {
  const { additionalFields, ...known } = event;
  return Object.freeze({ ...additionalFields, ...known }) as EncodedCommunicationEventEnvelope;
}

export function decodeCommunicationEventEnvelope(value: unknown): CommunicationEventEnvelope {
  if (!isRecord(value)) throw new TypeError("stored communication event must be an object");
  const eventSequence = value.eventSequence;
  if (!Number.isSafeInteger(eventSequence) || (eventSequence as number) < 1) {
    throw new TypeError("stored communication event sequence is invalid");
  }
  const knownInput: CommunicationEventInput = {
    schemaVersion: value.schemaVersion as 1,
    eventId: value.eventId as string,
    conversationId: value.conversationId as string,
    channelId: value.channelId as string,
    messageId: (value.messageId ?? null) as string | null,
    workId: (value.workId ?? null) as string | null,
    attemptId: (value.attemptId ?? null) as string | null,
    turnId: (value.turnId ?? null) as string | null,
    parentEventId: (value.parentEventId ?? null) as string | null,
    actor: actorInput(value.actor),
    source: sourceInput(value.source),
    kind: value.kind as string,
    provenance: (value.provenance ?? null) as string | null,
    occurredAt: value.occurredAt as string,
    payload: value.payload as Record<string, JsonValue>,
    terminal: value.terminal as boolean,
    additionalFields: unknownFields(value, EVENT_KEYS),
  };
  return buildCommunicationEventEnvelope({
    event: knownInput,
    eventId: knownInput.eventId!,
    eventSequence: eventSequence as number,
  });
}

function unknownFields(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const [key, field] of Object.entries(value)) {
    if (!known.has(key)) result[key] = field as JsonValue;
  }
  return result;
}

function actorInput(value: unknown): CommunicationActorInput {
  if (!isRecord(value)) throw new TypeError("stored communication actor is invalid");
  return {
    principalId: value.principalId as string,
    displayName: value.displayName as string,
    kind: value.kind as string,
    additionalFields: unknownFields(value, ACTOR_KEYS),
  };
}

function sourceInput(value: unknown): CommunicationSourceInput {
  if (!isRecord(value)) throw new TypeError("stored communication source is invalid");
  return {
    system: value.system as string,
    provider: (value.provider ?? null) as string | null,
    model: (value.model ?? null) as string | null,
    adapter: (value.adapter ?? null) as string | null,
    sourceEventType: (value.sourceEventType ?? null) as string | null,
    additionalFields: unknownFields(value, SOURCE_KEYS),
  };
}
