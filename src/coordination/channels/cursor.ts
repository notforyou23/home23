import { createHmac, timingSafeEqual } from "node:crypto";

import { assertCoordinationId } from "../ids/index.js";
import { MessagingError } from "./errors.js";
import type { ChannelListCursor } from "./types.js";

const CURSOR_ROUTE = "channels.list";
const CURSOR_FILTERS = "member_channels";
const CURSOR_DIRECTION = "forward";
const CURSOR_DOMAIN = "home23-channel-cursor:v1\0";
const BASE64URL = /^[A-Za-z0-9_-]+$/;

interface ChannelCursorEnvelope {
  version: 1;
  route: typeof CURSOR_ROUTE;
  principalId: string;
  filters: typeof CURSOR_FILTERS;
  direction: typeof CURSOR_DIRECTION;
  boundary: ChannelListCursor;
}

function invalidCursor(): never {
  throw new MessagingError("request_invalid");
}

export class ChannelCursorCodec {
  private readonly signingKey: Buffer;

  constructor(signingKey: Uint8Array) {
    if (!(signingKey instanceof Uint8Array) || signingKey.byteLength < 32) {
      throw new TypeError("Channel cursor signing key must contain at least 256 bits");
    }
    this.signingKey = Buffer.from(signingKey);
  }

  encode(cursor: ChannelListCursor, principalId: string): string {
    const envelope: ChannelCursorEnvelope = {
      version: 1,
      route: CURSOR_ROUTE,
      principalId,
      filters: CURSOR_FILTERS,
      direction: CURSOR_DIRECTION,
      boundary: {
        updatedAt: cursor.updatedAt,
        channelId: cursor.channelId,
      },
    };
    const payload = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
    return `${payload}.${this.sign(payload).toString("base64url")}`;
  }

  decode(value: string | null, principalId: string): ChannelListCursor | null {
    if (value === null) return null;
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
    const expected = this.sign(parts[0]);
    const supplied = Buffer.from(parts[1], "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return invalidCursor();
    }
    try {
      const parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as
        Partial<ChannelCursorEnvelope>;
      const boundary = parsed.boundary;
      if (
        parsed.version !== 1 ||
        parsed.route !== CURSOR_ROUTE ||
        parsed.principalId !== principalId ||
        parsed.filters !== CURSOR_FILTERS ||
        parsed.direction !== CURSOR_DIRECTION ||
        !boundary ||
        typeof boundary.updatedAt !== "string" ||
        new Date(boundary.updatedAt).toISOString() !== boundary.updatedAt ||
        typeof boundary.channelId !== "string"
      ) {
        return invalidCursor();
      }
      assertCoordinationId("channel", boundary.channelId);
      return Object.freeze({
        updatedAt: boundary.updatedAt,
        channelId: boundary.channelId,
      });
    } catch (error) {
      if (error instanceof MessagingError) throw error;
      return invalidCursor();
    }
  }

  private sign(payload: string): Buffer {
    return createHmac("sha256", this.signingKey)
      .update(CURSOR_DOMAIN, "utf8")
      .update(payload, "utf8")
      .digest();
  }
}
