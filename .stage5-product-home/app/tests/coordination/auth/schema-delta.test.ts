import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AUTH_SCHEMA_DELTA_CANONICAL_JSON,
  AUTH_SCHEMA_DELTA_PROPOSAL,
  AUTH_SCHEMA_DELTA_SHA256,
  computeAuthSchemaDeltaDigest,
} from "../../../src/coordination/auth/index.js";
import {
  CONNECTED_AGENTS_CONTRACT_PACK_SHA256,
  computeContractPackDigest,
} from "../../../src/coordination/contracts/contract-pack.js";
import { COORDINATION_CONTRACT_PACK_SHA256 } from "../../../src/coordination/migrations/index.js";

test("M06 publishes a deterministic M04-owned auth schema delta without raw credential columns", () => {
  assert.equal(AUTH_SCHEMA_DELTA_PROPOSAL.packageId, "M06");
  assert.deepEqual(AUTH_SCHEMA_DELTA_PROPOSAL.landing, {
    owner: "M04",
    status: "proposal_only",
    m06MustNotApply: true,
  });
  assert.deepEqual(AUTH_SCHEMA_DELTA_PROPOSAL.requires, {
    coordinationSchemaVersion: 1,
    coordinationSchemaChecksum:
      "0ce5eee85db7fe852a6e5ef970cf81d2bbc90352cd8bf4b5e09d3d02991c7dc9",
    connectedAgentsContractVersion: 1,
    connectedAgentsContractPackSha256:
      "fbc20017304aed66e579a2b95facbda6bbcf8572038f7f1c0c824423c65d6be2",
  });
  assert.deepEqual(
    AUTH_SCHEMA_DELTA_PROPOSAL.tables.map((table) => table.name),
    [
      "principals",
      "pairing_sessions",
      "devices",
      "client_sessions",
      "session_refresh_tokens",
      "idempotency_records",
    ],
  );
  assert.deepEqual(AUTH_SCHEMA_DELTA_PROPOSAL.forbiddenStoredColumns, [
    "pairing_code",
    "access_token",
    "refresh_token",
    "signing_key",
    "key_material",
    "refresh_digest_key",
    "idempotency_response",
    "idempotency_key",
    "response_body",
  ]);
  const proposedColumnNames = AUTH_SCHEMA_DELTA_PROPOSAL.tables.flatMap((table) =>
    table.columns.map((column) => column.name)
  );
  for (const forbidden of AUTH_SCHEMA_DELTA_PROPOSAL.forbiddenStoredColumns) {
    assert.equal(proposedColumnNames.includes(forbidden), false);
  }
  const independentDigest = createHash("sha256")
    .update(AUTH_SCHEMA_DELTA_CANONICAL_JSON, "utf8")
    .digest("hex");
  assert.equal(computeAuthSchemaDeltaDigest(), independentDigest);
  assert.equal(independentDigest, AUTH_SCHEMA_DELTA_SHA256);
  assert.equal(
    independentDigest,
    "265444e615e74e5a824776da2083b198e283ad19bfa8d58db2b526c85bc9b795",
  );
});

test("auth schema handoff preserves contract version 1 and its exact accepted digest", () => {
  assert.equal(COORDINATION_CONTRACT_PACK_SHA256,
    "fbc20017304aed66e579a2b95facbda6bbcf8572038f7f1c0c824423c65d6be2");
  assert.equal(computeContractPackDigest(), CONNECTED_AGENTS_CONTRACT_PACK_SHA256);
  assert.equal(
    AUTH_SCHEMA_DELTA_PROPOSAL.requires.connectedAgentsContractPackSha256,
    COORDINATION_CONTRACT_PACK_SHA256,
  );
});
