import assert from "node:assert/strict";
import test from "node:test";

import {
  CanaryPreflightError,
  CORE_CANARY_CANDIDATE,
  runFirstCanaryFixture,
  type FirstCanaryFixture,
} from "../../../src/coordination/rollout/index.js";
import { FEATURE_FLAG_REGISTRY } from "../../../src/coordination/schema/contract-registry.js";

const uuid = (suffix: string) => `0198d95f-6c00-7000-8000-${suffix.padStart(12, "0")}`;
const flags = () => Object.fromEntries(Object.keys(FEATURE_FLAG_REGISTRY).map((key) => [key, false]));
const resident = (slug: "jerry" | "forrest", base: number) => ({
  slug,
  botId: `bot_${uuid(String(base))}`,
  principalId: `bot_${uuid(String(base))}`,
  channelId: `chn_${uuid(String(base + 1))}`,
  conversationId: `cnv_${uuid(String(base + 2))}`,
  mailboxBinding: slug,
  runtime: { instanceId: `${slug}-resident-1`, keyVersion: 1, protocolVersion: 1 as const, capabilities: ["messages"] as const },
});

function fixture(stage: "M14" | "M15" = "M14"): FirstCanaryFixture {
  const activeFlags = flags();
  activeFlags["coordination.process.enabled"] = true;
  activeFlags["coordination.public_api.enabled"] = true;
  activeFlags["coordination.resident.jerry.enabled"] = true;
  activeFlags["coordination.resident.forrest.enabled"] = stage === "M15";
  const residents = stage === "M14" ? [resident("jerry", 101)] : [resident("jerry", 101), resident("forrest", 201)];
  const target = residents.at(-1)!;
  const value: FirstCanaryFixture = {
    evidenceMode: "fixture", candidateSha: CORE_CANARY_CANDIDATE, stage,
    capturedAt: "2026-08-25T20:00:00.000Z",
    capabilities: { contractVersion: 1, apiBase: "/api/v1", capabilities: { messageSubmission: true, eventReplay: true } },
    activeFlags, authority: { capability: "messages", epoch: 2, mode: "shadow", writer: "legacy-conversation-writer", rollbackEpoch: null },
    residents,
    restartResume: { lastEventId: 40, recoveryCheckpoint: "work-recovery:40", idempotencyKey: `fixture-${stage.toLowerCase()}-direct-0001` },
    apiOutputs: {
      accepted: { status: 202, requestId: `req_${uuid("301")}`, correlationId: `cor_${uuid("302")}`, channelId: target.channelId, workId: `wrk_${uuid("303")}` },
      terminal: { eventType: "turn.updated", correlationId: `cor_${uuid("302")}`, workId: `wrk_${uuid("303")}`, state: "succeeded" },
      result: { eventType: "message.appended", correlationId: `cor_${uuid("302")}`, workId: `wrk_${uuid("303")}`, channelId: target.channelId, authorBotId: target.botId },
      resumedThroughEventSequence: 44,
    },
    rollback: { explicit: true, targetEpoch: 1, targetWriter: "legacy-conversation-writer", action: "restore_legacy_authority" },
  };
  if (stage === "M15") {
    value.priorStageReceipt = { stage: "M14", verdict: "fixture_ready", receiptDigest: runFirstCanaryFixture(fixture("M14")).receiptDigest };
  }
  return value;
}

test("fixture output can never be mistaken for resident or live-canary success", () => {
  const receipt = runFirstCanaryFixture(fixture());
  assert.equal(receipt.verdict, "fixture_ready");
  assert.equal(receipt.evidenceMode, "fixture");
  assert.equal(receipt.liveCanary, false);
  assert.equal(receipt.residentSuccess, false);
  assert.deepEqual(receipt.redactions, ["message bodies omitted", "access tokens omitted", "resident credentials omitted"]);
});

test("M15 requires stable distinct Jerry and Forrest identities and mailboxes", () => {
  const valid = fixture("M15");
  assert.equal(runFirstCanaryFixture(valid).verdict, "fixture_ready");
  const forged = structuredClone(valid);
  forged.residents[1]!.botId = forged.residents[0]!.botId;
  forged.residents[1]!.principalId = forged.residents[0]!.principalId;
  assert.throws(() => runFirstCanaryFixture(forged), (error: unknown) =>
    error instanceof CanaryPreflightError && error.failures.includes("resident_isolation"));
});

test("restart and resume inputs are mandatory and watermarks must advance", () => {
  for (const mutate of [
    (value: FirstCanaryFixture) => { value.restartResume.recoveryCheckpoint = ""; },
    (value: FirstCanaryFixture) => { value.restartResume.idempotencyKey = ""; },
    (value: FirstCanaryFixture) => { value.apiOutputs.resumedThroughEventSequence = value.restartResume.lastEventId; },
  ]) {
    const input = structuredClone(fixture());
    mutate(input);
    assert.throws(() => runFirstCanaryFixture(input), CanaryPreflightError);
  }
});

test("rollback is explicit and names a prior legacy authority", () => {
  const input = fixture();
  input.rollback.explicit = false as true;
  assert.throws(() => runFirstCanaryFixture(input), (error: unknown) =>
    error instanceof CanaryPreflightError && error.failures.includes("rollback"));
});

test("runtime bindings, shadow authority, correlations, and stage order fail closed", () => {
  const input = fixture("M15");
  input.residents[1]!.runtime.instanceId = "";
  input.authority.mode = "canonical" as "shadow";
  input.apiOutputs.result.correlationId = `cor_${uuid("999")}`;
  input.activeFlags["coordination.resident.jerry.enabled"] = false;
  delete input.priorStageReceipt;
  assert.throws(() => runFirstCanaryFixture(input), (error: unknown) => error instanceof CanaryPreflightError &&
    ["runtime_forrest", "authority", "correlation_chain", "sequence", "prior_stage"].every((name) => error.failures.includes(name)));
});
