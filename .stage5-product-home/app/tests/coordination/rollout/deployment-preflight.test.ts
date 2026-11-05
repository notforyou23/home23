import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  CORE_DEPLOYMENT_CANDIDATE,
  DeploymentPreflightError,
  runDeploymentPreflightFixture,
  type DeploymentPreflightFixture,
} from "../../../src/coordination/rollout/index.js";
import { COORDINATION_MIGRATION_PLAN_CHECKSUM, COORDINATION_SCHEMA_CHECKSUM, COORDINATION_SCHEMA_VERSION } from "../../../src/coordination/migrations/index.js";
import { FEATURE_FLAG_REGISTRY } from "../../../src/coordination/schema/contract-registry.js";

const hash = (value: string) => value.repeat(64);
function fixture(): DeploymentPreflightFixture {
  return {
    evidenceMode: "fixture", candidateSha: CORE_DEPLOYMENT_CANDIDATE, capturedAt: "2026-08-25T20:00:00.000Z",
    source: { headSha: CORE_DEPLOYMENT_CANDIDATE, branch: "fixture-candidate", clean: true, trackedTreeSha256: hash("a"), buildSha256: hash("b") },
    generatedConfig: { ecosystemSha256: hash("c"), coordinationEntryCount: 1, coordinationAutorestart: false },
    migrations: { currentSchemaVersion: 0, targetSchemaVersion: COORDINATION_SCHEMA_VERSION, planSha256: COORDINATION_MIGRATION_PLAN_CHECKSUM, targetSchemaSha256: COORDINATION_SCHEMA_CHECKSUM },
    featureFlags: Object.fromEntries(Object.keys(FEATURE_FLAG_REGISTRY).map((key) => [key, false])),
    snapshot: { databaseSha256: hash("d"), walSha256: null, shmSha256: null, authorityHistorySha256: hash("e"), createdBeforeRehearsal: true },
    topology: { legacyWriterIds: ["legacy-conversation-writer"], coordinationWriterIds: [], coordinationProcessRunning: false },
    bindings: [
      { slug: "jerry", botId: "bot-jerry", channelId: "channel-jerry", conversationId: "conversation-jerry", mailbox: "jerry", runtimeInstanceId: "jerry-resident-1" },
      { slug: "forrest", botId: "bot-forrest", channelId: "channel-forrest", conversationId: "conversation-forrest", mailbox: "forrest", runtimeInstanceId: "forrest-resident-1" },
    ],
    rollback: { snapshotSha256: hash("d"), ecosystemSha256: hash("c"), sourceSha: CORE_DEPLOYMENT_CANDIDATE, legacyWriterIds: ["legacy-conversation-writer"] },
  };
}

test("emits deterministic fixture-only Jerry then Forrest deployment evidence", () => {
  const first = runDeploymentPreflightFixture(fixture());
  const second = runDeploymentPreflightFixture(fixture());
  assert.equal(first.receiptDigest, second.receiptDigest);
  assert.equal(first.liveDeploymentAttempted, false);
  assert.equal(first.liveMutationAuthorized, false);
  assert.deepEqual(first.stages.map(({ stage }) => stage), ["fixture-rehearsal", "deploy-feature-off", "canary-jerry", "canary-forrest", "rollback"]);
  assert.ok(first.stages.every(({ authorizedOnly }) => authorizedOnly));
});

test("fails closed on source, flags, migration, writer, binding, snapshot, or rollback drift", () => {
  const input = fixture();
  input.source.headSha = hash("f");
  input.featureFlags["coordination.process.enabled"] = true;
  input.migrations.planSha256 = hash("0");
  input.topology.coordinationWriterIds = ["unexpected-writer"];
  input.bindings[1]!.channelId = input.bindings[0]!.channelId;
  input.snapshot.createdBeforeRehearsal = false;
  input.rollback.ecosystemSha256 = hash("1");
  assert.throws(() => runDeploymentPreflightFixture(input), (error: unknown) => error instanceof DeploymentPreflightError
    && ["candidate", "migration_bytes", "feature_off", "snapshot", "single_writer", "bindings", "rollback"].every((name) => error.failures.includes(name)));
});

test("CLI refuses --live before reading a fixture", () => {
  const result = spawnSync(process.execPath, ["scripts/coordination/deployment-preflight.mjs", "--live"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /fixture-only/);
});
