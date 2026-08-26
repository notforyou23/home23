import { createHash } from "node:crypto";

import {
  COORDINATION_MIGRATION_PLAN_CHECKSUM,
  COORDINATION_SCHEMA_CHECKSUM,
  COORDINATION_SCHEMA_VERSION,
} from "../migrations/index.js";
import { FEATURE_FLAG_REGISTRY } from "../schema/contract-registry.js";

export const CORE_DEPLOYMENT_CANDIDATE = "9ae494591e164b11450323d058b684f7a3dbadd0";

export interface DeploymentPreflightFixture {
  evidenceMode: "fixture";
  candidateSha: string;
  capturedAt: string;
  source: { headSha: string; branch: string; clean: true; trackedTreeSha256: string; buildSha256: string };
  generatedConfig: { ecosystemSha256: string; coordinationEntryCount: number; coordinationAutorestart: false };
  migrations: { currentSchemaVersion: number; targetSchemaVersion: number; planSha256: string; targetSchemaSha256: string };
  featureFlags: Readonly<Record<string, boolean>>;
  snapshot: { databaseSha256: string; walSha256: string | null; shmSha256: string | null; authorityHistorySha256: string; createdBeforeRehearsal: true };
  topology: { legacyWriterIds: readonly string[]; coordinationWriterIds: readonly string[]; coordinationProcessRunning: false };
  bindings: readonly { slug: "jerry" | "forrest"; botId: string; channelId: string; conversationId: string; mailbox: string; runtimeInstanceId: string }[];
  rollback: { snapshotSha256: string; ecosystemSha256: string; sourceSha: string; legacyWriterIds: readonly string[] };
}

export interface DeploymentPreflightReceipt {
  receiptVersion: 1;
  evidenceMode: "fixture";
  liveDeploymentAttempted: false;
  liveMutationAuthorized: false;
  verdict: "fixture_ready_for_operator_review";
  candidateSha: string;
  checks: readonly { name: string; passed: boolean; detail: string }[];
  immutableEvidence: { trackedTreeSha256: string; buildSha256: string; ecosystemSha256: string; migrationPlanSha256: string; targetSchemaSha256: string };
  stages: readonly { stage: string; target: string; authorizedOnly: true; commands: readonly string[]; holdPoint: string }[];
  rollback: DeploymentPreflightFixture["rollback"];
  limitations: readonly string[];
  receiptDigest: string;
}

const sha = /^[a-f0-9]{64}$/;
const present = (value: unknown) => typeof value === "string" && value.trim().length > 0;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class DeploymentPreflightError extends Error {
  constructor(readonly failures: readonly string[]) {
    super(`deployment preflight blocked: ${failures.join("; ")}`);
  }
}

