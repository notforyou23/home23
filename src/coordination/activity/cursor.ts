import { createHmac, timingSafeEqual } from "node:crypto";

import { assertCoordinationId } from "../ids/index.js";

import type { ActivityBoundary, ActivityScope } from "./types.js";

const CURSOR_ROUTE = "/api/v1/activity";
const CURSOR_DIRECTION = "forward";
const CURSOR_DOMAIN = "home23-activity-cursor:v1\0";
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ACTIVITY_KEY = /^[A-Za-z0-9:_-]{1,256}$/;

interface ActivityCursorPayload extends ActivityBoundary {
  v: 1;
  route: typeof CURSOR_ROUTE;
  direction: typeof CURSOR_DIRECTION;
  principalId: string;
  scope: string;
}

function invalidCursor(): never {
  throw new TypeError("activity cursor is invalid");
}

function scopeKey(scope: ActivityScope): string {
  return scope.kind === "all" ? "all" : `channel:${scope.channelId}`;
}

function assertBinding(principalId: string, scope: ActivityScope): void {
  try {
    assertCoordinationId("principal", principalId);
    if (scope.kind === "channel") assertCoordinationId("channel", scope.channelId);
    else if (scope.kind !== "all") invalidCursor();
  } catch {
    invalidCursor();
  }
}

function assertBoundary(boundary: ActivityBoundary): void {
  if (!Number.isSafeInteger(boundary.eventSequence) || boundary.eventSequence < 1 ||
    typeof boundary.key !== "string" || !ACTIVITY_KEY.test(boundary.key)) {
    invalidCursor();
  }
}

export class ActivityCursorCodec {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (!(key instanceof Uint8Array) || key.byteLength < 32) {
      throw new TypeError("activity cursor signing key must contain at least 256 bits");
    }
    this.key = Buffer.from(key);
  }

  encode(boundary: ActivityBoundary, principalId: string, scope: ActivityScope): string {
    assertBoundary(boundary);
    assertBinding(principalId, scope);
    const payload: ActivityCursorPayload = {
      v: 1,
      route: CURSOR_ROUTE,
      direction: CURSOR_DIRECTION,
      principalId,
      scope: scopeKey(scope),
      eventSequence: boundary.eventSequence,
      key: boundary.key,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return `${encoded}.${this.sign(encoded).toString("base64url")}`;
  }

  decode(value: string | null, principalId: string, scope: ActivityScope): ActivityBoundary | null {
    if (value === null) return null;
    assertBinding(principalId, scope);
    if (typeof value !== "string" || value.length < 16 || value.length > 2048) {
      return invalidCursor();
    }
    const parts = value.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1] ||
      !BASE64URL.test(parts[0]) || !BASE64URL.test(parts[1])) {
      return invalidCursor();
    }
    const expected = this.sign(parts[0]);
    const supplied = Buffer.from(parts[1], "base64url");
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
      return invalidCursor();
    }
    try {
      const payload = JSON.parse(
        Buffer.from(parts[0], "base64url").toString("utf8"),
      ) as Partial<ActivityCursorPayload>;
      if (payload.v !== 1 || payload.route !== CURSOR_ROUTE ||
        payload.direction !== CURSOR_DIRECTION || payload.principalId !== principalId ||
        payload.scope !== scopeKey(scope) || typeof payload.eventSequence !== "number" ||
        typeof payload.key !== "string") {
        return invalidCursor();
      }
      const boundary = { eventSequence: payload.eventSequence, key: payload.key };
      assertBoundary(boundary);
      return Object.freeze(boundary);
    } catch {
      return invalidCursor();
    }
  }

  private sign(payload: string): Buffer {
    return createHmac("sha256", this.key)
      .update(CURSOR_DOMAIN, "utf8")
      .update(payload, "utf8")
      .digest();
  }
}
