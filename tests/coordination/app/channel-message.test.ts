import assert from "node:assert/strict";
import test from "node:test";

import type { AgentResponse } from "../../../src/agent/types.js";
import { createGroupChannelMessageService } from "../../../src/coordination/app/channel-message.js";
import type {
  GroupChannelMessageContextPort,
  GroupChannelPreparedContext,
  GroupChannelResidentTarget,
} from "../../../src/coordination/app/channel-message.js";
import type { DirectMessageResidentTarget } from "../../../src/coordination/app/direct-message.js";
import type { MessagingActorContext } from "../../../src/coordination/channels/index.js";
import { COORDINATION_MESSAGES_WRITER } from "../../../src/coordination/epochs/index.js";
import { generateCoordinationId } from "../../../src/coordination/ids/index.js";
import type { MessageProjection } from "../../../src/coordination/messages/index.js";
import type { WorkRecord } from "../../../src/coordination/work/index.js";

const CHANNEL_ID = generateCoordinationId("channel");
const CONVERSATION_ID = generateCoordinationId("conversation");
const OWNER_MESSAGE_ID = generateCoordinationId("message");
const ROUND_ID = generateCoordinationId("round");
const BOT_IDS = [generateCoordinationId("bot"), generateCoordinationId("bot")];
const WORK_IDS = [generateCoordinationId("work"), generateCoordinationId("work")];

function ownerContext(): MessagingActorContext {
  return {
    principalId: "user_owner",
    requestId: generateCoordinationId("request"),
    correlationId: generateCoordinationId("correlation"),
    identity: {
      kind: "owner",
      auth: {
        principalId: "user_owner",
        deviceId: generateCoordinationId("device"),
        sessionId: generateCoordinationId("clientSession"),
        scopes: ["product:read", "message:send"],
      },
    },
  };
}

function message(input: {
  id: string;
  authorPrincipalId: string;
  authorKind: "owner" | "bot";
  authorDisplayName: string;
  kind: "text" | "result";
  text: string;
  sequence: number;
  roundId?: string | null;
  workId?: string | null;
}): MessageProjection {
  return Object.freeze({
    id: input.id,
    channelId: CHANNEL_ID,
    conversationId: CONVERSATION_ID,
    sequence: input.sequence,
    author: Object.freeze({
      principalId: input.authorPrincipalId,
      kind: input.authorKind,
      displayName: input.authorDisplayName,
    }),
    kind: input.kind,
    text: input.text,
    mentions: Object.freeze(input.kind === "text" ? [...BOT_IDS] : []),
    attachments: Object.freeze([]),
    clientMessageId: input.kind === "text" ? "channel-client-message" : null,
    replyToMessageId: input.kind === "result" ? OWNER_MESSAGE_ID : null,
    tombstonesMessageId: null,
    provenance: Object.freeze({
      roundId: input.roundId ?? null,
      workId: input.workId ?? null,
    }),
    visibility: "visible",
    createdAt: "2026-08-28T12:00:00.000Z",
  });
}

function work(index: number, state: WorkRecord["state"] = "queued"): WorkRecord {
  return Object.freeze({
    id: WORK_IDS[index]!,
    principalId: "user_owner",
    targetPrincipalId: BOT_IDS[index]!,
    channelId: CHANNEL_ID,
    originMessageId: OWNER_MESSAGE_ID,
    roundId: ROUND_ID,
    contextManifestId: generateCoordinationId("contextManifest"),
    kind: "channel.bot_turn",
    idempotencyKeyDigest: String(index + 1).repeat(64),
    requestDigest: String(index + 2).repeat(64),
    state,
    currentAttemptId: state === "queued" ? null : generateCoordinationId("attempt"),
    nextFencingToken: 2,
    automaticOfferCount: state === "queued" ? 0 : 1,
    maxAutomaticOffers: 2,
    terminalReason: state === "succeeded" ? "resident_completed" : null,
    terminalReceiptDigest: state === "succeeded" ? "f".repeat(64) : null,
    version: 1,
    createdAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:00:00.000Z",
    terminalAt: state === "succeeded" ? "2026-08-28T12:00:01.000Z" : null,
  });
}

