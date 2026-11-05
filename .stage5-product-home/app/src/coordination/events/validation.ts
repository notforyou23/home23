import { assertCoordinationId } from "../ids/index.js";

import type { EventEnvelope } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((entry) => isJsonValue(entry, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(value).every((entry) => isJsonValue(entry, ancestors));
  } finally {
    ancestors.delete(value);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`event envelope ${label} must be a positive safe integer`);
  }
}

function assertId(
  kind: "event" | "channel" | "principal" | "request" | "correlation",
  value: unknown,
  label: string = kind,
): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`event envelope ${label} ID is invalid`);
  }
  try {
    assertCoordinationId(kind, value);
  } catch {
    throw new TypeError(`event envelope ${label} ID is invalid`);
  }
}

/** Validate the complete M02 event envelope before cursor state can advance. */
export function validateEventEnvelope(value: unknown): EventEnvelope {
  if (!isRecord(value)) throw new TypeError("event envelope must be an object");

  assertId("event", value.id);
  assertPositiveInteger(value.sequence, "sequence");
  if (value.schemaVersion !== 1) {
    throw new TypeError("event envelope schema version must be 1");
  }
  if (typeof value.type !== "string" || value.type.length < 3) {
    throw new TypeError("event envelope type must contain at least 3 characters");
  }
  if (value.type.includes("\n") || value.type.includes("\r")) {
    throw new TypeError("event envelope type cannot contain SSE line breaks");
  }
  if (value.durability !== "durable" && value.durability !== "transient") {
    throw new TypeError("event envelope durability is invalid");
  }
  if (!isRecord(value.aggregate)) {
    throw new TypeError("event envelope aggregate must be an object");
  }
  if (typeof value.aggregate.kind !== "string" || value.aggregate.kind.length < 1) {
    throw new TypeError("event envelope aggregate kind is required");
  }
  if (typeof value.aggregate.id !== "string" || value.aggregate.id.length < 1) {
    throw new TypeError("event envelope aggregate ID is required");
  }
  assertPositiveInteger(value.aggregate.version, "aggregate version");

  if (value.channelId !== null) assertId("channel", value.channelId);
  if (value.actorPrincipalId !== null) {
    assertId("principal", value.actorPrincipalId, "actor principal");
  }
  assertId("request", value.requestId);
  assertId("correlation", value.correlationId);

  if (typeof value.createdAt !== "string") {
    throw new TypeError("event envelope timestamp is invalid");
  }
  const createdAt = new Date(value.createdAt);
  if (Number.isNaN(createdAt.valueOf()) || createdAt.toISOString() !== value.createdAt) {
    throw new TypeError("event envelope timestamp is invalid");
  }
  if (!isRecord(value.payload) || !isJsonValue(value.payload)) {
    throw new TypeError("event envelope payload must be a JSON object");
  }
  if (!isJsonValue(value)) {
    throw new TypeError("event envelope must contain only JSON values");
  }

  return value as unknown as EventEnvelope;
}
