import assert from "node:assert/strict";
import test from "node:test";

import {
  ResidentCoordinationAdapter,
  createM11ResidentCoordinationPort,
} from "../../../src/coordination-adapter/index.js";
import {
  createCoordinationApplication,
  createDirectMessageSubmissionService,
  disabledCoordinationFeatureFlags,
  SqliteDirectMessageContext,
} from "../../../src/coordination/app/index.js";
import {
  SqliteBotConversationBindingAdapter,
  SqliteMessagingRepository,
} from "../../../src/coordination/channels/index.js";
import { SqliteCommunicationEventRepository } from "../../../src/coordination/communications/index.js";
import { workResultIdempotencyKey } from "../../../src/coordination/contracts/resident-presence.js";
import { SqliteEventRepository } from "../../../src/coordination/events/index.js";
import { createCoordinationHttpServer } from "../../../src/coordination/http/index.js";
import { createLeaseService } from "../../../src/coordination/leases/index.js";
import { createMessageService } from "../../../src/coordination/messages/index.js";
import {
  createWorkService,
  M11MessageProvenanceAuthority,
} from "../../../src/coordination/work/index.js";
import type { ResidentAgentPort } from "../../../src/coordination-adapter/index.js";
import {
  AT,
  BOT_ID,
  CHANNEL_ID,
  M11TestDatabase,
  OWNER_ID,
  createFixtureIdGenerator,
  fixtureId,
} from "../work/test-fixture.js";

const CONVERSATION_ID = "cnv_0198d95f-6c00-7000-8000-000000000961";
const canonicalMessagesAuthority = Object.freeze({
  capability: "messages" as const,
  epoch: 3,
  mode: "canonical" as const,
  writer: "home23-coordination",
  effectiveAtEventSequence: 41,
  rollbackEpoch: 1,
});

type AgentAnswer = {
  text: string;
  model: string;
  toolCallCount: number;
  durationMs: number;
};

function residentContext(suffix: number) {
  const requestId = fixtureId("request", suffix);
  const correlationId = fixtureId("correlation", suffix);
  return {
    principalId: BOT_ID,
    requestId,
    correlationId,
    identity: {
      kind: "resident" as const,
      resident: {
        requestId,
        correlationId,
        credential: {
          residentSlug: "jerry",
          role: "resident" as const,
          instanceId: "resident-1",
          keyVersion: 1,
        },
      },
    },
  };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 40 && !predicate(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), label);
}

