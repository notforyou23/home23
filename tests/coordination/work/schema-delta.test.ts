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
import { SEARCH_ATTACHMENT_SCHEMA_MIGRATION_SQL } from "../../../src/coordination/migrations/0003-search-and-attachment-schema.js";
import { CANONICAL_SEARCH_SCHEMA_DELTA_SHA256 } from "../../../src/coordination/search/index.js";
import {
  AT,
  BOT_ID,
  CHANNEL_ID,
  M11TestDatabase,
  OWNER_ID,
  fixtureId,
} from "./test-fixture.js";

const EXPECTED_TABLES = [
  "attempts",
  "context_manifests",
  "deliveries",
  "delivery_attempts",
  "leases",
  "outbox",
  "rounds",
  "terminal_receipts",
  "work_observations",
  "works",
];

function assertRawSqlRejected(
  database: M11TestDatabase,
  sql: string,
  parameters: unknown[],
  pattern: RegExp,
): void {
  database.raw.exec("SAVEPOINT m11_negative_probe");
  try {
    assert.throws(() => database.raw.prepare(sql).run(...parameters), pattern);
  } finally {
    database.raw.exec("ROLLBACK TO m11_negative_probe");
    database.raw.exec("RELEASE m11_negative_probe");
  }
}

function seedLifecycleRows(database: M11TestDatabase) {
  const roundId = fixtureId("round", 900);
  const manifestId = fixtureId("contextManifest", 900);
  const workId = fixtureId("work", 900);
  const attemptId = fixtureId("attempt", 900);
  const leaseId = fixtureId("lease", 900);
  const outboxId = fixtureId("outbox", 900);
  const deliveryId = fixtureId("delivery", 900);
  const terminalManifestId = fixtureId("contextManifest", 901);
  const terminalWorkId = fixtureId("work", 901);
  const endpointKey = "e".repeat(64);
  database.raw.prepare(
    `INSERT INTO rounds (
       id, channel_id, coordinator_bot_id, state, max_bot_turns, pass_count,
       deadline_at, terminal_reason, version, created_at, updated_at, terminal_at
     ) VALUES (?, ?, ?, 'open', 2, 0, '2026-08-25T17:00:00.000Z', NULL, 1, ?, ?, NULL)`,
  ).run(roundId, CHANNEL_ID, BOT_ID, AT, AT);
  database.raw.prepare(
    `INSERT INTO context_manifests (
       id, privacy, channel_id, message_refs_json, artifact_refs_json,
       message_count, artifact_count, channel_watermark, event_watermark,
       context_digest, source_digest, created_at
     ) VALUES (?, 'channel_only', ?, '[]', '[]', 0, 0, 1, 0, ?, ?, ?)`,
  ).run(manifestId, CHANNEL_ID, "a".repeat(64), "b".repeat(64), AT);
  database.raw.prepare(
    `INSERT INTO works (
       id, principal_id, target_principal_id, channel_id, origin_message_id,
       round_id, context_manifest_id, kind, idempotency_key_digest,
       request_digest, state, current_attempt_id, next_fencing_token,
       automatic_offer_count, max_automatic_offers, terminal_reason,
       terminal_receipt_digest, version, created_at, updated_at, terminal_at
     ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'resident_turn', ?, ?, 'queued', NULL,
               2, 1, 2, NULL, NULL, 1, ?, ?, NULL)`,
  ).run(workId, OWNER_ID, BOT_ID, CHANNEL_ID, roundId, manifestId, "c".repeat(64), "d".repeat(64), AT, AT);
  database.raw.prepare(
    `INSERT INTO attempts (
       id, work_id, ordinal, holder_principal_id, holder_instance_id,
       authority_reference, state, fencing_token, rejected_evidence_count,
       version, offered_at, accepted_at, started_at, ended_at, updated_at
     ) VALUES (?, ?, 1, ?, 'resident-1', 'authority-1', 'offered', 1, 0, 1,
               ?, NULL, NULL, NULL, ?)`,
  ).run(attemptId, workId, BOT_ID, AT, AT);
  database.raw.prepare(
    `INSERT INTO leases (
       id, work_id, attempt_id, holder_principal_id, holder_instance_id,
       fencing_token, state, issued_at, heartbeat_at, expires_at, ended_at,
       reason_code, version
     ) VALUES (?, ?, ?, ?, 'resident-1', 1, 'offered', ?, ?,
               '2026-08-25T17:00:00.000Z', NULL, NULL, 1)`,
  ).run(leaseId, workId, attemptId, BOT_ID, AT, AT);
  database.raw.prepare(
    `INSERT INTO outbox (
       id, kind, aggregate_kind, aggregate_id, destination_reference,
       payload_json, payload_digest, endpoint_idempotency_key, state,
       attempt_count, max_attempts, not_before, claimed_by, claim_expires_at,
       claim_epoch, active_claim_kind, recovery_probe_count, last_error_code,
       version, created_at, updated_at, delivered_at
     ) VALUES (?, 'work.wake', 'work', ?, 'resident-1', '{}', ?, ?, 'retry',
               1, 4, ?, NULL, NULL, 1, NULL, 0, 'claim_expired', 1, ?, ?, NULL)`,
  ).run(outboxId, workId, "f".repeat(64), endpointKey, AT, AT, AT);
  database.raw.prepare(
    `INSERT INTO deliveries (
       id, outbox_id, state, endpoint_idempotency_key, attempt_count,
       final_disposition, version, created_at, updated_at, terminal_at
     ) VALUES (?, ?, 'retry_wait', ?, 1, NULL, 1, ?, ?, NULL)`,
  ).run(deliveryId, outboxId, endpointKey, AT, AT);
  database.raw.prepare(
    `INSERT INTO delivery_attempts (
       delivery_id, ordinal, claim_epoch, claim_kind, endpoint_idempotency_key,
       claimant, started_at, settled_at, disposition, error_code
     ) VALUES (?, 1, 1, 'ordinary', ?, 'delivery-worker', ?, ?, 'claim_expired', 'claim_expired')`,
  ).run(deliveryId, endpointKey, AT, AT);
  database.raw.prepare(
    `INSERT INTO context_manifests (
       id, privacy, channel_id, message_refs_json, artifact_refs_json,
       message_count, artifact_count, channel_watermark, event_watermark,
       context_digest, source_digest, created_at
     ) VALUES (?, 'channel_only', ?, '[]', '[]', 0, 0, 1, 0, ?, ?, ?)`,
  ).run(terminalManifestId, CHANNEL_ID, "1".repeat(64), "2".repeat(64), AT);
  database.raw.prepare(
    `INSERT INTO works (
       id, principal_id, target_principal_id, channel_id, origin_message_id,
       round_id, context_manifest_id, kind, idempotency_key_digest,
       request_digest, state, current_attempt_id, next_fencing_token,
       automatic_offer_count, max_automatic_offers, terminal_reason,
       terminal_receipt_digest, version, created_at, updated_at, terminal_at
     ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 'resident_turn', ?, ?, 'queued', NULL,
               1, 0, 2, NULL, NULL, 1, ?, ?, NULL)`,
  ).run(terminalWorkId, OWNER_ID, BOT_ID, CHANNEL_ID, terminalManifestId, "3".repeat(64), "4".repeat(64), AT, AT);
  database.raw.prepare(
    `INSERT INTO terminal_receipts (
       work_id, attempt_id, fencing_token, terminal_status, source_reference,
       result_digest, artifact_refs_json, receipt_digest, created_at
     ) VALUES (?, NULL, 0, 'cancelled', 'operator', NULL, '[]', ?, ?)`,
  ).run(terminalWorkId, "5".repeat(64), AT);
  database.raw.prepare(
    `UPDATE works SET state = 'cancelled', terminal_reason = 'operator_cancelled',
       terminal_receipt_digest = ?, terminal_at = ?, updated_at = ?, version = 2
     WHERE id = ?`,
  ).run("5".repeat(64), AT, AT, terminalWorkId);
  return { attemptId, deliveryId, endpointKey, leaseId, outboxId, roundId, terminalWorkId, workId };
}

