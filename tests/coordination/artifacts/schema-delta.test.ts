import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import Database from "better-sqlite3";

import { MESSAGING_SCHEMA_DELTA_SHA256 } from "../../../src/coordination/channels/index.js";
import {
  CONNECTED_AGENTS_CONTRACT_PACK_SHA256,
  computeContractPackDigest,
} from "../../../src/coordination/contracts/contract-pack.js";
import { COORDINATION_SPINE_MIGRATION_SQL } from "../../../src/coordination/migrations/0001-coordination-spine.js";
import { CONNECTED_AGENTS_PRODUCT_SCHEMA_MIGRATION_SQL } from "../../../src/coordination/migrations/0002-connected-agents-product-schema.js";

test("M10 publishes one deterministic proposal-only M04 attachment schema handoff", async () => {
  const artifacts = await import("../../../src/coordination/artifacts/index.js").catch(
    (error: unknown) => assert.fail(`M10 schema handoff is unavailable: ${String(error)}`),
  );

  assert.equal(artifacts.ARTIFACT_SCHEMA_DELTA_PROPOSAL.packageId, "M10");
  assert.deepEqual(artifacts.ARTIFACT_SCHEMA_DELTA_PROPOSAL.landing, {
    owner: "M04",
    status: "proposal_only",
    m10MustNotApply: true,
  });
  assert.deepEqual(artifacts.ARTIFACT_SCHEMA_DELTA_PROPOSAL.requires, {
    coordinationSchemaVersion: 2,
    coordinationSchemaChecksum:
      "47c9045f580a020bce91d7ea64f572c7f88dc08532ff29b6f7601fdab23428a4",
    connectedAgentsContractVersion: 1,
    connectedAgentsContractPackSha256: CONNECTED_AGENTS_CONTRACT_PACK_SHA256,
    m08MessagingSchemaDeltaSha256: MESSAGING_SCHEMA_DELTA_SHA256,
  });
  assert.deepEqual(artifacts.ARTIFACT_SCHEMA_DELTA_PROPOSAL.tables, [
    "artifacts",
    "message_artifacts",
  ]);
  assert.equal(
    artifacts.ARTIFACT_SCHEMA_DELTA_PROPOSAL.sqlSha256,
    createHash("sha256").update(artifacts.ARTIFACT_SCHEMA_DELTA_SQL, "utf8").digest("hex"),
  );
  assert.equal(
    createHash("sha256")
      .update(artifacts.ARTIFACT_SCHEMA_DELTA_CANONICAL_JSON, "utf8")
      .digest("hex"),
    artifacts.ARTIFACT_SCHEMA_DELTA_SHA256,
  );
  assert.equal(artifacts.computeArtifactSchemaDeltaDigest(), artifacts.ARTIFACT_SCHEMA_DELTA_SHA256);
  assert.equal(computeContractPackDigest(), CONNECTED_AGENTS_CONTRACT_PACK_SHA256);
  assert.doesNotMatch(
    artifacts.ARTIFACT_SCHEMA_DELTA_SQL,
    /\bBLOB\b|storage_path|absolute_path|source_path|workspace_path|private_memory|resident_context/i,
  );
});

test("the proposal applies after the exact accepted schema v2 without modifying numbered migrations", async () => {
  const { ARTIFACT_SCHEMA_DELTA_SQL } = await import(
    "../../../src/coordination/artifacts/index.js"
  );
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    database.exec(COORDINATION_SPINE_MIGRATION_SQL);
    database.exec(CONNECTED_AGENTS_PRODUCT_SCHEMA_MIGRATION_SQL);
    database.exec(ARTIFACT_SCHEMA_DELTA_SQL);

    const tables = database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('artifacts', 'message_artifacts') ORDER BY name",
    ).all() as Array<{ name: string }>;
    assert.deepEqual(tables.map((row) => row.name), ["artifacts", "message_artifacts"]);
    const columns = database.prepare("PRAGMA table_info(artifacts)").all() as Array<{
      name: string;
      type: string;
    }>;
    assert.equal(columns.some((column) => column.type.toUpperCase() === "BLOB"), false);
    assert.equal(columns.some((column) => /path/i.test(column.name)), false);
  } finally {
    database.close();
  }
});

