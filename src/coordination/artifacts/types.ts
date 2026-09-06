import type { Readable } from "node:stream";
import type {
  MessagingActorContext,
  MessagingParticipantDirectory,
  ResolvedMessagingActor,
} from "../channels/index.js";
import type { CoordinationTransaction } from "../db/index.js";

export type ArtifactState = "staging" | "ready" | "failed" | "expired" | "deleted";

export type ArtifactActor = ResolvedMessagingActor;
export type ArtifactActorContext = MessagingActorContext;
export type ArtifactParticipantDirectory = MessagingParticipantDirectory;

export interface StagingArtifactRecord {
  id: string;
  ownerPrincipalId: string;
  state: "staging";
  name: string;
  declaredContentType: string | null;
  detectedContentType: null;
  byteCount: 0;
  sha256: null;
  storage: "content_addressed";
  createdAt: string;
  expiresAt: string;
}

export interface ReadyArtifactRecord {
  id: string;
  ownerPrincipalId: string;
  state: "ready";
  name: string;
  declaredContentType: string | null;
  detectedContentType: string;
  byteCount: number;
  sha256: string;
  storage: "content_addressed";
  createdAt: string;
  expiresAt: string | null;
}

/** M02-ready attachment plus the atomically committed M04 event watermark. */
export type ArtifactProjection = Readonly<ReadyArtifactRecord & {
  throughEventSequence: number;
}>;

export interface ArtifactMetadataRepository {
  beginStaging(input: {
    artifact: StagingArtifactRecord;
    actor: ArtifactActor;
  }): Promise<void>;
  commitReady(input: {
    artifact: ReadyArtifactRecord;
    actor: ArtifactActor;
    readyAt: string;
    idempotency?: ArtifactCreateIdempotency;
  }): Promise<ArtifactProjection>;
  markFailed(input: {
    artifactId: string;
    actor: ArtifactActor;
    failedAt: string;
  }): Promise<void>;
  findAuthorized(input: {
    artifactId: string;
    actor: ArtifactActor;
    observedAt: string;
  }): Promise<ReadyArtifactRecord | null>;
  countReadyReferencesByDigest(sha256: string): Promise<number>;
  listActiveDigests(): Promise<readonly string[]>;
  expireDueDrafts(input: {
    actor: ArtifactActor;
    observedAt: string;
    limit: number;
  }): Promise<ArtifactExpirationReport>;
  recoverAbandonedStaging(input: {
    actor: ArtifactActor;
    observedAt: string;
    createdBefore: string;
    limit: number;
    dryRun: boolean;
  }): Promise<ArtifactRecoveryReport>;
}

export interface ArtifactServiceDatabase {
  readOne<T = Record<string, unknown>>(sql: string, ...parameters: Array<string | number | bigint | Buffer | null>): T | undefined;
}

export interface AttachmentSummary {
  id: string;
  name: string;
  contentType: string;
  byteCount: number;
  sha256: string;
}

/**
 * Internal, verified reference to one immutable content-addressed object.
 * This is never part of a public attachment DTO; it exists only so the local
 * resident bridge can hand AgentLoop a path whose bytes were checked against
 * the canonical Message attachment metadata.
 */
export interface LocalArtifactReference extends AttachmentSummary {
  path: string;
}

/**
 * M08 integration seam. Its Message append owner calls this inside the same
 * M04 transaction after inserting the immutable Message and before returning
 * the Message event/idempotency receipt.
 */
export interface ArtifactMessageLinkTransactionPort {
  linkReadyArtifacts(
    transaction: CoordinationTransaction,
    input: {
      messageId: string;
      channelId: string;
      artifactIds: readonly string[];
      actor: ArtifactActor;
      linkedAt: string;
    },
  ): readonly AttachmentSummary[];
}

export interface ArtifactIngestInput {
  artifactId: string;
  actor: ArtifactActor;
  originalName: string;
  declaredContentType: string | null;
  expectedSha256: string;
  content: AsyncIterable<Uint8Array>;
  idempotency?: ArtifactCreateIdempotency;
}

export interface ArtifactCreateIdempotency {
  keyDigest: string;
  requestDigest: string;
}

export interface ArtifactDownload {
  status: 200 | 206;
  contentType: string;
  contentLength: number;
  byteCount: number;
  sha256: string;
  range: { start: number; end: number; total: number } | null;
  content: Readable;
}

export interface ArtifactGarbageCollectionCandidate {
  kind: "canonical_orphan" | "quarantine_orphan";
  digest: string;
  byteCount: number;
  action: "would_quarantine" | "quarantined";
}

export interface ArtifactGarbageCollectionReport {
  dryRun: boolean;
  planSha256: string;
  mutated: boolean;
  candidateCount: number;
  candidateBytes: number;
  deferredRecentQuarantineCount: number;
  deferredRecentQuarantineBytes: number;
  candidates: readonly ArtifactGarbageCollectionCandidate[];
}

export interface ArtifactExpirationReport {
  observedAt: string;
  expiredArtifactIds: readonly string[];
}

export interface ArtifactRecoveryReport {
  dryRun: boolean;
  observedAt: string;
  abandonedArtifactIds: readonly string[];
}

export interface LocalArtifactStoreOptions {
  rootDirectory: string;
  repository: ArtifactMetadataRepository;
  maximumBytes?: number;
  draftLifetimeMs?: number;
  maximumConcurrentUploads?: number;
  uploadAdmissionTimeoutMs?: number;
  now?: () => Date;
  quarantineId?: () => string;
}
