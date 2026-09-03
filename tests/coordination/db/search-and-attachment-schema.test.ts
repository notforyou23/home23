import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import {
  ARTIFACT_SCHEMA_DELTA_PROPOSAL,
  ARTIFACT_SCHEMA_DELTA_SHA256,
  ArtifactError,
  resolveArtifactActor,
  SqliteArtifactRepository,
  computeArtifactSchemaDeltaDigest,
} from "../../../src/coordination/artifacts/index.js";
import {
  COORDINATION_CONTRACT_PACK_SHA256,
  COORDINATION_PRODUCT_SCHEMA_MIGRATION_CHECKSUM,
  COORDINATION_SCHEMA_CHECKSUM,
  COORDINATION_SCHEMA_VERSION,
  COORDINATION_SPINE_MIGRATION_CHECKSUM,
  openCoordinationDatabase,
} from "../../../src/coordination/db/index.js";
import { migrateCoordinationSchema } from "../../../src/coordination/db/migration-engine.js";
import { COORDINATION_SPINE_MIGRATION_SQL } from "../../../src/coordination/migrations/0001-coordination-spine.js";
import { CONNECTED_AGENTS_PRODUCT_SCHEMA_MIGRATION_SQL } from "../../../src/coordination/migrations/0002-connected-agents-product-schema.js";
import {
  CANONICAL_SEARCH_SCHEMA_DELTA_PROPOSAL,
  CANONICAL_SEARCH_SCHEMA_DELTA_SHA256,
  computeCanonicalSearchSchemaDeltaDigest,
} from "../../../src/coordination/search/schema-delta.js";

const SCHEMA_V2_CHECKSUM =
  "47c9045f580a020bce91d7ea64f572c7f88dc08532ff29b6f7601fdab23428a4";
const M08_SCHEMA_PROPOSAL_SHA256 =
  "85695c952db6d1cfafa19296d48d241dbb7bf335342b534b1c76d51e24f74ae6";
const APPLIED_AT = "2026-08-25T16:00:00.000Z";
const CHANNEL_ID = "chn_0198d95f-6c00-7000-8000-000000001001";
const CONVERSATION_ID = "cnv_0198d95f-6c00-7000-8000-000000001001";
const MESSAGE_ID = "msg_0198d95f-6c00-7000-8000-000000001001";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function temporaryDatabase(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "home23-m04-m09-m10-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "coordination.sqlite3");
}