test("M11 publishes one deterministic proposal-only M04 work schema handoff", async () => {
  const work = await import("../../../src/coordination/work/index.js").catch(
    (error: unknown) => assert.fail(`M11 schema handoff is unavailable: ${String(error)}`),
  );

  assert.equal(work.WORK_SCHEMA_DELTA_PROPOSAL.packageId, "M11");
  assert.deepEqual(work.WORK_SCHEMA_DELTA_PROPOSAL.landing, {
    owner: "M04",
    status: "proposal_only",
    m11MustNotApply: true,
  });
  assert.deepEqual(work.WORK_SCHEMA_DELTA_PROPOSAL.requires, {
    exactBaseGitSha: "b2bdcfcd6b33fbf936bbd12388e7c829b9eeee87",
    coordinationSchemaVersion: 3,
    coordinationSchemaChecksum: "ddac2fb83bf73837f5200725697eff7d55a685f18a6c144fc33df17b75f113c2",
    connectedAgentsContractVersion: 1,
    connectedAgentsContractPackSha256: CONNECTED_AGENTS_CONTRACT_PACK_SHA256,
    m08MessagingSchemaDeltaSha256: MESSAGING_SCHEMA_DELTA_SHA256,
    m09CanonicalSearchSchemaDeltaSha256: CANONICAL_SEARCH_SCHEMA_DELTA_SHA256,
  });
  assert.deepEqual([...work.WORK_SCHEMA_DELTA_PROPOSAL.tables].sort(), EXPECTED_TABLES);
  assert.equal(
    work.WORK_SCHEMA_DELTA_PROPOSAL.sqlSha256,
    createHash("sha256").update(work.WORK_SCHEMA_DELTA_SQL, "utf8").digest("hex"),
  );
  assert.equal(
    createHash("sha256")
      .update(work.WORK_SCHEMA_DELTA_CANONICAL_JSON, "utf8")
      .digest("hex"),
    work.WORK_SCHEMA_DELTA_SHA256,
  );
  assert.equal(work.computeWorkSchemaDeltaDigest(), work.WORK_SCHEMA_DELTA_SHA256);
  assert.equal(computeContractPackDigest(), CONNECTED_AGENTS_CONTRACT_PACK_SHA256);
  assert.doesNotMatch(
    work.WORK_SCHEMA_DELTA_SQL,
    /\b(body|prompt|secret|token|private_path|workspace_path|absolute_path|locator)\b/i,
  );
});

