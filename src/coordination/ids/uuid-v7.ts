import { randomBytes as cryptoRandomBytes } from "node:crypto";

const MAX_TIMESTAMP = (1n << 48n) - 1n;
const RANDOM_BITS = 74n;
const MAX_RANDOM = (1n << RANDOM_BITS) - 1n;
const RAND_B_MASK = (1n << 62n) - 1n;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface UuidV7GeneratorOptions {
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}

function randomBits74(randomBytes: (size: number) => Uint8Array): bigint {
  const bytes = randomBytes(10);
  if (bytes.length !== 10) {
    throw new Error(`UUIDv7 randomness source returned ${bytes.length} bytes; expected 10`);
  }
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value & MAX_RANDOM;
}

function formatUuidV7(timestamp: bigint, random: bigint): string {
  const bytes = new Uint8Array(16);
  let remainingTimestamp = timestamp;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(remainingTimestamp & 0xffn);
    remainingTimestamp >>= 8n;
  }

  const randA = random >> 62n;
  const randB = random & RAND_B_MASK;
  bytes[6] = 0x70 | Number((randA >> 8n) & 0x0fn);
  bytes[7] = Number(randA & 0xffn);
  bytes[8] = 0x80 | Number((randB >> 56n) & 0x3fn);
  for (let index = 9; index < 16; index += 1) {
    const shift = BigInt((15 - index) * 8);
    bytes[index] = Number((randB >> shift) & 0xffn);
  }

  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class UuidV7Generator {
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Uint8Array;
  private lastTimestamp = -1n;
  private lastRandom = 0n;

  constructor(options: UuidV7GeneratorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? cryptoRandomBytes;
  }

  generate(): string {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error(`UUIDv7 clock returned invalid Unix milliseconds: ${now}`);
    }

    let timestamp = BigInt(now);
    let random: bigint;
    if (timestamp > this.lastTimestamp) {
      random = randomBits74(this.randomBytes);
    } else {
      timestamp = this.lastTimestamp;
      if (this.lastRandom === MAX_RANDOM) {
        timestamp += 1n;
        random = 0n;
      } else {
        random = this.lastRandom + 1n;
      }
    }

    if (timestamp > MAX_TIMESTAMP) {
      throw new Error("UUIDv7 timestamp exceeds the 48-bit Unix millisecond range");
    }
    this.lastTimestamp = timestamp;
    this.lastRandom = random;
    return formatUuidV7(timestamp, random);
  }
}

const defaultGenerator = new UuidV7Generator();

export function uuidV7(): string {
  return defaultGenerator.generate();
}

export function isUuidV7(value: string): boolean {
  return UUID_V7_PATTERN.test(value);
}
