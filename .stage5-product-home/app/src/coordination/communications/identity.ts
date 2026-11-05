import { createHash } from "node:crypto";

const MAX_UUID_V7_TIMESTAMP = (1n << 48n) - 1n;

/**
 * Derive a replay-stable communication UUIDv7 from immutable source identity.
 * The timestamp preserves UUIDv7 ordering semantics; SHA-256 supplies the 74
 * non-version bits. This is identity allocation, not a secrecy primitive.
 */
export function stableCommunicationEventId(stableKey: string, occurredAt: string): string {
  if (!stableKey || stableKey.includes("\0")) {
    throw new TypeError("stable communication event key must be nonempty and NUL-free");
  }
  const parsed = new Date(occurredAt);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== occurredAt) {
    throw new TypeError("stable communication event timestamp must be UTC ISO-8601 with milliseconds");
  }
  const timestamp = BigInt(parsed.valueOf());
  if (timestamp < 0n || timestamp > MAX_UUID_V7_TIMESTAMP) {
    throw new TypeError("stable communication event timestamp exceeds UUIDv7 range");
  }

  const bytes = Buffer.alloc(16);
  let remaining = timestamp;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  createHash("sha256")
    .update("home23-communication-event-v1\0", "utf8")
    .update(stableKey, "utf8")
    .digest()
    .copy(bytes, 6, 0, 10);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString("hex");
  return `cevt_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
