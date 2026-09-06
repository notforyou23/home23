import { DEFAULT_MAX_FRAME_BYTES } from "./constants.js";
import { ResidentProtocolError } from "./errors.js";

export function encodeJsonFrame(
  value: unknown,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
): Buffer {
  let body: Buffer;
  try {
    body = Buffer.from(JSON.stringify(value), "utf8");
  } catch {
    throw new ResidentProtocolError("frame_malformed", "frame is not JSON serializable");
  }
  if (body.length === 0) {
    throw new ResidentProtocolError("frame_malformed", "frame body is empty");
  }
  if (body.length > maxFrameBytes) {
    throw new ResidentProtocolError("frame_too_large", "frame exceeds the configured byte limit", {
      details: { maxFrameBytes },
    });
  }
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export class JsonFrameDecoder {
  readonly #maxFrameBytes: number;
  readonly #header = Buffer.alloc(4);
  #headerBytes = 0;
  #expectedBodyBytes: number | null = null;
  #bodyBytes = 0;
  #body: Buffer | null = null;

  constructor(options: { maxFrameBytes?: number } = {}) {
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (!Number.isSafeInteger(this.#maxFrameBytes) || this.#maxFrameBytes < 1) {
      throw new TypeError("maxFrameBytes must be a positive safe integer");
    }
  }

  get bufferedBytes(): number {
    return this.#headerBytes + this.#bodyBytes;
  }

  push(chunk: Uint8Array): unknown[] {
    const input = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const decoded: unknown[] = [];
    let offset = 0;

    while (offset < input.length) {
      if (this.#expectedBodyBytes === null) {
        const headerRemaining = 4 - this.#headerBytes;
        const copied = Math.min(headerRemaining, input.length - offset);
        input.copy(this.#header, this.#headerBytes, offset, offset + copied);
        this.#headerBytes += copied;
        offset += copied;
        if (this.#headerBytes < 4) break;

        const length = this.#header.readUInt32BE(0);
        if (length === 0) {
          this.#reset();
          throw new ResidentProtocolError("frame_malformed", "frame body is empty");
        }
        if (length > this.#maxFrameBytes) {
          this.#reset();
          throw new ResidentProtocolError(
            "frame_too_large",
            "frame exceeds the configured byte limit",
            { details: { maxFrameBytes: this.#maxFrameBytes } },
          );
        }
        this.#expectedBodyBytes = length;
        this.#body = Buffer.allocUnsafe(length);
      }

      const bodyRemaining = this.#expectedBodyBytes - this.#bodyBytes;
      const copied = Math.min(bodyRemaining, input.length - offset);
      if (copied > 0) {
        input.copy(this.#body!, this.#bodyBytes, offset, offset + copied);
        this.#bodyBytes += copied;
        offset += copied;
      }
      if (this.#bodyBytes !== this.#expectedBodyBytes) break;

      const body = this.#body!;
      this.#reset();
      try {
        const value = JSON.parse(body.toString("utf8")) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("frame must be a JSON object");
        }
        decoded.push(value);
      } catch {
        throw new ResidentProtocolError("frame_malformed", "frame body is not a JSON object");
      }
    }

    return decoded;
  }

  #reset(): void {
    this.#headerBytes = 0;
    this.#expectedBodyBytes = null;
    this.#bodyBytes = 0;
    this.#body = null;
  }
}
