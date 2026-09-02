import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type {
  ResidentArtifactPromotionPort,
  ResidentLeaseBinding,
} from "../../coordination-adapter/index.js";
import type { MediaAttachment } from "../../types.js";
import type { MessagingActorContext } from "../channels/index.js";
import { resolveArtifactActor } from "./access.js";
import { ArtifactError } from "./errors.js";
import {
  DEFAULT_MAXIMUM_ARTIFACT_BYTES,
  LocalArtifactStore,
} from "./store.js";
import type {
  ArtifactParticipantDirectory,
  ArtifactProjection,
  ArtifactServiceDatabase,
} from "./types.js";

const MAX_RESIDENT_ARTIFACTS = 10;
const IMAGE_CONTENT_TYPES = new Set(["image/gif", "image/jpeg", "image/png"]);
const MAX_UUID_V7_TIMESTAMP = (1n << 48n) - 1n;

type ExactResidentImage = Readonly<{
  type: "image";
  path: string;
  name: string;
  contentType: string;
  byteCount: number;
  sha256: string;
}>;

function sha256(...values: string[]): string {
  const hash = createHash("sha256");
  for (const value of values) hash.update(value, "utf8");
  return hash.digest("hex");
}

function exactTimestamp(value: string): number {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new ArtifactError("storage_conflict");
  }
  return parsed.valueOf();
}

