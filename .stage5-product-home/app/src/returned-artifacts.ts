export const RETURNED_ARTIFACT_GENERATORS = Object.freeze([
  "generate_image",
  "generate_music",
  "tts",
  "return_artifact",
] as const);

export type ReturnedArtifactGenerator =
  (typeof RETURNED_ARTIFACT_GENERATORS)[number];

export const RETURNED_ARTIFACT_CONTENT_TYPES = Object.freeze([
  "application/pdf",
  "audio/mpeg",
  "image/gif",
  "image/jpeg",
  "image/png",
  "text/plain",
] as const);

export type ReturnedArtifactContentType =
  (typeof RETURNED_ARTIFACT_CONTENT_TYPES)[number];

export const MAX_RETURNED_ARTIFACT_BYTES = 25 * 1024 * 1024;

interface Mp3Frame {
  readonly length: number;
  readonly version: number;
  readonly layer: number;
  readonly sampleRate: number;
}

const MPEG1_BITRATES = Object.freeze({
  1: Object.freeze([0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]),
  2: Object.freeze([0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384]),
  3: Object.freeze([0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]),
} as const);
const MPEG2_BITRATES = Object.freeze({
  1: Object.freeze([0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]),
  2: Object.freeze([0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]),
  3: Object.freeze([0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]),
} as const);

function mp3FrameAt(bytes: Buffer, offset: number): Mp3Frame | null {
  if (offset < 0 || bytes.length < offset + 4 || bytes[offset] !== 0xff || (bytes[offset + 1]! & 0xe0) !== 0xe0) {
    return null;
  }
  const versionBits = (bytes[offset + 1]! >> 3) & 0x03;
  const layerBits = (bytes[offset + 1]! >> 1) & 0x03;
  const bitrateIndex = (bytes[offset + 2]! >> 4) & 0x0f;
  const sampleRateIndex = (bytes[offset + 2]! >> 2) & 0x03;
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
    return null;
  }
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
  const layer = 4 - layerBits;
  const sampleRateBase = [44_100, 48_000, 32_000][sampleRateIndex]!;
  const sampleRate = version === 1 ? sampleRateBase : version === 2 ? sampleRateBase / 2 : sampleRateBase / 4;
  const table = version === 1 ? MPEG1_BITRATES : MPEG2_BITRATES;
  const bitrateKbps = table[layer as keyof typeof table][bitrateIndex];
  if (!bitrateKbps) return null;
  const padding = (bytes[offset + 2]! >> 1) & 0x01;
  const bitrate = bitrateKbps * 1_000;
  const length = layer === 1
    ? Math.floor((12 * bitrate) / sampleRate + padding) * 4
    : Math.floor(((layer === 3 && version !== 1 ? 72 : 144) * bitrate) / sampleRate + padding);
  if (!Number.isSafeInteger(length) || length < 4 || offset + length > bytes.length) return null;
  return Object.freeze({ length, version, layer, sampleRate });
}

export function isStructurallyValidMp3(bytes: Buffer): boolean {
  let offset = 0;
  if (bytes.subarray(0, 3).toString("ascii") === "ID3") {
    if (bytes.length < 10 || bytes[3]! < 2 || bytes[3]! > 4 || bytes[4] !== 0) return false;
    const sizeBytes = bytes.subarray(6, 10);
    if ([...sizeBytes].some((byte) => (byte & 0x80) !== 0)) return false;
    offset = ((sizeBytes[0]! << 21) | (sizeBytes[1]! << 14) |
      (sizeBytes[2]! << 7) | sizeBytes[3]!) + 10 + ((bytes[5]! & 0x10) !== 0 ? 10 : 0);
  }
  const first = mp3FrameAt(bytes, offset);
  if (!first) return false;
  const second = mp3FrameAt(bytes, offset + first.length);
  return second !== null && second.version === first.version && second.layer === first.layer &&
    second.sampleRate === first.sampleRate;
}

export function detectReturnedArtifactContentType(bytes: Buffer): ReturnedArtifactContentType {
  if (bytes.length < 1 || bytes.length > MAX_RETURNED_ARTIFACT_BYTES) {
    throw new Error("returned artifact size is outside the accepted boundary");
  }
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const signature = bytes.subarray(0, 6).toString("ascii");
  if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (isStructurallyValidMp3(bytes)) return "audio/mpeg";
  if (bytes.includes(0)) throw new Error("returned artifact content is not supported");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("returned artifact content is not supported");
  }
  const leading = text.replace(/^\uFEFF/u, "").trimStart().toLowerCase();
  if (/^(?:<!doctype\s+html|<html\b|<script\b|<svg\b|<\?xml\b)/u.test(leading)) {
    throw new Error("returned artifact content is not supported");
  }
  return "text/plain";
}

const generators = new Set<string>(RETURNED_ARTIFACT_GENERATORS);
const contentTypes = new Set<string>(RETURNED_ARTIFACT_CONTENT_TYPES);

export function isReturnedArtifactGenerator(
  value: unknown,
): value is ReturnedArtifactGenerator {
  return typeof value === "string" && generators.has(value);
}

export function isReturnedArtifactContentType(
  value: unknown,
): value is ReturnedArtifactContentType {
  return typeof value === "string" && contentTypes.has(value);
}

export function returnedArtifactMediaType(
  contentType: ReturnedArtifactContentType,
  generatedBy: ReturnedArtifactGenerator,
): "image" | "voice" | "document" {
  if (contentType.startsWith("image/")) return "image";
  if (contentType === "audio/mpeg" && generatedBy === "tts") return "voice";
  return "document";
}
