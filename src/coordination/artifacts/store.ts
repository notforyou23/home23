import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
} from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { inflate } from "node:zlib";

import { assertCoordinationId } from "../ids/index.js";
import { assertArtifactReadActor, assertArtifactWriteActor } from "./access.js";
import { ArtifactError } from "./errors.js";
import type {
  ArtifactDownload,
  ArtifactExpirationReport,
  ArtifactGarbageCollectionCandidate,
  ArtifactGarbageCollectionReport,
  ArtifactIngestInput,
  ArtifactMetadataRepository,
  ArtifactProjection,
  ArtifactRecoveryReport,
  LocalArtifactStoreOptions,
  ReadyArtifactRecord,
  StagingArtifactRecord,
} from "./types.js";

export const DEFAULT_MAXIMUM_ARTIFACT_BYTES = 25 * 1024 * 1024;
export const DEFAULT_ARTIFACT_DRAFT_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_ABANDONED_ARTIFACT_STAGING_MS = 60 * 60 * 1000;
export const ARTIFACT_STREAM_IDLE_TIMEOUT_MS = 15_000;
export const ARTIFACT_STREAM_TOTAL_TIMEOUT_MS = 120_000;
export const DEFAULT_MAXIMUM_CONCURRENT_ARTIFACT_UPLOADS = 4;
export const DEFAULT_ARTIFACT_UPLOAD_ADMISSION_TIMEOUT_MS = 15_000;
export const SUPPORTED_ARTIFACT_CONTENT_TYPES = Object.freeze([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "text/plain",
] as const);
export const ARTIFACT_CONTENT_POLICY = Object.freeze({
  version: 1,
  maximumBytes: DEFAULT_MAXIMUM_ARTIFACT_BYTES,
  maximumStructuralRecords: 65_536,
  maximumRasterDimension: 8_192,
  maximumRasterPixels: 4_000_000,
  maximumEncodedRasterBytes: 8 * 1024 * 1024,
  maximumDecodedRasterBytes: 16 * 1024 * 1024,
  maximumStructuredDocumentBytes: 8 * 1024 * 1024,
  profiles: Object.freeze({
    "application/pdf": "header_xref_trailer_startxref_eof",
    "image/gif": "logical_screen_blocks_image_trailer",
    "image/jpeg": "soi_frame_scan_eoi",
    "image/png": "signature_ihdr_idat_iend",
    "text/plain": "complete_valid_utf8_without_nul_or_active_markup_prefix",
  }),
} as const);

const supportedContentTypes = new Set<string>(SUPPORTED_ARTIFACT_CONTENT_TYPES);
type OpenFileHandle = Awaited<ReturnType<typeof open>>;
const rootMutationTails = new Map<string, Promise<void>>();
interface UploadAdmissionWaiter {
  resolve: (release: () => void) => void;
  timeout: ReturnType<typeof setTimeout>;
}
interface UploadAdmissionState {
  active: number;
  limit: number;
  waiters: UploadAdmissionWaiter[];
}
const rootUploadAdmissions = new Map<string, UploadAdmissionState>();
const verifiedDownloadObjects = new Map<string, Promise<void>>();
const MAX_VERIFIED_DOWNLOAD_IDENTITIES = 1024;
const STORE_MARKER_NAME = ".home23-artifact-store-v1";
const STORE_MARKER_BYTES = Buffer.from("home23-artifact-store-v1\n", "utf8");

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function safeFilename(value: string): string {
  const normalized = value.normalize("NFC");
  if (
    normalized.length < 1 ||
    normalized.length > 255 ||
    normalized === "." ||
    normalized === ".." ||
    /^[A-Za-z]:/.test(normalized) ||
    /[\0-\x1f\x7f/\\]/u.test(normalized)
  ) {
    throw new ArtifactError("invalid_filename");
  }
  return normalized;
}

function assertSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new ArtifactError("invalid_digest");
}

function safeQuarantineId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new ArtifactError("storage_integrity");
  }
  return value;
}

function detectContentType(
  prefix: Buffer,
  validUtf8Text: boolean,
  containsNul: boolean,
): string {
  if (prefix.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) {
    return "image/jpeg";
  }
  if (prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
      prefix.subarray(8, 12).toString("ascii") === "WEBP") {
    throw new ArtifactError("invalid_content_type");
  }
  const gif = prefix.subarray(0, 6).toString("ascii");
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  if (prefix.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (validUtf8Text && !containsNul) {
    const leadingText = prefix.toString("utf8").replace(/^\uFEFF/u, "").trimStart().toLowerCase();
    if (/^(?:<!doctype\s+html|<html\b|<script\b|<svg\b|<\?xml\b)/u.test(leadingText)) {
      throw new ArtifactError("invalid_content_type");
    }
    return "text/plain";
  }
  throw new ArtifactError("invalid_content_type");
}

async function hashPath(path: string): Promise<{ sha256: string; byteCount: number }> {
  let handle: OpenFileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      !Number.isSafeInteger(stat.size) ||
      stat.size < 0 ||
      stat.size > DEFAULT_MAXIMUM_ARTIFACT_BYTES
    ) throw new ArtifactError("storage_integrity");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < stat.size) {
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, stat.size - position),
        position,
      );
      if (read.bytesRead === 0) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    if (position !== stat.size) throw new ArtifactError("storage_integrity");
    return { sha256: hash.digest("hex"), byteCount: position };
  } catch {
    throw new ArtifactError("storage_integrity");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function verifyAndSealCanonical(
  path: string,
  expectedSha256: string,
  expectedByteCount: number,
): Promise<void> {
  let handle: OpenFileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expectedByteCount) {
      throw new ArtifactError("storage_integrity");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < stat.size) {
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, stat.size - position),
        position,
      );
      if (read.bytesRead === 0) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    if (position !== stat.size || hash.digest("hex") !== expectedSha256) {
      throw new ArtifactError("storage_integrity");
    }
    await handle.chmod(0o400);
    await handle.sync();
    const sealedStat = await handle.stat();
    rememberVerifiedDownload(path, expectedSha256, sealedStat);
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError("storage_integrity");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await fsyncDirectory(dirname(path));
}

function downloadIdentityKey(
  path: string,
  expectedSha256: string,
  stat: Awaited<ReturnType<OpenFileHandle["stat"]>>,
): string {
  return [
    path,
    expectedSha256,
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
  ].join(":");
}

function rememberVerifiedDownload(
  path: string,
  expectedSha256: string,
  stat: Awaited<ReturnType<OpenFileHandle["stat"]>>,
): void {
  const key = downloadIdentityKey(path, expectedSha256, stat);
  verifiedDownloadObjects.set(key, Promise.resolve());
  while (verifiedDownloadObjects.size > MAX_VERIFIED_DOWNLOAD_IDENTITIES) {
    const oldest = verifiedDownloadObjects.keys().next().value as string | undefined;
    if (!oldest) break;
    verifiedDownloadObjects.delete(oldest);
  }
}

