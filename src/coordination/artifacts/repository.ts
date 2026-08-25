import type {
  CoordinationDatabase,
  CoordinationTransaction,
} from "../db/index.js";
import { assertCoordinationId } from "../ids/index.js";
import { assertArtifactReadActor, assertArtifactWriteActor } from "./access.js";
import { ArtifactError } from "./errors.js";
import type {
  ArtifactActor,
  ArtifactMessageLinkTransactionPort,
  ArtifactMetadataRepository,
  ArtifactProjection,
  ArtifactExpirationReport,
  ArtifactRecoveryReport,
  AttachmentSummary,
  ReadyArtifactRecord,
  StagingArtifactRecord,
} from "./types.js";

type ArtifactDatabase = Pick<
  CoordinationDatabase,
  "readOne" | "readAll" | "mutateWithEvent"
>;

interface ArtifactRow {
  id: string;
  ownerPrincipalId: string;
  state: "staging" | "ready" | "failed" | "expired" | "deleted";
  name: string;
  declaredContentType: string | null;
  detectedContentType: string | null;
  byteCount: number | null;
  sha256: string | null;
  createdAt: string;
  expiresAt: string | null;
  version: number;
}

function assertArtifactId(value: string, code: "invalid_artifact_id" | "invalid_link"): void {
  try {
    assertCoordinationId("artifact", value);
  } catch {
    throw new ArtifactError(code);
  }
}

function assertIsoTimestamp(value: string): void {
  try {
    if (new Date(value).toISOString() !== value) throw new Error("not canonical");
  } catch {
    throw new ArtifactError("storage_conflict");
  }
}

function isSqliteConstraint(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    String(error.code).startsWith("SQLITE_CONSTRAINT");
}

function artifactSelect(where: string): string {
  return `SELECT id, owner_principal_id AS ownerPrincipalId, state,
                 original_name AS name, declared_content_type AS declaredContentType,
                 detected_content_type AS detectedContentType,
                 byte_count AS byteCount, sha256, created_at AS createdAt,
                 expires_at AS expiresAt, version
          FROM artifacts WHERE ${where}`;
}

function toReady(row: ArtifactRow): ReadyArtifactRecord {
  if (
    row.state !== "ready" ||
    row.detectedContentType === null ||
    row.byteCount === null ||
    row.sha256 === null
  ) {
    throw new ArtifactError("storage_integrity");
  }
  return Object.freeze({
    id: row.id,
    ownerPrincipalId: row.ownerPrincipalId,
    state: "ready" as const,
    name: row.name,
    declaredContentType: row.declaredContentType,
    detectedContentType: row.detectedContentType,
    byteCount: row.byteCount,
    sha256: row.sha256,
    storage: "content_addressed" as const,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  });
}

function assertStoredActor(
  database: Pick<ArtifactDatabase, "readOne"> | CoordinationTransaction,
  actor: ArtifactActor,
  requireAttachmentCapability = false,
): void {
  const principal = database.readOne<{ kind: "owner" | "bot" }>(
    "SELECT kind FROM principals WHERE id = ?",
    actor.principalId,
  );
  if (!principal || principal.kind !== actor.kind) {
    throw new ArtifactError("identity_context_mismatch");
  }
  if (actor.kind === "owner") {
    if (
      actor.principalId !== "user_owner" ||
      actor.displayName !== "Owner" ||
      actor.residentCredential !== null
    ) {
      throw new ArtifactError("identity_context_mismatch");
    }
    return;
  }
  const credential = actor.residentCredential;
  if (!credential) throw new ArtifactError("identity_context_mismatch");
  const bot = database.readOne<{
    residentBinding: string;
    instanceId: string | null;
    keyVersion: number | null;
    lifecycle: string;
    name: string;
    continuingIdentity: number;
    durableMailbox: number;
    requiredCapabilitiesJson: string;
    residentCapabilitiesJson: string;
  }>(
    `SELECT name, resident_binding AS residentBinding,
            active_instance_id AS instanceId,
            active_key_version AS keyVersion,
            lifecycle, continuing_identity AS continuingIdentity,
            durable_mailbox AS durableMailbox,
            required_capabilities_json AS requiredCapabilitiesJson,
            resident_capabilities_json AS residentCapabilitiesJson
     FROM bots WHERE id = ? AND principal_id = ?`,
    actor.principalId,
    actor.principalId,
  );
  let requiredCapabilities: unknown = [];
  let residentCapabilities: unknown = [];
  try {
    requiredCapabilities = bot ? JSON.parse(bot.requiredCapabilitiesJson) : [];
    residentCapabilities = bot ? JSON.parse(bot.residentCapabilitiesJson) : [];
  } catch {
    throw new ArtifactError("identity_context_mismatch");
  }
  if (
    !bot ||
    bot.lifecycle !== "active" ||
    bot.continuingIdentity !== 1 ||
    bot.durableMailbox !== 1 ||
    bot.name !== actor.displayName ||
    bot.residentBinding !== credential.residentBinding ||
    bot.instanceId !== credential.instanceId ||
    bot.keyVersion !== credential.keyVersion ||
    (requireAttachmentCapability && (
      !Array.isArray(requiredCapabilities) ||
      !requiredCapabilities.includes("attachments") ||
      !Array.isArray(residentCapabilities) ||
      !residentCapabilities.includes("attachments")
    ))
  ) {
    throw new ArtifactError("identity_context_mismatch");
  }
}

