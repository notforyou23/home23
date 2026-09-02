import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDirectMessageSubmissionService,
  createOnDemandBotRuntime,
  SqliteDirectMessageContext,
  type OnDemandBotModelConfiguration,
} from "../../../src/coordination/app/index.js";
import { createBotDirectory, SqliteBotDirectoryRepository } from "../../../src/coordination/bots/index.js";
import {
  SqliteBotConversationBindingAdapter,
  SqliteMessagingRepository,
} from "../../../src/coordination/channels/index.js";
import { SqliteCommunicationEventRepository } from "../../../src/coordination/communications/index.js";
import { createLeaseService } from "../../../src/coordination/leases/index.js";
import { createMessageService } from "../../../src/coordination/messages/index.js";
import { createWorkService, M11MessageProvenanceAuthority } from "../../../src/coordination/work/index.js";
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
const SPECIALIST_BINDING = "bot-lens-0123456789abcdef";
const PRIVATE_RESIDENT_SENTINEL = "JERRY_PRIVATE_MEMORY_MUST_NEVER_CROSS";
const authority = Object.freeze({
  capability: "messages" as const,
  epoch: 3,
  mode: "canonical" as const,
  writer: "home23-coordination",
  effectiveAtEventSequence: 41,
  rollbackEpoch: 1,
});