async function verifyDownloadHandle(
  handle: OpenFileHandle,
  path: string,
  expectedSha256: string,
  expectedByteCount: number,
): Promise<void> {
  const before = await handle.stat();
  if (!before.isFile() || before.size !== expectedByteCount) {
    throw new ArtifactError("storage_integrity");
  }
  const key = downloadIdentityKey(path, expectedSha256, before);
  let verification = verifiedDownloadObjects.get(key);
  if (!verification) {
    verification = (async () => {
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < before.size) {
        const read = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, before.size - position),
          position,
        );
        if (read.bytesRead === 0) break;
        hash.update(buffer.subarray(0, read.bytesRead));
        position += read.bytesRead;
      }
      if (position !== before.size || hash.digest("hex") !== expectedSha256) {
        throw new ArtifactError("storage_integrity");
      }
    })();
    verifiedDownloadObjects.set(key, verification);
    verification.catch(() => {
      if (verifiedDownloadObjects.get(key) === verification) {
        verifiedDownloadObjects.delete(key);
      }
    });
    while (verifiedDownloadObjects.size > MAX_VERIFIED_DOWNLOAD_IDENTITIES) {
      const oldest = verifiedDownloadObjects.keys().next().value as string | undefined;
      if (!oldest) break;
      verifiedDownloadObjects.delete(oldest);
    }
  }
  await verification;
  const after = await handle.stat();
  if (downloadIdentityKey(path, expectedSha256, after) !== key) {
    verifiedDownloadObjects.delete(key);
    throw new ArtifactError("storage_integrity");
  }
}

interface ArtifactWritableHandle {
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
  ): Promise<{ bytesWritten: number }>;
}

export async function writeArtifactBytesFully(
  handle: ArtifactWritableHandle,
  bytes: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset);
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten < 1) {
      throw new ArtifactError("storage_integrity");
    }
    offset += result.bytesWritten;
  }
}

async function readExact(
  handle: OpenFileHandle,
  position: number,
  length: number,
): Promise<Buffer | null> {
  if (position < 0 || length < 0) return null;
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, position + offset);
    if (result.bytesRead === 0) return null;
    offset += result.bytesRead;
  }
  return bytes;
}

const CRC32_TABLE = Object.freeze(Array.from({ length: 256 }, (_unused, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
}));

function updateCrc32(crc: number, bytes: Buffer): number {
  let value = crc;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return value >>> 0;
}

function permittedRaster(width: number, height: number): boolean {
  return Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= ARTIFACT_CONTENT_POLICY.maximumRasterDimension &&
    height <= ARTIFACT_CONTENT_POLICY.maximumRasterDimension &&
    width * height <= ARTIFACT_CONTENT_POLICY.maximumRasterPixels;
}

function inflateBounded(input: Buffer, maximumOutputBytes: number): Promise<Buffer> {
  return new Promise((resolveOutput, rejectOutput) => {
    inflate(input, { maxOutputLength: maximumOutputBytes }, (error, output) => {
      if (error) rejectOutput(error);
      else resolveOutput(output);
    });
  });
}

async function validatePng(handle: OpenFileHandle, byteCount: number): Promise<boolean> {
  if (byteCount < 45) return false;
  let position = 8;
  let chunkIndex = 0;
  let sawImageData = false;
  let endedImageData = false;
  let sawPalette = false;
  let width = 0;
  let height = 0;
  let bitsPerPixel = 0;
  let pngColorType = -1;
  let compressedByteCount = 0;
  const compressedImageData: Buffer[] = [];
  while (position + 12 <= byteCount) {
    if (chunkIndex >= ARTIFACT_CONTENT_POLICY.maximumStructuralRecords) return false;
    const header = await readExact(handle, position, 8);
    if (!header) return false;
    const length = header.readUInt32BE(0);
    const type = header.subarray(4, 8).toString("ascii");
    const next = position + 12 + length;
    if (!Number.isSafeInteger(next) || next > byteCount) return false;
    if (chunkIndex === 0) {
      if (type !== "IHDR" || length !== 13) return false;
      const headerData = await readExact(handle, position + 8, 13);
      if (!headerData) return false;
      width = headerData.readUInt32BE(0);
      height = headerData.readUInt32BE(4);
      if (!permittedRaster(width, height)) return false;
      const bitDepth = headerData[8]!;
      const colorType = headerData[9]!;
      pngColorType = colorType;
      const permittedDepths: Readonly<Record<number, readonly number[]>> = {
        0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16],
      };
      if (
        !permittedDepths[colorType]?.includes(bitDepth) ||
        headerData[10] !== 0 ||
        headerData[11] !== 0 ||
        headerData[12] !== 0
      ) return false;
      const components: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
      bitsPerPixel = components[colorType]! * bitDepth;
    }
    let crc = updateCrc32(0xffffffff, header.subarray(4, 8));
    let dataPosition = position + 8;
    let remaining = length;
    while (remaining > 0) {
      const size = Math.min(64 * 1024, remaining);
      const data = await readExact(handle, dataPosition, size);
      if (!data) return false;
      crc = updateCrc32(crc, data);
      dataPosition += size;
      remaining -= size;
    }
    const storedCrc = await readExact(handle, position + 8 + length, 4);
    if (!storedCrc || ((crc ^ 0xffffffff) >>> 0) !== storedCrc.readUInt32BE(0)) return false;
    if (type === "PLTE") {
      if (sawImageData || length < 3 || length > 768 || length % 3 !== 0) return false;
      sawPalette = true;
    } else if (type === "IDAT") {
      if (endedImageData || length === 0) return false;
      const data = await readExact(handle, position + 8, length);
      if (!data) return false;
      compressedByteCount += data.length;
      if (compressedByteCount > ARTIFACT_CONTENT_POLICY.maximumEncodedRasterBytes) return false;
      compressedImageData.push(data);
      sawImageData = true;
    } else if (sawImageData && type !== "IEND") {
      endedImageData = true;
    }
    if (["acTL", "fcTL", "fdAT", "iCCP", "iTXt", "zTXt"].includes(type)) return false;
    if (type === "IEND") {
      if (length !== 0 || !sawImageData || next !== byteCount) return false;
      const rowBytes = Math.ceil(width * bitsPerPixel / 8);
      const decodedByteCount = height * (rowBytes + 1);
      if (
        !Number.isSafeInteger(decodedByteCount) ||
        decodedByteCount > ARTIFACT_CONTENT_POLICY.maximumDecodedRasterBytes
      ) return false;
      let decoded: Buffer;
      try {
        decoded = await inflateBounded(Buffer.concat(compressedImageData), decodedByteCount);
      } catch {
        return false;
      }
      if (decoded.length !== decodedByteCount) return false;
      for (let row = 0; row < height; row += 1) {
        if (decoded[row * (rowBytes + 1)]! > 4) return false;
      }
      return pngColorType !== 3 || sawPalette;
    }
    if (/^[A-Z]/u.test(type) && !["IHDR", "PLTE", "IDAT", "IEND"].includes(type)) return false;
    position = next;
    chunkIndex += 1;
  }
  return false;
}

