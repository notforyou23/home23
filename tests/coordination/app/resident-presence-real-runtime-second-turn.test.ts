/**
 * First-convergence runtime proof: Canary-style HTTP → coordination DB →
 * real resident UDS → real AgentLoop → held W1 → second Jerry turn →
 * exactly one result each.
 *
 * The model is a deterministic stub. AgentLoop and the UDS transport are not.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/loop.js";
import { ConversationHistory } from "../../../src/agent/history.js";
import {
  ResidentCoordinationAdapter,
  ResidentTurnUdsServer,
  ResidentUdsAgentPort,
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
import { createResidentCredential } from "../../../src/coordination/resident-protocol/index.js";
import { ResidentUdsClient } from "../../../src/coordination/transport/uds/index.js";
import {
  createWorkService,
  M11MessageProvenanceAuthority,
} from "../../../src/coordination/work/index.js";
import {
  AT,
  BOT_ID,
  CHANNEL_ID,
  M11TestDatabase,
  OWNER_ID,
  createFixtureIdGenerator,
  fixtureId,
} from "../work/test-fixture.js";

const CONVERSATION_ID = "cnv_0198d95f-6c00-7000-8000-000000000971";
const INSTANCE_ID = "resident-1";
const canonicalMessagesAuthority = Object.freeze({
  capability: "messages" as const,
  epoch: 3,
  mode: "canonical" as const,
  writer: "home23-coordination",
  effectiveAtEventSequence: 41,
  rollbackEpoch: 1,
});

async function waitUntil(predicate: () => boolean, label: string, tries = 3_600): Promise<void> {
  for (let index = 0; index < tries && !predicate(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(predicate(), label);
}

async function startHoldingModel() {
  type Held = {
    userText: string;
    resolve: (text: string) => void;
    reject: (error: Error) => void;
    promise: Promise<string>;
  };
  const held: Held[] = [];
  const seen: string[] = [];
  let closed = false;
  const server: Server = createServer(async (request, response) => {
    if (closed) {
      response.writeHead(503).end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    const userText = String(body.messages?.findLast((message) => message.role === "user")?.content ?? "");
    seen.push(userText);
    let resolveHeld!: (text: string) => void;
    let rejectHeld!: (error: Error) => void;
    const promise = new Promise<string>((resolve, reject) => {
      resolveHeld = resolve;
      rejectHeld = reject;
    });
    held.push({ userText, resolve: resolveHeld, reject: rejectHeld, promise });
    try {
      const text = await promise;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: text } }],
      }));
    } catch {
      if (!response.headersSent) response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    seen: () => [...seen],
    held: () => held,
    release(index: number, text: string) {
      const row = held[index];
      assert.ok(row, `held model call ${index} is missing`);
      row.resolve(text);
    },
    abort() {
      closed = true;
      for (const row of held) row.reject(new Error("holding model closed"));
      server.closeAllConnections?.();
    },
    close: () => new Promise<void>((resolve, reject) => {
      closed = true;
      for (const row of held) row.reject(new Error("holding model closed"));
      server.closeAllConnections?.();
      server.close((error) => error ? reject(error) : resolve());
    }),
  });
}

function actualAgent(root: string) {
  const history = new ConversationHistory(join(root, "conversations-jerry"), 400_000, "jerry");
  const workspacePath = join(root, "workspace-jerry");
  mkdirSync(workspacePath, { recursive: true });
  const agent = new AgentLoop({
    apiKey: "test",
    model: "fixture-local-model",
    provider: "ollama-local",
    registry: {
      getAnthropicTools: () => [],
      getOpenAITools: () => [],
      get: () => undefined,
      execute: async () => ({ content: "" }),
    } as never,
    contextManager: {
      getSystemPrompt: () => "fixture",
      getPromptSourceInfo: () => ({ loadedFiles: [] }),
    } as never,
    history,
    toolContext: {
      brainOperations: {
        searchContext: async () => ({
          results: [],
          sourceEvidence: { sourceHealth: "healthy", matchOutcome: "no_match" },
        }),
      },
    } as never,
    workspacePath,
  });
  return { agent, history };
}

test("HTTP submitMessage runs a second real AgentLoop turn through UDS while W1 is held", { timeout: 120_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-rp-real-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const model = await startHoldingModel();
  t.after(() => model.close());
  const prior = process.env.LOCAL_LLM_BASE_URL;
  process.env.LOCAL_LLM_BASE_URL = model.baseUrl;
  t.after(() => {
    if (prior === undefined) delete process.env.LOCAL_LLM_BASE_URL;
    else process.env.LOCAL_LLM_BASE_URL = prior;
  });

  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  database.raw.prepare("INSERT INTO conversation_handles (id, channel_id, created_at) VALUES (?, ?, ?)")
    .run(CONVERSATION_ID, CHANNEL_ID, AT);
  database.raw.prepare("UPDATE bots SET conversation_id = ? WHERE id = ?").run(CONVERSATION_ID, BOT_ID);

  const botRecord = Object.freeze({
    id: BOT_ID, principalId: BOT_ID, name: "Jerry", purpose: "Persistent resident",
    lifecycle: "active" as const, conversationId: CONVERSATION_ID, residentBinding: "jerry",
    continuingIdentity: true, durableMailbox: true, requiredCapabilities: Object.freeze(["messages"]),
    activeInstanceId: INSTANCE_ID, activeKeyVersion: 1, residentProtocolVersion: 1,
    residentCapabilities: Object.freeze(["messages"]), residentRegisteredAt: AT,
    lastHeartbeatAt: AT, reportedAvailability: "available" as const, availability: "available" as const,
    version: 1, createdAt: AT, updatedAt: AT,
  });
  const directory = {
    listVisibleBots: async () => [botRecord],
    resolveAlias: async (_namespace: string, value: string) => value === "jerry" ? botRecord : null,
    getBotByResidentBinding: async (value: string) => value === "jerry" ? botRecord : null,
  };
  const messages = createMessageService({
    repository: new SqliteMessagingRepository(database, {
      botConversationBinding: new SqliteBotConversationBindingAdapter(),
      messageProvenanceAuthorization: new M11MessageProvenanceAuthority(),
    }),
    participantDirectory: directory,
    now: () => new Date(AT),
  });
  const generateId = createFixtureIdGenerator(51_000);
  const work = createWorkService({ database, generateId, now: () => new Date(AT) });
  const leases = createLeaseService({ database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000 });
  const communications = new SqliteCommunicationEventRepository(database);

  const { agent, history } = actualAgent(root);
  t.after(() => model.abort());
  const credential = createResidentCredential({
    rootKey: Buffer.alloc(32, 0x58),
    residentSlug: "jerry",
    role: "resident",
    instanceId: INSTANCE_ID,
    keyVersion: 1,
  });
  const socketPath = join(root, "resident.sock");
  const udsServer = new ResidentTurnUdsServer({
    socketPath,
    serverInstanceId: INSTANCE_ID,
    credential,
    residentSlug: "jerry",
    agent,
    history,
  });
  await udsServer.start();
  t.after(() => udsServer.close());
  const udsClient = new ResidentUdsClient({
    socketPath,
    serverInstanceId: INSTANCE_ID,
    credential,
  });
  t.after(() => udsClient.close());
  const udsPort = new ResidentUdsAgentPort({ client: udsClient, residentSlug: "jerry" });
  const resident = new ResidentCoordinationAdapter(
    udsPort,
    createM11ResidentCoordinationPort(leases),
    () => new Date(AT),
    communications,
  );

  const owner = {
    principalId: OWNER_ID, requestId: fixtureId("request", 971), correlationId: fixtureId("correlation", 971),
    identity: { kind: "owner" as const, auth: {
      principalId: OWNER_ID as "user_owner", deviceId: "dev_0198d95f-6c00-7000-8000-000000000971",
      sessionId: "ses_0198d95f-6c00-7000-8000-000000000971", scopes: ["product:read", "message:send"] as const,
    } },
  };
  let activeBackgroundWork = 0;
  const service = createDirectMessageSubmissionService({
    messages, context: new SqliteDirectMessageContext(database, messages), work, leases,
    communications,
    resolveResident: (residentBinding) => residentBinding === "jerry" ? {
      resident,
      holderInstanceId: INSTANCE_ID,
      models: udsPort,
      context: ({ principalId, requestId, correlationId }) => ({
        principalId, requestId, correlationId,
        identity: { kind: "resident" as const, resident: { requestId, correlationId, credential: {
          residentSlug: "jerry", role: "resident" as const, instanceId: INSTANCE_ID, keyVersion: 1,
        } } },
      }),
    } : undefined,
    authority: { current: () => canonicalMessagesAuthority },
    beginWork: () => {
      activeBackgroundWork += 1;
      return () => { activeBackgroundWork -= 1; };
    },
    recoveryIdentity: () => ({
      requestId: fixtureId("request", 974), correlationId: fixtureId("correlation", 974),
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
        authorization: "Bearer resident-presence-real-runtime",
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
      message: { id: string };
      work: { id: string; state: string };
      replayed: boolean;
    };
    return { status: accepted.status, body };
  };

  const first = await postMessage({
    suffix: 971,
    idempotencyKey: "resident-presence-real-runtime-m1",
    clientMessageId: "client-rp-real-runtime-m1",
    text: "Start the long assignment.",
  });
  assert.equal(first.status, 202, "M1 must be accepted");
  const w1 = first.body.work.id;
  await waitUntil(
    () => model.held().length >= 1 &&
      database.readOne<{ state: string }>("SELECT state FROM works WHERE id = ?", w1)?.state === "running",
    "W1 must reach AgentLoop and mark Work running",
  );
  assert.equal(model.held().length, 1, "W1 must be the only held model call so far");
  assert.match(model.held()[0]!.userText, /Start the long assignment/);
  assert.equal(agent.isRunning(`coordination:${CHANNEL_ID}:${w1}`), false);

  const second = await postMessage({
    suffix: 972,
    idempotencyKey: "resident-presence-real-runtime-m2",
    clientMessageId: "client-rp-real-runtime-m2",
    text: "Ask something else while that assignment is still running.",
  });
  assert.equal(second.status, 202, "M2 must be accepted while W1 is still executing");
  const w2 = second.body.work.id;
  assert.notEqual(w2, w1);
  await waitUntil(
    () => model.held().length >= 2,
    "W2 must reach the real AgentLoop / provider while W1 is still held",
  );
  assert.equal(
    database.readOne<{ state: string }>("SELECT state FROM works WHERE id = ?", w1)?.state,
    "running",
  );
  assert.match(model.held()[1]!.userText, /Ask something else/);
  assert.equal(model.held().length, 2, "exactly two real AgentLoop provider calls");
  const activeChatIds = agent.getActiveRuns();
  const w1ChatId = `coordination:${CHANNEL_ID}:${w1}`;
  const w2ChatId = `coordination:${CHANNEL_ID}:${w2}`;
  assert.equal(activeChatIds.includes(w1ChatId), true, "W1 must be an active AgentLoop run");
  assert.equal(activeChatIds.includes(w2ChatId), true, "W2 must be an active AgentLoop run while W1 is held");
  for (const chatId of [w1ChatId, w2ChatId]) {
    assert.equal(chatId.startsWith("ios_"), false);
    assert.equal(chatId.startsWith("mac_"), false);
    assert.equal(/^\d+$/.test(chatId), false);
  }
  assert.ok(history.load(w1ChatId).length > 0, "W1 must have a real AgentLoop history file");
  assert.ok(history.load(w2ChatId).length > 0, "W2 must have a real AgentLoop history file");
  assert.equal(agent.isRunning(w1ChatId), false, "coordination Work must not take the speaking lock");
  assert.equal(agent.isRunning(w2ChatId), false);

  const resultCount = (workId: string) => database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages WHERE kind = 'result' AND work_id = ?",
    workId,
  )?.count ?? 0;

  model.release(1, "Foreground answer while the assignment continues.");
  await waitUntil(() => resultCount(w2) === 1, "W2 must post one result Message");
  assert.equal(resultCount(w1), 0);
  assert.equal(
    database.readOne<{ state: string }>("SELECT state FROM works WHERE id = ?", w1)?.state,
    "running",
  );

  model.release(0, "The assignment finished once.");
  await waitUntil(() => resultCount(w1) === 1, "W1 must post one result Message");
  assert.equal(workResultIdempotencyKey(w1), `work-result:${w1}`);
  const replayed = await messages.sendMessage({
    context: {
      principalId: BOT_ID,
      requestId: fixtureId("request", 975),
      correlationId: fixtureId("correlation", 975),
      identity: {
        kind: "resident",
        resident: {
          requestId: fixtureId("request", 975),
          correlationId: fixtureId("correlation", 975),
          credential: {
            residentSlug: "jerry",
            role: "resident",
            instanceId: INSTANCE_ID,
            keyVersion: 1,
          },
        },
      },
    },
    channelId: CHANNEL_ID,
    messageId: `msg_${w1.slice(4)}`,
    authorPrincipalId: BOT_ID,
    idempotencyKey: workResultIdempotencyKey(w1),
    kind: "result",
    text: "The assignment finished once.",
    mentions: [],
    clientMessageId: null,
    replyToMessageId: first.body.message.id,
    tombstonesMessageId: null,
    provenance: { roundId: null, workId: w1 },
  });
  assert.equal(replayed.outcome, "replayed");
  assert.equal(resultCount(w1), 1, "replay of the W1 result must not create a second result row");
  assert.equal(resultCount(w2), 1);
});
