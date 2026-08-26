import { createHash } from "node:crypto";

import { FEATURE_FLAG_REGISTRY } from "../schema/contract-registry.js";

export const CORE_CANARY_CANDIDATE = "9ae494591e164b11450323d058b684f7a3dbadd0";

export type CanaryStage = "M14" | "M15";

export interface FirstCanaryFixture {
  evidenceMode: "fixture";
  candidateSha: string;
  stage: CanaryStage;
  capturedAt: string;
  capabilities: {
    contractVersion: number;
    apiBase: string;
    capabilities: { messageSubmission: boolean; eventReplay: boolean };
  };
  activeFlags: Readonly<Record<string, boolean>>;
  authority: {
    capability: "messages";
    epoch: number;
    mode: "shadow";
    writer: string;
    rollbackEpoch: null;
  };
  residents: readonly ResidentFixture[];
  restartResume: {
    lastEventId: number;
    recoveryCheckpoint: string;
    idempotencyKey: string;
  };
  priorStageReceipt?: {
    stage: "M14";
    verdict: "fixture_ready";
    receiptDigest: string;
  };
  apiOutputs: {
    accepted: { status: number; requestId: string; correlationId: string; channelId: string; workId: string };
    terminal: { eventType: "turn.updated"; correlationId: string; workId: string; state: "succeeded" };
    result: { eventType: "message.appended"; correlationId: string; workId: string; channelId: string; authorBotId: string };
    resumedThroughEventSequence: number;
  };
  rollback: {
    explicit: true;
    targetEpoch: number;
    targetWriter: string;
    action: "restore_legacy_authority";
  };
}

export interface ResidentFixture {
  slug: "jerry" | "forrest";
  botId: string;
  principalId: string;
  channelId: string;
  conversationId: string;
  mailboxBinding: string;
  runtime: { instanceId: string; keyVersion: number; protocolVersion: 1; capabilities: readonly ["messages"] };
}

export interface FirstCanaryReceipt {
  receiptVersion: 1;
  evidenceMode: "fixture";
  liveCanary: false;
  residentSuccess: false;
  verdict: "fixture_ready" | "blocked";
  candidateSha: string;
  stage: CanaryStage;
  checks: readonly { name: string; passed: boolean; detail: string }[];
  correlation: { requestId: string; correlationId: string; workId: string };
  watermark: { lastEventId: number; resumedThroughEventSequence: number };
  rollback: FirstCanaryFixture["rollback"];
  redactions: readonly string[];
  receiptDigest: string;
}

const id = (prefix: string, value: unknown) => typeof value === "string" && new RegExp(`^${prefix}_[0-9a-f-]{36}$`).test(value);
const present = (value: unknown) => typeof value === "string" && value.trim().length > 0;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class CanaryPreflightError extends Error {
  constructor(readonly failures: readonly string[]) {
    super(`first-canary preflight blocked: ${failures.join("; ")}`);
  }
}