function createSchemaV2(path: string): void {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.exec(COORDINATION_SPINE_MIGRATION_SQL);
  database.exec(CONNECTED_AGENTS_PRODUCT_SCHEMA_MIGRATION_SQL);
  const insertMigration = database.prepare(
    `INSERT INTO schema_migrations
       (version, name, checksum, applied_at, application_version)
     VALUES (?, ?, ?, ?, 'm04-schema-v2-fixture')`,
  );
  insertMigration.run(
    1,
    "coordination-spine",
    COORDINATION_SPINE_MIGRATION_CHECKSUM,
    APPLIED_AT,
  );
  insertMigration.run(
    2,
    "connected-agents-product-schema",
    COORDINATION_PRODUCT_SCHEMA_MIGRATION_CHECKSUM,
    APPLIED_AT,
  );
  const insertMeta = database.prepare(
    "INSERT INTO kernel_meta (key, value, updated_at) VALUES (?, ?, ?)",
  );
  for (const [key, value] of [
    ["schema.version", "2"],
    ["schema.checksum", SCHEMA_V2_CHECKSUM],
    ["contract.version", "1"],
    ["contract.pack_sha256", COORDINATION_CONTRACT_PACK_SHA256],
  ] as const) {
    insertMeta.run(key, value, APPLIED_AT);
  }
  database.pragma("user_version = 2");

  database.prepare(
    "INSERT INTO principals (id, kind, created_at) VALUES ('user_owner', 'owner', ?)",
  ).run(APPLIED_AT);
  database.prepare(
    `INSERT INTO channels (
       id, kind, title, purpose, owner_principal_id, responder_mode,
       coordinator_bot_id, response_order, max_bot_turns, lifecycle, pinned,
       version, next_message_sequence, created_at, updated_at
     ) VALUES (?, 'direct', 'Schema v2', '', 'user_owner', 'mentions_only',
               NULL, 'parallel', 1, 'active', 0, 1, 2, ?, ?)`,
  ).run(CHANNEL_ID, APPLIED_AT, APPLIED_AT);
  database.prepare(
    "INSERT INTO conversation_handles (id, channel_id, created_at) VALUES (?, ?, ?)",
  ).run(CONVERSATION_ID, CHANNEL_ID, APPLIED_AT);
  database.prepare(
    `INSERT INTO channel_members (
       channel_id, principal_id, kind, role, active, joined_at, left_at
     ) VALUES (?, 'user_owner', 'owner', 'owner', 1, ?, NULL)`,
  ).run(CHANNEL_ID, APPLIED_AT);
  database.prepare(
    `INSERT INTO messages (
       id, channel_id, channel_sequence, author_principal_id, author_kind,
       author_display_name, kind, body_text, stored_visibility, client_message_id,
       reply_to_message_id, tombstones_message_id, round_id, work_id, created_at
     ) VALUES (?, ?, 1, 'user_owner', 'owner', 'Owner', 'text', ?, 'visible',
               NULL, NULL, NULL, NULL, NULL, ?)`,
  ).run(MESSAGE_ID, CHANNEL_ID, "schema v2 cobalt canary", APPLIED_AT);
  database.prepare(
    `INSERT INTO events (
       id, schema_version, type, durability, aggregate_kind, aggregate_id,
       aggregate_version, channel_id, actor_principal_id, request_id,
       correlation_id, payload_json, payload_digest, created_at
     ) VALUES (?, 1, 'message.appended', 'durable', 'message', ?, 1, ?,
               'user_owner', ?, ?, '{}', ?, ?)`,
  ).run(
    "evt_0198d95f-6c00-7000-8000-000000001001",
    MESSAGE_ID,
    CHANNEL_ID,
    "req_0198d95f-6c00-7000-8000-000000001001",
    "cor_0198d95f-6c00-7000-8000-000000001001",
    sha256("{}"),
    APPLIED_AT,
  );
  database.close();
}