function eventPayload(
  artifactId: string,
  state: "staging" | "ready" | "failed" | "expired",
  ownerPrincipalId?: string,
): Record<string, string | number | boolean | null> {
  return ownerPrincipalId ? { artifactId, state, ownerPrincipalId } : { artifactId, state };
}

export class SqliteArtifactRepository
implements ArtifactMetadataRepository, ArtifactMessageLinkTransactionPort {
  constructor(private readonly database: ArtifactDatabase) {}

  async beginStaging(input: {
    artifact: StagingArtifactRecord;
    actor: ArtifactActor;
  }): Promise<void> {
    assertArtifactWriteActor(input.actor);
    assertArtifactId(input.artifact.id, "invalid_artifact_id");
    if (input.artifact.ownerPrincipalId !== input.actor.principalId) {
      throw new ArtifactError("identity_context_mismatch");
    }
    assertStoredActor(this.database, input.actor, true);
    try {
      this.database.mutateWithEvent((transaction) => {
        assertStoredActor(transaction, input.actor, true);
        transaction.run(
          `INSERT INTO artifacts (
            id, owner_principal_id, state, original_name, declared_content_type,
            detected_content_type, byte_count, sha256, storage_kind, created_at,
            expires_at, failed_at, deleted_at, version
          ) VALUES (?, ?, 'staging', ?, ?, NULL, 0, NULL, 'content_addressed', ?, ?, NULL, NULL, 1)`,
          input.artifact.id,
          input.artifact.ownerPrincipalId,
          input.artifact.name,
          input.artifact.declaredContentType,
          input.artifact.createdAt,
          input.artifact.expiresAt,
        );
        return {
          value: undefined,
          event: {
            type: "attachment.updated",
            aggregateKind: "artifact",
            aggregateId: input.artifact.id,
            aggregateVersion: 1,
            channelId: null,
            actorPrincipalId: input.actor.principalId,
            requestId: input.actor.requestId,
            correlationId: input.actor.correlationId,
            payload: eventPayload(input.artifact.id, "staging"),
            createdAt: input.artifact.createdAt,
          },
        };
      });
    } catch (error) {
      if (isSqliteConstraint(error)) throw new ArtifactError("artifact_id_conflict");
      throw error;
    }
  }

  async commitReady(input: {
    artifact: ReadyArtifactRecord;
    actor: ArtifactActor;
    readyAt: string;
    idempotency?: { keyDigest: string; requestDigest: string };
  }): Promise<ArtifactProjection> {
    assertArtifactWriteActor(input.actor);
    assertArtifactId(input.artifact.id, "invalid_artifact_id");
    assertIsoTimestamp(input.readyAt);
    assertStoredActor(this.database, input.actor, true);
    try {
      const result = this.database.mutateWithEvent((transaction) => {
        assertStoredActor(transaction, input.actor, true);
        const staging = transaction.readOne<ArtifactRow>(
          artifactSelect("id = ?"),
          input.artifact.id,
        );
        if (
          !staging ||
          staging.state !== "staging" ||
          staging.ownerPrincipalId !== input.actor.principalId ||
          input.artifact.ownerPrincipalId !== input.actor.principalId ||
          staging.name !== input.artifact.name ||
          staging.declaredContentType !== input.artifact.declaredContentType ||
          staging.createdAt !== input.artifact.createdAt ||
          staging.expiresAt !== input.artifact.expiresAt
        ) {
          throw new ArtifactError("storage_conflict");
        }
        const update = transaction.run(
          `UPDATE artifacts
           SET state = 'ready', detected_content_type = ?, byte_count = ?, sha256 = ?,
               version = version + 1
           WHERE id = ? AND state = 'staging' AND owner_principal_id = ? AND version = 1`,
          input.artifact.detectedContentType,
          input.artifact.byteCount,
          input.artifact.sha256,
          input.artifact.id,
          input.actor.principalId,
        );
        if (update.changes !== 1) throw new ArtifactError("storage_conflict");
        if (input.idempotency) {
          transaction.run(
            `INSERT INTO attachment_create_idempotency
             (principal_id, key_digest, request_digest, artifact_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            input.actor.principalId,
            input.idempotency.keyDigest,
            input.idempotency.requestDigest,
            input.artifact.id,
            input.readyAt,
          );
        }
        return {
          value: Object.freeze({ ...input.artifact }),
          event: {
            type: "attachment.updated",
            aggregateKind: "artifact",
            aggregateId: input.artifact.id,
            aggregateVersion: 2,
            channelId: null,
            actorPrincipalId: input.actor.principalId,
            requestId: input.actor.requestId,
            correlationId: input.actor.correlationId,
            payload: eventPayload(input.artifact.id, "ready"),
            createdAt: input.readyAt,
          },
        };
      });
      return Object.freeze({
        ...result.value,
        throughEventSequence: result.event.sequence,
      });
    } catch (error) {
      if (isSqliteConstraint(error)) throw new ArtifactError("storage_conflict");
      throw error;
    }
  }

  async markFailed(input: {
    artifactId: string;
    actor: ArtifactActor;
    failedAt: string;
  }): Promise<void> {
    assertArtifactWriteActor(input.actor);
    assertArtifactId(input.artifactId, "invalid_artifact_id");
    assertIsoTimestamp(input.failedAt);
    const current = this.database.readOne<ArtifactRow>(artifactSelect("id = ?"), input.artifactId);
    if (!current || current.state !== "staging") return;
    assertStoredActor(this.database, input.actor);
    this.database.mutateWithEvent((transaction) => {
      assertStoredActor(transaction, input.actor);
      const update = transaction.run(
        `UPDATE artifacts SET state = 'failed', failed_at = ?, expires_at = NULL,
                              version = version + 1
         WHERE id = ? AND state = 'staging' AND owner_principal_id = ?`,
        input.failedAt,
        input.artifactId,
        input.actor.principalId,
      );
      if (update.changes !== 1) throw new ArtifactError("storage_conflict");
      return {
        value: undefined,
        event: {
          type: "attachment.updated",
          aggregateKind: "artifact",
          aggregateId: input.artifactId,
          aggregateVersion: current.version + 1,
          channelId: null,
          actorPrincipalId: input.actor.principalId,
          requestId: input.actor.requestId,
          correlationId: input.actor.correlationId,
          payload: eventPayload(input.artifactId, "failed"),
          createdAt: input.failedAt,
        },
      };
    });
  }

  async findAuthorized(input: {
    artifactId: string;
    actor: ArtifactActor;
    observedAt: string;
  }): Promise<ReadyArtifactRecord | null> {
    assertArtifactReadActor(input.actor);
    try {
      assertArtifactId(input.artifactId, "invalid_artifact_id");
      assertIsoTimestamp(input.observedAt);
    } catch {
      return null;
    }
    try {
      assertStoredActor(this.database, input.actor);
    } catch {
      return null;
    }
    const row = this.database.readOne<ArtifactRow>(
      `${artifactSelect("id = ? AND state = 'ready' AND (expires_at IS NULL OR expires_at > ?)")}
       AND (
         (owner_principal_id = ? AND NOT EXISTS (
           SELECT 1 FROM message_artifacts own_link WHERE own_link.artifact_id = artifacts.id
         )) OR EXISTS (
           SELECT 1
           FROM message_artifacts link
           JOIN channel_members member
             ON member.channel_id = link.channel_id
            AND member.principal_id = ?
            AND member.active = 1
           WHERE link.artifact_id = artifacts.id
         )
       )`,
      input.artifactId,
      input.observedAt,
      input.actor.principalId,
      input.actor.principalId,
    );
    return row ? toReady(row) : null;
  }

  async countReadyReferencesByDigest(sha256: string): Promise<number> {
    return this.database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM artifacts WHERE sha256 = ? AND state = 'ready'",
      sha256,
    )?.count ?? 0;
  }

  async listActiveDigests(): Promise<readonly string[]> {
    return Object.freeze(this.database.readAll<{ sha256: string }>(
      `SELECT DISTINCT sha256 FROM artifacts
       WHERE sha256 IS NOT NULL AND state = 'ready' ORDER BY sha256`,
    ).map((row) => row.sha256));
  }

  linkReadyArtifacts(
    transaction: CoordinationTransaction,
    input: {
      messageId: string;
      channelId: string;
      artifactIds: readonly string[];
      actor: ArtifactActor;
      linkedAt: string;
    },
  ): readonly AttachmentSummary[] {
    if (
      input.artifactIds.length > 10 ||
      new Set(input.artifactIds).size !== input.artifactIds.length
    ) {
      throw new ArtifactError("invalid_link");
    }
    if (input.artifactIds.length === 0) return Object.freeze([]);
    assertArtifactWriteActor(input.actor);
    try {
      assertCoordinationId("message", input.messageId);
      assertCoordinationId("channel", input.channelId);
      for (const artifactId of input.artifactIds) assertArtifactId(artifactId, "invalid_link");
      assertIsoTimestamp(input.linkedAt);
    } catch {
      throw new ArtifactError("invalid_link");
    }
    assertStoredActor(transaction, input.actor, true);
    const message = transaction.readOne<{ authorPrincipalId: string }>(
      `SELECT message.author_principal_id AS authorPrincipalId
       FROM messages message
       JOIN channel_members member
         ON member.channel_id = message.channel_id
        AND member.principal_id = ?
        AND member.active = 1
       WHERE message.id = ? AND message.channel_id = ?`,
      input.actor.principalId,
      input.messageId,
      input.channelId,
    );
    if (!message || message.authorPrincipalId !== input.actor.principalId) {
      throw new ArtifactError("invalid_link");
    }
    const summaries: AttachmentSummary[] = [];
    for (const [ordinal, artifactId] of input.artifactIds.entries()) {
      const row = transaction.readOne<ArtifactRow>(
        artifactSelect(
          `id = ? AND state = 'ready' AND owner_principal_id = ?
           AND (expires_at IS NULL OR expires_at > ?)`,
        ),
        artifactId,
        input.actor.principalId,
        input.linkedAt,
      );
      if (!row) throw new ArtifactError("invalid_link");
      const artifact = toReady(row);
      transaction.run(
        `INSERT INTO message_artifacts (
          message_id, channel_id, artifact_id, ordinal, linked_at
        ) VALUES (?, ?, ?, ?, ?)`,
        input.messageId,
        input.channelId,
        artifactId,
        ordinal,
        input.linkedAt,
      );
      transaction.run("UPDATE artifacts SET expires_at = NULL WHERE id = ?", artifactId);
      summaries.push(Object.freeze({
        id: artifact.id,
        name: artifact.name,
        contentType: artifact.detectedContentType,
        byteCount: artifact.byteCount,
        sha256: artifact.sha256,
      }));
    }
    return Object.freeze(summaries);
  }

  async listMessageAttachments(input: {
    messageId: string;
    actor: ArtifactActor;
  }): Promise<readonly AttachmentSummary[]> {
    assertArtifactReadActor(input.actor);
    try {
      assertCoordinationId("message", input.messageId);
    } catch {
      throw new ArtifactError("not_found");
    }
    try {
      assertStoredActor(this.database, input.actor);
    } catch {
      throw new ArtifactError("not_found");
    }
    const visible = this.database.readOne<{ present: number }>(
      `SELECT 1 AS present
       FROM messages message
       JOIN channel_members member
         ON member.channel_id = message.channel_id
        AND member.principal_id = ?
        AND member.active = 1
       WHERE message.id = ?`,
      input.actor.principalId,
      input.messageId,
    );
    if (!visible) throw new ArtifactError("not_found");
    return Object.freeze(this.database.readAll<{
      id: string;
      name: string;
      contentType: string;
      byteCount: number;
      sha256: string;
    }>(
      `SELECT artifact.id, artifact.original_name AS name,
              artifact.detected_content_type AS contentType,
              artifact.byte_count AS byteCount, artifact.sha256
       FROM message_artifacts link
       JOIN artifacts artifact ON artifact.id = link.artifact_id
       WHERE link.message_id = ? AND artifact.state = 'ready'
       ORDER BY link.ordinal`,
      input.messageId,
    ).map((row) => Object.freeze({ ...row })));
  }

  async expireDueDrafts(input: {
    actor: ArtifactActor;
    observedAt: string;
    limit: number;
  }): Promise<ArtifactExpirationReport> {
    assertArtifactWriteActor(input.actor);
    assertStoredActor(this.database, input.actor);
    assertIsoTimestamp(input.observedAt);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000) {
      throw new ArtifactError("storage_conflict");
    }
    const due = this.database.readAll<{ id: string }>(
      `SELECT artifact.id
       FROM artifacts artifact
       WHERE artifact.state = 'ready'
         AND (? = 'user_owner' OR artifact.owner_principal_id = ?)
         AND artifact.expires_at IS NOT NULL
         AND artifact.expires_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM message_artifacts link WHERE link.artifact_id = artifact.id
         )
       ORDER BY artifact.expires_at, artifact.id
       LIMIT ?`,
      input.actor.principalId,
      input.actor.principalId,
      input.observedAt,
      input.limit,
    );
    const expiredArtifactIds: string[] = [];
    for (const candidate of due) {
      assertArtifactId(candidate.id, "invalid_artifact_id");
      this.database.mutateWithEvent((transaction) => {
        assertStoredActor(transaction, input.actor);
        const current = transaction.readOne<ArtifactRow>(
          artifactSelect(
            `id = ? AND (? = 'user_owner' OR owner_principal_id = ?) AND state = 'ready'
             AND expires_at IS NOT NULL AND expires_at <= ?
             AND NOT EXISTS (
               SELECT 1 FROM message_artifacts link WHERE link.artifact_id = artifacts.id
             )`,
          ),
          candidate.id,
          input.actor.principalId,
          input.actor.principalId,
          input.observedAt,
        );
        if (!current) throw new ArtifactError("storage_conflict");
        const update = transaction.run(
          `UPDATE artifacts SET state = 'expired', version = version + 1
           WHERE id = ? AND state = 'ready' AND version = ?`,
          candidate.id,
          current.version,
        );
        if (update.changes !== 1) throw new ArtifactError("storage_conflict");
        return {
          value: undefined,
          event: {
            type: "attachment.updated",
            aggregateKind: "artifact",
            aggregateId: candidate.id,
            aggregateVersion: current.version + 1,
            channelId: null,
            actorPrincipalId: input.actor.principalId,
            requestId: input.actor.requestId,
            correlationId: input.actor.correlationId,
            payload: eventPayload(candidate.id, "expired", current.ownerPrincipalId),
            createdAt: input.observedAt,
          },
        };
      });
      expiredArtifactIds.push(candidate.id);
    }
    return Object.freeze({
      observedAt: input.observedAt,
      expiredArtifactIds: Object.freeze(expiredArtifactIds),
    });
  }

  async recoverAbandonedStaging(input: {
    actor: ArtifactActor;
    observedAt: string;
    createdBefore: string;
    limit: number;
    dryRun: boolean;
  }): Promise<ArtifactRecoveryReport> {
    assertArtifactWriteActor(input.actor);
    assertStoredActor(this.database, input.actor);
    if (input.actor.kind !== "owner") throw new ArtifactError("scope_denied");
    assertIsoTimestamp(input.observedAt);
    assertIsoTimestamp(input.createdBefore);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000) {
      throw new ArtifactError("storage_conflict");
    }
    const candidates = this.database.readAll<{ id: string }>(
      `SELECT id FROM artifacts
       WHERE state = 'staging' AND created_at <= ?
       ORDER BY created_at, id LIMIT ?`,
      input.createdBefore,
      input.limit,
    );
    const abandonedArtifactIds = candidates.map((candidate) => {
      assertArtifactId(candidate.id, "invalid_artifact_id");
      return candidate.id;
    });
    if (!input.dryRun) {
      for (const artifactId of abandonedArtifactIds) {
        this.database.mutateWithEvent((transaction) => {
          assertStoredActor(transaction, input.actor);
          const current = transaction.readOne<ArtifactRow>(
            artifactSelect("id = ? AND state = 'staging' AND created_at <= ?"),
            artifactId,
            input.createdBefore,
          );
          if (!current) throw new ArtifactError("storage_conflict");
          const update = transaction.run(
            `UPDATE artifacts
             SET state = 'failed', failed_at = ?, expires_at = NULL, version = version + 1
             WHERE id = ? AND state = 'staging' AND version = ?`,
            input.observedAt,
            artifactId,
            current.version,
          );
          if (update.changes !== 1) throw new ArtifactError("storage_conflict");
          return {
            value: undefined,
            event: {
              type: "attachment.updated",
              aggregateKind: "artifact",
              aggregateId: artifactId,
              aggregateVersion: current.version + 1,
              channelId: null,
              actorPrincipalId: input.actor.principalId,
              requestId: input.actor.requestId,
              correlationId: input.actor.correlationId,
              payload: eventPayload(artifactId, "failed"),
              createdAt: input.observedAt,
            },
          };
        });
      }
    }
    return Object.freeze({
      dryRun: input.dryRun,
      observedAt: input.observedAt,
      abandonedArtifactIds: Object.freeze(abandonedArtifactIds),
    });
  }
}
