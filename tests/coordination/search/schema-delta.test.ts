import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CANONICAL_SEARCH_SCHEMA_DELTA_CANONICAL_JSON,
  CANONICAL_SEARCH_INDEX_REBUILD_SQL,
  CANONICAL_SEARCH_SCHEMA_DELTA_PROPOSAL,
  CANONICAL_SEARCH_SCHEMA_DELTA_SHA256,
  CANONICAL_SEARCH_SCHEMA_DELTA_SQL,
  computeCanonicalSearchSchemaDeltaDigest,
} from "../../../src/coordination/search/index.js";
import {
  COORDINATION_SCHEMA_CHECKSUM,
  COORDINATION_SCHEMA_VERSION,
} from "../../../src/coordination/db/index.js";
import { MESSAGING_SCHEMA_DELTA_SHA256 } from "../../../src/coordination/channels/index.js";

test("M09 publishes one deterministic proposal-only M04 FTS handoff", () => {
  assert.equal(CANONICAL_SEARCH_SCHEMA_DELTA_PROPOSAL.packageId, "M09");
  assert.deepEqual(CANONICAL_SEARCH_SCHEMA_DELTA_PROPOSAL.landing, {
    owner: "M04",
    status: "proposal_only",
    m09MustNotApply: true,
    gate: "M04 schema-hotspot owner review and next numbered migration integration",
  });
  assert.deepEqual(CANONICAL_SEARCH_SCHEMA_DELTA_PROPOSAL.requires, {
    coordinationSchemaVersion: COORDINATION_SCHEMA_VERSION,
    coordinationSchemaChecksum: COORDINATION_SCHEMA_CHECKSUM,
    connectedAgentsContractVersion: 1,
    connectedAgentsContractPackSha256:
      "fbc20017304aed66e579a2b95facbda6bbcf8572038f7f1c0c824423c65d6be2",
    m08MessagingSchemaDeltaSha256: MESSAGING_SCHEMA_DELTA_SHA256,
    messageAppendEventCardinality: 1,
  });
  assert.deepEqual(CANONICAL_SEARCH_SCHEMA_DELTA_PROPOSAL.tables, [
    "search_watermarks",
  ]);
  assert.deepEqual(CANONICAL_SEARCH_SCHEMA_DELTA_PROPOSAL.virtualTables, [
    "message_fts",
  ]);
  assert.deepEqual(CANONICAL_SEARCH_SCHEMA_DELTA_PROPOSAL.sourceClasses, [
    "coordination.messages",
  ]);
  assert.deepEqual(CANONICAL_SEARCH_SCHEMA_DELTA_PROPOSAL.forbiddenStoredColumns, [
    "query_text",
    "query_digest",
    "cursor",
    "principal_id",
    "channel_id",
    "private_memory",
    "resident_context",
    "workspace_path",
    "credential",
    "secret",
  ]);
  assert.deepEqual(CANONICAL_SEARCH_SCHEMA_DELTA_PROPOSAL.rollback, {
    beforeLanding: "remove this unconsumed proposal with M09",
    afterLanding:
      "disable coordination.search.canonical; the M04 owner may rebuild or drop only the derived FTS index and watermark while preserving every canonical message",
  });
  assert.equal(
    CANONICAL_SEARCH_SCHEMA_DELTA_PROPOSAL.sqlSha256,
    createHash("sha256").update(CANONICAL_SEARCH_SCHEMA_DELTA_SQL, "utf8").digest("hex"),
  );
  assert.equal(
    CANONICAL_SEARCH_SCHEMA_DELTA_PROPOSAL.rebuildSqlSha256,
    createHash("sha256").update(CANONICAL_SEARCH_INDEX_REBUILD_SQL, "utf8").digest("hex"),
  );
  assert.equal(
    computeCanonicalSearchSchemaDeltaDigest(),
    CANONICAL_SEARCH_SCHEMA_DELTA_SHA256,
  );
  assert.equal(
    createHash("sha256")
      .update(CANONICAL_SEARCH_SCHEMA_DELTA_CANONICAL_JSON, "utf8")
      .digest("hex"),
    CANONICAL_SEARCH_SCHEMA_DELTA_SHA256,
  );
  assert.match(CANONICAL_SEARCH_SCHEMA_DELTA_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(
    CANONICAL_SEARCH_SCHEMA_DELTA_SHA256,
    "83cbba277cb83667e9412704de922303fb87f3715be4e14dbe430adcdb089965",
  );
  assert.doesNotMatch(
    CANONICAL_SEARCH_SCHEMA_DELTA_SQL,
    /private_memory|resident_context|workspace_path|legacy_sources|import_items/i,
  );
  assert.doesNotMatch(CANONICAL_SEARCH_SCHEMA_DELTA_SQL, /CREATE TABLE events/i);
});