function prepared(
  targets: readonly GroupChannelResidentTarget[],
  responseOrder: "parallel" | "sequential" = "parallel",
): GroupChannelPreparedContext {
  return Object.freeze({
    channelId: CHANNEL_ID,
    conversationId: CONVERSATION_ID,
    originMessageId: OWNER_MESSAGE_ID,
    originEventId: generateCoordinationId("event"),
    actorPrincipalId: "user_owner",
    visibleParticipantIds: Object.freeze([...BOT_IDS]),
    selectedTargets: Object.freeze([...targets]),
    responseOrder,
    standingReference: `canonical-channel-membership:${CHANNEL_ID}:version:2`,
    instruction: "Owner: @Jerry and @Forrest, respond or pass.",
    manifest: Object.freeze({
      privacy: "channel_only",
      channelId: CHANNEL_ID,
      messageIds: Object.freeze([OWNER_MESSAGE_ID]),
      artifactIds: Object.freeze([]),
      counts: Object.freeze({ messages: 1, artifacts: 0 }),
      watermarks: Object.freeze({ channelSequence: 1, eventSequence: 1 }),
      digests: Object.freeze({ context: "a".repeat(64), source: "b".repeat(64) }),
    }),
  });
}

function harness(input: {
  responses: readonly (AgentResponse | Error)[];
  initialStates?: readonly WorkRecord["state"][];
  recovery?: boolean;
  responseOrder?: "parallel" | "sequential";
  initialWorkCount?: number;
  initialResultIndexes?: readonly number[];
  messageOutcome?: "committed" | "replayed";
  admissionReplay?: "coordinating" | "waiting" | "completed" | "failed" | "cancelled";
}) {
  const targets = BOT_IDS.map((botId, index) => Object.freeze({
    targetBotId: botId,
    targetBotDisplayName: index === 0 ? "Jerry" : "Forrest",
    targetPrincipalId: botId,
    residentBinding: index === 0 ? "jerry" : "forrest",
  }));
  const works = targets.map((_, index) =>
    work(index, input.initialStates?.[index] ?? "queued")
  );
  const responseOrder = input.responseOrder ?? "parallel";
  const initialWorkCount = input.initialWorkCount ??
    (responseOrder === "parallel" || input.recovery === true ? works.length : 0);
  const current = new Map(
    works.slice(0, initialWorkCount)
      .map((record) => [record.id, record]),
  );
  const results = new Set<string>();
  const sent: Array<{ kind: string; message: MessageProjection }> = [];
  const recorded: MessageProjection[] = [];
  const dispositions: Array<Record<string, string>> = [];
  let executions = 0;
  let coordinatorStarts = 0;
  let coordinatorReconciles = 0;
  const residentInstructions: string[] = [];
  let ended = 0;
  let resolveEnded!: () => void;
  const endedPromise = new Promise<void>((resolve) => { resolveEnded = resolve; });
  const owner = message({
    id: OWNER_MESSAGE_ID,
    authorPrincipalId: "user_owner",
    authorKind: "owner",
    authorDisplayName: "Owner",
    kind: "text",
    text: "@Jerry and @Forrest, respond or pass.",
    sequence: 1,
  });
  const exactPrepared = prepared(targets, responseOrder);
  for (const index of input.initialResultIndexes ?? []) {
    const response = input.responses[index];
    if (response instanceof Error || response === undefined || !response.text.trim()) {
      throw new Error("initial Channel result fixture is invalid");
    }
    const projected = message({
      id: `msg_${WORK_IDS[index]!.slice(4)}`,
      authorPrincipalId: BOT_IDS[index]!,
      authorKind: "bot",
      authorDisplayName: targets[index]!.targetBotDisplayName,
      kind: "result",
      text: response.text,
      sequence: index + 2,
      roundId: ROUND_ID,
      workId: WORK_IDS[index],
    });
    results.add(WORK_IDS[index]!);
    sent.push({ kind: "result", message: projected });
  }
  const context: GroupChannelMessageContextPort = {
    loadOrigin: async () => ({ message: owner, attachmentIds: [], eventSequence: 1 }),
    prepare: async () => exactPrepared,
    prepareSequentialTurn: async ({ plan, targetBotId }) => {
      const committedResults = sent
        .filter((entry) => entry.kind === "result")
        .map((entry) => entry.message);
      return Object.freeze({
        ...plan,
        selectedTargets: Object.freeze([
          targets.find((target) => target.targetBotId === targetBotId)!,
        ]),
        instruction: [
          plan.instruction,
          ...committedResults.map((result) => `${result.author.displayName}: ${result.text}`),
        ].join("\n"),
        manifest: Object.freeze({
          ...plan.manifest,
          messageIds: Object.freeze([
            ...plan.manifest.messageIds,
            ...committedResults.map((result) => result.id),
          ]),
          counts: Object.freeze({
            ...plan.manifest.counts,
            messages: plan.manifest.messageIds.length + committedResults.length,
          }),
        }),
      });
    },
    recover: async (record) => {
      const committedResults = sent
        .filter((entry) => entry.kind === "result")
        .map((entry) => entry.message);
      return Object.freeze({
        ...exactPrepared,
        selectedTargets: Object.freeze([
          targets.find((target) => target.targetPrincipalId === record.targetPrincipalId)!,
        ]),
        instruction: [
          exactPrepared.instruction,
          ...committedResults.map((result) => `${result.author.displayName}: ${result.text}`),
        ].join("\n"),
      });
    },
    recoverPlan: async () => Object.freeze({
      prepared: exactPrepared,
      turnSelection: Object.freeze({ modelAlias: null, reasoningEffort: null }),
    }),
    listRecoveryRoundIds: () => input.recovery ? Object.freeze([ROUND_ID]) : Object.freeze([]),
    listRoundWorks: () => Object.freeze([...current.values()]),
    hasResult: (workId) => results.has(workId),
  };
  const residentTargets = new Map<string, DirectMessageResidentTarget>();
  for (const [index, target] of targets.entries()) {
    const finish = () => {
      const prior = current.get(works[index]!.id)!;
      current.set(prior.id, Object.freeze({
        ...prior,
        state: input.responses[index] instanceof Error ? "failed" : "succeeded",
        currentAttemptId: generateCoordinationId("attempt"),
      }));
    };
    const run = (request: { instruction?: string }) => {
      executions += 1;
      residentInstructions.push(request.instruction ?? "");
      const response = input.responses[index] instanceof Error
        ? Promise.reject(input.responses[index])
        : Promise.resolve(input.responses[index] as AgentResponse);
      const receipt = response.then(
        () => { finish(); },
        () => { finish(); },
      );
      return Promise.resolve({ turnId: `turn-${index}`, response, receipt });
    };
    residentTargets.set(target.residentBinding, {
      resident: {
        execute: run,
        continueAccepted: run,
        reattach: run,
        recoverCompleted: async () => {
          executions += 1;
          const response = input.responses[index] instanceof Error
            ? Promise.reject(input.responses[index])
            : Promise.resolve(input.responses[index] as AgentResponse);
          return { turnId: `recovered-${index}`, response };
        },
      } as never,
      holderInstanceId: `resident-${index}`,
      models: {
        modelCatalog: async () => ({
          models: Object.freeze([{ alias: "default", provider: "fixture", model: "fixture", reasoningEffort: "low" as const }]),
          defaultModel: "fixture",
          defaultProvider: "fixture",
          defaultReasoningEffort: "low" as const,
          reasoningEfforts: Object.freeze(["low" as const]),
        }),
      },
      context: ({ principalId, requestId, correlationId }) => ({
        principalId,
        requestId,
        correlationId,
        identity: {
          kind: "resident",
          resident: {
            requestId,
            correlationId,
            credential: {
              residentSlug: target.residentBinding,
              role: "resident",
              instanceId: `resident-${index}`,
              keyVersion: 1,
            },
          },
        },
      }),
    });
  }
  const service = createGroupChannelMessageService({
    messages: {
      sendMessage: async (request) => {
        if (request.kind === "text") {
          sent.push({ kind: request.kind, message: owner });
          return {
            outcome: input.messageOutcome ?? "committed",
            message: owner,
            receipt: { eventSequence: 1 },
          };
        }
        const index = works.findIndex((candidate) => candidate.id === request.provenance.workId);
        const projected = message({
          id: request.messageId,
          authorPrincipalId: request.authorPrincipalId,
          authorKind: "bot",
          authorDisplayName: targets[index]!.targetBotDisplayName,
          kind: "result",
          text: request.text,
          sequence: sent.length + 1,
          roundId: request.provenance.roundId,
          workId: request.provenance.workId,
        });
        results.add(request.provenance.workId!);
        sent.push({ kind: request.kind, message: projected });
        return { outcome: "committed", message: projected, receipt: { eventSequence: sent.length } };
      },
      listMessages: async () => ({ messages: sent.map((entry) => entry.message) }),
    },
    context,
    coordinator: {
      start: (request: { mentionedBotIds: readonly string[] }) => {
        coordinatorStarts += 1;
        const requestedWorks = request.mentionedBotIds.map((botId) => {
          const index = BOT_IDS.indexOf(botId);
          const record = works[index]!;
          const replayed = current.has(record.id);
          if (!replayed) current.set(record.id, record);
          return { work: current.get(record.id)!, replayed };
        });
        return {
        round: { id: ROUND_ID, state: "coordinating" },
        recipients: request.mentionedBotIds,
        works: requestedWorks,
        replayed: requestedWorks.every((entry) => entry.replayed),
      };
      },
      admissionReplay: () => input.admissionReplay === undefined ? null : ({
        round: { id: ROUND_ID, state: input.admissionReplay },
        recipients: BOT_IDS,
        works: [...current.values()],
        replayed: true,
      }),
      resumeAdmission: () => ({
        round: { id: ROUND_ID, state: "coordinating" },
        recipients: BOT_IDS,
        works: [...current.values()],
        replayed: true,
      }),
      reconcile: (request) => {
        coordinatorReconciles += 1;
        dispositions.push({ ...(request.dispositions ?? {}) });
        const failed = Object.values(request.dispositions ?? {}).includes("permanent_failure");
        return {
          round: { id: ROUND_ID, state: failed ? "failed" : "completed" },
          works: [...current.values()],
          outcome: failed ? "failed" : "completed",
          reasonCode: failed ? "partial_failure" : "completed",
        };
      },
    } as never,
    work: {
      create: (() => { throw new Error("coordinator owns creation"); }) as never,
      cancelQueued: (() => { throw new Error("unused"); }) as never,
      get: (workId) => current.get(workId) ?? null,
      getTurnSelection: () => ({ modelAlias: null, reasoningEffort: null }),
      listResidentRecoverable: () => [],
      listSucceededMissingResult: () => [],
    },
    leases: {
      offer: (request) => ({
        work: current.get(request.workId)!,
        attempt: {
          id: generateCoordinationId("attempt"),
          authorityReference: request.authorityReference,
        },
        lease: { id: generateCoordinationId("lease") },
        fencingToken: 1,
      }),
      current: (workId) => {
        const record = current.get(workId)!;
        const targetIndex = works.findIndex((candidate) => candidate.id === workId);
        const attemptId = record.currentAttemptId ?? generateCoordinationId("attempt");
        return {
          work: record,
          attempt: {
            id: attemptId,
            state: "succeeded",
            holderPrincipalId: record.targetPrincipalId,
            holderInstanceId: `resident-${targetIndex}`,
            authorityReference: `resident:${targets[targetIndex]!.residentBinding}`,
            fencingToken: 1,
          },
          lease: {
            id: generateCoordinationId("lease"),
            state: "released",
            holderPrincipalId: record.targetPrincipalId,
            holderInstanceId: `resident-${targetIndex}`,
            fencingToken: 1,
          },
        };
      },
    } as never,
    resolveResident: (binding) => residentTargets.get(binding),
    authority: {
      current: () => ({
        capability: "messages",
        epoch: 3,
        mode: "canonical",
        writer: COORDINATION_MESSAGES_WRITER,
        effectiveAtEventSequence: 0,
        rollbackEpoch: 1,
      }),
    },
    recordMessage: async ({ message: projected }) => { recorded.push(projected); },
    beginWork: () => () => {
      ended += 1;
      resolveEnded();
    },
    recoveryIdentity: () => ({
      requestId: generateCoordinationId("request"),
      correlationId: generateCoordinationId("correlation"),
    }),
    now: () => new Date("2026-08-28T12:00:00.000Z"),
  });
  return {
    service,
    context: ownerContext(),
    sent,
    recorded,
    dispositions,
    executions: () => executions,
    residentInstructions: () => Object.freeze([...residentInstructions]),
    workCount: () => current.size,
    coordinatorStarts: () => coordinatorStarts,
    coordinatorReconciles: () => coordinatorReconciles,
    ended: () => ended,
    endedPromise,
  };
}

