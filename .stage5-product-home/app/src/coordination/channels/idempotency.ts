import { createHash } from "node:crypto";

import { digestExactAction, type JsonValue } from "../policy/index.js";
import { MessagingError } from "./errors.js";
import type { MessagingIdempotencyClaim } from "./types.js";

const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7e]{16,128}$/;

export function createMessagingIdempotencyClaim(
  operation: MessagingIdempotencyClaim["operation"],
  principalId: string,
  idempotencyKey: string,
  request: JsonValue,
): MessagingIdempotencyClaim {
  if (
    typeof idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
  ) {
    throw new MessagingError("request_invalid");
  }
  return Object.freeze({
    operation,
    keyDigest: createHash("sha256")
      .update(`home23-messaging-idempotency:${operation}:v1\0`, "utf8")
      .update(idempotencyKey, "utf8")
      .digest("hex"),
    requestDigest: digestExactAction({
      actorPrincipalId: principalId,
      operation,
      target: "messaging_mutation",
      parameters: request,
    }),
  });
}
