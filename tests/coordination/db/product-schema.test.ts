import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

import Database from "better-sqlite3";

import {
  COORDINATION_CONTRACT_PACK_SHA256,
  COORDINATION_SCHEMA_CHECKSUM,
  COORDINATION_SCHEMA_VERSION,
  openCoordinationDatabase,
} from "../../../src/coordination/db/index.js";
import { migrateCoordinationSchema } from "../../../src/coordination/db/migration-engine.js";
import { COORDINATION_SPINE_MIGRATION_SQL } from "../../../src/coordination/migrations/0001-coordination-spine.js";
import {
  computeCoordinationMigrationPlanChecksum,
  COORDINATION_MIGRATION_PLAN_CHECKSUM,
  COORDINATION_PRODUCT_SCHEMA_DEPENDENCIES,
  COORDINATION_PRODUCT_SCHEMA_MIGRATION_CHECKSUM,
  COORDINATION_SEARCH_ATTACHMENT_MIGRATION_CHECKSUM,
  COORDINATION_SPINE_MIGRATION_CHECKSUM,
  COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES,
} from "../../../src/coordination/migrations/index.js";

const V1_SCHEMA_CHECKSUM =
  "0ce5eee85db7fe852a6e5ef970cf81d2bbc90352cd8bf4b5e09d3d02991c7dc9";
const APPLIED_AT = "2026-08-25T12:00:00.000Z";

const EXPECTED_TABLES = [
  "aliases",
  "artifacts",
  "authority_epochs",
  "bots",
  "channel_members",
  "channel_membership_history",
  "channels",
  "client_sessions",
  "conversation_handles",
  "devices",
  "direct_channel_pairs",
  "events",
  "idempotency_records",
  "kernel_meta",
  "mentions",
  "message_artifacts",
  "message_fts",
  "message_fts_config",
  "message_fts_content",
  "message_fts_data",
  "message_fts_docsize",
  "message_fts_idx",
  "messages",
  "pairing_sessions",
  "principals",
  "read_cursors",
  "schema_migrations",
  "search_watermarks",
  "session_refresh_tokens",
] as const;

const EXPECTED_INDEXES = [
  "aliases_target",
  "artifacts_digest_state",
  "artifacts_owner_state_expiry",
  "authority_epochs_capability_epoch_desc",
  "bots_heartbeat",
  "bots_lifecycle_name",
  "channel_members_principal",
  "channel_membership_history_active",
  "channel_membership_history_principal",
  "channels_inbox_order",
  "client_sessions_device_state",
  "client_sessions_family_state",
  "devices_principal_status",
  "events_aggregate_sequence",
  "events_correlation_sequence",
  "events_type_sequence",
  "idempotency_records_created_at",
  "mentions_principal_message",
  "message_artifacts_artifact",
  "message_artifacts_channel",
  "messages_channel_sequence_desc",
  "messages_reply",
  "messages_tombstone",
  "pairing_sessions_state_expiry",
  "session_refresh_tokens_family_state",
] as const;

const EXPECTED_TRIGGERS = [
  "artifacts_deleted_immutable",
  "artifacts_digest_metadata_consistent_insert",
  "artifacts_digest_metadata_consistent_update",
  "artifacts_linked_expiry_immutable",
  "artifacts_linked_state_immutable",
  "artifacts_no_delete",
  "artifacts_ready_content_immutable",
  "artifacts_state_transition_guard",
  "channel_members_no_delete",
  "channel_membership_history_close_only",
  "channel_membership_history_no_delete",
  "event_requires_canonical_message_journal",
  "mentions_immutable_delete",
  "mentions_immutable_update",
  "mentions_require_active_visible_bot",
  "message_append_event_requires_indexed_source",
  "message_artifacts_clear_draft_expiry",
  "message_artifacts_no_delete",
  "message_artifacts_no_update",
  "message_artifacts_require_ready_owner",
  "message_fts_after_insert_nonsearchable",
  "message_fts_after_insert_searchable",
  "messages_immutable_delete",
  "messages_immutable_update",
  "messages_require_active_author",
  "read_cursors_monotonic_update",
  "read_cursors_no_delete",
  "read_cursors_require_active_member_insert",
  "read_cursors_require_active_member_update",
  "search_watermark_after_message_event",
] as const;