function submissionBody() {
  return {
    messageId: OWNER_MESSAGE_ID,
    clientMessageId: "channel-client-message",
    text: "@Jerry and @Forrest, respond or pass.",
    attachmentIds: [],
    mentions: [...BOT_IDS],
    replyToMessageId: null,
    modelAlias: null,
    reasoningEffort: null,
  };
}

test("group Channel records an explicit pass without fabricating Bot speech", async () => {
  const testHarness = harness({
    responses: [
      { text: "Jerry answered.", model: "fixture", toolCallCount: 0, durationMs: 1 },
      { text: "   ", model: "fixture", toolCallCount: 0, durationMs: 1 },
    ],
  });
  const accepted = await testHarness.service.submitMessage({
    context: testHarness.context,
    channelId: CHANNEL_ID,
    idempotencyKey: "channel-pass-message-0001",
    body: submissionBody(),
  });
  const terminal = await accepted.response as { outcome: string };
  assert.equal(terminal.outcome, "completed");
  assert.equal(testHarness.sent.filter((entry) => entry.kind === "result").length, 1);
  assert.deepEqual(Object.values(testHarness.dispositions[0]!).sort(), ["completed", "passed"]);
  assert.equal(testHarness.executions(), 2);
  assert.equal(testHarness.ended(), 1);
});

