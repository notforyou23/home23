import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  computeImportSchemaDeltaDigest,
  IMPORT_SCHEMA_DELTA_CANONICAL_JSON,
  IMPORT_SCHEMA_DELTA_PROPOSAL,
  IMPORT_SCHEMA_DELTA_SHA256,
} from "../../../src/coordination/import/index.js";
import {
  CONNECTED_AGENTS_CONTRACT_PACK_SHA256,
  computeContractPackDigest,
} from "../../../src/coordination/contracts/contract-pack.js";
import {
  COORDINATION_CONTRACT_PACK_SHA256,
  COORDINATION_SCHEMA_CHECKSUM,
  COORDINATION_SCHEMA_VERSION,
  COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES,
} from "../../../src/coordination/migrations/index.js";

test("M17 publishes a deterministic proposal-only M04 import schema delta", () => {
  assert.deepEqual(IMPORT_SCHEMA_DELTA_PROPOSAL.landing, {
    owner: "M04",
    status: "proposal_only",
    m17MustNotApply: true,
  });
  assert.deepEqual(
    IMPORT_SCHEMA_DELTA_PROPOSAL.tables.map((table) => table.name),
    [
      "legacy_sources",
      "legacy_source_segments",
      "import_cohorts",
      "import_batches",
      "import_items",
      "import_cursors",
      "shadow_compare_receipts",
    ],
  );
  assert.equal(
    IMPORT_SCHEMA_DELTA_PROPOSAL.tables.some((table) => table.name === "legacy_aliases"),
    false,
  );
  assert.deepEqual(IMPORT_SCHEMA_DELTA_PROPOSAL.canonicalBindings.aliases, {
    table: "aliases",
    identityColumns: ["namespace", "alias_digest"],
    targetColumns: ["target_type", "target_id", "active"],
    provenanceOwner: "import_items",
  });
  const independentDigest = createHash("sha256")
    .update(IMPORT_SCHEMA_DELTA_CANONICAL_JSON, "utf8")
    .digest("hex");
  assert.equal(computeImportSchemaDeltaDigest(), independentDigest);
  assert.equal(independentDigest, IMPORT_SCHEMA_DELTA_SHA256);
});

test("the proposal excludes bodies and binds materialization to canonical M08/M09 truth", () => {
  const tableNames = IMPORT_SCHEMA_DELTA_PROPOSAL.tables.map((table) => table.name);
  assert.equal(tableNames.includes("messages"), false);
  assert.equal(tableNames.includes("conversations"), false);
  assert.equal(tableNames.includes("attachments"), false);

  const columnNames = IMPORT_SCHEMA_DELTA_PROPOSAL.tables.flatMap((table) =>
    table.columns.map((column) => column.name)
  );
  for (const forbidden of IMPORT_SCHEMA_DELTA_PROPOSAL.forbiddenStoredColumns) {
    assert.equal(columnNames.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(
    IMPORT_SCHEMA_DELTA_PROPOSAL.canonicalBindings.messages,
    { table: "messages", idempotencyTable: "idempotency_records" },
  );
  assert.deepEqual(
    IMPORT_SCHEMA_DELTA_PROPOSAL.canonicalBindings.events,
    { table: "events", orderedTypes: ["message.appended", "import.updated"] },
  );
  assert.deepEqual(
    IMPORT_SCHEMA_DELTA_PROPOSAL.canonicalBindings.search,
    {
      indexTable: "message_fts",
      watermarkTable: "search_watermarks",
      sourceClass: "coordination.messages",
      rebuildSqlSha256:
        COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.m09SearchRebuildSql,
    },
  );
});

test("the M04 proposal remains bound to the accepted contract and materialized schema v3", () => {
  assert.equal(computeContractPackDigest(), CONNECTED_AGENTS_CONTRACT_PACK_SHA256);
  assert.equal(
    IMPORT_SCHEMA_DELTA_PROPOSAL.requires.connectedAgentsContractPackSha256,
    "fbc20017304aed66e579a2b95facbda6bbcf8572038f7f1c0c824423c65d6be2",
  );
  assert.equal(
    IMPORT_SCHEMA_DELTA_PROPOSAL.requires.connectedAgentsContractPackSha256,
    COORDINATION_CONTRACT_PACK_SHA256,
  );
  assert.equal(
    IMPORT_SCHEMA_DELTA_PROPOSAL.requires.coordinationSchemaVersion,
    3,
  );
  assert.equal(COORDINATION_SCHEMA_VERSION, 8);
  assert.equal(
    IMPORT_SCHEMA_DELTA_PROPOSAL.requires.coordinationSchemaChecksum,
    "ddac2fb83bf73837f5200725697eff7d55a685f18a6c144fc33df17b75f113c2",
  );
});
