import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { AUTH_SCHEMA_DELTA_SHA256 } from "../../../src/coordination/auth/index.js";
import { BOT_DIRECTORY_SCHEMA_DELTA_SHA256 } from "../../../src/coordination/bots/index.js";
import {
  MESSAGING_SCHEMA_DELTA_CANONICAL_JSON,
  MESSAGING_SCHEMA_DELTA_PROPOSAL,
  MESSAGING_SCHEMA_DELTA_SHA256,
  MESSAGING_SCHEMA_DELTA_SQL,
  computeMessagingSchemaDeltaDigest,
} from "../../../src/coordination/channels/index.js";
import {
  CONNECTED_AGENTS_CONTRACT_PACK_SHA256,
  computeContractPackDigest,
} from "../../../src/coordination/contracts/contract-pack.js";
import { OWNER_ID, TestMessagingDatabase, fixtureId } from "./test-fixture.js";

test("M08 publishes one deterministic proposal-only M04 messaging schema delta", () => {
  assert.equal(MESSAGING_SCHEMA_DELTA_PROPOSAL.packageId, "M08");
  assert.deepEqual(MESSAGING_SCHEMA_DELTA_PROPOSAL.landing, {
    owner: "M04",
    status: "proposal_only",
    m08MustNotApply: true,
  });
  assert.deepEqual(MESSAGING_SCHEMA_DELTA_PROPOSAL.tables, [
    "channels",
    "channel_members",
    "channel_membership_history",
    "direct_channel_pairs",
    "conversation_handles",
    "messages",
    "mentions",
    "read_cursors",
  ]);
  assert.deepEqual(MESSAGING_SCHEMA_DELTA_PROPOSAL.modifiesProposedTables, [
    {
      name: "bots",
      column: "conversation_id",
      addReference: "conversation_handles(id)",
      directConversationBinding: "set once in the direct Channel creation transaction",
      authorityAdapter: "required from the M07/M04 owner; M08 supplies no Bot SQL writer",
      compositeEventContract: "channel.created payload carries botId and botVersion",
    },
    {
      name: "idempotency_records",
      replacesChecksFrom: "M06",
      principalCheck: "principal_id = 'user_owner' OR principal_id LIKE 'bot_%'",
      operations: [
        "pairing.issue",
        "pairing.redeem",
        "session.refresh",
        "session.revoke",
        "device.revoke",
        "channel.create",
        "channel.update",
        "message.append",
        "read_cursor.update",
      ],
      resultKinds: [
        "pairing",
        "pairing_failure",
        "redemption",
        "refresh",
        "refresh_failure",
        "revoke",
        "channel",
        "message",
        "read_cursor",
      ],
      rawIdempotencyKeyStored: false,
    },
  ]);
  assert.equal(
    MESSAGING_SCHEMA_DELTA_PROPOSAL.sqlSha256,
    createHash("sha256").update(MESSAGING_SCHEMA_DELTA_SQL, "utf8").digest("hex"),
  );
  assert.equal(computeMessagingSchemaDeltaDigest(), MESSAGING_SCHEMA_DELTA_SHA256);
  assert.equal(
    createHash("sha256")
      .update(MESSAGING_SCHEMA_DELTA_CANONICAL_JSON, "utf8")
      .digest("hex"),
    MESSAGING_SCHEMA_DELTA_SHA256,
  );
  assert.match(MESSAGING_SCHEMA_DELTA_SHA256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(MESSAGING_SCHEMA_DELTA_SQL, /private_memory|resident_context|workspace_path|credential|secret/);
  assert.doesNotMatch(MESSAGING_SCHEMA_DELTA_SQL, /CREATE TABLE (?:events|principals)/);
});

test("M08 composes the accepted M06 and M07 proposals without losing M06 claims", () => {
  const database = new TestMessagingDatabase(false);
  try {
    database.seedPrincipal(OWNER_ID, "owner");
    const botId = fixtureId("bot", 901);
    database.seedPrincipal(botId, "bot");
    database.seedBot({
      id: botId,
      principalId: botId,
      name: "Schema Bot",
      purpose: "Preserved M07 row.",
      lifecycle: "active",
      availability: "offline",
      conversationId: null,
      residentBinding: "schema-bot",
      version: 1,
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
    });
    database.raw.prepare(
      `INSERT INTO idempotency_records (
        principal_id, operation, idempotency_key_digest, request_digest,
        result_kind, result_ref_json, request_id, correlation_id, created_at
      ) VALUES (?, 'device.revoke', ?, ?, 'revoke', '{}', ?, ?, ?)`,
    ).run(
      OWNER_ID,
      "a".repeat(64),
      "b".repeat(64),
      fixtureId("request", 901),
      fixtureId("correlation", 901),
      "2026-08-25T12:00:00.000Z",
    );

    database.raw.exec(MESSAGING_SCHEMA_DELTA_SQL);
    assert.equal(database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM idempotency_records WHERE operation = 'device.revoke'",
    )?.count, 1);
    assert.equal(database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM bots WHERE id = ?",
      botId,
    )?.count, 1);
    assert.equal(
      database.readAll<{ table: string; from: string }>("PRAGMA foreign_key_list(bots)")
        .some((foreignKey) =>
          foreignKey.table === "conversation_handles" &&
          foreignKey.from === "conversation_id"
        ),
      true,
    );

    database.raw.prepare(
      `INSERT INTO idempotency_records (
        principal_id, operation, idempotency_key_digest, request_digest,
        result_kind, result_ref_json, request_id, correlation_id, created_at
      ) VALUES (?, 'message.append', ?, ?, 'message', '{}', ?, ?, ?)`,
    ).run(
      botId,
      "c".repeat(64),
      "d".repeat(64),
      fixtureId("request", 902),
      fixtureId("correlation", 902),
      "2026-08-25T12:00:00.000Z",
    );
    assert.throws(
      () => database.raw.prepare(
        `INSERT INTO idempotency_records (
          principal_id, operation, idempotency_key_digest, request_digest,
          result_kind, result_ref_json, request_id, correlation_id, created_at
        ) VALUES (?, 'search.write', ?, ?, 'message', '{}', ?, ?, ?)`,
      ).run(
        OWNER_ID,
        "e".repeat(64),
        "f".repeat(64),
        fixtureId("request", 903),
        fixtureId("correlation", 903),
        "2026-08-25T12:00:00.000Z",
      ),
      /CHECK constraint failed/,
    );
  } finally {
    database.close();
  }
});

test("the proposal is bound to the exact accepted M02, M06, and M07 artifacts", () => {
  assert.equal(computeContractPackDigest(), CONNECTED_AGENTS_CONTRACT_PACK_SHA256);
  assert.equal(
    MESSAGING_SCHEMA_DELTA_PROPOSAL.requires.connectedAgentsContractPackSha256,
    CONNECTED_AGENTS_CONTRACT_PACK_SHA256,
  );
  assert.equal(
    MESSAGING_SCHEMA_DELTA_PROPOSAL.requires.m06AuthSchemaDeltaSha256,
    AUTH_SCHEMA_DELTA_SHA256,
  );
  assert.equal(
    MESSAGING_SCHEMA_DELTA_PROPOSAL.requires.m07BotDirectorySchemaDeltaSha256,
    BOT_DIRECTORY_SCHEMA_DELTA_SHA256,
  );
});
