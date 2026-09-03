import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDirectMessageSubmissionService,
  createOnDemandBotRuntime,
  SqliteDirectMessageContext,
} from "../../../src/coordination/app/index.js";
import { getHome23Root } from "../../../src/config.js";
import {
  _resetCredentialCache,
  freshProviderKey,
} from "../../../src/agent/provider-credentials.js";
import { canonicalReturnedArtifactDirectory } from "../../../src/agent/tools/return-artifact.js";
import {
  createResidentArtifactPromotionPort,
  LocalArtifactStore,
  resolveArtifactActor,
  SqliteArtifactRepository,
} from "../../../src/coordination/artifacts/index.js";
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
const ARTIFACT_PROMPT = "Lens, return your private note as a file.";
const ARTIFACT_RELATIVE_PATH = "media/returned-artifacts/lens-note.txt";
const authority = Object.freeze({
  capability: "messages" as const,
  epoch: 3,
  mode: "canonical" as const,
  writer: "home23-coordination",
  effectiveAtEventSequence: 41,
  rollbackEpoch: 1,
});

async function startModelFixture() {
  const baseUrl = "http://home23-on-demand-model.test/v1";
  const originalFetch = globalThis.fetch;
  const requests: Array<{ messages?: Array<{ role?: string; content?: unknown }> }> = [];
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  const contentText = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((block) =>
      block && typeof block === "object" && "text" in block &&
        typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : ""
    ).join("");
  };
  globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
    const url = typeof request === "string"
      ? request
      : request instanceof URL
        ? request.href
        : request.url;
    if (url !== `${baseUrl}/chat/completions`) return originalFetch(request, init);
    assert.equal(init?.method, "POST");
    assert.equal(typeof init?.body, "string");
    const body = JSON.parse(init.body as string) as
      { messages?: Array<{ role?: string; content?: unknown }> };
    requests.push(body);
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const current = [...(body.messages ?? [])].reverse()
        .find((message) => message.role === "user");
      const prompt = contentText(current?.content);
      const returnedArtifact = (body.messages ?? []).some((message) => message.role === "tool");
      if (prompt === ARTIFACT_PROMPT && !returnedArtifact) {
        return new Response(JSON.stringify({ choices: [{ message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-return-artifact",
            type: "function",
            function: {
              name: "return_artifact",
              arguments: JSON.stringify({ path: ARTIFACT_RELATIVE_PATH }),
            },
          }],
        } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const answer = prompt === "Lens, give me the concise answer."
        ? "Lens answered from its own durable context."
        : prompt === ARTIFACT_PROMPT
          ? "Lens returned its note."
        : `Lens answer for: ${prompt}`;
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: answer } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    } finally {
      activeRequests -= 1;
    }
  }) as typeof fetch;
  return {
    baseUrl,
    requests,
    maximumActiveRequests: () => maximumActiveRequests,
    close: () => { globalThis.fetch = originalFetch; },
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
  const artifactRepository = new SqliteArtifactRepository(database);
  const artifactStore = await LocalArtifactStore.open({
    rootDirectory: join(runtimeRoot, "artifacts"),
    repository: artifactRepository,
  });
  const messagingRepository = new SqliteMessagingRepository(database, {
    botConversationBinding: new SqliteBotConversationBindingAdapter(),
    messageProvenanceAuthorization: new M11MessageProvenanceAuthority(),
    artifactMessageLink: artifactRepository,
  });
  const canonicalMessages = createMessageService({
    repository: messagingRepository,
    participantDirectory,
    resolveAttachmentActor: (context) => resolveArtifactActor(context, participantDirectory),
  });
  let failFirstResultCommit = true;
  let failArtifactResultCommit = false;
  const messages = {
    listMessages: canonicalMessages.listMessages,
    sendMessage: async (input: Parameters<typeof canonicalMessages.sendMessage>[0]) => {
      if (input.kind === "result" && failFirstResultCommit) {
        failFirstResultCommit = false;
        throw new Error("fixture result commit interruption");
      }
      if (input.kind === "result" && input.attachmentIds?.length && failArtifactResultCommit) {
        failArtifactResultCommit = false;
        throw new Error("fixture artifact result commit interruption");
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
  const configDirectory = join(runtimeRoot, "config");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(join(configDirectory, "home.yaml"), JSON.stringify({
    ports: { engine: 43210, dashboard: 3300 },
    chat: {
      provider: "ollama-local",
      model: "fixture-local-model",
      defaultProvider: "ollama-local",
      defaultModel: "fixture-local-model",
      reasoningEffort: "none",
      maxTokens: 256,
      temperature: 0,
      historyDepth: 20,
      historyBudget: 50_000,
      sessionGapMs: 30 * 60 * 1000,
      memorySearch: { enabled: false, timeoutMs: 10, topK: 1 },
      identityFiles: [],
      heartbeatRefreshMs: 0,
    },
    models: { aliases: {} },
    providers: { "ollama-local": { baseUrl: model.baseUrl } },
  }));
  writeFileSync(join(configDirectory, "secrets.yaml"), JSON.stringify({
    providers: { xai: { apiKey: "live-root-xai-fixture" } },
  }));
  const previousHome23Root = process.env.HOME23_ROOT;
  const previousSecretsPath = process.env.HOME23_SECRETS_PATH;
  process.env.HOME23_ROOT = runtimeRoot;
  delete process.env.HOME23_SECRETS_PATH;
  _resetCredentialCache();
  t.after(() => {
    if (previousHome23Root === undefined) delete process.env.HOME23_ROOT;
    else process.env.HOME23_ROOT = previousHome23Root;
    if (previousSecretsPath === undefined) delete process.env.HOME23_SECRETS_PATH;
    else process.env.HOME23_SECRETS_PATH = previousSecretsPath;
    _resetCredentialCache();
  });
  assert.equal(getHome23Root(), runtimeRoot);
  assert.equal(freshProviderKey("xai", true), "live-root-xai-fixture",
    "provider rotation reads the live installation, never the immutable release");
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
      artifactPromotion: (bot) => createResidentArtifactPromotionPort({
        database,
        store: () => artifactStore,
        participantDirectory,
        context: (binding) => ({
          principalId: binding.holderPrincipalId,
          requestId: binding.requestId,
          correlationId: binding.correlationId,
          identity: {
            kind: "on_demand_bot" as const,
            bot: { botId: bot.id, residentBinding: bot.residentBinding },
          },
        }),
      }),
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
  assert.deepEqual(selection.capabilities, ["messages"]);
  assert.equal(existsSync(join(botsRoot, BOT_ID)), false,
    "catalog lookup must not wake or instantiate the Bot");
  const send = (
    service: ReturnType<typeof makeService>,
    suffix: number,
    text: string,
  ) => service.submitMessage({
    context: owner,
    channelId: CHANNEL_ID,
    idempotencyKey: `on-demand-lens-message-${String(suffix).padStart(4, "0")}`,
    body: {
      messageId: fixtureId("message", 970 + suffix - 1),
      clientMessageId: `client-on-demand-lens-${suffix}`,
      text,
      attachmentIds: [],
      mentions: [],
      replyToMessageId: null,
      modelAlias: null,
      reasoningEffort: null,
    },
  });
  const firstPrompt = "Lens, give me the concise answer.";
  const submitted = await send(firstService, 1, firstPrompt);
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
  await assert.rejects(
    botRepository.transitionLifecycle({
      botId: BOT_ID,
      from: "active",
      to: "archived",
      actorPrincipalId: "user_owner",
      requestId: fixtureId("request", 975),
      correlationId: fixtureId("correlation", 975),
      changedAt: "2026-08-25T16:01:00.000Z",
    }),
    (error: unknown) => (error as { code?: string }).code === "bot_has_unsettled_work",
  );
  assert.equal((await botRepository.getBotById(BOT_ID))?.lifecycle, "active");

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

  const occurrences = (value: string, needle: string) => value.split(needle).length - 1;
  const firstRequest = JSON.stringify(model.requests[0]);
  assert.equal(occurrences(firstRequest, "not exposed"), 1);
  assert.equal(occurrences(firstRequest, firstPrompt), 1);

  const secondPrompt = "What did I ask you first?";
  const second = await send(restartedService, 2, secondPrompt);
  const secondResult = await second.response;
  assert.equal(secondResult.text, `Lens answer for: ${secondPrompt}`);
  assert.equal(model.requests.length, 2);
  const secondRequest = JSON.stringify(model.requests[1]);
  for (const prior of [
    "not exposed",
    firstPrompt,
    "Lens answered from its own durable context.",
    secondPrompt,
  ]) {
    assert.equal(occurrences(secondRequest, prior), 1,
      `Bot-local durable history must contain ${JSON.stringify(prior)} exactly once`);
  }

  const thirdPrompt = "Concurrent question alpha";
  const fourthPrompt = "Concurrent question beta";
  const [third, fourth] = await Promise.all([
    send(restartedService, 3, thirdPrompt),
    send(restartedService, 4, fourthPrompt),
  ]);
  const [thirdResult, fourthResult] = await Promise.all([third.response, fourth.response]);
  assert.equal(thirdResult.text, `Lens answer for: ${thirdPrompt}`);
  assert.equal(fourthResult.text, `Lens answer for: ${fourthPrompt}`);
  assert.equal(model.requests.length, 4);
  assert.equal(model.maximumActiveRequests(), 1,
    "one Bot/channel history must never execute overlapping model turns");
  assert.equal(activeWork, 0);

  const artifactBytes = Buffer.from("A private Lens note returned through canonical storage.\n", "utf8");
  const artifactOutput = canonicalReturnedArtifactDirectory(
    join(botsRoot, BOT_ID, "workspace"),
  );
  writeFileSync(join(artifactOutput, "lens-note.txt"), artifactBytes, { mode: 0o600 });
  failArtifactResultCommit = true;
  const artifactTurn = await send(restartedService, 5, ARTIFACT_PROMPT);
  await assert.rejects(artifactTurn.response, /fixture artifact result commit interruption/);
  assert.equal(database.readOne<{ state: string }>(
    "SELECT state FROM works WHERE id = ?", artifactTurn.work.id,
  )?.state, "succeeded");
  assert.equal(model.requests.length, 6, "one tool call and one final answer must complete the artifact turn");
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM artifacts WHERE owner_principal_id = ?", BOT_ID,
  )?.count, 1);

  const artifactRecoveryService = makeService();
  const artifactRecovery = await artifactRecoveryService.recoverResidentWork();
  assert.deepEqual(artifactRecovery, { discovered: 1, scheduled: 1, refused: 0 });
  for (let index = 0; index < 100 && activeWork !== 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(activeWork, 0);
  assert.equal(model.requests.length, 6, "artifact recovery must not rerun the processless Bot");
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM artifacts WHERE owner_principal_id = ?", BOT_ID,
  )?.count, 1, "artifact recovery must replay the original canonical artifact");
  const artifactPage = await canonicalMessages.listMessages({
    context: owner,
    channelId: CHANNEL_ID,
    limit: 100,
  });
  const artifactMessages = artifactPage.messages.filter(
    (message) => message.provenance.workId === artifactTurn.work.id,
  );
  assert.equal(artifactMessages.length, 1);
  assert.equal(artifactMessages[0]?.text, "Lens returned its note.");
  assert.deepEqual(artifactMessages[0]?.attachments.map((attachment) => ({
    name: attachment.name,
    contentType: attachment.contentType,
    byteCount: attachment.byteCount,
  })), [{
    name: "lens-note.txt",
    contentType: "text/plain",
    byteCount: artifactBytes.length,
  }]);
  assert.equal(JSON.stringify(artifactMessages[0]).includes(runtimeRoot), false);
  const artifactActor = await resolveArtifactActor({
    principalId: BOT_ID,
    requestId: fixtureId("request", 978),
    correlationId: fixtureId("correlation", 978),
    identity: {
      kind: "on_demand_bot",
      bot: { botId: BOT_ID, residentBinding: SPECIALIST_BINDING },
    },
  }, participantDirectory);
  const download = await artifactStore.openDownload({
    artifactId: artifactMessages[0]!.attachments[0]!.id,
    actor: artifactActor,
  });
  const downloaded: Buffer[] = [];
  for await (const chunk of download.content) downloaded.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(downloaded), artifactBytes);

  const artifactEvidence = communications.history({
    afterSequence: 0,
    limit: 1_000,
    requestId: fixtureId("request", 979),
    conversationId: CONVERSATION_ID,
  });
  assert.equal(JSON.stringify(artifactEvidence).includes(runtimeRoot), false,
    "processless artifact evidence must not expose private filesystem paths");

  const evidence = communications.history({
    afterSequence: 0,
    limit: 1_000,
    requestId: fixtureId("request", 976),
    conversationId: CONVERSATION_ID,
  });
  assert.equal(evidence.kind, "events");
  if (evidence.kind !== "events") return;
  const runtimeEvidence = evidence.events.filter((event) =>
    event.workId === submitted.work.id && event.source.adapter === "agent_loop"
  );
  assert.ok(runtimeEvidence.length > 0);
  assert.ok(runtimeEvidence.every((event) => event.actor.kind === "specialist_bot"));
  const evidenceText = JSON.stringify(runtimeEvidence);
  for (const botTerm of ["bot_runtime", "botSequence", "botStatus", "botTerminal"]) {
    assert.equal(evidenceText.includes(botTerm), true, `missing ${botTerm} evidence`);
  }
  for (const residentTerm of [
    "resident_runtime", "residentSequence", "residentStatus", "residentTerminal",
  ]) {
    assert.equal(evidenceText.includes(residentTerm), false,
      `processless Bot evidence leaked resident term ${residentTerm}`);
  }

  const archived = await botRepository.transitionLifecycle({
    botId: BOT_ID,
    from: "active",
    to: "archived",
    actorPrincipalId: "user_owner",
    requestId: fixtureId("request", 977),
    correlationId: fixtureId("correlation", 977),
    changedAt: "2026-08-25T16:02:00.000Z",
  });
  assert.equal(archived.lifecycle, "archived");

  const botRoot = join(botsRoot, BOT_ID);
  const identity = readFileSync(join(botRoot, "workspace", "IDENTITY.md"), "utf8");
  assert.match(identity, /You are Lens/);
  assert.match(identity, /Answer focused research questions/);
  assert.equal(readFileSync(join(residentPrivate, "MEMORY.md"), "utf8"), PRIVATE_RESIDENT_SENTINEL);
  const requestText = JSON.stringify(model.requests);
  assert.equal(requestText.includes(PRIVATE_RESIDENT_SENTINEL), false);
  const historyFiles = readdirSync(join(botRoot, "state", "history"));
  assert.equal(historyFiles.length, 1);
  const durableHistory = readFileSync(join(botRoot, "state", "history", historyFiles[0]!), "utf8");
  assert.match(durableHistory, /Lens answered from its own durable context/);
  const durableMessages = durableHistory.trim().split("\n")
    .map((line) => JSON.parse(line) as { role?: string; content?: unknown })
    .filter((record) => record.role === "user" || record.role === "assistant");
  const durableUserTexts = durableMessages
    .filter((record) => record.role === "user")
    .map((record) => record.content);
  for (const phrase of [
    "not exposed", firstPrompt, secondPrompt, thirdPrompt, fourthPrompt, ARTIFACT_PROMPT,
  ]) {
    assert.equal(durableUserTexts.filter((content) => content === phrase).length, 1,
      `durable Bot history duplicated ${JSON.stringify(phrase)}`);
  }
});