test("sequential Channel admits each later Work from the preceding committed result", async () => {
  const testHarness = harness({
    responseOrder: "sequential",
    responses: [
      { text: "Jerry committed first.", model: "fixture", toolCallCount: 0, durationMs: 1 },
      { text: "Forrest continued.", model: "fixture", toolCallCount: 0, durationMs: 1 },
    ],
  });
  const accepted = await testHarness.service.submitMessage({
    context: testHarness.context,
    channelId: CHANNEL_ID,
    idempotencyKey: "channel-sequential-message-0001",
    body: submissionBody(),
  });
  assert.equal((accepted.works as readonly unknown[]).length, 1,
    "later sequential Work must not be pre-admitted with stale context");
  const terminal = await accepted.response as { outcome: string };
  assert.equal(terminal.outcome, "completed");
  assert.equal(testHarness.workCount(), 2);
  assert.equal(testHarness.executions(), 2);
  assert.match(testHarness.residentInstructions()[1]!, /Jerry: Jerry committed first\./);
  assert.equal(testHarness.sent.filter((entry) => entry.kind === "result").length, 2);
  assert.equal(testHarness.ended(), 1);
});

test("group Channel preserves partial resident failure and still returns the successful peer", async () => {
  const testHarness = harness({
    responses: [
      { text: "Jerry answered.", model: "fixture", toolCallCount: 0, durationMs: 1 },
      new Error("resident unavailable"),
    ],
  });
  const accepted = await testHarness.service.submitMessage({
    context: testHarness.context,
    channelId: CHANNEL_ID,
    idempotencyKey: "channel-partial-failure-0001",
    body: submissionBody(),
  });
  const terminal = await accepted.response as { outcome: string; reasonCode: string };
  assert.equal(terminal.outcome, "failed");
  assert.equal(terminal.reasonCode, "partial_failure");
  assert.equal(testHarness.sent.filter((entry) => entry.kind === "result").length, 1);
  assert.deepEqual(
    Object.values(testHarness.dispositions[0]!).sort(),
    ["completed", "permanent_failure"],
  );
  assert.equal(testHarness.ended(), 1);
});