test("schema v2 migrates atomically to the checksummed M09 and M10 final catalog and reopens", async (t) => {
  const path = temporaryDatabase(t);
  createSchemaV2(path);
  const integration = await import(
    "../../../src/coordination/migrations/0003-search-and-attachment-schema.js"
  ).catch(() => null);
  assert.ok(integration, "M04 schema-v3 migration module must exist");

  assert.equal(computeCanonicalSearchSchemaDeltaDigest(), CANONICAL_SEARCH_SCHEMA_DELTA_SHA256);
  assert.equal(computeArtifactSchemaDeltaDigest(), ARTIFACT_SCHEMA_DELTA_SHA256);
  assert.deepEqual(integration.COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES, {
    coordinationSchemaV2: SCHEMA_V2_CHECKSUM,
    contractPack: COORDINATION_CONTRACT_PACK_SHA256,
    m08MessagingProposal: M08_SCHEMA_PROPOSAL_SHA256,
    m09SearchProposal: CANONICAL_SEARCH_SCHEMA_DELTA_SHA256,
    m09SearchSql: CANONICAL_SEARCH_SCHEMA_DELTA_PROPOSAL.sqlSha256,
    m09SearchRebuildSql: CANONICAL_SEARCH_SCHEMA_DELTA_PROPOSAL.rebuildSqlSha256,
    m10ArtifactProposal: ARTIFACT_SCHEMA_DELTA_SHA256,
    m10ArtifactSql: ARTIFACT_SCHEMA_DELTA_PROPOSAL.sqlSha256,
  });

  const database = openCoordinationDatabase({
    path,
    applicationVersion: "m04-m09-m10-integration-test",
    now: () => new Date("2026-08-25T16:01:00.000Z"),
  });
  assert.equal(database.openReceipt.migratedFrom, 2);
  assert.equal(database.openReceipt.schemaVersion, 11);
  assert.equal(COORDINATION_SCHEMA_VERSION, 11);
  assert.equal(database.openReceipt.schemaChecksum, COORDINATION_SCHEMA_CHECKSUM);
  const tables = database.readAll<{ name: string }>(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((row) => row.name);
  for (const table of ["artifacts", "attachment_create_idempotency", "message_artifacts", "message_fts", "search_watermarks"]) {
    assert.equal(tables.includes(table), true, `${table} must be in schema v3`);
  }
  assert.equal(tables.includes("legacy_aliases"), false);
  assert.deepEqual(
    database.readAll<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE '%event%' ORDER BY name",
    ).map((row) => row.name),
    ["events"],
  );
  assert.deepEqual(
    database.readAll<{ messageId: string; bodyText: string }>(
      "SELECT message_id AS messageId, body_text AS bodyText FROM message_fts",
    ),
    [{ messageId: MESSAGE_ID, bodyText: "schema v2 cobalt canary" }],
  );
  assert.deepEqual(
    database.readOne<{
      sourceEventSequence: number;
      indexedThroughEventSequence: number;
      sourceRows: number;
      indexedRows: number;
    }>(
      `SELECT source_event_sequence AS sourceEventSequence,
              indexed_through_event_sequence AS indexedThroughEventSequence,
              source_rows AS sourceRows, indexed_rows AS indexedRows
       FROM search_watermarks WHERE source_class = 'coordination.messages'`,
    ),
    {
      sourceEventSequence: 1,
      indexedThroughEventSequence: 1,
      sourceRows: 1,
      indexedRows: 1,
    },
  );
  assert.deepEqual(
    database.readAll<{ version: number; name: string }>(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    ),
    [
      { version: 1, name: "coordination-spine" },
      { version: 2, name: "connected-agents-product-schema" },
      { version: 3, name: "search-and-attachment-schema" },
      { version: 4, name: "atomic-import-ledger" },
      { version: 5, name: "attachment-create-idempotency" },
      { version: 6, name: "work-lifecycle-schema" },
      { version: 7, name: "work-product-controls" },
      { version: 8, name: "communication-evidence-indexes" },
      { version: 9, name: "work-turn-selection" },
      { version: 10, name: "bot-lifecycle-receipts" },
      { version: 11, name: "artifact-audio-mpeg" },
    ],
  );
  assert.deepEqual(database.readAll("PRAGMA foreign_key_check"), []);
  database.close();

  const reopened = openCoordinationDatabase({ path });
  assert.equal(reopened.openReceipt.migratedFrom, 11);
  assert.equal(reopened.openReceipt.startupCheck, "quick_check");
  reopened.close();
});

test("the M04 rebuild handoff restores exact FTS crossings and rolls back an induced failure", async (t) => {
  const path = temporaryDatabase(t);
  createSchemaV2(path);
  openCoordinationDatabase({ path }).close();
  const raw = new Database(path);
  raw.prepare("UPDATE message_fts SET body_text = 'blind route' WHERE message_id = ?")
    .run(MESSAGE_ID);
  raw.close();

  const database = openCoordinationDatabase({ path });
  const maintainer = database as unknown as {
    rebuildCanonicalSearchIndex?: () => {
      sourceClass: string;
      sourceEventSequence: number;
      indexedThroughEventSequence: number;
      sourceRows: number;
      indexedRows: number;
      rebuildSqlSha256: string;
    };
  };
  assert.equal(typeof maintainer.rebuildCanonicalSearchIndex, "function");
  const receipt = maintainer.rebuildCanonicalSearchIndex!();
  assert.deepEqual(receipt, {
    sourceClass: "coordination.messages",
    sourceEventSequence: 1,
    indexedThroughEventSequence: 1,
    sourceRows: 1,
    indexedRows: 1,
    rebuildSqlSha256: CANONICAL_SEARCH_SCHEMA_DELTA_PROPOSAL.rebuildSqlSha256,
  });
  assert.equal(
    database.readOne<{ bodyText: string }>(
      "SELECT body_text AS bodyText FROM message_fts WHERE message_id = ?",
      MESSAGE_ID,
    )?.bodyText,
    "schema v2 cobalt canary",
  );
  database.close();

  const maintenance = await import("../../../src/coordination/db/derived-projections.js")
    .catch(() => null);
  assert.ok(maintenance, "M04 derived-projection maintenance module must exist");
  const injected = new Database(path);
  injected.prepare("UPDATE message_fts SET body_text = 'pre-failure crossing' WHERE message_id = ?")
    .run(MESSAGE_ID);
  injected.exec(`
    CREATE TEMP TRIGGER inject_rebuild_failure
    BEFORE UPDATE ON search_watermarks
    BEGIN
      SELECT RAISE(ABORT, 'injected search watermark failure');
    END;
  `);
  assert.throws(
    () => maintenance.rebuildCanonicalSearchIndex(injected),
    /injected search watermark failure/,
  );
  assert.equal(
    injected.prepare("SELECT body_text AS bodyText FROM message_fts WHERE message_id = ?")
      .get(MESSAGE_ID).bodyText,
    "pre-failure crossing",
  );
  injected.close();
});