test("the M11 owner never applies its proposal and an isolated M04 fixture may install it", async () => {
  const { WORK_SCHEMA_DELTA_PROPOSAL, WORK_SCHEMA_DELTA_SQL } = await import(
    "../../../src/coordination/work/index.js"
  );
  assert.equal(WORK_SCHEMA_DELTA_PROPOSAL.landing.m11MustNotApply, true);

  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    database.exec(COORDINATION_SPINE_MIGRATION_SQL);
    database.exec(CONNECTED_AGENTS_PRODUCT_SCHEMA_MIGRATION_SQL);
    database.exec(SEARCH_ATTACHMENT_SCHEMA_MIGRATION_SQL);
    database.exec(WORK_SCHEMA_DELTA_SQL);

    const tables = database.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name IN (${EXPECTED_TABLES.map(() => "?").join(",")})
       ORDER BY name`,
    ).all(...EXPECTED_TABLES) as Array<{ name: string }>;
    assert.deepEqual(tables.map((row) => row.name), EXPECTED_TABLES);
    const columns = database.prepare("PRAGMA table_info(context_manifests)").all() as Array<{
      name: string;
    }>;
    assert.equal(
      columns.some((column) =>
        /body|prompt|secret|token|private|workspace|path|locator/i.test(column.name)
      ),
      false,
    );
  } finally {
    database.close();
  }
});

test("proposal SQL rejects every registry-illegal lifecycle transition", () => {
  const database = M11TestDatabase.temporary();
  try {
    const ids = seedLifecycleRows(database);
    const illegal: Array<[string, unknown[]]> = [
      ["UPDATE rounds SET state = 'completed', terminal_reason = 'bad', terminal_at = ? WHERE id = ?", [AT, ids.roundId]],
      ["UPDATE works SET state = 'succeeded', terminal_reason = 'bad', terminal_at = ? WHERE id = ?", [AT, ids.workId]],
      ["UPDATE attempts SET state = 'running', accepted_at = ?, started_at = ? WHERE id = ?", [AT, AT, ids.attemptId]],
      ["UPDATE leases SET state = 'released', ended_at = ?, reason_code = 'bad' WHERE id = ?", [AT, ids.leaseId]],
      ["UPDATE outbox SET state = 'delivered', delivered_at = ? WHERE id = ?", [AT, ids.outboxId]],
      ["UPDATE deliveries SET state = 'delivered', final_disposition = 'accepted', terminal_at = ? WHERE id = ?", [AT, ids.deliveryId]],
    ];
    for (const [sql, parameters] of illegal) {
      assertRawSqlRejected(database, sql, parameters, /illegal (Round|Work|Attempt|Lease|Outbox|Delivery) transition/);
    }
  } finally {
    database.close();
  }
});

test("proposal SQL enforces cross-row bindings and state-field coherence", () => {
  const database = M11TestDatabase.temporary();
  try {
    const ids = seedLifecycleRows(database);
    assertRawSqlRejected(
      database,
      "UPDATE leases SET fencing_token = 2 WHERE id = ?",
      [ids.leaseId],
      /Lease binding is inconsistent/,
    );
    assertRawSqlRejected(
      database,
      "UPDATE deliveries SET endpoint_idempotency_key = ? WHERE id = ?",
      ["9".repeat(64), ids.deliveryId],
      /Delivery binding is inconsistent/,
    );
    assertRawSqlRejected(
      database,
      "UPDATE attempts SET state = 'accepted' WHERE id = ?",
      [ids.attemptId],
      /Attempt fields are incoherent/,
    );
    assertRawSqlRejected(
      database,
      "UPDATE outbox SET state = 'claimed' WHERE id = ?",
      [ids.outboxId],
      /Outbox fields are incoherent/,
    );
  } finally {
    database.close();
  }
});

test("proposal SQL retains all lifecycle and delivery history", () => {
  const database = M11TestDatabase.temporary();
  try {
    const ids = seedLifecycleRows(database);
    const retained: Array<[string, unknown[], RegExp]> = [
      ["DELETE FROM rounds WHERE id = ?", [ids.roundId], /Round is retained/],
      ["DELETE FROM works WHERE id = ?", [ids.workId], /Work is retained/],
      ["DELETE FROM attempts WHERE id = ?", [ids.attemptId], /Attempt is retained/],
      ["DELETE FROM leases WHERE id = ?", [ids.leaseId], /Lease is retained/],
      ["DELETE FROM outbox WHERE id = ?", [ids.outboxId], /Outbox is retained/],
      ["DELETE FROM deliveries WHERE id = ?", [ids.deliveryId], /Delivery is retained/],
      ["DELETE FROM delivery_attempts WHERE delivery_id = ?", [ids.deliveryId], /Delivery attempt is retained/],
      ["DELETE FROM terminal_receipts WHERE work_id = ?", [ids.terminalWorkId], /terminal receipt is retained/],
    ];
    for (const [sql, parameters, pattern] of retained) {
      assertRawSqlRejected(database, sql, parameters, pattern);
    }
  } finally {
    database.close();
  }
});