test("startup recovery regenerates one missing result and reconciles its retained Round", async () => {
  const testHarness = harness({
    responses: [
      { text: "Recovered Jerry result.", model: "fixture", toolCallCount: 0, durationMs: 1 },
      { text: "Recovered Forrest result.", model: "fixture", toolCallCount: 0, durationMs: 1 },
    ],
    initialStates: ["succeeded", "succeeded"],
    recovery: true,
  });
  const receipt = await testHarness.service.recoverResidentWork();
  assert.deepEqual(receipt, { discovered: 1, scheduled: 1, refused: 0 });
  await testHarness.endedPromise;
  assert.equal(testHarness.executions(), 2);
  assert.equal(testHarness.sent.filter((entry) => entry.kind === "result").length, 2);
  assert.deepEqual(Object.values(testHarness.dispositions[0]!), ["completed", "completed"]);
  assert.equal(testHarness.ended(), 1);
});

test("startup recovery resumes a sequential plan after its first committed Bot result", async () => {
  const testHarness = harness({
    responseOrder: "sequential",
    recovery: true,
    initialWorkCount: 1,
    initialStates: ["succeeded", "queued"],
    initialResultIndexes: [0],
    responses: [
      { text: "Jerry survived restart.", model: "fixture", toolCallCount: 0, durationMs: 1 },
      { text: "Forrest resumed once.", model: "fixture", toolCallCount: 0, durationMs: 1 },
    ],
  });
  const receipt = await testHarness.service.recoverResidentWork();
  assert.deepEqual(receipt, { discovered: 1, scheduled: 1, refused: 0 });
  await testHarness.endedPromise;
  assert.equal(testHarness.workCount(), 2);
  assert.equal(testHarness.executions(), 1, "the committed first Bot must not execute twice");
  assert.match(testHarness.residentInstructions()[0]!, /Jerry: Jerry survived restart\./);
  assert.equal(testHarness.sent.filter((entry) => entry.kind === "result").length, 2);
  assert.deepEqual(Object.values(testHarness.dispositions[0]!), ["completed", "completed"]);
});

