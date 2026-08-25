import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  BOT_DIRECTORY_SCHEMA_DELTA_CANONICAL_JSON,
  BOT_DIRECTORY_SCHEMA_DELTA_PROPOSAL,
  BOT_DIRECTORY_SCHEMA_DELTA_SHA256,
  computeBotDirectorySchemaDeltaDigest,
} from "../../../src/coordination/bots/index.js";
import {
  CONNECTED_AGENTS_CONTRACT_PACK_SHA256,
  computeContractPackDigest,
} from "../../../src/coordination/contracts/contract-pack.js";
import { AUTH_SCHEMA_DELTA_SHA256 } from "../../../src/coordination/auth/index.js";

test("M07 publishes a deterministic M04-owned Bot directory schema delta", () => {
  assert.equal(BOT_DIRECTORY_SCHEMA_DELTA_PROPOSAL.packageId, "M07");
  assert.deepEqual(BOT_DIRECTORY_SCHEMA_DELTA_PROPOSAL.landing, {
    owner: "M04",
    status: "proposal_only",
    m07MustNotApply: true,
  });
  assert.deepEqual(
    BOT_DIRECTORY_SCHEMA_DELTA_PROPOSAL.tables.map((table) => table.name),
    ["bots", "aliases"],
  );
  assert.equal(
    BOT_DIRECTORY_SCHEMA_DELTA_PROPOSAL.requires.connectedAgentsContractPackSha256,
    "fbc20017304aed66e579a2b95facbda6bbcf8572038f7f1c0c824423c65d6be2",
  );
  assert.equal(
    BOT_DIRECTORY_SCHEMA_DELTA_PROPOSAL.requires.coordinationSchemaChecksum,
    "0ce5eee85db7fe852a6e5ef970cf81d2bbc90352cd8bf4b5e09d3d02991c7dc9",
  );
  assert.equal(
    BOT_DIRECTORY_SCHEMA_DELTA_PROPOSAL.requires.m06AuthSchemaDeltaSha256,
    AUTH_SCHEMA_DELTA_SHA256,
  );
  assert.equal(
    BOT_DIRECTORY_SCHEMA_DELTA_PROPOSAL.forbiddenStoredColumns.includes("alias_value"),
    true,
  );
  const proposedColumnNames = BOT_DIRECTORY_SCHEMA_DELTA_PROPOSAL.tables.flatMap(
    (table) => table.columns.map((column) => column.name),
  );
  for (const forbidden of BOT_DIRECTORY_SCHEMA_DELTA_PROPOSAL.forbiddenStoredColumns) {
    assert.equal(proposedColumnNames.includes(forbidden), false);
  }
  assert.doesNotMatch(BOT_DIRECTORY_SCHEMA_DELTA_CANONICAL_JSON, /\/Users\//);
  assert.doesNotMatch(
    BOT_DIRECTORY_SCHEMA_DELTA_CANONICAL_JSON,
    /private_memory|memory_body|credential|secret|mailbox_body/,
  );
  assert.equal(
    computeBotDirectorySchemaDeltaDigest(),
    BOT_DIRECTORY_SCHEMA_DELTA_SHA256,
  );
  assert.equal(
    createHash("sha256")
      .update(BOT_DIRECTORY_SCHEMA_DELTA_CANONICAL_JSON, "utf8")
      .digest("hex"),
    BOT_DIRECTORY_SCHEMA_DELTA_SHA256,
  );
  assert.equal(
    BOT_DIRECTORY_SCHEMA_DELTA_SHA256,
    "2da835b11fca4d1cadb7f98eac6cec30128a84b7f205348f718ffabc3136df6f",
  );
  assert.match(BOT_DIRECTORY_SCHEMA_DELTA_SHA256, /^[a-f0-9]{64}$/);
});

test("the schema handoff is bound to the exact accepted M02 contract pack", () => {
  assert.equal(
    CONNECTED_AGENTS_CONTRACT_PACK_SHA256,
    "fbc20017304aed66e579a2b95facbda6bbcf8572038f7f1c0c824423c65d6be2",
  );
  assert.equal(
    computeContractPackDigest(),
    CONNECTED_AGENTS_CONTRACT_PACK_SHA256,
  );
  assert.equal(
    BOT_DIRECTORY_SCHEMA_DELTA_PROPOSAL.requires.connectedAgentsContractPackSha256,
    CONNECTED_AGENTS_CONTRACT_PACK_SHA256,
  );
});