function formatStableUuidV7(stableKey: string, createdAt: string): string {
  const timestamp = BigInt(exactTimestamp(createdAt));
  if (timestamp < 0n || timestamp > MAX_UUID_V7_TIMESTAMP) {
    throw new ArtifactError("storage_conflict");
  }
  const bytes = Buffer.alloc(16);
  let remaining = timestamp;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  createHash("sha256")
    .update("home23-resident-artifact-id-v1\0", "utf8")
    .update(stableKey, "utf8")
    .digest()
    .copy(bytes, 6, 0, 10);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString("hex");
  return `art_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function exactImage(value: MediaAttachment): ExactResidentImage {
  const candidate = value as MediaAttachment & { generatedBy?: string };
  if (
    candidate?.type !== "image" ||
    candidate.generatedBy !== "generate_image" ||
    typeof candidate.path !== "string" ||
    !isAbsolute(candidate.path) ||
    candidate.path.length < 1 ||
    candidate.path.length > 4_096 ||
    candidate.path.includes("\0") ||
    typeof candidate.fileName !== "string" ||
    candidate.fileName.length < 1 ||
    candidate.fileName.length > 255 ||
    candidate.fileName.normalize("NFC") !== candidate.fileName ||
    candidate.fileName === "." ||
    candidate.fileName === ".." ||
    /^[A-Za-z]:/u.test(candidate.fileName) ||
    /[\0-\x1f\x7f/\\]/u.test(candidate.fileName) ||
    typeof candidate.mimeType !== "string" ||
    !IMAGE_CONTENT_TYPES.has(candidate.mimeType) ||
    !Number.isSafeInteger(candidate.byteCount) ||
    candidate.byteCount! < 1 ||
    candidate.byteCount! > DEFAULT_MAXIMUM_ARTIFACT_BYTES ||
    typeof candidate.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.sha256)
  ) {
    throw new ArtifactError("storage_conflict");
  }
  return Object.freeze({
    type: "image",
    path: candidate.path,
    name: candidate.fileName,
    contentType: candidate.mimeType,
    byteCount: candidate.byteCount!,
    sha256: candidate.sha256,
  });
}

function stableKey(
  binding: ResidentLeaseBinding,
  ordinal: number,
  image: ExactResidentImage,
): string {
  return [
    binding.workId,
    binding.holderPrincipalId,
    String(ordinal),
    image.sha256,
    image.name,
    image.contentType,
    String(image.byteCount),
  ].join("\0");
}

async function *fileChunks(handle: FileHandle, expectedBytes: number): AsyncGenerator<Uint8Array> {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < expectedBytes) {
    const read = await handle.read(buffer, 0, Math.min(buffer.length, expectedBytes - offset), offset);
    if (read.bytesRead === 0) break;
    offset += read.bytesRead;
    yield Buffer.from(buffer.subarray(0, read.bytesRead));
  }
  if (offset !== expectedBytes) throw new ArtifactError("storage_integrity");
  const final = await handle.read(buffer, 0, 1, offset);
  if (final.bytesRead !== 0) throw new ArtifactError("storage_integrity");
}

async function verifySource(handle: FileHandle, image: ExactResidentImage): Promise<void> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of fileChunks(handle, image.byteCount)) {
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  if (bytes !== image.byteCount || hash.digest("hex") !== image.sha256) {
    throw new ArtifactError("storage_integrity");
  }
}

function exactProjection(projection: ArtifactProjection, input: {
  artifactId: string;
  actorPrincipalId: string;
  image: ExactResidentImage;
}): boolean {
  return projection.id === input.artifactId &&
    projection.ownerPrincipalId === input.actorPrincipalId &&
    projection.name === input.image.name &&
    projection.declaredContentType === input.image.contentType &&
    projection.detectedContentType === input.image.contentType &&
    projection.byteCount === input.image.byteCount &&
    projection.sha256 === input.image.sha256;
}

export function createResidentArtifactPromotionPort(input: {
  database: ArtifactServiceDatabase;
  store(): LocalArtifactStore | undefined;
  participantDirectory: ArtifactParticipantDirectory;
  context(binding: ResidentLeaseBinding): MessagingActorContext;
}): ResidentArtifactPromotionPort {
  const replay = (
    principalId: string,
    keyDigest: string,
    requestDigest: string,
  ): ArtifactProjection | null => {
    const row = input.database.readOne<{
      requestDigest: string;
      id: string;
      ownerPrincipalId: string;
      name: string;
      declaredContentType: string | null;
      detectedContentType: string;
      byteCount: number;
      sha256: string;
      createdAt: string;
      expiresAt: string | null;
      sequence: number;
    }>(`SELECT receipt.request_digest AS requestDigest, artifact.id,
              artifact.owner_principal_id AS ownerPrincipalId,
              artifact.original_name AS name,
              artifact.declared_content_type AS declaredContentType,
              artifact.detected_content_type AS detectedContentType,
              artifact.byte_count AS byteCount, artifact.sha256,
              artifact.created_at AS createdAt, artifact.expires_at AS expiresAt,
              event.sequence
       FROM attachment_create_idempotency receipt
       JOIN artifacts artifact ON artifact.id = receipt.artifact_id AND artifact.state = 'ready'
       JOIN events event ON event.aggregate_kind = 'artifact' AND event.aggregate_id = artifact.id
                        AND event.aggregate_version = 2 AND event.type = 'attachment.updated'
       WHERE receipt.principal_id = ? AND receipt.key_digest = ?`, principalId, keyDigest);
    if (!row) return null;
    if (row.requestDigest !== requestDigest) throw new ArtifactError("storage_conflict");
    return Object.freeze({
      id: row.id,
      ownerPrincipalId: row.ownerPrincipalId,
      state: "ready",
      name: row.name,
      declaredContentType: row.declaredContentType,
      detectedContentType: row.detectedContentType,
      byteCount: row.byteCount,
      sha256: row.sha256,
      storage: "content_addressed",
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      throughEventSequence: row.sequence,
    });
  };

  return Object.freeze({
    async promote({ binding, media }: {
      binding: ResidentLeaseBinding;
      media: MediaAttachment[];
    }) {
      if (!Array.isArray(media) || media.length < 1 || media.length > MAX_RESIDENT_ARTIFACTS) {
        throw new ArtifactError("storage_conflict");
      }
      const store = input.store();
      if (!store) throw new ArtifactError("storage_unavailable");
      const work = input.database.readOne<{ createdAt: string; targetPrincipalId: string }>(
        "SELECT created_at AS createdAt, target_principal_id AS targetPrincipalId FROM works WHERE id = ?",
        binding.workId,
      );
      if (!work || work.targetPrincipalId !== binding.holderPrincipalId) {
        throw new ArtifactError("identity_context_mismatch");
      }
      exactTimestamp(work.createdAt);
      const actor = await resolveArtifactActor(input.context(binding), input.participantDirectory);
      if (actor.principalId !== binding.holderPrincipalId) {
        throw new ArtifactError("identity_context_mismatch");
      }

      const artifactIds: string[] = [];
      for (const [ordinal, raw] of media.entries()) {
        const image = exactImage(raw);
        const identity = stableKey(binding, ordinal, image);
        const artifactId = formatStableUuidV7(identity, work.createdAt);
        const keyDigest = sha256(
          "home23-resident-artifact-idempotency-key-v1\0",
          binding.workId,
          "\0",
          binding.holderPrincipalId,
          "\0",
          String(ordinal),
        );
        const requestDigest = sha256("home23-resident-artifact-request-v1\0", identity);
        let handle: FileHandle | undefined;
        try {
          handle = await open(image.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size !== image.byteCount) {
            throw new ArtifactError("storage_integrity");
          }
          const prior = replay(actor.principalId, keyDigest, requestDigest);
          if (prior) {
            await verifySource(handle, image);
            if (!exactProjection(prior, { artifactId, actorPrincipalId: actor.principalId, image })) {
              throw new ArtifactError("storage_conflict");
            }
            artifactIds.push(prior.id);
            continue;
          }
          let projection: ArtifactProjection;
          try {
            projection = await store.ingest({
              artifactId,
              actor,
              originalName: image.name,
              declaredContentType: image.contentType,
              expectedSha256: image.sha256,
              content: fileChunks(handle, image.byteCount),
              idempotency: { keyDigest, requestDigest },
            });
          } catch (error) {
            const raced = replay(actor.principalId, keyDigest, requestDigest);
            if (!raced) throw error;
            await verifySource(handle, image);
            projection = raced;
          }
          if (!exactProjection(projection, { artifactId, actorPrincipalId: actor.principalId, image })) {
            throw new ArtifactError("storage_conflict");
          }
          artifactIds.push(projection.id);
        } finally {
          await handle?.close().catch(() => undefined);
        }
      }
      return Object.freeze(artifactIds);
    },
  });
}