test("ready referenced metadata and Message links reject mutation or deletion", async () => {
  const { ARTIFACT_SCHEMA_DELTA_SQL } = await import(
    "../../../src/coordination/artifacts/index.js"
  );
  const database = new Database(":memory:");
  const at = "2026-08-25T15:00:00.000Z";
  const channelId = "chn_0198d95f-6c00-7000-8000-000000000901";
  const messageId = "msg_0198d95f-6c00-7000-8000-000000000901";
  const artifactId = "art_0198d95f-6c00-7000-8000-000000000901";
  try {
    database.pragma("foreign_keys = ON");
    database.exec(COORDINATION_SPINE_MIGRATION_SQL);
    database.exec(CONNECTED_AGENTS_PRODUCT_SCHEMA_MIGRATION_SQL);
    database.exec(ARTIFACT_SCHEMA_DELTA_SQL);
    database.prepare("INSERT INTO principals (id, kind, created_at) VALUES ('user_owner', 'owner', ?)")
      .run(at);
    database.prepare(
      `INSERT INTO channels (
        id, kind, title, purpose, owner_principal_id, responder_mode,
        coordinator_bot_id, response_order, max_bot_turns, lifecycle, pinned,
        version, next_message_sequence, created_at, updated_at
      ) VALUES (?, 'direct', 'Immutable', '', 'user_owner', 'mentions_only',
                NULL, 'parallel', 1, 'active', 0, 1, 2, ?, ?)`,
    ).run(channelId, at, at);
    database.prepare(
      `INSERT INTO channel_members (
        channel_id, principal_id, kind, role, active, joined_at, left_at
      ) VALUES (?, 'user_owner', 'owner', 'owner', 1, ?, NULL)`,
    ).run(channelId, at);
    database.prepare(
      `INSERT INTO messages (
        id, channel_id, channel_sequence, author_principal_id, author_kind,
        author_display_name, kind, body_text, stored_visibility, client_message_id,
        reply_to_message_id, tombstones_message_id, round_id, work_id, created_at
      ) VALUES (?, ?, 1, 'user_owner', 'owner', 'Owner', 'text', 'linked',
                'visible', NULL, NULL, NULL, NULL, NULL, ?)`,
    ).run(messageId, channelId, at);
    database.prepare(
      `INSERT INTO artifacts (
        id, owner_principal_id, state, original_name, declared_content_type,
        detected_content_type, byte_count, sha256, storage_kind, created_at,
        expires_at, failed_at, deleted_at, version
      ) VALUES (?, 'user_owner', 'ready', 'immutable.txt', 'text/plain',
                'text/plain', 16, ?, 'content_addressed', ?, NULL, NULL, NULL, 2)`,
    ).run(
      artifactId,
      "b2a7d72c4486981563921cca03d7c72756f0c4d1bff2f07d2773dee696260fda",
      at,
    );
    database.prepare(
      `INSERT INTO message_artifacts (
        message_id, channel_id, artifact_id, ordinal, linked_at
      ) VALUES (?, ?, ?, 0, ?)`,
    ).run(messageId, channelId, artifactId, at);

    assert.throws(
      () => database.prepare("UPDATE artifacts SET sha256 = ? WHERE id = ?")
        .run("f".repeat(64), artifactId),
      /content metadata is immutable/,
    );
    assert.throws(
      () => database.prepare("UPDATE artifacts SET state = 'expired' WHERE id = ?")
        .run(artifactId),
      /linked artifacts cannot change state/,
    );
    assert.throws(
      () => database.prepare("UPDATE message_artifacts SET ordinal = 1 WHERE artifact_id = ?")
        .run(artifactId),
      /links are immutable/,
    );
    assert.throws(
      () => database.prepare("DELETE FROM message_artifacts WHERE artifact_id = ?")
        .run(artifactId),
      /links cannot be deleted/,
    );
    assert.throws(
      () => database.prepare("DELETE FROM artifacts WHERE id = ?").run(artifactId),
      /artifact records cannot be deleted/,
    );
    const dueId = "art_0198d95f-6c00-7000-8000-000000000903";
    database.prepare(
      `INSERT INTO artifacts (
        id, owner_principal_id, state, original_name, declared_content_type,
        detected_content_type, byte_count, sha256, storage_kind, created_at,
        expires_at, failed_at, deleted_at, version
      ) VALUES (?, 'user_owner', 'ready', 'due.txt', 'text/plain',
                'text/plain', 1, ?, 'content_addressed', ?, ?, NULL, NULL, 2)`,
    ).run(dueId, "a".repeat(64), at, at);
    assert.throws(
      () => database.prepare(
        `INSERT INTO message_artifacts (
          message_id, channel_id, artifact_id, ordinal, linked_at
        ) VALUES (?, ?, ?, 1, ?)`,
      ).run(messageId, channelId, dueId, at),
      /ready author-owned artifact/,
    );
    database.prepare(
      `INSERT INTO events (
        id, schema_version, type, durability, aggregate_kind, aggregate_id,
        aggregate_version, channel_id, actor_principal_id, request_id,
        correlation_id, payload_json, payload_digest, created_at
      ) VALUES (?, 1, 'message.appended', 'durable', 'message', ?, 1, ?,
                'user_owner', ?, ?, '{}', ?, ?)`,
    ).run(
      "evt_0198d95f-6c00-7000-8000-000000000904",
      messageId,
      channelId,
      "req_0198d95f-6c00-7000-8000-000000000904",
      "cor_0198d95f-6c00-7000-8000-000000000904",
      "b".repeat(64),
      at,
    );
    const lateId = "art_0198d95f-6c00-7000-8000-000000000904";
    database.prepare(
      `INSERT INTO artifacts (
        id, owner_principal_id, state, original_name, declared_content_type,
        detected_content_type, byte_count, sha256, storage_kind, created_at,
        expires_at, failed_at, deleted_at, version
      ) VALUES (?, 'user_owner', 'ready', 'late.txt', 'text/plain',
                'text/plain', 1, ?, 'content_addressed', ?, NULL, NULL, NULL, 2)`,
    ).run(lateId, "c".repeat(64), at);
    assert.throws(
      () => database.prepare(
        `INSERT INTO message_artifacts (
          message_id, channel_id, artifact_id, ordinal, linked_at
        ) VALUES (?, ?, ?, 2, ?)`,
      ).run(messageId, channelId, lateId, at),
      /ready author-owned artifact/,
    );
    const deletedId = "art_0198d95f-6c00-7000-8000-000000000902";
    database.prepare(
      `INSERT INTO artifacts (
        id, owner_principal_id, state, original_name, declared_content_type,
        detected_content_type, byte_count, sha256, storage_kind, created_at,
        expires_at, failed_at, deleted_at, version
      ) VALUES (?, 'user_owner', 'failed', 'failed.txt', 'text/plain',
                NULL, 0, NULL, 'content_addressed', ?, NULL, ?, NULL, 1)`,
    ).run(deletedId, at, at);
    assert.throws(
      () => database.prepare(
        `UPDATE artifacts
         SET state = 'deleted', original_name = 'forged.txt', deleted_at = ?, version = 2
         WHERE id = ?`,
      ).run(at, deletedId),
      /content metadata is immutable/,
    );
    database.prepare(
      "UPDATE artifacts SET state = 'deleted', deleted_at = ?, version = 2 WHERE id = ?",
    ).run(at, deletedId);
    assert.throws(
      () => database.prepare("UPDATE artifacts SET version = 3 WHERE id = ?").run(deletedId),
      /deleted artifacts are immutable/,
    );
  } finally {
    database.close();
  }
});