export function runDeploymentPreflightFixture(input: DeploymentPreflightFixture): DeploymentPreflightReceipt {
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
  const check = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });
  const flagKeys = Object.keys(FEATURE_FLAG_REGISTRY).sort();
  const bindingFields = ["botId", "channelId", "conversationId", "mailbox", "runtimeInstanceId"] as const;

  check("fixture_only", input.evidenceMode === "fixture", "input must be synthetic/offline fixture evidence");
  check("candidate", input.candidateSha === CORE_DEPLOYMENT_CANDIDATE && input.source?.headSha === CORE_DEPLOYMENT_CANDIDATE, "manifest and source HEAD must equal the reviewed candidate");
  check("source_snapshot", input.source?.clean === true && present(input.source.branch) && sha.test(input.source.trackedTreeSha256) && sha.test(input.source.buildSha256), "clean named source plus tracked-tree and build hashes are required");
  check("generated_config", sha.test(input.generatedConfig?.ecosystemSha256 ?? "") && input.generatedConfig?.coordinationEntryCount === 1 && input.generatedConfig?.coordinationAutorestart === false, "exactly one disabled, non-autorestarting coordination PM2 entry is required");
  check("migration_bytes", input.migrations?.targetSchemaVersion === COORDINATION_SCHEMA_VERSION && input.migrations?.planSha256 === COORDINATION_MIGRATION_PLAN_CHECKSUM && input.migrations?.targetSchemaSha256 === COORDINATION_SCHEMA_CHECKSUM && Number.isSafeInteger(input.migrations?.currentSchemaVersion) && input.migrations.currentSchemaVersion >= 0 && input.migrations.currentSchemaVersion <= input.migrations.targetSchemaVersion, "migration plan and target schema must match compiled reviewed constants");
  check("feature_off", JSON.stringify(Object.keys(input.featureFlags ?? {}).sort()) === JSON.stringify(flagKeys) && flagKeys.every((key) => input.featureFlags[key] === false), "the complete registered feature-flag set must remain false");
  check("snapshot", input.snapshot?.createdBeforeRehearsal === true && sha.test(input.snapshot.databaseSha256) && (input.snapshot.walSha256 === null || sha.test(input.snapshot.walSha256)) && (input.snapshot.shmSha256 === null || sha.test(input.snapshot.shmSha256)) && sha.test(input.snapshot.authorityHistorySha256), "pre-rehearsal database, sidecar, and authority-history hashes are required");
  check("single_writer", input.topology?.coordinationProcessRunning === false && input.topology?.coordinationWriterIds.length === 0 && input.topology?.legacyWriterIds.length === 1 && present(input.topology.legacyWriterIds[0]), "feature-off topology must retain exactly one legacy writer and no coordination writer");
  check("bindings", JSON.stringify(input.bindings?.map(({ slug }) => slug)) === JSON.stringify(["jerry", "forrest"]) && input.bindings.every((binding) => bindingFields.every((field) => present(binding[field]))) && bindingFields.every((field) => new Set(input.bindings.map((binding) => binding[field])).size === 2), "Jerry and Forrest binding discovery must be complete, ordered, and distinct");
  check("rollback", input.rollback?.snapshotSha256 === input.snapshot?.databaseSha256 && input.rollback?.ecosystemSha256 === input.generatedConfig?.ecosystemSha256 && input.rollback?.sourceSha === input.source?.headSha && JSON.stringify(input.rollback?.legacyWriterIds) === JSON.stringify(input.topology?.legacyWriterIds), "rollback must pin the exact pre-change snapshot, ecosystem, source, and legacy writer");

  const failures = checks.filter(({ passed }) => !passed).map(({ name }) => name);
  if (failures.length > 0) throw new DeploymentPreflightError(failures);

  const stages = [
    { stage: "fixture-rehearsal", target: "isolated temporary fixture", authorizedOnly: true as const, commands: ["npm run build", "npm run test:coordination", "npm run test:contracts", "npm run coordination:deployment-preflight:fixture -- --fixture <reviewed-fixture.json> --out <new-receipt.json>"], holdPoint: "review receipt digest; no live state has been inspected or changed" },
    { stage: "deploy-feature-off", target: "installation", authorizedOnly: true as const, commands: ["test \"$(git rev-parse HEAD)\" = 9ae494591e164b11450323d058b684f7a3dbadd0", "npm ci --include=dev", "npm run build", "node --input-type=module -e \"import {generateEcosystem} from './cli/lib/generate-ecosystem.js'; generateEcosystem(process.cwd())\""], holdPoint: "compare tree/build/ecosystem/migration hashes and confirm coordination remains stopped with every flag false" },
    { stage: "canary-jerry", target: "jerry", authorizedOnly: true as const, commands: ["npm run coordination:canary:fixture -- --fixture <jerry-M14-fixture.json> --out <new-jerry-receipt.json>"], holdPoint: "separate operator authority is required for any live flag, process, epoch, or Message change" },
    { stage: "canary-forrest", target: "forrest", authorizedOnly: true as const, commands: ["npm run coordination:canary:fixture -- --fixture <forrest-M15-fixture.json> --out <new-forrest-receipt.json>"], holdPoint: "require accepted Jerry live receipt and separate Forrest authority before any live action" },
    { stage: "rollback", target: "installation", authorizedOnly: true as const, commands: ["restore <snapshotSha256> under an approved database restore procedure", "restore <ecosystemSha256> and source 9ae494591e164b11450323d058b684f7a3dbadd0", "verify exactly one legacy writer before reopening admission"], holdPoint: "rollback execution requires explicit operator authority and a stopped/drained writer" },
  ] as const;
  const unsigned = {
    receiptVersion: 1 as const, evidenceMode: "fixture" as const, liveDeploymentAttempted: false as const,
    liveMutationAuthorized: false as const, verdict: "fixture_ready_for_operator_review" as const,
    candidateSha: input.candidateSha, checks,
    immutableEvidence: { trackedTreeSha256: input.source.trackedTreeSha256, buildSha256: input.source.buildSha256, ecosystemSha256: input.generatedConfig.ecosystemSha256, migrationPlanSha256: input.migrations.planSha256, targetSchemaSha256: input.migrations.targetSchemaSha256 },
    stages, rollback: input.rollback,
    limitations: ["fixture evidence is not live deployment evidence", "commands are a reviewed plan and are never executed by this preflight", "live database, configuration, processes, epochs, and Messages require separate explicit authority"] as const,
  };
  return Object.freeze({ ...unsigned, receiptDigest: digest(unsigned) });
}
