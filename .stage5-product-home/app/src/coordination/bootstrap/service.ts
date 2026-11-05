import { createHash } from "node:crypto";

import { MessagingError, resolveMessagingActor } from "../channels/index.js";
import type {
  BootstrapResponse,
  BootstrapService,
  BootstrapSnapshot,
  CreateBootstrapServiceOptions,
} from "./types.js";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("bootstrap projection has a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") {
    throw new TypeError("bootstrap projection contains a non-JSON value");
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

export function digestBootstrapProjection(snapshot: BootstrapSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot), "utf8").digest("hex");
}

export function createBootstrapService(
  options: CreateBootstrapServiceOptions,
): BootstrapService {
  const now = options.now ?? (() => new Date());

  async function getBootstrap(input: Parameters<BootstrapService["getBootstrap"]>[0]) {
    const actor = await resolveMessagingActor(
      input.context,
      options.participantDirectory,
      "product:read",
    );
    if (actor.kind !== "owner" || input.context.identity.kind !== "owner") {
      throw new MessagingError("identity_context_mismatch");
    }
    const at = now().toISOString();
    const boundary = options.repository.readProjection({
      principalId: actor.principalId,
      at,
      availabilityPolicy: options.availabilityPolicy,
    });
    const auth = input.context.identity.auth;
    const response: BootstrapResponse = {
      contractVersion: 1,
      minimumClientBuild: options.minimumClientBuild,
      serverTime: at,
      requestId: actor.requestId,
      correlationId: actor.correlationId,
      home: Object.freeze({ ...options.home }),
      client: Object.freeze({
        sessionId: auth.sessionId,
        deviceId: auth.deviceId,
        principalId: "user_owner",
        scopes: Object.freeze([...auth.scopes]),
      }),
      connection: Object.freeze({ ...options.connection }),
      capabilities: Object.freeze({ ...options.capabilities }),
      limits: Object.freeze({ ...options.limits }),
      snapshot: boundary.snapshot,
      eventCursor: boundary.throughEventSequence,
      throughEventSequence: boundary.throughEventSequence,
    };
    return Object.freeze(response);
  }

  return Object.freeze({ getBootstrap });
}
