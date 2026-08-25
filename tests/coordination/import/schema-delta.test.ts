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
      "legacy_aliases",
      "shadow_compare_receipts",
    ],
  );
  const independentDigest = createHash("sha256")
    .update(IMPORT_SCHEMA_DELTA_CANONICAL_JSON, "utf8")
    .digest("hex");
  assert.equal(computeImportSchemaDeltaDigest(), independentDigest);
  assert.equal(independentDigest, IMPORT_SCHEMA_DELTA_SHA256);
});

test("the proposal excludes real bodies, resident memory, raw paths, and M08/M09 product tables", () => {
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
    IMPORT_SCHEMA_DELTA_PROPOSAL.requires.productionBodyMaterializationAfter,
    ["M08", "M09"],
  );
});

test("the M04 proposal remains bound to the accepted Connected Agents contract", () => {
  assert.equal(computeContractPackDigest(), CONNECTED_AGENTS_CONTRACT_PACK_SHA256);
  assert.equal(
    IMPORT_SCHEMA_DELTA_PROPOSAL.requires.connectedAgentsContractPackSha256,
    "fbc20017304aed66e579a2b95facbda6bbcf8572038f7f1c0c824423c65d6be2",
  );
  assert.equal(
    IMPORT_SCHEMA_DELTA_PROPOSAL.requires.connectedAgentsContractPackSha256,
    CONNECTED_AGENTS_CONTRACT_PACK_SHA256,
  );
});