test("a canonical Message event cannot advance a watermark across an already-blind FTS route", (t) => {
  const path = temporaryDatabase(t);
  createSchemaV2(path);
  openCoordinationDatabase({ path }).close();
  const raw = new Database(path);
  raw.prepare("UPDATE message_fts SET body_text = 'stale crossing' WHERE message_id = ?")
    .run(MESSAGE_ID);
  raw.close();

  const database = openCoordinationDatabase({ path });
  const nextMessageId = "msg_0198d95f-6c00-7000-8000-000000001009";
  assert.throws(
    () => database.mutateWithEvent((transaction) => {
      transaction.run(
        `INSERT INTO messages (
           id, channel_id, channel_sequence, author_principal_id, author_kind,
           author_display_name, kind, body_text, stored_visibility, client_message_id,
           reply_to_message_id, tombstones_message_id, round_id, work_id, created_at
         ) VALUES (?, ?, 2, 'user_owner', 'owner', 'Owner', 'text', 'new crossing',
                   'visible', NULL, NULL, NULL, NULL, NULL, ?)`,
        nextMessageId,
        CHANNEL_ID,
        APPLIED_AT,
      );
      return {
        value: undefined,
        event: {
          type: "message.appended",
          aggregateKind: "message",
          aggregateId: nextMessageId,
          aggregateVersion: 1,
          channelId: CHANNEL_ID,
          actorPrincipalId: "user_owner",
          requestId: "req_0198d95f-6c00-7000-8000-000000001009",
          correlationId: "cor_0198d95f-6c00-7000-8000-000000001009",
          payload: { messageId: nextMessageId },
          createdAt: APPLIED_AT,
        },
      };
    }),
    /message.appended event requires the exact canonical search projection/,
  );
  assert.equal(
    database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM messages WHERE id = ?",
      nextMessageId,
    )?.count,
    0,
  );
  assert.equal(
    database.readOne<{ sourceEventSequence: number }>(
      `SELECT source_event_sequence AS sourceEventSequence
       FROM search_watermarks WHERE source_class = 'coordination.messages'`,
    )?.sourceEventSequence,
    1,
  );
  database.close();
});

test("a Message cannot commit behind a noncanonical event type", (t) => {
  const path = temporaryDatabase(t);
  createSchemaV2(path);
  const database = openCoordinationDatabase({ path });
  const nextMessageId = "msg_0198d95f-6c00-7000-8000-000000001010";

  assert.throws(
    () => database.mutateWithEvent((transaction) => {
      transaction.run(
        `INSERT INTO messages (
           id, channel_id, channel_sequence, author_principal_id, author_kind,
           author_display_name, kind, body_text, stored_visibility, client_message_id,
           reply_to_message_id, tombstones_message_id, round_id, work_id, created_at
         ) VALUES (?, ?, 2, 'user_owner', 'owner', 'Owner', 'text', 'wrong journal',
                   'visible', NULL, NULL, NULL, NULL, NULL, ?)`,
        nextMessageId,
        CHANNEL_ID,
        APPLIED_AT,
      );
      return {
        value: undefined,
        event: {
          type: "channel.updated",
          aggregateKind: "channel",
          aggregateId: CHANNEL_ID,
          aggregateVersion: 1,
          channelId: CHANNEL_ID,
          actorPrincipalId: "user_owner",
          requestId: "req_0198d95f-6c00-7000-8000-000000001010",
          correlationId: "cor_0198d95f-6c00-7000-8000-000000001010",
          payload: { messageId: nextMessageId },
          createdAt: APPLIED_AT,
        },
      };
    }),
    /every Message requires one exact canonical journal event/,
  );
  assert.equal(
    database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM messages WHERE id = ?",
      nextMessageId,
    )?.count,
    0,
  );
  assert.equal(
    database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM message_fts WHERE message_id = ?",
      nextMessageId,
    )?.count,
    0,
  );
  assert.equal(
    database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM events WHERE type = 'channel.updated'",
    )?.count,
    0,
  );
  database.close();
});