async function startModelFixture() {
  const requests: Array<{ messages?: Array<{ role?: string; content?: unknown }> }> = [];
  const server: Server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Lens answered from its own durable context." } }],
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

test("a lifecycle-created Bot answers on demand from its own durable namespace and recovery does not duplicate", async (t) => {
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const runtimeRoot = mkdtempSync(join(tmpdir(), "home23-on-demand-bot-"));
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }));
  const botsRoot = join(runtimeRoot, "bots");
  const residentPrivate = join(botsRoot, "jerry", "workspace");
  mkdirSync(residentPrivate, { recursive: true });
  writeFileSync(join(residentPrivate, "MEMORY.md"), PRIVATE_RESIDENT_SENTINEL);

  database.raw.prepare(
    "INSERT INTO conversation_handles (id, channel_id, created_at) VALUES (?, ?, ?)",
  ).run(CONVERSATION_ID, CHANNEL_ID, AT);
  database.raw.prepare(
    `UPDATE bots SET name = 'Lens', purpose = 'Answer focused research questions',
       conversation_id = ?, resident_binding = ?, active_instance_id = NULL,
       active_key_version = NULL, resident_protocol_version = NULL,
       resident_capabilities_json = '[]', resident_registered_at = NULL,
       last_heartbeat_at = NULL, reported_availability = NULL, version = 2
     WHERE id = ?`,
  ).run(CONVERSATION_ID, SPECIALIST_BINDING, BOT_ID);

  const botRepository = new SqliteBotDirectoryRepository(database);
  const botDirectory = createBotDirectory({
    repository: botRepository,
    availabilityPolicy: { degradedAfterMs: 30_000, offlineAfterMs: 120_000 },
  });
  const participantDirectory = Object.freeze({
    listVisibleBots: botDirectory.listVisibleBots,
    resolveAlias: botDirectory.resolveAlias,
    getBotByResidentBinding: (binding: string) => botRepository.getBotByResidentBinding(binding),
  });
  const messagingRepository = new SqliteMessagingRepository(database, {
    botConversationBinding: new SqliteBotConversationBindingAdapter(),
    messageProvenanceAuthorization: new M11MessageProvenanceAuthority(),
  });
  const canonicalMessages = createMessageService({
    repository: messagingRepository,
    participantDirectory,
  });
  let failFirstResultCommit = true;
  const messages = {
    listMessages: canonicalMessages.listMessages,
    sendMessage: async (input: Parameters<typeof canonicalMessages.sendMessage>[0]) => {
      if (input.kind === "result" && failFirstResultCommit) {
        failFirstResultCommit = false;
        throw new Error("fixture result commit interruption");
      }
      return canonicalMessages.sendMessage(input);
    },
  };
  const generateId = createFixtureIdGenerator(70_000);
  const work = createWorkService({ database, generateId });
  const leases = createLeaseService({ database, generateId, leaseTtlMs: 60_000 });
  const communications = new SqliteCommunicationEventRepository(database);
  const model = await startModelFixture();
  t.after(model.close);
  const previousModelUrl = process.env.LOCAL_LLM_BASE_URL;
  process.env.LOCAL_LLM_BASE_URL = model.baseUrl;
  t.after(() => {
    if (previousModelUrl === undefined) delete process.env.LOCAL_LLM_BASE_URL;
    else process.env.LOCAL_LLM_BASE_URL = previousModelUrl;
  });
  const modelConfiguration: OnDemandBotModelConfiguration = Object.freeze({
    defaultModel: "fixture-local-model",
    defaultProvider: "ollama-local",
    defaultReasoningEffort: "none",
    modelAliases: Object.freeze({}),
    apiKey: "",
    maxTokens: 256,
    temperature: 0,
    historyBudget: 50_000,
    sessionGapMs: 30 * 60 * 1000,
    enginePort: 3300,
    cosmo23BaseUrl: "http://127.0.0.1:43210",
  });
  const owner = {
    principalId: OWNER_ID,
    requestId: fixtureId("request", 970),
    correlationId: fixtureId("correlation", 970),
    identity: { kind: "owner" as const, auth: {
      principalId: OWNER_ID as "user_owner",
      deviceId: "dev_0198d95f-6c00-7000-8000-000000000970",
      sessionId: "ses_0198d95f-6c00-7000-8000-000000000970",
      scopes: ["product:read", "message:send"] as const,
    } },
  };
  let activeWork = 0;
  const beginWork = () => {
    activeWork += 1;
    return () => { activeWork -= 1; };
  };
  const makeService = () => {
    const runtime = createOnDemandBotRuntime({
      botsRootDirectory: botsRoot,
      bots: { getBotById: (botId) => botRepository.getBotById(botId) },
      leases,
      communications,
      loadModelConfiguration: () => modelConfiguration,
    });
    return createDirectMessageSubmissionService({
      messages,
      context: new SqliteDirectMessageContext(database, messages),
      work,
      leases,
      communications,
      resolveResident: () => undefined,
      resolveExecutionTarget: runtime.resolve,
      authority: { current: () => authority },
      beginWork,
      recoveryIdentity: () => ({
        requestId: fixtureId("request", 974),
        correlationId: fixtureId("correlation", 974),
      }),
    });
  };

  const firstService = makeService();
  const selection = await firstService.selectionOptions({ context: owner, channelId: CHANNEL_ID });
  assert.equal(selection.defaultModel, "fixture-local-model");
  assert.equal(existsSync(join(botsRoot, BOT_ID)), false,
    "catalog lookup must not wake or instantiate the Bot");
  const submitted = await firstService.submitMessage({
    context: owner,
    channelId: CHANNEL_ID,
    idempotencyKey: "on-demand-lens-message-0001",
    body: {
      messageId: fixtureId("message", 970),
      clientMessageId: "client-on-demand-lens-1",
      text: "Lens, give me the concise answer.",
      attachmentIds: [],
      mentions: [],
      replyToMessageId: null,
      modelAlias: null,
      reasoningEffort: null,
    },
  });
  await assert.rejects(submitted.response, /fixture result commit interruption/);
  assert.equal(submitted.work.kind, "bot_turn");
  assert.equal(model.requests.length, 1);
  assert.equal(database.readOne<{ state: string }>(
    "SELECT state FROM works WHERE id = ?", submitted.work.id,
  )?.state, "succeeded");
  assert.equal(database.readOne<{ authority: string }>(
    "SELECT authority_reference AS authority FROM attempts WHERE work_id = ?",
    submitted.work.id,
  )?.authority, `bot:${BOT_ID}`);

  const restartedService = makeService();
  const recovery = await restartedService.recoverResidentWork();
  assert.deepEqual(recovery, { discovered: 1, scheduled: 1, refused: 0 });
  for (let index = 0; index < 100 && activeWork !== 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(activeWork, 0);
  assert.equal(model.requests.length, 1, "completed durable turn must be replayed, not asked twice");
  const page = await canonicalMessages.listMessages({
    context: owner,
    channelId: CHANNEL_ID,
    limit: 100,
  });
  const results = page.messages.filter((message) => message.provenance.workId === submitted.work.id);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.text, "Lens answered from its own durable context.");
  assert.equal(results[0]?.author.kind, "bot");

  const botRoot = join(botsRoot, BOT_ID);
  const identity = readFileSync(join(botRoot, "workspace", "IDENTITY.md"), "utf8");
  assert.match(identity, /You are Lens/);
  assert.match(identity, /Answer focused research questions/);
  assert.equal(readFileSync(join(residentPrivate, "MEMORY.md"), "utf8"), PRIVATE_RESIDENT_SENTINEL);
  const requestText = JSON.stringify(model.requests);
  assert.equal(requestText.includes(PRIVATE_RESIDENT_SENTINEL), false);
  const historyFiles = readdirSync(join(botRoot, "state", "history"));
  assert.equal(historyFiles.length, 1);
  assert.match(readFileSync(join(botRoot, "state", "history", historyFiles[0]!), "utf8"),
    /Lens answered from its own durable context/);
});
