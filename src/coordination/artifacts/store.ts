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

import { detectAttachmentContentType, isAttachmentContentType, ATTACHMENT_PREVIEW_CONTENT_TYPES } from "../../attachment-content.js";
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
  AttachmentSummary,
  LocalArtifactReference,
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
// Storage accepts files independently of preview support. Unknown formats remain
// opaque, downloadable bytes; they are never executed or decoded during upload.
export const SUPPORTED_ARTIFACT_CONTENT_TYPES = ATTACHMENT_PREVIEW_CONTENT_TYPES;
export const ARTIFACT_CONTENT_POLICY = Object.freeze({
  version: 2,
  maximumBytes: DEFAULT_MAXIMUM_ARTIFACT_BYTES,
  acceptsGeneralFiles: true,
  detection: "signature_or_utf8_with_opaque_fallback",
  previewValidation: "performed_by_the_viewer",
});

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

async function readExact(handle: OpenFileHandle, position: number, length: number): Promise<Buffer | null> {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = await handle.read(bytes, offset, length - offset, position + offset);
    if (read.bytesRead === 0) return null;
    offset += read.bytesRead;
  }
  return bytes;
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
    if (input.declaredContentType !== null && !isAttachmentContentType(input.declaredContentType)) {
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
      const detectedContentType = detectAttachmentContentType(
        Buffer.concat(prefixChunks),
        validUtf8Text,
        containsNul,
      );
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
            idempotency: input.idempotency,
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

  /**
   * Resolve a canonical Message attachment to its sealed local object. The
   * caller owns Message/Work authorization; this method owns path confinement
   * and byte/digest verification. Public clients never receive this path.
   */
  async verifiedLocalReference(
    attachment: AttachmentSummary,
  ): Promise<LocalArtifactReference> {
    try {
      assertCoordinationId("artifact", attachment.id);
    } catch {
      throw new ArtifactError("storage_integrity");
    }
    if (
      typeof attachment.name !== "string" ||
      attachment.name.length < 1 ||
      attachment.name.length > 255 ||
      typeof attachment.contentType !== "string" ||
      !isAttachmentContentType(attachment.contentType) ||
      !Number.isSafeInteger(attachment.byteCount) ||
      attachment.byteCount < 0 ||
      attachment.byteCount > this.maximumBytes
    ) {
      throw new ArtifactError("storage_integrity");
    }
    assertSha256(attachment.sha256);
    const path = await this.canonicalPath(attachment.sha256, false);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      await verifyDownloadHandle(
        handle,
        path,
        attachment.sha256,
        attachment.byteCount,
      );
    } catch (error) {
      if (error instanceof ArtifactError) throw error;
      throw new ArtifactError("storage_integrity");
    } finally {
      await handle?.close().catch(() => undefined);
    }
    return Object.freeze({ ...attachment, path });
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