test("artifact metadata dedupe and Message links stay consistent without blob or path columns", async (t) => {
  const path = temporaryDatabase(t);
  createSchemaV2(path);
  const database = openCoordinationDatabase({ path });
  const columns = database.readAll<{ name: string; type: string }>("PRAGMA table_info(artifacts)");
  assert.equal(columns.some((column) => column.type.toUpperCase() === "BLOB"), false);
  assert.equal(columns.some((column) => /path|bytes|blob/i.test(column.name)), false);

  const digest = "a".repeat(64);
  const insertReady = (artifactId: string, byteCount: number) =>
    database.mutateWithEvent((transaction) => {
      transaction.run(
        `INSERT INTO artifacts (
           id, owner_principal_id, state, original_name, declared_content_type,
           detected_content_type, byte_count, sha256, storage_kind, created_at,
           expires_at, failed_at, deleted_at, version
         ) VALUES (?, 'user_owner', 'ready', ?, 'text/plain', 'text/plain', ?, ?,
                   'content_addressed', ?, ?, NULL, NULL, 1)`,
        artifactId,
        `${artifactId}.txt`,
        byteCount,
        digest,
        APPLIED_AT,
        "2026-08-26T16:00:00.000Z",
      );
      return {
        value: undefined,
        event: {
          type: "attachment.updated",
          aggregateKind: "artifact",
          aggregateId: artifactId,
          aggregateVersion: 1,
          channelId: null,
          actorPrincipalId: "user_owner",
          requestId: artifactId.replace("art_", "req_"),
          correlationId: artifactId.replace("art_", "cor_"),
          payload: { artifactId, state: "ready" },
          createdAt: APPLIED_AT,
        },
      };
    });
  const firstArtifact = "art_0198d95f-6c00-7000-8000-000000001011";
  const secondArtifact = "art_0198d95f-6c00-7000-8000-000000001012";
  insertReady(firstArtifact, 5);
  insertReady(secondArtifact, 5);
  assert.equal(
    database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM artifacts WHERE sha256 = ?",
      digest,
    )?.count,
    2,
  );
  assert.throws(
    () => insertReady("art_0198d95f-6c00-7000-8000-000000001013", 6),
    /artifact digest metadata mismatch/,
  );
  assert.equal(
    database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM artifacts WHERE sha256 = ?",
      digest,
    )?.count,
    2,
  );

  const owner = await resolveArtifactActor({
    principalId: "user_owner",
    requestId: "req_0198d95f-6c00-7000-8000-000000001016",
    correlationId: "cor_0198d95f-6c00-7000-8000-000000001016",
    identity: {
      kind: "owner",
      auth: {
        principalId: "user_owner",
        deviceId: "dev_0198d95f-6c00-7000-8000-000000001016",
        sessionId: "ses_0198d95f-6c00-7000-8000-000000001016",
        scopes: ["attachment:write"],
      },
    },
  }, {
    async listVisibleBots() { return []; },
    async resolveAlias() { return null; },
    async getBotByResidentBinding() { return null; },
  });
  const repository = new SqliteArtifactRepository(database);
  const stage = async (
    artifactId: string,
    declaredContentType: "text/plain" | "image/png",
  ) => repository.beginStaging({
    artifact: {
      id: artifactId,
      ownerPrincipalId: "user_owner",
      state: "staging",
      name: `${artifactId}.${declaredContentType === "text/plain" ? "txt" : "png"}`,
      declaredContentType,
      detectedContentType: null,
      byteCount: 0,
      sha256: null,
      storage: "content_addressed",
      createdAt: APPLIED_AT,
      expiresAt: "2026-08-26T16:00:00.000Z",
    },
    actor: owner,
  });
  const commit = (
    artifactId: string,
    byteCount: number,
    detectedContentType: "text/plain" | "image/png",
  ) => repository.commitReady({
    artifact: {
      id: artifactId,
      ownerPrincipalId: "user_owner",
      state: "ready",
      name: `${artifactId}.${detectedContentType === "text/plain" ? "txt" : "png"}`,
      declaredContentType: detectedContentType,
      detectedContentType,
      byteCount,
      sha256: digest,
      storage: "content_addressed",
      createdAt: APPLIED_AT,
      expiresAt: "2026-08-26T16:00:00.000Z",
    },
    actor: owner,
    readyAt: APPLIED_AT,
  });

  const updateMatch = "art_0198d95f-6c00-7000-8000-000000001016";
  await stage(updateMatch, "text/plain");
  assert.equal((await commit(updateMatch, 5, "text/plain")).state, "ready");

  const updateByteMismatch = "art_0198d95f-6c00-7000-8000-000000001017";
  await stage(updateByteMismatch, "text/plain");
  await assert.rejects(
    () => commit(updateByteMismatch, 6, "text/plain"),
    (error: unknown) => error instanceof ArtifactError && error.code === "storage_conflict",
  );
  const updateTypeMismatch = "art_0198d95f-6c00-7000-8000-000000001018";
  await stage(updateTypeMismatch, "image/png");
  await assert.rejects(
    () => commit(updateTypeMismatch, 5, "image/png"),
    (error: unknown) => error instanceof ArtifactError && error.code === "storage_conflict",
  );
  assert.deepEqual(
    database.readAll<{ id: string; state: string; byteCount: number; sha256: string | null }>(
      `SELECT id, state, byte_count AS byteCount, sha256
       FROM artifacts WHERE id IN (?, ?) ORDER BY id`,
      updateByteMismatch,
      updateTypeMismatch,
    ),
    [
      { id: updateByteMismatch, state: "staging", byteCount: 0, sha256: null },
      { id: updateTypeMismatch, state: "staging", byteCount: 0, sha256: null },
    ],
  );

  const linkedMessage = "msg_0198d95f-6c00-7000-8000-000000001014";
  database.mutateWithEvent((transaction) => {
    transaction.run(
      `INSERT INTO messages (
         id, channel_id, channel_sequence, author_principal_id, author_kind,
         author_display_name, kind, body_text, stored_visibility, client_message_id,
         reply_to_message_id, tombstones_message_id, round_id, work_id, created_at
       ) VALUES (?, ?, 2, 'user_owner', 'owner', 'Owner', 'text', 'linked bytes',
                 'visible', NULL, NULL, NULL, NULL, NULL, ?)`,
      linkedMessage,
      CHANNEL_ID,
      APPLIED_AT,
    );
    transaction.run(
      `INSERT INTO message_artifacts
         (message_id, channel_id, artifact_id, ordinal, linked_at)
       VALUES (?, ?, ?, 0, ?)`,
      linkedMessage,
      CHANNEL_ID,
      firstArtifact,
      APPLIED_AT,
    );
    return {
      value: undefined,
      event: {
        type: "message.appended",
        aggregateKind: "message",
        aggregateId: linkedMessage,
        aggregateVersion: 1,
        channelId: CHANNEL_ID,
        actorPrincipalId: "user_owner",
        requestId: "req_0198d95f-6c00-7000-8000-000000001014",
        correlationId: "cor_0198d95f-6c00-7000-8000-000000001014",
        payload: { messageId: linkedMessage, attachmentIds: [firstArtifact] },
        createdAt: APPLIED_AT,
      },
    };
  });
  assert.equal(
    database.readOne<{ expiresAt: string | null }>(
      "SELECT expires_at AS expiresAt FROM artifacts WHERE id = ?",
      firstArtifact,
    )?.expiresAt,
    null,
  );
  assert.throws(
    () => database.mutateWithEvent((transaction) => {
      transaction.run(
        "UPDATE artifacts SET expires_at = ? WHERE id = ?",
        "2026-08-27T16:00:00.000Z",
        firstArtifact,
      );
      throw new Error("unreachable");
    }),
    /linked artifact expiry is immutable/,
  );

  const rolledBackMessage = "msg_0198d95f-6c00-7000-8000-000000001015";
  assert.throws(
    () => database.mutateWithEvent((transaction) => {
      transaction.run(
        `INSERT INTO messages (
           id, channel_id, channel_sequence, author_principal_id, author_kind,
           author_display_name, kind, body_text, stored_visibility, client_message_id,
           reply_to_message_id, tombstones_message_id, round_id, work_id, created_at
         ) VALUES (?, ?, 3, 'user_owner', 'owner', 'Owner', 'text', 'roll back link',
                   'visible', NULL, NULL, NULL, NULL, NULL, ?)`,
        rolledBackMessage,
        CHANNEL_ID,
        APPLIED_AT,
      );
      transaction.run(
        `INSERT INTO message_artifacts
           (message_id, channel_id, artifact_id, ordinal, linked_at)
         VALUES (?, ?, ?, 0, ?)`,
        rolledBackMessage,
        CHANNEL_ID,
        secondArtifact,
        APPLIED_AT,
      );
      return {
        value: undefined,
        event: {
          type: "message.appended",
          aggregateKind: "message",
          aggregateId: rolledBackMessage,
          aggregateVersion: 2,
          channelId: CHANNEL_ID,
          actorPrincipalId: "user_owner",
          requestId: "req_0198d95f-6c00-7000-8000-000000001015",
          correlationId: "cor_0198d95f-6c00-7000-8000-000000001015",
          payload: { messageId: rolledBackMessage },
          createdAt: APPLIED_AT,
        },
      };
    }),
    /aggregate version is not gap-free/,
  );
  assert.equal(
    database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM message_artifacts WHERE message_id = ?",
      rolledBackMessage,
    )?.count,
    0,
  );
  assert.equal(
    database.readOne<{ expiresAt: string | null }>(
      "SELECT expires_at AS expiresAt FROM artifacts WHERE id = ?",
      secondArtifact,
    )?.expiresAt,
    "2026-08-26T16:00:00.000Z",
  );
  database.close();
});