async function validateJpeg(handle: OpenFileHandle, byteCount: number): Promise<boolean> {
  if (byteCount < 24) return false;
  const start = await readExact(handle, 0, 2);
  const end = await readExact(handle, byteCount - 2, 2);
  if (!start?.equals(Buffer.from([0xff, 0xd8])) || !end?.equals(Buffer.from([0xff, 0xd9]))) {
    return false;
  }
  let position = 2;
  let sawFrame = false;
  let markerCount = 0;
  const quantizationTables = new Set<number>();
  const huffmanTables = new Set<string>();
  const frameComponents = new Set<number>();
  while (position + 4 <= byteCount - 2) {
    if (markerCount++ >= ARTIFACT_CONTENT_POLICY.maximumStructuralRecords) return false;
    const marker = await readExact(handle, position, 2);
    if (!marker || marker[0] !== 0xff || marker[1] === 0x00 || marker[1] === 0xff) return false;
    const lengthBytes = await readExact(handle, position + 2, 2);
    if (!lengthBytes) return false;
    const length = lengthBytes.readUInt16BE(0);
    if (length < 2 || position + 2 + length > byteCount - 2) return false;
    const code = marker[1]!;
    if (code === 0xdb) {
      const tables = await readExact(handle, position + 4, length - 2);
      if (!tables) return false;
      let offset = 0;
      while (offset < tables.length) {
        const precision = tables[offset]! >>> 4;
        const tableId = tables[offset]! & 0x0f;
        const tableBytes = precision === 0 ? 64 : precision === 1 ? 128 : 0;
        if (tableId > 3 || tableBytes === 0 || offset + 1 + tableBytes > tables.length) return false;
        quantizationTables.add(tableId);
        offset += 1 + tableBytes;
      }
    } else if (code === 0xc4) {
      const tables = await readExact(handle, position + 4, length - 2);
      if (!tables) return false;
      let offset = 0;
      while (offset < tables.length) {
        if (offset + 17 > tables.length) return false;
        const tableClass = tables[offset]! >>> 4;
        const tableId = tables[offset]! & 0x0f;
        if (tableClass > 1 || tableId > 3) return false;
        let symbolCount = 0;
        for (let index = 1; index <= 16; index += 1) symbolCount += tables[offset + index]!;
        if (symbolCount < 1 || symbolCount > 256 || offset + 17 + symbolCount > tables.length) {
          return false;
        }
        huffmanTables.add(`${tableClass}:${tableId}`);
        offset += 17 + symbolCount;
      }
    } else if (code === 0xc0) {
      const frame = await readExact(handle, position + 4, length - 2);
      const components = frame?.[5] ?? 0;
      if (
        !frame ||
        frame.length < 9 ||
        frame[0] !== 8 ||
        !permittedRaster(frame.readUInt16BE(3), frame.readUInt16BE(1)) ||
        components < 1 ||
        components > 3 ||
        length !== 8 + 3 * components
      ) {
        return false;
      }
      if (sawFrame || quantizationTables.size === 0) return false;
      for (let index = 0; index < components; index += 1) {
        const componentId = frame[6 + 3 * index]!;
        const sampling = frame[7 + 3 * index]!;
        const quantizationTable = frame[8 + 3 * index]!;
        if (
          frameComponents.has(componentId) ||
          (sampling >>> 4) < 1 ||
          (sampling >>> 4) > 4 ||
          (sampling & 0x0f) < 1 ||
          (sampling & 0x0f) > 4 ||
          !quantizationTables.has(quantizationTable)
        ) return false;
        frameComponents.add(componentId);
      }
      sawFrame = true;
    } else if ([0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]
      .includes(code)) {
      return false;
    } else if (code === 0xda) {
      const scan = await readExact(handle, position + 4, length - 2);
      const components = scan?.[0] ?? 0;
      if (
        !sawFrame ||
        !scan ||
        components < 1 ||
        components > frameComponents.size ||
        length !== 6 + 2 * components ||
        scan[1 + 2 * components] !== 0 ||
        scan[2 + 2 * components] !== 63 ||
        scan[3 + 2 * components] !== 0
      ) return false;
      const scanComponents = new Set<number>();
      for (let index = 0; index < components; index += 1) {
        const componentId = scan[1 + 2 * index]!;
        const tables = scan[2 + 2 * index]!;
        if (
          !frameComponents.has(componentId) ||
          scanComponents.has(componentId) ||
          !huffmanTables.has(`0:${tables >>> 4}`) ||
          !huffmanTables.has(`1:${tables & 0x0f}`)
        ) return false;
        scanComponents.add(componentId);
      }
      let entropyPosition = position + 2 + length;
      let entropyBytes = 0;
      let pendingMarkerPrefix = false;
      const entropyEnd = byteCount - 2;
      while (entropyPosition < entropyEnd) {
        const size = Math.min(64 * 1024, entropyEnd - entropyPosition);
        const bytes = await readExact(handle, entropyPosition, size);
        if (!bytes) return false;
        for (const byte of bytes) {
          if (!pendingMarkerPrefix) {
            if (byte === 0xff) pendingMarkerPrefix = true;
            else entropyBytes += 1;
            continue;
          }
          if (byte === 0xff) continue;
          if (byte === 0x00) entropyBytes += 1;
          else if (byte < 0xd0 || byte > 0xd7) return false;
          pendingMarkerPrefix = false;
        }
        entropyPosition += bytes.length;
      }
      return !pendingMarkerPrefix && entropyBytes >= 2;
    }
    position += 2 + length;
  }
  return false;
}

async function skipGifSubBlocks(
  handle: OpenFileHandle,
  start: number,
  byteCount: number,
  budget: { remaining: number },
): Promise<{ position: number; data: Buffer } | null> {
  let position = start;
  const chunks: Buffer[] = [];
  let dataBytes = 0;
  while (position < byteCount) {
    if (budget.remaining-- < 1) return null;
    const size = await readExact(handle, position, 1);
    if (!size) return null;
    position += 1;
    if (size[0] === 0) return { position, data: Buffer.concat(chunks) };
    const data = await readExact(handle, position, size[0]!);
    if (!data) return null;
    chunks.push(data);
    dataBytes += data.length;
    if (dataBytes > ARTIFACT_CONTENT_POLICY.maximumEncodedRasterBytes) return null;
    position += size[0]!;
  }
  return null;
}

