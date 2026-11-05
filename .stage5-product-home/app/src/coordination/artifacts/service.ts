import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import { digestExactAction } from "../policy/index.js";
import { resolveArtifactActor, resolveArtifactReader } from "./access.js";
import { ArtifactError } from "./errors.js";
import { DEFAULT_MAXIMUM_ARTIFACT_BYTES, LocalArtifactStore } from "./store.js";
import type {
  ArtifactMetadataRepository, ArtifactParticipantDirectory, ArtifactProjection,
  ArtifactServiceDatabase,
} from "./types.js";

const KEY = /^[\x20-\x7e]{16,128}$/;
const MAX_METADATA_BYTES = 16 * 1024;

interface UploadMetadata {
  artifactId: string;
  name: string;
  declaredContentType: string | null;
  expectedSha256: string;
}

function boundaryFrom(contentType: string): string {
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/iu.exec(contentType);
  const value = match?.[1] ?? match?.[2];
  if (!value || value.length > 70 || /[\r\n\0]/u.test(value)) throw new ArtifactError("invalid_content_type");
  return value;
}

function parseMetadata(value: Buffer): UploadMetadata {
  if (value.length > MAX_METADATA_BYTES) throw new ArtifactError("size_limit_exceeded");
  let parsed: unknown;
  try { parsed = JSON.parse(value.toString("utf8")); } catch { throw new ArtifactError("storage_conflict"); }
  const item = parsed as Partial<UploadMetadata> | null;
  if (!item || typeof item.artifactId !== "string" || typeof item.name !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.expectedSha256 ?? "") ||
      !(item.declaredContentType === null || typeof item.declaredContentType === "string")) {
    throw new ArtifactError("storage_conflict");
  }
  return Object.freeze(item as UploadMetadata);
}

async function readMultipart(input: Readable, boundary: string): Promise<{
  metadata: UploadMetadata; content: AsyncIterable<Uint8Array>;
}> {
  const iterator = input[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0);
  const takeUntil = async (needle: Buffer, maximum: number): Promise<Buffer> => {
    for (;;) {
      const index = buffer.indexOf(needle);
      if (index >= 0) { const out = buffer.subarray(0, index); buffer = buffer.subarray(index + needle.length); return out; }
      if (buffer.length > maximum) throw new ArtifactError("size_limit_exceeded");
      const next = await iterator.next();
      if (next.done) throw new ArtifactError("storage_conflict");
      buffer = Buffer.concat([buffer, Buffer.from(next.value)]);
    }
  };
  const marker = Buffer.from(`--${boundary}\r\n`);
  const first = await takeUntil(Buffer.from("\r\n\r\n"), MAX_METADATA_BYTES);
  if (!first.subarray(0, marker.length).equals(marker) || !/name="metadata"/iu.test(first.toString("utf8"))) {
    throw new ArtifactError("storage_conflict");
  }
  const separator = Buffer.from(`\r\n--${boundary}\r\n`);
  const metadata = parseMetadata(await takeUntil(separator, MAX_METADATA_BYTES));
  const contentHeaders = await takeUntil(Buffer.from("\r\n\r\n"), MAX_METADATA_BYTES);
  if (!/name="content"/iu.test(contentHeaders.toString("utf8"))) throw new ArtifactError("storage_conflict");
  const closing = Buffer.from(`\r\n--${boundary}--`);
  async function* content(): AsyncIterable<Uint8Array> {
    for (;;) {
      const index = buffer.indexOf(closing);
      if (index >= 0) {
        if (index > 0) yield buffer.subarray(0, index);
        buffer = buffer.subarray(index + closing.length);
        if (!/^\r\n?$/u.test(buffer.toString("binary")) && buffer.length !== 0) throw new ArtifactError("storage_conflict");
        const tail = await iterator.next();
        if (!tail.done) throw new ArtifactError("storage_conflict");
        return;
      }
      const retain = closing.length - 1;
      if (buffer.length > retain) { yield buffer.subarray(0, buffer.length - retain); buffer = buffer.subarray(buffer.length - retain); }
      const next = await iterator.next();
      if (next.done) throw new ArtifactError("storage_conflict");
      buffer = Buffer.concat([buffer, Buffer.from(next.value)]);
    }
  }
  return { metadata, content: content() };
}

function keyDigest(key: string): string {
  if (!KEY.test(key)) throw new ArtifactError("storage_conflict");
  return createHash("sha256").update("home23-attachment-idempotency:attachment.create:v1\0").update(key).digest("hex");
}