test("startup recovery resumes a sequential Work that was already admitted", async () => {
  const testHarness = harness({
    responseOrder: "sequential",
    recovery: true,
    initialWorkCount: 2,
    initialStates: ["succeeded", "queued"],
    initialResultIndexes: [0],
    responses: [
      { text: "Jerry committed before the second admission.", model: "fixture", toolCallCount: 0, durationMs: 1 },
      { text: "Forrest resumed the admitted Work.", model: "fixture", toolCallCount: 0, durationMs: 1 },
    ],
  });
  const receipt = await testHarness.service.recoverResidentWork();
  assert.deepEqual(receipt, { discovered: 1, scheduled: 1, refused: 0 });
  await testHarness.endedPromise;
  assert.equal(testHarness.workCount(), 2);
  assert.equal(testHarness.executions(), 1, "only the uncompleted admitted Work executes");
  assert.match(
    testHarness.residentInstructions()[0]!,
    /Jerry: Jerry committed before the second admission\./,
  );
  assert.deepEqual(Object.values(testHarness.dispositions[0]!), ["completed", "completed"]);
});

test("exact active or terminal message replay returns stored admission without policy reconstruction", async () => {
  for (const admissionReplay of ["coordinating", "waiting", "completed", "failed", "cancelled"] as const) {
    const testHarness = harness({
      messageOutcome: "replayed",
      admissionReplay,
      responses: [
        { text: "unused", model: "fixture", toolCallCount: 0, durationMs: 1 },
        { text: "unused", model: "fixture", toolCallCount: 0, durationMs: 1 },
      ],
    });
    const accepted = await testHarness.service.submitMessage({
      context: testHarness.context,
      channelId: CHANNEL_ID,
      idempotencyKey: `channel-admission-replay-${admissionReplay}-0001`,
      body: submissionBody(),
    });
    assert.equal(accepted.replayed, true);
    assert.equal((accepted.round as { state: string }).state, admissionReplay);
    assert.equal((accepted.works as readonly unknown[]).length, 2);
    assert.equal("response" in accepted, false);
    assert.equal(testHarness.coordinatorStarts(), 0);
    assert.equal(testHarness.coordinatorReconciles(), 0);
    assert.equal(testHarness.executions(), 0);
    assert.equal(testHarness.recorded.length, 0);
    assert.equal(testHarness.ended(), 0);
  }
});

test("legacy message replay without an admission starts the missing group Round once", async () => {
  const testHarness = harness({
    messageOutcome: "replayed",
    initialWorkCount: 0,
    responses: [
      { text: "Jerry recovered the legacy admission.", model: "fixture", toolCallCount: 0, durationMs: 1 },
      { text: "Forrest recovered the legacy admission.", model: "fixture", toolCallCount: 0, durationMs: 1 },
    ],
  });

  const accepted = await testHarness.service.submitMessage({
    context: testHarness.context,
    channelId: CHANNEL_ID,
    idempotencyKey: "legacy-group-message-without-admission-0001",
    body: submissionBody(),
  });
  const terminal = await accepted.response as { outcome: string };

  assert.equal(accepted.replayed, true);
  assert.equal(testHarness.recorded.filter((entry) => entry.id === OWNER_MESSAGE_ID).length, 1,
    "the previously committed owner Message must enter canonical communication evidence");
  assert.equal(testHarness.coordinatorStarts(), 1);
  assert.equal(testHarness.workCount(), 2);
  assert.equal(testHarness.executions(), 2);
  assert.equal(terminal.outcome, "completed");
  assert.equal(testHarness.ended(), 1);
});