function validateGifLzw(data: Buffer, minimumCodeSize: number, expectedPixels: number): boolean {
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  const dictionaryLengths = new Uint32Array(4096);
  for (let code = 0; code < clearCode; code += 1) dictionaryLengths[code] = 1;
  let codeSize = minimumCodeSize + 1;
  let nextCode = endCode + 1;
  let previousCode = -1;
  let bitPosition = 0;
  let outputPixels = 0;
  while (bitPosition + codeSize <= data.length * 8) {
    let code = 0;
    for (let bit = 0; bit < codeSize; bit += 1) {
      const absoluteBit = bitPosition + bit;
      code |= ((data[absoluteBit >>> 3]! >>> (absoluteBit & 7)) & 1) << bit;
    }
    bitPosition += codeSize;
    if (code === clearCode) {
      codeSize = minimumCodeSize + 1;
      nextCode = endCode + 1;
      previousCode = -1;
      continue;
    }
    if (code === endCode) return outputPixels === expectedPixels;
    let outputLength: number;
    if (code < clearCode) outputLength = 1;
    else if (code < nextCode && dictionaryLengths[code]! > 0) outputLength = dictionaryLengths[code]!;
    else if (code === nextCode && previousCode >= 0) outputLength = dictionaryLengths[previousCode]! + 1;
    else return false;
    outputPixels += outputLength;
    if (outputPixels > expectedPixels) return false;
    if (previousCode >= 0 && nextCode < 4096) {
      dictionaryLengths[nextCode] = dictionaryLengths[previousCode]! + 1;
      nextCode += 1;
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    previousCode = code;
  }
  return false;
}

async function validateGif(handle: OpenFileHandle, byteCount: number): Promise<boolean> {
  if (byteCount < 15) return false;
  const header = await readExact(handle, 0, 13);
  if (!header) return false;
  const signature = header.subarray(0, 6).toString("ascii");
  if (
    (signature !== "GIF87a" && signature !== "GIF89a") ||
    !permittedRaster(header.readUInt16LE(6), header.readUInt16LE(8))
  ) return false;
  const globalTableBytes = header[10]! & 0x80 ? 3 * (2 ** ((header[10]! & 0x07) + 1)) : 0;
  let position = 13 + globalTableBytes;
  let sawImage = false;
  const budget = { remaining: ARTIFACT_CONTENT_POLICY.maximumStructuralRecords };
  while (position < byteCount) {
    if (budget.remaining-- < 1) return false;
    const introducer = await readExact(handle, position, 1);
    if (!introducer) return false;
    if (introducer[0] === 0x3b) return sawImage && position + 1 === byteCount;
    if (introducer[0] === 0x21) {
      if (position + 2 > byteCount) return false;
      const skipped = await skipGifSubBlocks(handle, position + 2, byteCount, budget);
      if (skipped === null) return false;
      position = skipped.position;
      continue;
    }
    if (introducer[0] !== 0x2c || sawImage) return false;
    const descriptor = await readExact(handle, position + 1, 9);
    const imageWidth = descriptor?.readUInt16LE(4) ?? 0;
    const imageHeight = descriptor?.readUInt16LE(6) ?? 0;
    if (!descriptor || !permittedRaster(imageWidth, imageHeight)) {
      return false;
    }
    const localTableBytes = descriptor[8]! & 0x80
      ? 3 * (2 ** ((descriptor[8]! & 0x07) + 1))
      : 0;
    if (globalTableBytes === 0 && localTableBytes === 0) return false;
    const lzwPosition = position + 10 + localTableBytes;
    const lzwMinimum = await readExact(handle, lzwPosition, 1);
    if (!lzwMinimum || lzwMinimum[0]! < 2 || lzwMinimum[0]! > 8) return false;
    const skipped = await skipGifSubBlocks(handle, lzwPosition + 1, byteCount, budget);
    if (
      skipped === null ||
      skipped.data.length === 0 ||
      !validateGifLzw(skipped.data, lzwMinimum[0]!, imageWidth * imageHeight)
    ) return false;
    sawImage = true;
    position = skipped.position;
  }
  return false;
}

async function validatePdf(handle: OpenFileHandle, byteCount: number): Promise<boolean> {
  if (byteCount < 32 || byteCount > ARTIFACT_CONTENT_POLICY.maximumStructuredDocumentBytes) {
    return false;
  }
  const bytes = await readExact(handle, 0, byteCount);
  if (!bytes) return false;
  const document = bytes.toString("latin1");
  if (!/^%PDF-\d\.\d(?:\r?\n|\r)/u.test(document)) return false;
  const ending = /trailer\s*<<(.*?)>>\s*startxref\s+(\d+)\s*%%EOF(?:\r?\n|\r)?$/su.exec(document);
  if (!ending) return false;
  const trailer = ending[1]!;
  const xrefPosition = Number(ending[2]);
  if (!Number.isSafeInteger(xrefPosition) || xrefPosition < 9 || xrefPosition >= byteCount) {
    return false;
  }
  const root = /\/Root\s+(\d+)\s+(\d+)\s+R\b/u.exec(trailer);
  const size = /\/Size\s+(\d+)\b/u.exec(trailer);
  if (!root || !size) return false;
  const xrefText = document.slice(xrefPosition, ending.index);
  const heading = /^xref\s+(\d+)\s+(\d+)\s*(?:\r?\n|\r)/u.exec(xrefText);
  if (!heading) return false;
  const firstObject = Number(heading[1]);
  const objectCount = Number(heading[2]);
  if (
    !Number.isSafeInteger(firstObject) ||
    !Number.isSafeInteger(objectCount) ||
    firstObject !== 0 ||
    objectCount < 2 ||
    objectCount > ARTIFACT_CONTENT_POLICY.maximumStructuralRecords ||
    Number(size[1]) !== objectCount
  ) return false;
  let linePosition = heading[0].length;
  const objectOffsets = new Map<number, { offset: number; generation: number }>();
  for (let index = 0; index < objectCount; index += 1) {
    const entry = /^(\d{10}) (\d{5}) ([fn]) ?(?:\r?\n|\r)/u.exec(
      xrefText.slice(linePosition, linePosition + 24),
    );
    if (!entry) return false;
    linePosition += entry[0].length;
    if (entry[3] === "n") {
      const offset = Number(entry[1]);
      const generation = Number(entry[2]);
      if (!Number.isSafeInteger(offset) || offset < 9 || offset >= xrefPosition) return false;
      const objectNumber = firstObject + index;
      if (!document.startsWith(`${objectNumber} ${generation} obj`, offset)) return false;
      objectOffsets.set(objectNumber, { offset, generation });
    }
  }
  if (xrefText.slice(linePosition).trim() !== "") return false;
  const rootNumber = Number(root[1]);
  const rootGeneration = Number(root[2]);
  const rootEntry = objectOffsets.get(rootNumber);
  if (!rootEntry || rootEntry.generation !== rootGeneration) return false;
  const rootEnd = document.indexOf("endobj", rootEntry.offset);
  if (rootEnd < 0 || rootEnd >= xrefPosition) return false;
  const rootObject = document.slice(rootEntry.offset, rootEnd);
  return /<<[\s\S]*?\/Type\s*\/Catalog\b[\s\S]*?>>/u.test(rootObject);
}

async function validateStoredContent(
  path: string,
  contentType: string,
  byteCount: number,
): Promise<void> {
  if (contentType === "text/plain") return;
  let handle: OpenFileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== byteCount) throw new ArtifactError("storage_integrity");
    const valid = contentType === "image/png"
      ? await validatePng(handle, byteCount)
      : contentType === "image/jpeg"
        ? await validateJpeg(handle, byteCount)
        : contentType === "image/gif"
            ? await validateGif(handle, byteCount)
            : contentType === "application/pdf"
              ? await validatePdf(handle, byteCount)
              : false;
    if (!valid) throw new ArtifactError("invalid_content_type");
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError("storage_unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function* boundedArtifactChunks(
  content: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const iterator = content[Symbol.asyncIterator]();
  const deadline = Date.now() + ARTIFACT_STREAM_TOTAL_TIMEOUT_MS;
  let completed = false;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining < 1) throw new ArtifactError("storage_unavailable");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new ArtifactError("storage_unavailable")),
          Math.min(remaining, ARTIFACT_STREAM_IDLE_TIMEOUT_MS),
        );
        timeout.unref?.();
      });
      let next: IteratorResult<Uint8Array>;
      try {
        next = await Promise.race([iterator.next(), timedOut]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (next.done) {
        completed = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!completed) void iterator.return?.().catch(() => undefined);
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new ArtifactError("storage_integrity");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function cleanStorageError(error: unknown): ArtifactError {
  return error instanceof ArtifactError ? error : new ArtifactError("storage_unavailable");
}

export function parseSingleByteRange(
  header: string,
  byteCount: number,
): { start: number; end: number; total: number } {
  if (!Number.isSafeInteger(byteCount) || byteCount < 1 || header.includes(",")) {
    throw new ArtifactError("range_invalid");
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new ArtifactError("range_invalid");
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) {
      throw new ArtifactError("range_invalid");
    }
    start = Math.max(0, byteCount - suffixLength);
    end = byteCount - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : byteCount - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= byteCount ||
      end < start
    ) {
      throw new ArtifactError("range_invalid");
    }
    end = Math.min(end, byteCount - 1);
  }
  return Object.freeze({ start, end, total: byteCount });
}