function temporaryDirectory(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "home23-product-schema-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function createSchemaV1(path: string): void {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.exec(COORDINATION_SPINE_MIGRATION_SQL);
  database.prepare(
    `INSERT INTO schema_migrations
       (version, name, checksum, applied_at, application_version)
     VALUES (1, 'coordination-spine', ?, ?, 'm04-v1-fixture')`,
  ).run(sha256(COORDINATION_SPINE_MIGRATION_SQL), APPLIED_AT);
  const metadata = [
    ["schema.version", "1"],
    ["schema.checksum", V1_SCHEMA_CHECKSUM],
    ["contract.version", "1"],
    ["contract.pack_sha256", COORDINATION_CONTRACT_PACK_SHA256],
  ] as const;
  const insertMeta = database.prepare(
    "INSERT INTO kernel_meta (key, value, updated_at) VALUES (?, ?, ?)",
  );
  for (const [key, value] of metadata) insertMeta.run(key, value, APPLIED_AT);
  database.pragma("user_version = 1");
  database.close();
}

function catalogNames(
  database: ReturnType<typeof openCoordinationDatabase>,
  type: "table" | "index" | "trigger",
): string[] {
  return database.readAll<{ name: string }>(
    `SELECT name FROM sqlite_schema
     WHERE type = ? AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
    type,
  ).map((row) => row.name);
}

test("schema v1 migrates directly through the reconciled M06-M10 final catalog", async (t) => {
  const path = join(temporaryDirectory(t), "coordination.sqlite3");
  createSchemaV1(path);

  const database = openCoordinationDatabase({
    path,
    applicationVersion: "m04-product-schema-test",
    now: () => new Date("2026-08-25T12:01:00.000Z"),
  });
  assert.equal(database.openReceipt.migratedFrom, 1);
  assert.equal(COORDINATION_SCHEMA_VERSION, 3);
  assert.equal(
    COORDINATION_SCHEMA_CHECKSUM,
    "ddac2fb83bf73837f5200725697eff7d55a685f18a6c144fc33df17b75f113c2",
  );
  assert.equal(
    COORDINATION_PRODUCT_SCHEMA_MIGRATION_CHECKSUM,
    "40fd7ba924885a25a1ca28025d9dc907540f908dd72f1ce7e7636b1944628c2f",
  );
  assert.equal(
    COORDINATION_MIGRATION_PLAN_CHECKSUM,
    "ed386888eabf6fb5f447fde1d181cac7e1c5c6310f740be97d7767fbd9abce9e",
  );
  assert.equal(
    COORDINATION_SEARCH_ATTACHMENT_MIGRATION_CHECKSUM,
    "7176274402321c6f3e295cc3bfabbc6c9ffa2304304855334f9be31a2356da1e",
  );
  assert.equal(
    computeCoordinationMigrationPlanChecksum(),
    COORDINATION_MIGRATION_PLAN_CHECKSUM,
  );
  assert.equal(sha256(COORDINATION_SPINE_MIGRATION_SQL), COORDINATION_SPINE_MIGRATION_CHECKSUM);
  assert.deepEqual(catalogNames(database, "table"), EXPECTED_TABLES);
  assert.deepEqual(catalogNames(database, "index"), EXPECTED_INDEXES);
  assert.deepEqual(catalogNames(database, "trigger"), EXPECTED_TRIGGERS);
  assert.equal(
    database.readOne<{ present: number }>(
      "SELECT 1 AS present FROM sqlite_schema WHERE name = 'legacy_aliases'",
    ),
    undefined,
  );
  assert.deepEqual(database.readAll("PRAGMA foreign_key_check"), []);
  assert.deepEqual(database.readAll("PRAGMA integrity_check"), [{ integrity_check: "ok" }]);
  assert.deepEqual(
    database.readAll<{ version: number; name: string; checksum: string }>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    ).map((row) => ({ ...row, checksumLength: row.checksum.length })),
    [
      {
        version: 1,
        name: "coordination-spine",
        checksum: sha256(COORDINATION_SPINE_MIGRATION_SQL),
        checksumLength: 64,
      },
      {
        version: 2,
        name: "connected-agents-product-schema",
        checksum: COORDINATION_PRODUCT_SCHEMA_MIGRATION_CHECKSUM,
        checksumLength: 64,
      },
      {
        version: 3,
        name: "search-and-attachment-schema",
        checksum: COORDINATION_SEARCH_ATTACHMENT_MIGRATION_CHECKSUM,
        checksumLength: 64,
      },
    ],
  );
  assert.deepEqual(
    COORDINATION_PRODUCT_SCHEMA_DEPENDENCIES,
    {
      coordinationSchemaV1:
        "0ce5eee85db7fe852a6e5ef970cf81d2bbc90352cd8bf4b5e09d3d02991c7dc9",
      contractPack:
        "fbc20017304aed66e579a2b95facbda6bbcf8572038f7f1c0c824423c65d6be2",
      m06AuthProposal:
        "265444e615e74e5a824776da2083b198e283ad19bfa8d58db2b526c85bc9b795",
      m07BotDirectoryProposal:
        "2da835b11fca4d1cadb7f98eac6cec30128a84b7f205348f718ffabc3136df6f",
      m08MessagingProposal:
        "85695c952db6d1cfafa19296d48d241dbb7bf335342b534b1c76d51e24f74ae6",
    },
  );
  assert.deepEqual(COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES, {
    coordinationSchemaV2:
      "47c9045f580a020bce91d7ea64f572c7f88dc08532ff29b6f7601fdab23428a4",
    contractPack:
      "fbc20017304aed66e579a2b95facbda6bbcf8572038f7f1c0c824423c65d6be2",
    m08MessagingProposal:
      "85695c952db6d1cfafa19296d48d241dbb7bf335342b534b1c76d51e24f74ae6",
    m09SearchProposal:
      "83cbba277cb83667e9412704de922303fb87f3715be4e14dbe430adcdb089965",
    m09SearchSql:
      "30c7cedff6b22bce52b628b6cbf614953acba297c555a69c6321343273685179",
    m09SearchRebuildSql:
      "d1cbbc7729e59f36dc0bd1e26d5a92a9ac1f4648a6289ec8319e8090fb4638d7",
    m10ArtifactProposal:
      "9ce2f8e6e841f1ebb91b23f6cfca23dacf640086bc65ab6126cd66f35ee570b1",
    m10ArtifactSql:
      "a74954762fcecffa96632679c89d52dd4f6146d6d1da35248295729b25d890f3",
  });
  database.close();

  const reopened = openCoordinationDatabase({ path });
  assert.equal(reopened.openReceipt.migratedFrom, 3);
  assert.equal(reopened.openReceipt.startupCheck, "quick_check");
  assert.deepEqual(catalogNames(reopened, "table"), EXPECTED_TABLES);
  reopened.close();
});

test("the reconciled idempotency and alias constraints preserve one canonical authority", (t) => {
  const path = join(temporaryDirectory(t), "coordination.sqlite3");
  const database = openCoordinationDatabase({ path });
  const now = "2026-08-25T12:00:00.000Z";
  const validChannelResultRef = JSON.stringify({
    eventReference: {
      aggregateKind: "channel",
      aggregateId: "chn_0198d95f-6c00-7000-8000-000000000201",
      aggregateVersion: 1,
    },
    channel: { id: "chn_0198d95f-6c00-7000-8000-000000000201" },
  });
  database.mutateWithEvent((transaction) => {
    transaction.run(
      "INSERT INTO principals (id, kind, created_at) VALUES ('user_owner', 'owner', ?)",
      now,
    );
    transaction.run(
      `INSERT INTO idempotency_records (
        principal_id, operation, idempotency_key_digest, request_digest,
        result_kind, result_ref_json, request_id, correlation_id, created_at
      ) VALUES ('user_owner', 'channel.create', ?, ?, 'channel', ?, ?, ?, ?)`,
      "a".repeat(64),
      "b".repeat(64),
      validChannelResultRef,
      "req_0198d95f-6c00-7000-8000-000000000202",
      "cor_0198d95f-6c00-7000-8000-000000000203",
      now,
    );
    return {
      value: undefined,
      event: {
        type: "channel.created",
        aggregateKind: "channel",
        aggregateId: "chn_0198d95f-6c00-7000-8000-000000000201",
        aggregateVersion: 1,
        channelId: "chn_0198d95f-6c00-7000-8000-000000000201",
        actorPrincipalId: "user_owner",
        requestId: "req_0198d95f-6c00-7000-8000-000000000202",
        correlationId: "cor_0198d95f-6c00-7000-8000-000000000203",
        payload: { fixture: true },
        createdAt: now,
      },
    };
  });

  assert.throws(
    () => database.mutateWithEvent((transaction) => {
      transaction.run(
        `INSERT INTO idempotency_records (
          principal_id, operation, idempotency_key_digest, request_digest,
          result_kind, result_ref_json, request_id, correlation_id, created_at
        ) VALUES ('user_owner', 'channel.create', ?, ?, 'channel', ?, ?, ?, ?)`,
        "a".repeat(64),
        "c".repeat(64),
        validChannelResultRef,
        "req_0198d95f-6c00-7000-8000-000000000204",
        "cor_0198d95f-6c00-7000-8000-000000000205",
        now,
      );
      throw new Error("unreachable");
    }),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => database.mutateWithEvent((transaction) => {
      transaction.run(
        `INSERT INTO idempotency_records (
          principal_id, operation, idempotency_key_digest, request_digest,
          result_kind, result_ref_json, request_id, correlation_id, created_at
        ) VALUES ('user_owner', 'search.write', ?, ?, 'channel', '{}', ?, ?, ?)`,
        "d".repeat(64),
        "e".repeat(64),
        "req_0198d95f-6c00-7000-8000-000000000206",
        "cor_0198d95f-6c00-7000-8000-000000000207",
        now,
      );
      throw new Error("unreachable");
    }),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => database.mutateWithEvent((transaction) => {
      transaction.run(
        `INSERT INTO idempotency_records (
          principal_id, operation, idempotency_key_digest, request_digest,
          result_kind, result_ref_json, request_id, correlation_id, created_at
        ) VALUES ('user_owner', 'channel.create', ?, ?, 'channel', '{}', ?, ?, ?)`,
        "f".repeat(64),
        "0".repeat(64),
        "req_0198d95f-6c00-7000-8000-000000000208",
        "cor_0198d95f-6c00-7000-8000-000000000209",
        now,
      );
      throw new Error("unreachable");
    }),
    /CHECK constraint failed/,
  );
  assert.deepEqual(
    database.readAll<{ name: string }>("PRAGMA table_info(idempotency_records)")
      .map((column) => column.name),
    [
      "principal_id",
      "operation",
      "idempotency_key_digest",
      "request_digest",
      "result_kind",
      "result_ref_json",
      "request_id",
      "correlation_id",
      "created_at",
    ],
  );
  assert.deepEqual(
    database.readAll<{ name: string }>("PRAGMA table_info(aliases)")
      .map((column) => column.name),
    [
      "id",
      "namespace",
      "alias_digest",
      "target_type",
      "target_id",
      "active",
      "created_at",
      "updated_at",
    ],
  );
  database.close();
});

test("migration refuses a checksummed schema v1 journal with aggregate-version gaps", (t) => {
  const path = join(temporaryDirectory(t), "coordination.sqlite3");
  createSchemaV1(path);
  const database = new Database(path);
  const insert = database.prepare(
    `INSERT INTO events (
      id, schema_version, type, durability, aggregate_kind, aggregate_id,
      aggregate_version, channel_id, actor_principal_id, request_id,
      correlation_id, payload_json, payload_digest, created_at
    ) VALUES (?, 1, 'bot.updated', 'durable', 'bot', ?, ?, NULL,
              'user_owner', ?, ?, '{}', ?, ?)`,
  );
  const botId = "bot_0198d95f-6c00-7000-8000-000000000221";
  const payloadDigest = sha256("{}");
  insert.run(
    "evt_0198d95f-6c00-7000-8000-000000000222",
    botId,
    1,
    "req_0198d95f-6c00-7000-8000-000000000223",
    "cor_0198d95f-6c00-7000-8000-000000000224",
    payloadDigest,
    APPLIED_AT,
  );
  insert.run(
    "evt_0198d95f-6c00-7000-8000-000000000225",
    botId,
    3,
    "req_0198d95f-6c00-7000-8000-000000000226",
    "cor_0198d95f-6c00-7000-8000-000000000227",
    payloadDigest,
    APPLIED_AT,
  );
  database.close();

  assert.throws(
    () => openCoordinationDatabase({ path }),
    /CHECK constraint failed/,
  );
  const refused = new Database(path, { readonly: true, fileMustExist: true });
  assert.equal(refused.pragma("user_version", { simple: true }), 1);
  assert.deepEqual(
    refused.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
    [{ version: 1, name: "coordination-spine" }],
  );
  assert.equal(
    refused.prepare(
      "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'principals'",
    ).get().count,
    0,
  );
  refused.close();
});

test("a failed product migration leaves schema v1 intact for forward correction", (t) => {
  const path = join(temporaryDirectory(t), "coordination.sqlite3");
  createSchemaV1(path);
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.exec("CREATE TABLE channels (id TEXT PRIMARY KEY) STRICT;");

  assert.throws(
    () => migrateCoordinationSchema(
      database,
      1,
      "m04-induced-migration-failure",
      () => new Date("2026-08-25T12:01:00.000Z"),
    ),
    /table channels already exists/,
  );
  assert.equal(database.pragma("user_version", { simple: true }), 1);
  assert.deepEqual(
    database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
    [{ version: 1, name: "coordination-spine" }],
  );
  assert.equal(
    database.prepare(
      "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'principals'",
    ).get().count,
    0,
  );
  assert.equal(
    database.prepare("SELECT value FROM kernel_meta WHERE key = 'schema.version'").get().value,
    "1",
  );
  database.close();
});

test("restoring an exact schema v1 snapshot permits a clean migration reapply", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "coordination.sqlite3");
  const snapshot = join(directory, "coordination-v1.snapshot.sqlite3");
  createSchemaV1(path);
  copyFileSync(path, snapshot);

  openCoordinationDatabase({ path }).close();
  copyFileSync(snapshot, path);
  const reapplied = openCoordinationDatabase({ path });
  assert.equal(reapplied.openReceipt.migratedFrom, 1);
  assert.equal(reapplied.openReceipt.schemaVersion, 3);
  assert.deepEqual(catalogNames(reapplied, "table"), EXPECTED_TABLES);
  reapplied.close();
});
