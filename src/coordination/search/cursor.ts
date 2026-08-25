import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";

import { assertCoordinationId } from "../ids/index.js";
import { CanonicalSearchError } from "./errors.js";
import type { SearchBoundary, SearchScope } from "./types.js";

const CURSOR_ROUTE = "/api/v1/search";
const CURSOR_DIRECTION = "forward";
const CURSOR_DOMAIN = "home23-search-cursor:v1\0";
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

interface SearchCursorPayload extends SearchBoundary {
  v: 1;
  route: typeof CURSOR_ROUTE;
  direction: typeof CURSOR_DIRECTION;
  principalId: string;
  queryDigest: string;
  scope: string;
}

function scopeKey(scope: SearchScope): string {
  return scope.kind === "all" ? "all" : `channel:${scope.channelId}`;
}

function signature(key: Buffer, payload: string): Buffer {
  return createHmac("sha256", key)
    .update(CURSOR_DOMAIN, "utf8")
    .update(payload, "utf8")
    .digest();
}

function invalidCursor(): never {
  throw new CanonicalSearchError("cursor_invalid");
}

function assertBoundary(boundary: SearchBoundary): void {
  try {
    if (
      typeof boundary.createdAt !== "string" ||
      new Date(boundary.createdAt).toISOString() !== boundary.createdAt ||
      typeof boundary.messageId !== "string"
    ) {
      invalidCursor();
    }
    assertCoordinationId("message", boundary.messageId);
  } catch (error) {
    if (error instanceof CanonicalSearchError) throw error;
    invalidCursor();
  }
}

function assertBinding(
  principalId: string,
  queryDigest: string,
  scope: SearchScope,
): void {
  try {
    assertCoordinationId("principal", principalId);
    if (!SHA256_HEX.test(queryDigest)) invalidCursor();
    if (scope.kind === "channel") {
      assertCoordinationId("channel", scope.channelId);
    } else if (scope.kind !== "all") {
      invalidCursor();
    }
  } catch (error) {
    if (error instanceof CanonicalSearchError) throw error;
    invalidCursor();
  }
}

export class SearchCursorCodec {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (!(key instanceof Uint8Array) || key.byteLength < 32) {
      throw new TypeError("search cursor signing key must contain at least 256 bits");
    }
    this.key = Buffer.from(key);
  }

  encode(
    boundary: SearchBoundary,
    principalId: string,
    queryDigest: string,
    scope: SearchScope,
  ): string {
    assertBoundary(boundary);
    assertBinding(principalId, queryDigest, scope);
    const payload: SearchCursorPayload = {
      v: 1,
      route: CURSOR_ROUTE,
      direction: CURSOR_DIRECTION,
      principalId,
      queryDigest,
      scope: scopeKey(scope),
      createdAt: boundary.createdAt,
      messageId: boundary.messageId,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return `${encoded}.${signature(this.key, encoded).toString("base64url")}`;
  }

  decode(
    value: string | null,
    principalId: string,
    queryDigest: string,
    scope: SearchScope,
  ): SearchBoundary | null {
    if (value === null) return null;
    assertBinding(principalId, queryDigest, scope);
    if (typeof value !== "string" || value.length < 16 || value.length > 1024) {
      return invalidCursor();
    }
    const parts = value.split(".");
    if (
      parts.length !== 2 ||
      !parts[0] ||
      !parts[1] ||
      !BASE64URL.test(parts[0]) ||
      !BASE64URL.test(parts[1])
    ) {
      return invalidCursor();
    }
    const [encoded, provided] = parts as [string, string];
    const providedBytes = Buffer.from(provided, "base64url");
    const expected = signature(this.key, encoded);
    if (providedBytes.byteLength !== expected.byteLength ||
      !timingSafeEqual(providedBytes, expected)) {
      return invalidCursor();
    }
    try {
      const payload = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      ) as Partial<SearchCursorPayload>;
      if (
        !payload ||
        payload.v !== 1 ||
        payload.route !== CURSOR_ROUTE ||
        payload.direction !== CURSOR_DIRECTION ||
        payload.principalId !== principalId ||
        payload.queryDigest !== queryDigest ||
        payload.scope !== scopeKey(scope) ||
        typeof payload.createdAt !== "string" ||
        typeof payload.messageId !== "string"
      ) {
        return invalidCursor();
      }
      const boundary = {
        createdAt: payload.createdAt,
        messageId: payload.messageId,
      };
      assertBoundary(boundary);
      return Object.freeze(boundary);
    } catch (error) {
      if (error instanceof CanonicalSearchError) throw error;
      return invalidCursor();
    }
  }
}