export function runFirstCanaryFixture(input: FirstCanaryFixture): FirstCanaryReceipt {
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
  const check = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });
  check("fixture_only", input.evidenceMode === "fixture", "evidence must be explicitly fixture-scoped");
  check("candidate", input.candidateSha === CORE_CANARY_CANDIDATE, "candidate SHA must match the reviewed Core candidate");
  check("supported_api", input.capabilities.contractVersion === 1 && input.capabilities.apiBase === "/api/v1" && input.capabilities.capabilities.messageSubmission === true && input.capabilities.capabilities.eventReplay === true, "supported message submission and event replay must be advertised");
  const flagKeys = Object.keys(FEATURE_FLAG_REGISTRY).sort();
  check("complete_flags", JSON.stringify(Object.keys(input.activeFlags).sort()) === JSON.stringify(flagKeys), "receipt must include the complete registered feature-flag set");
  check("base_flags", input.activeFlags["coordination.process.enabled"] === true && input.activeFlags["coordination.public_api.enabled"] === true, "coordination process and public API flags must be on in captured fixture output");
  check("stage_flag", input.activeFlags[`coordination.resident.${input.stage === "M14" ? "jerry" : "forrest"}.enabled`] === true, `${input.stage} resident flag must be on in captured fixture output`);
  check("sequence", input.stage === "M14" || input.activeFlags["coordination.resident.jerry.enabled"] === true, "M15 requires Jerry rollout to remain enabled");
  check("prior_stage", input.stage === "M14" || (input.priorStageReceipt?.stage === "M14" && input.priorStageReceipt.verdict === "fixture_ready" && /^[a-f0-9]{64}$/.test(input.priorStageReceipt.receiptDigest)), "M15 requires the retained digest of a fixture-ready M14 receipt");
  check("authority", input.authority.capability === "messages" && input.authority.mode === "shadow" && Number.isSafeInteger(input.authority.epoch) && input.authority.epoch > 0 && present(input.authority.writer), "messages authority must be an identified shadow epoch; flags do not transfer authority");
  const expected = input.stage === "M14" ? ["jerry"] : ["jerry", "forrest"];
  check("resident_set", JSON.stringify(input.residents.map((resident) => resident.slug)) === JSON.stringify(expected), "stage resident set and order must be exact");
  for (const resident of input.residents) {
    check(`binding_${resident.slug}`, id("bot", resident.botId) && resident.principalId === resident.botId && id("chn", resident.channelId) && id("cnv", resident.conversationId) && resident.mailboxBinding === resident.slug, `${resident.slug} stable IDs and mailbox must be bound exactly`);
    check(`runtime_${resident.slug}`, present(resident.runtime.instanceId) && Number.isSafeInteger(resident.runtime.keyVersion) && resident.runtime.keyVersion > 0 && resident.runtime.protocolVersion === 1 && resident.runtime.capabilities.length === 1 && resident.runtime.capabilities[0] === "messages", `${resident.slug} runtime binding and message capability are required`);
  }
  const stableFields = (["botId", "principalId", "channelId", "conversationId", "mailboxBinding"] as const);
  check("resident_isolation", stableFields.every((field) => new Set(input.residents.map((resident) => resident[field])).size === input.residents.length), "Jerry and Forrest IDs/channels/conversations/mailboxes must remain distinct");
  check("restart_resume", Number.isSafeInteger(input.restartResume.lastEventId) && input.restartResume.lastEventId >= 0 && present(input.restartResume.recoveryCheckpoint) && present(input.restartResume.idempotencyKey), "event cursor, recovery checkpoint, and idempotency key are required");
  const target = input.residents.at(-1);
  const output = input.apiOutputs;
  check("accepted", output.accepted.status === 202 && id("req", output.accepted.requestId) && id("cor", output.accepted.correlationId) && id("wrk", output.accepted.workId) && output.accepted.channelId === target?.channelId, "accepted output must identify the target channel and durable work");
  check("correlation_chain", output.terminal.correlationId === output.accepted.correlationId && output.result.correlationId === output.accepted.correlationId && output.terminal.workId === output.accepted.workId && output.result.workId === output.accepted.workId, "terminal and result outputs must retain one correlation/work chain");
  check("resident_result", output.result.channelId === target?.channelId && output.result.authorBotId === target?.botId, "canonical result must be authored by the bound target resident in its direct channel");
  check("watermark", Number.isSafeInteger(output.resumedThroughEventSequence) && output.resumedThroughEventSequence > input.restartResume.lastEventId, "event resume must cross the supplied cursor");
  check("rollback", input.rollback.explicit === true && input.rollback.action === "restore_legacy_authority" && Number.isSafeInteger(input.rollback.targetEpoch) && input.rollback.targetEpoch > 0 && input.rollback.targetEpoch < input.authority.epoch && present(input.rollback.targetWriter), "rollback must explicitly name a prior legacy epoch and writer");
  const failures = checks.filter((item) => !item.passed).map((item) => item.name);
  if (failures.length > 0) throw new CanaryPreflightError(failures);
  const unsigned = {
    receiptVersion: 1 as const, evidenceMode: "fixture" as const, liveCanary: false as const,
    residentSuccess: false as const, verdict: "fixture_ready" as const,
    candidateSha: input.candidateSha, stage: input.stage, checks,
    correlation: { requestId: output.accepted.requestId, correlationId: output.accepted.correlationId, workId: output.accepted.workId },
    watermark: { lastEventId: input.restartResume.lastEventId, resumedThroughEventSequence: output.resumedThroughEventSequence },
    rollback: input.rollback,
    redactions: ["message bodies omitted", "access tokens omitted", "resident credentials omitted"] as const,
  };
  return Object.freeze({ ...unsigned, receiptDigest: digest(unsigned) });
}