test("submitMessage starts a second resident runWithTurn while Work 1 is still executing", async (t) => {
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  database.raw.prepare("INSERT INTO conversation_handles (id, channel_id, created_at) VALUES (?, ?, ?)")
    .run(CONVERSATION_ID, CHANNEL_ID, AT);
  database.raw.prepare("UPDATE bots SET conversation_id = ? WHERE id = ?").run(CONVERSATION_ID, BOT_ID);

  const botRecord = Object.freeze({
    id: BOT_ID, principalId: BOT_ID, name: "Jerry", purpose: "Persistent resident",
    lifecycle: "active" as const, conversationId: CONVERSATION_ID, residentBinding: "jerry",
    continuingIdentity: true, durableMailbox: true, requiredCapabilities: Object.freeze(["messages"]),
    activeInstanceId: "resident-1", activeKeyVersion: 1, residentProtocolVersion: 1,
    residentCapabilities: Object.freeze(["messages"]), residentRegisteredAt: AT,
    lastHeartbeatAt: AT, reportedAvailability: "available" as const, availability: "available" as const,
    version: 1, createdAt: AT, updatedAt: AT,
  });
  const directory = {
    listVisibleBots: async () => [botRecord],
    resolveAlias: async (_namespace: string, value: string) => value === "jerry" ? botRecord : null,
    getBotByResidentBinding: async (value: string) => value === "jerry" ? botRecord : null,
  };
  const repository = new SqliteMessagingRepository(database, {
    botConversationBinding: new SqliteBotConversationBindingAdapter(),
    messageProvenanceAuthorization: new M11MessageProvenanceAuthority(),
  });
  const messages = createMessageService({ repository, participantDirectory: directory, now: () => new Date(AT) });
  const generateId = createFixtureIdGenerator(50_000);
  const work = createWorkService({ database, generateId, now: () => new Date(AT) });
  const leases = createLeaseService({ database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000 });
  const communications = new SqliteCommunicationEventRepository(database);

  const runStarts: Array<{ chatId: string; workId: string }> = [];
  const held = new Map<string, {
    resolve: (answer: AgentAnswer) => void;
    promise: Promise<AgentAnswer>;
  }>();
  const agent: ResidentAgentPort = {
    async modelCatalog() {
      return {
        models: [{ alias: "sol", provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" }],
        defaultModel: "gpt-5.6-terra",
        defaultProvider: "openai-codex",
        defaultReasoningEffort: "medium",
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      };
    },
    async runWithTurn(chatId, _text, options) {
      const workId = options.coordinationOrigin.workId;
      let resolveHeld!: (answer: AgentAnswer) => void;
      const promise = new Promise<AgentAnswer>((resolve) => {
        resolveHeld = resolve;
      });
      held.set(workId, { resolve: resolveHeld, promise });
      runStarts.push({ chatId, workId });
      const turnId = `coord-${workId}`;
      await options.onDurableStart({
        turnId, chatId, persistedAt: AT,
        selection: {
          requestedProvider: null,
          requestedModelAlias: options.turnSelection.modelAlias,
          requestedModel: null,
          requestedEffort: options.turnSelection.reasoningEffort,
          resolvedProvider: "openai-codex",
          resolvedModel: "gpt-5.6-terra",
          resolvedEffort: options.turnSelection.reasoningEffort ?? "medium",
          actualProvider: "openai-codex",
          actualModel: "gpt-5.6-terra",
          actualEffort: options.turnSelection.reasoningEffort ?? "medium",
        },
      });
      options.onEvent({
        turnId,
        sequence: 1,
        occurredAt: AT,
        provider: "fixture",
        model: "test-executor",
        reasoningEffort: options.turnSelection.reasoningEffort ?? "medium",
        event: { type: "status", status: "working", sourceEventType: "runtime.status" },
      });
      return { turnId, response: promise };
    },
    stop: () => ({ stopped: true }),
  };
  t.after(() => {
    for (const hold of held.values()) {
      hold.resolve({ text: "released by cleanup", model: "test-executor", toolCallCount: 0, durationMs: 1 });
    }
  });

  const resident = new ResidentCoordinationAdapter(
    agent,
    createM11ResidentCoordinationPort(leases),
    () => new Date(AT),
    communications,
  );
  const owner = {
    principalId: OWNER_ID, requestId: fixtureId("request", 960), correlationId: fixtureId("correlation", 960),
    identity: { kind: "owner" as const, auth: {
      principalId: OWNER_ID as "user_owner", deviceId: "dev_0198d95f-6c00-7000-8000-000000000960",
      sessionId: "ses_0198d95f-6c00-7000-8000-000000000960", scopes: ["product:read", "message:send"] as const,
    } },
  };
  const residentBindingContext = ({ principalId, requestId, correlationId }: {
    residentBinding: string; principalId: string; requestId: string; correlationId: string;
  }) => ({
    principalId, requestId, correlationId,
    identity: { kind: "resident", resident: { requestId, correlationId, credential: {
      residentSlug: "jerry", role: "resident", instanceId: "resident-1", keyVersion: 1,
    } } },
  } as const);
  let activeBackgroundWork = 0;
  const beginWork = () => {
    activeBackgroundWork += 1;
    return () => { activeBackgroundWork -= 1; };
  };
  const service = createDirectMessageSubmissionService({
    messages, context: new SqliteDirectMessageContext(database, messages), work, leases,
    communications,
    resolveResident: (residentBinding) => residentBinding === "jerry" ? {
      resident,
      holderInstanceId: "resident-1",
      models: agent,
      context: ({ principalId, requestId, correlationId }) => residentBindingContext({
        residentBinding,
        principalId,
        requestId,
        correlationId,
      }),
    } : undefined,
    authority: { current: () => canonicalMessagesAuthority },
    beginWork,
    recoveryIdentity: () => ({
      requestId: fixtureId("request", 964), correlationId: fixtureId("correlation", 964),
    }),
  });

  const application = createCoordinationApplication({
    flags: { ...disabledCoordinationFeatureFlags(), "coordination.process.enabled": true,
      "coordination.public_api.enabled": true, "coordination.resident.jerry.enabled": true },
    services: {
      auth: { validateAccessToken: async () => owner.identity.auth },
      messageSubmission: {
        submitMessage: async (input) => service.submitMessage(input),
        selectionOptions: async (input) => service.selectionOptions(input),
      },
      work, leases, events: new SqliteEventRepository(database),
      communications,
      authorityEpochs: {
        current: () => canonicalMessagesAuthority,
        listCurrent: async () => ({ epochs: [canonicalMessagesAuthority], throughEventSequence: 41 }),
      },
    },
  });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();

  const postMessage = async (input: {
    suffix: number;
    idempotencyKey: string;
    clientMessageId: string;
    text: string;
  }) => {
    const accepted = await fetch(`${address.origin}/api/v1/channels/${CHANNEL_ID}/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer resident-presence-second-turn",
        "content-type": "application/json",
        "idempotency-key": input.idempotencyKey,
        "x-correlation-id": fixtureId("correlation", input.suffix),
      },
      body: JSON.stringify({
        messageId: fixtureId("message", input.suffix),
        clientMessageId: input.clientMessageId,
        text: input.text,
        attachmentIds: [],
        mentions: [],
        replyToMessageId: null,
      }),
    });
    const body = await accepted.json() as {
      message: { id: string; provenance: { workId: string | null } };
      work: { id: string; state: string };
      replayed: boolean;
    };
    return { status: accepted.status, body };
  };

  const first = await postMessage({
    suffix: 960,
    idempotencyKey: "resident-presence-second-turn-m1",
    clientMessageId: "client-rp-second-turn-m1",
    text: "Start the long assignment.",
  });
  assert.equal(first.status, 202);
  assert.equal(first.body.replayed, false);
  const w1 = first.body.work.id;
  assert.match(w1, /^wrk_/);
  await waitUntil(
    () => runStarts.some((start) => start.workId === w1) &&
      database.readOne<{ state: string }>("SELECT state FROM works WHERE id = ?", w1)?.state === "running",
    "W1 runWithTurn must start and mark Work running",
  );
  assert.equal(held.has(w1), true);
  let w1Settled = false;
  void held.get(w1)!.promise.finally(() => { w1Settled = true; });
  assert.equal(w1Settled, false);

  const second = await postMessage({
    suffix: 961,
    idempotencyKey: "resident-presence-second-turn-m2",
    clientMessageId: "client-rp-second-turn-m2",
    text: "Ask something else while that assignment is still running.",
  });
  assert.equal(second.status, 202, "M2 must be accepted while W1 is still executing");
  assert.equal(second.body.replayed, false);
  const w2 = second.body.work.id;
  assert.match(w2, /^wrk_/);
  assert.notEqual(w2, w1);
  assert.equal(
    database.readOne<{ state: string }>("SELECT state FROM works WHERE id = ?", w1)?.state,
    "running",
  );

  await waitUntil(
    () => runStarts.some((start) => start.workId === w2),
    "W2 runWithTurn must be invoked while W1 is still held",
  );
  assert.equal(w1Settled, false, "W2 must start before W1's agent promise resolves");
  assert.equal(
    database.readOne<{ state: string }>("SELECT state FROM works WHERE id = ?", w2)?.state,
    "running",
  );

  const w1Start = runStarts.find((start) => start.workId === w1);
  const w2Start = runStarts.find((start) => start.workId === w2);
  assert.ok(w1Start);
  assert.ok(w2Start);
  assert.equal(w1Start.chatId, `coordination:${CHANNEL_ID}:${w1}`);
  assert.equal(w2Start.chatId, `coordination:${CHANNEL_ID}:${w2}`);
  for (const start of [w1Start, w2Start]) {
    assert.equal(start.chatId.startsWith("ios_"), false);
    assert.equal(start.chatId.startsWith("mac_"), false);
    assert.equal(/^\d+$/.test(start.chatId), false);
  }

  const resultCount = (workId: string) => database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages WHERE kind = 'result' AND work_id = ?",
    workId,
  )?.count ?? 0;

  held.get(w2)!.resolve({
    text: "Foreground answer while the assignment continues.",
    model: "test-executor",
    toolCallCount: 0,
    durationMs: 1,
  });
  await waitUntil(() => resultCount(w2) === 1, "W2 must post one result Message");
  assert.equal(workResultIdempotencyKey(w2), `work-result:${w2}`);
  assert.equal(resultCount(w1), 0);
  assert.equal(
    database.readOne<{ state: string }>("SELECT state FROM works WHERE id = ?", w1)?.state,
    "running",
  );

  held.get(w1)!.resolve({
    text: "The assignment finished once.",
    model: "test-executor",
    toolCallCount: 0,
    durationMs: 1,
  });
  await waitUntil(() => resultCount(w1) === 1, "W1 must post one result Message");
  await waitUntil(() => w1Settled, "W1 agent promise must settle after release");

  const w1ResultId = `msg_${w1.slice(4)}`;
  const replayRequest = {
    context: residentContext(970),
    channelId: CHANNEL_ID,
    messageId: w1ResultId,
    authorPrincipalId: BOT_ID,
    idempotencyKey: workResultIdempotencyKey(w1),
    kind: "result" as const,
    text: "The assignment finished once.",
    mentions: [] as const,
    clientMessageId: null,
    replyToMessageId: first.body.message.id,
    tombstonesMessageId: null,
    provenance: { roundId: null, workId: w1 },
  };
  const replayed = await messages.sendMessage(replayRequest);
  assert.equal(replayed.outcome, "replayed");
  assert.equal(replayed.message.id, w1ResultId);
  assert.equal(resultCount(w1), 1, "replay of the W1 result must not create a second result row");
  assert.equal(resultCount(w2), 1);
});