test("a failed schema-v3 statement rolls back the entire numbered migration for forward correction", (t) => {
  const path = temporaryDatabase(t);
  createSchemaV2(path);
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.exec("CREATE TABLE artifacts (id TEXT PRIMARY KEY) STRICT;");

  assert.throws(
    () => migrateCoordinationSchema(
      database,
      2,
      "m04-induced-schema-v3-failure",
      () => new Date("2026-08-25T16:01:00.000Z"),
    ),
    /table artifacts already exists/,
  );
  assert.equal(database.pragma("user_version", { simple: true }), 2);
  assert.deepEqual(
    database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
    [
      { version: 1, name: "coordination-spine" },
      { version: 2, name: "connected-agents-product-schema" },
    ],
  );
  assert.equal(
    database.prepare(
      "SELECT count(*) AS count FROM sqlite_schema WHERE name IN ('message_fts', 'search_watermarks')",
    ).get().count,
    0,
  );
  assert.equal(
    database.prepare("SELECT value FROM kernel_meta WHERE key = 'schema.version'").get().value,
    "2",
  );
  database.close();
});

test("schema v3 refuses a schema-v2 Message that is missing its canonical M04 journal event", (t) => {
  const path = temporaryDatabase(t);
  createSchemaV2(path);
  const raw = new Database(path);
  raw.prepare("DELETE FROM events WHERE aggregate_id = ?").run(MESSAGE_ID);
  raw.close();

  assert.throws(
    () => openCoordinationDatabase({ path }),
    /CHECK constraint failed/,
  );
  const refused = new Database(path, { readonly: true, fileMustExist: true });
  assert.equal(refused.pragma("user_version", { simple: true }), 2);
  assert.deepEqual(
    refused.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
    [
      { version: 1, name: "coordination-spine" },
      { version: 2, name: "connected-agents-product-schema" },
    ],
  );
  assert.equal(
    refused.prepare(
      "SELECT count(*) AS count FROM sqlite_schema WHERE name IN ('message_fts', 'search_watermarks')",
    ).get().count,
    0,
  );
  refused.close();
});