export function createDurableAttachmentService(input: {
  database: ArtifactServiceDatabase;
  repository: ArtifactMetadataRepository;
  store: LocalArtifactStore;
  participantDirectory: ArtifactParticipantDirectory;
  maximumRequestBytes?: number;
  now?: () => Date;
}) {
  if (!input.database || !input.repository || !input.store || !input.participantDirectory) {
    throw new TypeError("durable attachment service requires complete dependencies");
  }
  const maximumRequestBytes = input.maximumRequestBytes ?? DEFAULT_MAXIMUM_ARTIFACT_BYTES + 64 * 1024;
  const now = input.now ?? (() => new Date());
  const replay = (principalId: string, digest: string, requestDigest?: string): ArtifactProjection | null => {
    const row = input.database.readOne<{
      requestDigest: string; id: string; ownerPrincipalId: string; name: string;
      declaredContentType: string | null; detectedContentType: string; byteCount: number;
      sha256: string; createdAt: string; expiresAt: string | null; sequence: number;
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
       WHERE receipt.principal_id = ? AND receipt.key_digest = ?`, principalId, digest);
    if (!row) return null;
    if (requestDigest && row.requestDigest !== requestDigest) throw new ArtifactError("storage_conflict");
    return Object.freeze({ id: row.id, ownerPrincipalId: row.ownerPrincipalId, state: "ready", name: row.name,
      declaredContentType: row.declaredContentType, detectedContentType: row.detectedContentType,
      byteCount: row.byteCount, sha256: row.sha256, storage: "content_addressed",
      createdAt: row.createdAt, expiresAt: row.expiresAt, throughEventSequence: row.sequence });
  };
  return Object.freeze({
    async create(args: { context: Parameters<typeof resolveArtifactActor>[0]; idempotencyKey: string; contentType: string; contentLength: number | null; body: Readable }) {
      const actor = await resolveArtifactActor(args.context, input.participantDirectory);
      const digest = keyDigest(args.idempotencyKey);
      if (args.contentLength !== null && args.contentLength > maximumRequestBytes) throw new ArtifactError("size_limit_exceeded");
      const parsed = await readMultipart(args.body, boundaryFrom(args.contentType));
      const requestDigest = digestExactAction({ actorPrincipalId: actor.principalId, operation: "attachment.create", target: "artifact", parameters: {
        artifactId: parsed.metadata.artifactId, name: parsed.metadata.name,
        declaredContentType: parsed.metadata.declaredContentType,
        expectedSha256: parsed.metadata.expectedSha256,
      } });
      const prior = replay(actor.principalId, digest, requestDigest);
      if (prior) {
        const hash = createHash("sha256");
        let byteCount = 0;
        for await (const chunk of parsed.content) {
          byteCount += chunk.byteLength;
          if (byteCount > DEFAULT_MAXIMUM_ARTIFACT_BYTES) throw new ArtifactError("size_limit_exceeded");
          hash.update(chunk);
        }
        if (hash.digest("hex") !== parsed.metadata.expectedSha256 || byteCount !== prior.byteCount) {
          throw new ArtifactError("storage_conflict");
        }
        return prior;
      }
      let projection: ArtifactProjection;
      try {
        projection = await input.store.ingest({ ...parsed.metadata, originalName: parsed.metadata.name,
          actor, content: parsed.content, idempotency: { keyDigest: digest, requestDigest } });
      } catch (error) {
        const raced = replay(actor.principalId, digest, requestDigest);
        if (raced) return raced;
        throw error;
      }
      return projection;
    },
    async getMetadata(args: { context: Parameters<typeof resolveArtifactReader>[0]; artifactId: string }) {
      const actor = await resolveArtifactReader(args.context, input.participantDirectory);
      const artifact = await input.repository.findAuthorized({ artifactId: args.artifactId, actor, observedAt: now().toISOString() });
      if (!artifact) throw new ArtifactError("not_found");
      const event = input.database.readOne<{ sequence: number }>(`SELECT max(sequence) AS sequence FROM events WHERE aggregate_kind = 'artifact' AND aggregate_id = ?`, artifact.id);
      if (!event || !Number.isSafeInteger(event.sequence)) throw new ArtifactError("storage_integrity");
      return Object.freeze({ ...artifact, throughEventSequence: event.sequence });
    },
    async openDownload(args: { context: Parameters<typeof resolveArtifactReader>[0]; artifactId: string; rangeHeader?: string }) {
      const actor = await resolveArtifactReader(args.context, input.participantDirectory);
      return input.store.openDownload({ artifactId: args.artifactId, actor, rangeHeader: args.rangeHeader });
    },
  });
}