export class LocalArtifactStore {
  private constructor(
    private readonly rootDirectory: string,
    private readonly quarantineDirectory: string,
    private readonly objectsDirectory: string,
    private readonly repository: ArtifactMetadataRepository,
    private readonly maximumBytes: number,
    private readonly draftLifetimeMs: number,
    private readonly maximumConcurrentUploads: number,
    private readonly uploadAdmissionTimeoutMs: number,
    private readonly now: () => Date,
    private readonly quarantineId: () => string,
  ) {}

  static async open(options: LocalArtifactStoreOptions): Promise<LocalArtifactStore> {
    if (!Number.isSafeInteger(options.maximumBytes ?? DEFAULT_MAXIMUM_ARTIFACT_BYTES) ||
        (options.maximumBytes ?? DEFAULT_MAXIMUM_ARTIFACT_BYTES) < 1 ||
        (options.maximumBytes ?? DEFAULT_MAXIMUM_ARTIFACT_BYTES) > DEFAULT_MAXIMUM_ARTIFACT_BYTES) {
      throw new Error(
        `artifact maximumBytes must be a positive safe integer at most ${DEFAULT_MAXIMUM_ARTIFACT_BYTES}`,
      );
    }
    const draftLifetimeMs = options.draftLifetimeMs ?? DEFAULT_ARTIFACT_DRAFT_LIFETIME_MS;
    if (
      !Number.isSafeInteger(draftLifetimeMs) ||
      draftLifetimeMs < 1 ||
      draftLifetimeMs > DEFAULT_ARTIFACT_DRAFT_LIFETIME_MS
    ) {
      throw new Error(
        `artifact draftLifetimeMs must be a positive safe integer at most ${DEFAULT_ARTIFACT_DRAFT_LIFETIME_MS}`,
      );
    }
    const maximumConcurrentUploads = options.maximumConcurrentUploads ??
      DEFAULT_MAXIMUM_CONCURRENT_ARTIFACT_UPLOADS;
    const uploadAdmissionTimeoutMs = options.uploadAdmissionTimeoutMs ??
      DEFAULT_ARTIFACT_UPLOAD_ADMISSION_TIMEOUT_MS;
    if (!Number.isSafeInteger(maximumConcurrentUploads) || maximumConcurrentUploads < 1 ||
        maximumConcurrentUploads > 8) {
      throw new Error("artifact maximumConcurrentUploads must be a safe integer from 1 through 8");
    }
    if (!Number.isSafeInteger(uploadAdmissionTimeoutMs) || uploadAdmissionTimeoutMs < 1 ||
        uploadAdmissionTimeoutMs > DEFAULT_ARTIFACT_UPLOAD_ADMISSION_TIMEOUT_MS) {
      throw new Error(
        `artifact uploadAdmissionTimeoutMs must be a positive safe integer at most ${DEFAULT_ARTIFACT_UPLOAD_ADMISSION_TIMEOUT_MS}`,
      );
    }
    const configuredRoot = resolve(options.rootDirectory);
    const configuredParent = dirname(configuredRoot);
    const parentEntry = await lstat(configuredParent);
    if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink()) {
      throw new ArtifactError("storage_integrity");
    }
    const realParent = await realpath(configuredParent);
    const allowedMacSystemAlias = configuredParent.startsWith("/var/") &&
      realParent === `/private${configuredParent}`;
    if (realParent !== configuredParent && !allowedMacSystemAlias) {
      throw new ArtifactError("storage_integrity");
    }
    const canonicalConfiguredRoot = join(realParent, basename(configuredRoot));
    const createdRoot = await mkdir(canonicalConfiguredRoot, { recursive: true, mode: 0o700 });
    const configuredEntry = await lstat(canonicalConfiguredRoot);
    if (!configuredEntry.isDirectory() || configuredEntry.isSymbolicLink()) {
      throw new ArtifactError("storage_integrity");
    }
    const rootDirectory = await realpath(canonicalConfiguredRoot);
    if (rootDirectory !== canonicalConfiguredRoot) throw new ArtifactError("storage_integrity");
    const rootEntry = await lstat(rootDirectory);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
      throw new ArtifactError("storage_integrity");
    }
    const markerPath = join(rootDirectory, STORE_MARKER_NAME);
    let rootEntries = await readdir(rootDirectory);
    const markerTempPattern = /^\.home23-artifact-store-v1\.[a-f0-9-]+\.tmp$/u;
    const recoverableTemps = rootEntries.filter((entry) => markerTempPattern.test(entry));
    if (createdRoot !== undefined || rootEntries.length === recoverableTemps.length || rootEntries.includes(STORE_MARKER_NAME)) {
      await chmod(rootDirectory, 0o700);
    }
    if (!rootEntries.includes(STORE_MARKER_NAME)) {
      if (createdRoot === undefined && rootEntries.length !== recoverableTemps.length) {
        throw new ArtifactError("storage_integrity");
      }
      for (const tempName of recoverableTemps) {
        const tempPath = join(rootDirectory, tempName);
        const tempEntry = await lstat(tempPath);
        if (!tempEntry.isFile() || tempEntry.isSymbolicLink()) {
          throw new ArtifactError("storage_integrity");
        }
        await unlink(tempPath);
      }
      const markerTempPath = join(
        rootDirectory,
        `${STORE_MARKER_NAME}.${randomUUID()}.tmp`,
      );
      const markerHandle = await open(
        markerTempPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        await writeArtifactBytesFully(markerHandle, STORE_MARKER_BYTES);
        await markerHandle.sync();
      } finally {
        await markerHandle.close();
      }
      await link(markerTempPath, markerPath);
      await unlink(markerTempPath);
      await fsyncDirectory(rootDirectory);
    } else {
      const markerEntry = await lstat(markerPath);
      if (!markerEntry.isFile() || markerEntry.isSymbolicLink()) {
        throw new ArtifactError("storage_integrity");
      }
      const markerHandle = await open(markerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const bytes = await readExact(markerHandle, 0, STORE_MARKER_BYTES.length);
        const stat = await markerHandle.stat();
        if (!bytes?.equals(STORE_MARKER_BYTES) || stat.size !== STORE_MARKER_BYTES.length) {
          throw new ArtifactError("storage_integrity");
        }
      } finally {
        await markerHandle.close();
      }
      await chmod(markerPath, 0o600);
      for (const tempName of recoverableTemps) {
        const tempPath = join(rootDirectory, tempName);
        const tempEntry = await lstat(tempPath);
        if (!tempEntry.isFile() || tempEntry.isSymbolicLink()) {
          throw new ArtifactError("storage_integrity");
        }
        await unlink(tempPath);
      }
      if (recoverableTemps.length > 0) await fsyncDirectory(rootDirectory);
    }
    const ensureChild = async (parent: string, segment: string): Promise<string> => {
      const child = join(parent, segment);
      let created = false;
      try {
        await mkdir(child, { mode: 0o700 });
        created = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      const [entry, resolvedChild] = await Promise.all([lstat(child), realpath(child)]);
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        resolvedChild !== child ||
        !isInside(rootDirectory, resolvedChild)
      ) {
        throw new ArtifactError("storage_integrity");
      }
      await chmod(child, 0o700);
      if (created) await fsyncDirectory(parent);
      return child;
    };
    const quarantineDirectory = await ensureChild(rootDirectory, "quarantine");
    const objectsParent = await ensureChild(rootDirectory, "objects");
    const objectsDirectory = await ensureChild(objectsParent, "sha256");
    return new LocalArtifactStore(
      rootDirectory,
      quarantineDirectory,
      objectsDirectory,
      options.repository,
      options.maximumBytes ?? DEFAULT_MAXIMUM_ARTIFACT_BYTES,
      draftLifetimeMs,
      maximumConcurrentUploads,
      uploadAdmissionTimeoutMs,
      options.now ?? (() => new Date()),
      options.quarantineId ?? (() => randomUUID()),
    );
  }

  async ingest(input: ArtifactIngestInput): Promise<ArtifactProjection> {
    assertArtifactWriteActor(input.actor);
    return this.withUploadAdmission(() => this.ingestConcurrent(input));
  }

  private async ingestConcurrent(input: ArtifactIngestInput): Promise<ArtifactProjection> {
    assertArtifactWriteActor(input.actor);
    try {
      assertCoordinationId("artifact", input.artifactId);
    } catch {
      throw new ArtifactError("invalid_artifact_id");
    }
    assertSha256(input.expectedSha256);
    const name = safeFilename(input.originalName);
    if (input.declaredContentType !== null && !supportedContentTypes.has(input.declaredContentType)) {
      throw new ArtifactError("invalid_content_type");
    }
    const createdAt = this.now();
    if (!Number.isFinite(createdAt.getTime())) throw new ArtifactError("storage_unavailable");
    const staging: StagingArtifactRecord = {
      id: input.artifactId,
      ownerPrincipalId: input.actor.principalId,
      state: "staging",
      name,
      declaredContentType: input.declaredContentType,
      detectedContentType: null,
      byteCount: 0,
      sha256: null,
      storage: "content_addressed",
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.draftLifetimeMs).toISOString(),
    };
    await this.repository.beginStaging({ artifact: staging, actor: input.actor });

    let quarantineName: string;
    try {
      const nonce = safeQuarantineId(this.quarantineId());
      quarantineName = safeQuarantineId(`${input.artifactId}.${nonce}.upload`);
    } catch (error) {
      await this.failStaging(input);
      throw error;
    }
    const quarantinePath = join(this.quarantineDirectory, quarantineName);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let canonicalPath: string | undefined;
    let newlyPublished = false;
    try {
      await this.assertStoreDirectory(this.quarantineDirectory);
      handle = await open(
        quarantinePath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      const hash = createHash("sha256");
      const prefixChunks: Buffer[] = [];
      let prefixBytes = 0;
      let byteCount = 0;
      let validUtf8Text = true;
      let containsNul = false;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      for await (const chunk of boundedArtifactChunks(input.content)) {
        if (!(chunk instanceof Uint8Array)) throw new ArtifactError("storage_unavailable");
        if (chunk.byteLength > this.maximumBytes - byteCount) {
          throw new ArtifactError("size_limit_exceeded");
        }
        const bytes = Buffer.from(chunk);
        if (bytes.length === 0) continue;
        byteCount += bytes.length;
        if (!containsNul && bytes.includes(0)) containsNul = true;
        hash.update(bytes);
        if (prefixBytes < 4096) {
          const prefixPart = bytes.subarray(0, 4096 - prefixBytes);
          prefixChunks.push(prefixPart);
          prefixBytes += prefixPart.length;
        }
        if (validUtf8Text) {
          try {
            decoder.decode(bytes, { stream: true });
          } catch {
            validUtf8Text = false;
          }
        }
        await writeArtifactBytesFully(handle, bytes);
      }
      if (validUtf8Text) {
        try {
          decoder.decode();
        } catch {
          validUtf8Text = false;
        }
      }
      await handle.sync();
      await handle.close();
      handle = undefined;

      const sha256 = hash.digest("hex");
      if (sha256 !== input.expectedSha256) throw new ArtifactError("digest_mismatch");
      const persisted = await hashPath(quarantinePath);
      if (persisted.sha256 !== sha256 || persisted.byteCount !== byteCount) {
        throw new ArtifactError("storage_integrity");
      }
      const detectedContentType = detectContentType(
        Buffer.concat(prefixChunks),
        validUtf8Text,
        containsNul,
      );
      if (input.declaredContentType !== null && input.declaredContentType !== detectedContentType) {
        throw new ArtifactError("invalid_content_type");
      }
      await validateStoredContent(quarantinePath, detectedContentType, byteCount);
      return await this.runExclusive(async () => {
        canonicalPath = await this.canonicalPath(sha256);
        try {
          await link(quarantinePath, canonicalPath);
          newlyPublished = true;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }
        await verifyAndSealCanonical(canonicalPath, sha256, byteCount);
        await unlink(quarantinePath);
        await fsyncDirectory(this.quarantineDirectory);

        const ready: ReadyArtifactRecord = {
          ...staging,
          state: "ready",
          detectedContentType,
          byteCount,
          sha256,
          expiresAt: staging.expiresAt,
        };
        try {
          const readyAt = this.now();
          if (!Number.isFinite(readyAt.getTime())) throw new ArtifactError("storage_unavailable");
          const committed = await this.repository.commitReady({
            artifact: ready,
            actor: input.actor,
            readyAt: readyAt.toISOString(),
          });
          return Object.freeze({ ...committed });
        } catch (error) {
          if (
            newlyPublished &&
            await this.repository.countReadyReferencesByDigest(sha256) === 0
          ) {
            await unlink(canonicalPath).catch(() => undefined);
            await fsyncDirectory(dirname(canonicalPath)).catch(() => undefined);
          }
          await this.failStaging(input);
          throw cleanStorageError(error);
        }
      });
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(quarantinePath).catch(() => undefined);
      if (canonicalPath && newlyPublished) {
        const references = await this.repository.countReadyReferencesByDigest(
          input.expectedSha256,
        ).catch(() => 1);
        if (references === 0) {
          await unlink(canonicalPath).catch(() => undefined);
          await fsyncDirectory(dirname(canonicalPath)).catch(() => undefined);
        }
      }
      await this.failStaging(input);
      throw cleanStorageError(error);
    }
  }

  async openDownload(input: {
    artifactId: string;
    actor: ArtifactIngestInput["actor"];
    rangeHeader?: string;
  }): Promise<ArtifactDownload> {
    assertArtifactReadActor(input.actor);
    const observedAt = this.now();
    if (!Number.isFinite(observedAt.getTime())) throw new ArtifactError("storage_unavailable");
    let artifact: ReadyArtifactRecord | null;
    try {
      artifact = await this.repository.findAuthorized({
        ...input,
        observedAt: observedAt.toISOString(),
      });
    } catch {
      throw new ArtifactError("not_found");
    }
    if (!artifact) throw new ArtifactError("not_found");
    const range = input.rangeHeader
      ? parseSingleByteRange(input.rangeHeader, artifact.byteCount)
      : null;
    const canonicalPath = await this.canonicalPath(artifact.sha256, false);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(canonicalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      await verifyDownloadHandle(handle, canonicalPath, artifact.sha256, artifact.byteCount);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw cleanStorageError(error);
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? artifact.byteCount - 1;
    let content: Readable;
    if (artifact.byteCount === 0) {
      await handle.close();
      content = Readable.from([]);
    } else {
      const source = handle.createReadStream({ start, end, autoClose: true });
      content = Readable.from((async function* redactedArtifactBytes() {
        try {
          for await (const chunk of source) yield chunk;
        } catch {
          throw new ArtifactError("storage_unavailable");
        } finally {
          source.destroy();
        }
      })());
    }
    return Object.freeze({
      status: range ? 206 as const : 200 as const,
      contentType: artifact.detectedContentType,
      contentLength: end - start + 1,
      byteCount: artifact.byteCount,
      sha256: artifact.sha256,
      range,
      content,
    });
  }

  collectGarbage(input: {
    dryRun: true;
  } | {
    dryRun: false;
    expectedPlanSha256: string;
  }): Promise<ArtifactGarbageCollectionReport> {
    if (!input || typeof input.dryRun !== "boolean") {
      return Promise.reject(new ArtifactError("storage_conflict"));
    }
    return this.runExclusive(() => this.collectGarbageExclusive(input));
  }

  expireDueDrafts(input: {
    actor: ArtifactIngestInput["actor"];
    limit?: number;
  }): Promise<ArtifactExpirationReport> {
    try {
      assertArtifactWriteActor(input.actor);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.runExclusive(async () => {
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw new ArtifactError("storage_conflict");
      }
      const observedAt = this.now();
      if (!Number.isFinite(observedAt.getTime())) {
        throw new ArtifactError("storage_unavailable");
      }
      return this.repository.expireDueDrafts({
        actor: input.actor,
        observedAt: observedAt.toISOString(),
        limit,
      });
    });
  }

  recoverAbandonedUploads(input: {
    actor: ArtifactIngestInput["actor"];
    dryRun: boolean;
    olderThanMs?: number;
    limit?: number;
  }): Promise<ArtifactRecoveryReport> {
    if (!input || typeof input.dryRun !== "boolean") {
      return Promise.reject(new ArtifactError("storage_conflict"));
    }
    try {
      assertArtifactWriteActor(input.actor);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.runExclusive(async () => {
      if (input.actor.kind !== "owner") throw new ArtifactError("scope_denied");
      const olderThanMs = input.olderThanMs ?? DEFAULT_ABANDONED_ARTIFACT_STAGING_MS;
      const limit = input.limit ?? 100;
      if (
        !Number.isSafeInteger(olderThanMs) ||
        olderThanMs < 1 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1000
      ) {
        throw new ArtifactError("storage_conflict");
      }
      const observedAt = this.now();
      if (!Number.isFinite(observedAt.getTime())) {
        throw new ArtifactError("storage_unavailable");
      }
      return this.repository.recoverAbandonedStaging({
        actor: input.actor,
        observedAt: observedAt.toISOString(),
        createdBefore: new Date(observedAt.getTime() - olderThanMs).toISOString(),
        limit,
        dryRun: input.dryRun,
      });
    });
  }

  private async collectGarbageExclusive(
    input: { dryRun: true } | { dryRun: false; expectedPlanSha256: string },
  ): Promise<ArtifactGarbageCollectionReport> {
    const activeDigests = new Set(await this.repository.listActiveDigests());
    const inventory: Array<{
      paths: string[];
      device: number;
      inode: number;
      candidate: ArtifactGarbageCollectionCandidate;
    }> = [];
    const inventoryByIdentity = new Map<string, typeof inventory[number]>();
    let deferredRecentQuarantineCount = 0;
    let deferredRecentQuarantineBytes = 0;
    const firstLevel = await readdir(this.objectsDirectory, { withFileTypes: true });
    for (const first of firstLevel.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!first.isDirectory() || !/^[a-f0-9]{2}$/.test(first.name)) {
        throw new ArtifactError("storage_integrity");
      }
      const firstPath = join(this.objectsDirectory, first.name);
      const secondLevel = await readdir(firstPath, { withFileTypes: true });
      for (const second of secondLevel.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!second.isDirectory() || !/^[a-f0-9]{2}$/.test(second.name)) {
          throw new ArtifactError("storage_integrity");
        }
        const secondPath = join(firstPath, second.name);
        const objects = await readdir(secondPath, { withFileTypes: true });
        for (const object of objects.sort((left, right) => left.name.localeCompare(right.name))) {
          if (
            !object.isFile() ||
            !/^[a-f0-9]{64}$/.test(object.name) ||
            !object.name.startsWith(`${first.name}${second.name}`)
          ) {
            throw new ArtifactError("storage_integrity");
          }
          if (activeDigests.has(object.name)) continue;
          const objectPath = join(secondPath, object.name);
          const objectStat = await lstat(objectPath);
          if (!objectStat.isFile()) throw new ArtifactError("storage_integrity");
          const verified = await hashPath(objectPath);
          if (verified.sha256 !== object.name || verified.byteCount !== objectStat.size) {
            throw new ArtifactError("storage_integrity");
          }
          const item: typeof inventory[number] = {
            paths: [objectPath],
            device: objectStat.dev,
            inode: objectStat.ino,
            candidate: {
              kind: "canonical_orphan" as const,
              digest: object.name,
              byteCount: objectStat.size,
              action: input.dryRun ? "would_quarantine" as const : "quarantined" as const,
            },
          };
          inventory.push(item);
          inventoryByIdentity.set(`${objectStat.dev}:${objectStat.ino}`, item);
        }
      }
    }
    const quarantineEntries = await readdir(this.quarantineDirectory, { withFileTypes: true });
    for (const entry of quarantineEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === "orphans" && entry.isDirectory()) continue;
      if (!entry.isFile()) throw new ArtifactError("storage_integrity");
      safeQuarantineId(entry.name);
      const quarantinePath = join(this.quarantineDirectory, entry.name);
      const quarantineStat = await lstat(quarantinePath);
      if (!quarantineStat.isFile()) throw new ArtifactError("storage_integrity");
      const identity = `${quarantineStat.dev}:${quarantineStat.ino}`;
      const existing = inventoryByIdentity.get(identity);
      if (existing) {
        existing.paths.push(quarantinePath);
        continue;
      }
      const observedAt = this.now();
      if (!Number.isFinite(observedAt.getTime())) throw new ArtifactError("storage_unavailable");
      if (quarantineStat.mtimeMs > observedAt.getTime() - DEFAULT_ABANDONED_ARTIFACT_STAGING_MS) {
        deferredRecentQuarantineCount += 1;
        deferredRecentQuarantineBytes += quarantineStat.size;
        if (!Number.isSafeInteger(deferredRecentQuarantineBytes)) {
          throw new ArtifactError("storage_integrity");
        }
        continue;
      }
      const verified = await hashPath(quarantinePath);
      const item: typeof inventory[number] = {
        paths: [quarantinePath],
        device: quarantineStat.dev,
        inode: quarantineStat.ino,
        candidate: {
          kind: "quarantine_orphan",
          digest: verified.sha256,
          byteCount: verified.byteCount,
          action: input.dryRun ? "would_quarantine" : "quarantined",
        },
      };
      inventory.push(item);
      inventoryByIdentity.set(identity, item);
    }
    const planSha256 = createHash("sha256").update(JSON.stringify(inventory.map((item) => ({
      kind: item.candidate.kind,
      digest: item.candidate.digest,
      byteCount: item.candidate.byteCount,
      sources: item.paths
        .map((path) => relative(this.rootDirectory, path))
        .sort((left, right) => left.localeCompare(right)),
      device: item.device,
      inode: item.inode,
    })))).digest("hex");
    if (!input.dryRun) {
      assertSha256(input.expectedPlanSha256);
      if (input.expectedPlanSha256 !== planSha256) throw new ArtifactError("storage_conflict");
    }
    const processed = input.dryRun ? inventory : [];
    if (!input.dryRun && inventory.length > 0) {
      const orphanDirectory = join(this.quarantineDirectory, "orphans");
      let createdOrphanDirectory = false;
      try {
        await mkdir(orphanDirectory, { mode: 0o700 });
        createdOrphanDirectory = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      await this.assertStoreDirectory(orphanDirectory);
      await chmod(orphanDirectory, 0o700);
      if (createdOrphanDirectory) await fsyncDirectory(this.quarantineDirectory);
      const resolvedOrphanDirectory = await realpath(orphanDirectory);
      if (!isInside(this.rootDirectory, resolvedOrphanDirectory)) {
        throw new ArtifactError("storage_integrity");
      }
      for (const item of inventory) {
          if (
            item.candidate.kind === "canonical_orphan" &&
            (await this.repository.listActiveDigests()).includes(item.candidate.digest)
          ) {
            continue;
          }
          const quarantineName = safeQuarantineId(this.quarantineId());
          const destination = join(
            resolvedOrphanDirectory,
            `${item.candidate.digest}.${quarantineName}`,
          );
          if (!isInside(resolvedOrphanDirectory, destination)) {
            throw new ArtifactError("storage_integrity");
          }
          for (const source of item.paths) {
            await this.assertStoreDirectory(dirname(source));
            const beforeLink = await lstat(source);
            if (
              !beforeLink.isFile() ||
              beforeLink.isSymbolicLink() ||
              beforeLink.dev !== item.device ||
              beforeLink.ino !== item.inode
            ) {
              throw new ArtifactError("storage_integrity");
            }
          }
          await link(item.paths[0]!, destination);
          let sourceRemoved = false;
          try {
            const destinationStat = await lstat(destination);
            if (
              !destinationStat.isFile() ||
              destinationStat.isSymbolicLink() ||
              destinationStat.dev !== item.device ||
              destinationStat.ino !== item.inode
            ) {
              throw new ArtifactError("storage_integrity");
            }
            const destinationHandle = await open(
              destination,
              fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
            );
            try {
              await destinationHandle.sync();
            } finally {
              await destinationHandle.close();
            }
            await fsyncDirectory(resolvedOrphanDirectory);
            if (
              item.candidate.kind === "canonical_orphan" &&
              (await this.repository.listActiveDigests()).includes(item.candidate.digest)
            ) {
              await unlink(destination);
              await fsyncDirectory(resolvedOrphanDirectory);
              continue;
            }
            for (const source of item.paths) {
              const sourceStat = await lstat(source);
              if (
                !sourceStat.isFile() ||
                sourceStat.isSymbolicLink() ||
                sourceStat.dev !== item.device ||
                sourceStat.ino !== item.inode
              ) {
                throw new ArtifactError("storage_integrity");
              }
            }
            const sourceDirectories = new Set<string>();
            for (const source of item.paths) {
              await unlink(source);
              sourceRemoved = true;
              sourceDirectories.add(dirname(source));
            }
            for (const sourceDirectory of sourceDirectories) {
              await fsyncDirectory(sourceDirectory);
            }
            await chmod(destination, 0o600);
            const sealedDestination = await open(
              destination,
              fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
            );
            try {
              await sealedDestination.sync();
            } finally {
              await sealedDestination.close();
            }
            await fsyncDirectory(resolvedOrphanDirectory);
            processed.push(item);
          } catch (error) {
            if (!sourceRemoved) {
              await unlink(destination).catch(() => undefined);
              await fsyncDirectory(resolvedOrphanDirectory).catch(() => undefined);
            }
            throw error;
          }
      }
    }
    const candidates = processed.map((item) => Object.freeze({ ...item.candidate }));
    let candidateBytes = 0;
    for (const candidate of candidates) {
      candidateBytes += candidate.byteCount;
      if (!Number.isSafeInteger(candidateBytes)) throw new ArtifactError("storage_integrity");
    }
    return Object.freeze({
      dryRun: input.dryRun,
      planSha256,
      mutated: !input.dryRun && candidates.length > 0,
      candidateCount: candidates.length,
      candidateBytes,
      deferredRecentQuarantineCount,
      deferredRecentQuarantineBytes,
      candidates: Object.freeze(candidates),
    });
  }

  private async canonicalPath(sha256: string, createParents = true): Promise<string> {
    assertSha256(sha256);
    await this.assertStoreDirectory(this.objectsDirectory);
    let parent = this.objectsDirectory;
    for (const segment of [sha256.slice(0, 2), sha256.slice(2, 4)]) {
      const child = join(parent, segment);
      let created = false;
      if (createParents) {
        try {
          await mkdir(child, { mode: 0o700 });
          created = true;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
            throw new ArtifactError("storage_integrity");
          }
        }
      }
      await this.assertStoreDirectory(child);
      await chmod(child, 0o700);
      if (created) await fsyncDirectory(parent);
      parent = child;
    }
    const candidate = join(parent, sha256);
    if (!isInside(this.objectsDirectory, candidate)) throw new ArtifactError("storage_integrity");
    return candidate;
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = rootMutationTails.get(this.rootDirectory) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveTail) => {
      release = resolveTail;
    });
    rootMutationTails.set(this.rootDirectory, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (rootMutationTails.get(this.rootDirectory) === current) {
        rootMutationTails.delete(this.rootDirectory);
      }
    }
  }

  private async withUploadAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireUploadAdmission();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquireUploadAdmission(): Promise<() => void> {
    let state = rootUploadAdmissions.get(this.rootDirectory);
    if (!state) {
      state = { active: 0, limit: this.maximumConcurrentUploads, waiters: [] };
      rootUploadAdmissions.set(this.rootDirectory, state);
    } else if (state.limit !== this.maximumConcurrentUploads) {
      return Promise.reject(new ArtifactError("storage_conflict"));
    }
    const makeRelease = (): (() => void) => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const current = rootUploadAdmissions.get(this.rootDirectory);
        if (!current) return;
        current.active -= 1;
        const waiter = current.waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timeout);
          current.active += 1;
          waiter.resolve(makeRelease());
        } else if (current.active === 0) {
          rootUploadAdmissions.delete(this.rootDirectory);
        }
      };
    };
    if (state.active < state.limit) {
      state.active += 1;
      return Promise.resolve(makeRelease());
    }
    if (state.waiters.length >= state.limit * 4) {
      return Promise.reject(new ArtifactError("storage_unavailable"));
    }
    return new Promise<() => void>((resolveAdmission, rejectAdmission) => {
      const waiter: UploadAdmissionWaiter = {
        resolve: resolveAdmission,
        timeout: setTimeout(() => {
          const current = rootUploadAdmissions.get(this.rootDirectory);
          const index = current?.waiters.indexOf(waiter) ?? -1;
          if (current && index >= 0) current.waiters.splice(index, 1);
          rejectAdmission(new ArtifactError("storage_unavailable"));
        }, this.uploadAdmissionTimeoutMs),
      };
      state!.waiters.push(waiter);
    });
  }

  private async assertStoreDirectory(path: string): Promise<void> {
    try {
      const [entry, resolvedPath] = await Promise.all([lstat(path), realpath(path)]);
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        resolvedPath !== path ||
        !isInside(this.rootDirectory, resolvedPath)
      ) {
        throw new ArtifactError("storage_integrity");
      }
    } catch {
      throw new ArtifactError("storage_integrity");
    }
  }

  private async failStaging(input: ArtifactIngestInput): Promise<void> {
    const failedAt = this.now();
    if (!Number.isFinite(failedAt.getTime())) return;
    await this.repository.markFailed({
      artifactId: input.artifactId,
      actor: input.actor,
      failedAt: failedAt.toISOString(),
    }).catch(() => undefined);
  }
}
