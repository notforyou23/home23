import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ResidentCoordinationAdapter, createM11ResidentCoordinationPort } from "../../../src/coordination-adapter/index.js";
import { createCoordinationApplication, createDirectMessageSubmissionService, disabledCoordinationFeatureFlags, SqliteDirectMessageContext } from "../../../src/coordination/app/index.js";
import { createCoordinationHttpServer } from "../../../src/coordination/http/index.js";
import { SqliteBotConversationBindingAdapter, SqliteMessagingRepository } from "../../../src/coordination/channels/index.js";
import { SqliteEventRepository } from "../../../src/coordination/events/index.js";
import { SqliteCommunicationEventRepository } from "../../../src/coordination/communications/index.js";
import { createLeaseService, LeaseError } from "../../../src/coordination/leases/index.js";
import { createMessageService } from "../../../src/coordination/messages/index.js";
import { createUnreadService, SqliteUnreadRepository } from "../../../src/coordination/unread/index.js";
import { createWorkService, M11MessageProvenanceAuthority } from "../../../src/coordination/work/index.js";
import type { ResidentAgentPort } from "../../../src/coordination-adapter/index.js";
import { AT, BOT_ID, CHANNEL_ID, M11TestDatabase, OWNER_ID, createFixtureIdGenerator, fixtureId } from "../work/test-fixture.js";
import type { AuthorityEpoch } from "../../../src/coordination/epochs/index.js";

const CONVERSATION_ID = "cnv_0198d95f-6c00-7000-8000-000000000901";
const canonicalMessagesAuthority = Object.freeze({
  capability: "messages" as const,
  epoch: 3,
  mode: "canonical" as const,
  writer: "home23-coordination",
  effectiveAtEventSequence: 41,
  rollbackEpoch: 1,
});

test("authenticated direct Message follows one durable M08/M11/M13 correlation chain", async (t) => {
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
  const generateId = createFixtureIdGenerator(30_000);
  const work = createWorkService({ database, generateId, now: () => new Date(AT) });
  const leases = createLeaseService({ database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000 });
  const communications = new SqliteCommunicationEventRepository(database);
  let resolveAgent!: (response: { text: string; model: string; toolCallCount: number; durationMs: number }) => void;
  const agentResponse = new Promise<{ text: string; model: string; toolCallCount: number; durationMs: number }>((resolve) => {
    resolveAgent = resolve;
  });
  let residentAttachments = 0;
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
      residentAttachments += 1;
      const turnId = `coord-${options.coordinationOrigin.workId}`;
      const selected = options.turnSelection.modelAlias === "sol"
        ? { provider: "openai-codex", model: "gpt-5.6-sol" }
        : { provider: "openai-codex", model: "gpt-5.6-terra" };
      const actualEffort = options.turnSelection.reasoningEffort ?? "medium";
      await options.onDurableStart({
        turnId, chatId, persistedAt: AT,
        selection: {
          requestedProvider: null,
          requestedModelAlias: options.turnSelection.modelAlias,
          requestedModel: null,
          requestedEffort: options.turnSelection.reasoningEffort,
          resolvedProvider: selected.provider,
          resolvedModel: selected.model,
          resolvedEffort: actualEffort,
          actualProvider: selected.provider,
          actualModel: selected.model,
          actualEffort,
        },
      });
      options.onEvent({
        turnId,
        sequence: 1,
        occurredAt: AT,
        provider: "fixture",
        model: "test-executor",
        reasoningEffort: actualEffort,
        event: { type: "status", status: "working", sourceEventType: "runtime.status" },
      });
      return { turnId, response: agentResponse };
    },
    stop: () => ({ stopped: true }),
  };
  const resident = new ResidentCoordinationAdapter(
    agent,
    createM11ResidentCoordinationPort(leases),
    () => new Date(AT),
    communications,
  );
  const owner = {
    principalId: OWNER_ID, requestId: fixtureId("request", 900), correlationId: fixtureId("correlation", 900),
    identity: { kind: "owner" as const, auth: {
      principalId: OWNER_ID as "user_owner", deviceId: "dev_0198d95f-6c00-7000-8000-000000000900",
      sessionId: "ses_0198d95f-6c00-7000-8000-000000000900", scopes: ["product:read", "message:send"] as const,
    } },
  };
  let activeBackgroundWork = 0;
  const beginWork = () => {
    activeBackgroundWork += 1;
    return () => { activeBackgroundWork -= 1; };
  };
  const residentContext = ({ principalId, requestId, correlationId }: {
    residentBinding: string; principalId: string; requestId: string; correlationId: string;
  }) => ({
    principalId, requestId, correlationId,
    identity: { kind: "resident", resident: { requestId, correlationId, credential: {
      residentSlug: "jerry", role: "resident", instanceId: "resident-1", keyVersion: 1,
    } } },
  } as const);
  let currentMessagesAuthority: AuthorityEpoch = Object.freeze({
    ...canonicalMessagesAuthority,
    mode: "shadow" as const,
    writer: "legacy-conversation-writer",
    effectiveAtEventSequence: null,
    rollbackEpoch: null,
  });
  const authority = { current: () => currentMessagesAuthority };
  const service = createDirectMessageSubmissionService({
    messages, context: new SqliteDirectMessageContext(database, messages), work, leases,
    communications,
    resolveResident: (residentBinding) => residentBinding === "jerry" ? {
      resident,
      holderInstanceId: "resident-1",
      models: agent,
      context: ({ principalId, requestId, correlationId }) => residentContext({
        residentBinding,
        principalId,
        requestId,
        correlationId,
      }),
    } : undefined,
    authority,
    beginWork,
    recoveryIdentity: () => ({
      requestId: fixtureId("request", 904), correlationId: fixtureId("correlation", 904),
    }),
  });
  const messageCountBeforeDeniedSubmission = database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages",
  )?.count;
  await assert.rejects(service.submitMessage({
    context: owner,
    channelId: CHANNEL_ID,
    idempotencyKey: "shadow-message-must-not-append",
    body: {
      messageId: fixtureId("message", 899),
      clientMessageId: "shadow-message-899",
      text: "must remain legacy-authoritative",
      attachmentIds: [],
      mentions: [],
      replyToMessageId: null,
    },
  }), { code: "authority_unavailable" });
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages",
  )?.count, messageCountBeforeDeniedSubmission);
  currentMessagesAuthority = canonicalMessagesAuthority;
  let submitted!: Awaited<ReturnType<typeof service.submitMessage>>;
  const application = createCoordinationApplication({
    flags: { ...disabledCoordinationFeatureFlags(), "coordination.process.enabled": true,
      "coordination.public_api.enabled": true, "coordination.resident.jerry.enabled": true },
    services: {
      auth: { validateAccessToken: async () => owner.identity.auth },
      messageSubmission: {
        submitMessage: async (input) => (submitted = await service.submitMessage(input)),
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
  const optionsResponse = await fetch(
    `${address.origin}/api/v1/channels/${CHANNEL_ID}/execution-options`,
    { headers: { authorization: "Bearer m14-test", "x-correlation-id": owner.correlationId } },
  );
  assert.equal(optionsResponse.status, 200);
  assert.deepEqual(await optionsResponse.json(), {
    requestId: optionsResponse.headers.get("x-request-id"),
    correlationId: owner.correlationId,
    networkEvidence: "loopback",
    remoteAddress: "127.0.0.1",
    channelId: CHANNEL_ID,
    conversationId: CONVERSATION_ID,
    targetBotId: BOT_ID,
    models: [{ alias: "sol", provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "high" }],
    defaultModel: "gpt-5.6-terra",
    defaultProvider: "openai-codex",
    defaultReasoningEffort: "medium",
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
  });
  const countBeforeInvalidSelection = database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages",
  )!.count;
  const invalidSelection = await fetch(`${address.origin}/api/v1/channels/${CHANNEL_ID}/messages`, {
    method: "POST",
    headers: { authorization: "Bearer m14-test", "content-type": "application/json",
      "idempotency-key": "m14-invalid-model-selection-0001", "x-correlation-id": owner.correlationId },
    body: JSON.stringify({ messageId: fixtureId("message", 898), clientMessageId: "client-m14-invalid-model",
      text: "Do not append this.", attachmentIds: [], mentions: [], replyToMessageId: null,
      modelAlias: "not-in-resident-catalog", reasoningEffort: "xhigh" }),
  });
  assert.equal(invalidSelection.status, 400);
  assert.equal((await invalidSelection.json() as any).error.code, "request_invalid");
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages",
  )!.count, countBeforeInvalidSelection);
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM works",
  )!.count, 0);
  const accepted = await fetch(`${address.origin}/api/v1/channels/${CHANNEL_ID}/messages`, {
    method: "POST",
    headers: { authorization: "Bearer m14-test", "content-type": "application/json",
      "idempotency-key": "m14-direct-message-0001", "x-correlation-id": owner.correlationId },
    body: JSON.stringify({ messageId: fixtureId("message", 900), clientMessageId: "client-m14-1",
      text: "Jerry, answer canonically.", attachmentIds: [], mentions: [], replyToMessageId: null,
      modelAlias: "sol", reasoningEffort: "xhigh" }),
  });
  assert.equal(accepted.status, 202);
  const acceptedBody = await accepted.json() as {
    requestId: string; correlationId: string; channelId: string; conversationId: string;
    message: { id: string; channelId: string; conversationId: string; clientMessageId: string;
      author: { kind: string }; provenance: { workId: string | null } };
    work: { id: string; state: string };
    replayed: boolean; throughEventSequence: number; response?: unknown;
  };
  assert.deepEqual(Object.keys(acceptedBody).sort(), [
    "channelId", "conversationId", "correlationId", "message", "replayed",
    "requestId", "throughEventSequence", "work",
  ]);
  assert.equal(acceptedBody.requestId, accepted.headers.get("x-request-id"));
  assert.match(acceptedBody.requestId, /^req_/);
  assert.equal(acceptedBody.correlationId, owner.correlationId);
  assert.equal(acceptedBody.channelId, CHANNEL_ID);
  assert.equal(acceptedBody.message.channelId, CHANNEL_ID);
  assert.equal(acceptedBody.message.conversationId, acceptedBody.conversationId);
  assert.equal(acceptedBody.message.clientMessageId, "client-m14-1");
  assert.equal(acceptedBody.message.author.kind, "owner");
  assert.equal(acceptedBody.message.provenance.workId, null);
  assert.equal(acceptedBody.work.id, submitted.work.id);
  assert.match(acceptedBody.work.id, /^wrk_/);
  assert.ok(["queued", "leased", "running"].includes(acceptedBody.work.state));
  assert.equal(acceptedBody.replayed, false);
  assert.ok(Number.isSafeInteger(acceptedBody.throughEventSequence));
  assert.equal(acceptedBody.response, undefined, "the internal terminal promise must never cross HTTP");
  assert.equal(activeBackgroundWork, 1, "accepted resident execution must remain enrolled in lifecycle drain");
  assert.deepEqual(work.getTurnSelection(submitted.work.id), {
    modelAlias: "sol",
    reasoningEffort: "xhigh",
  });
  assert.deepEqual(JSON.parse(database.readOne<{ resultRef: string }>(
    `SELECT result_ref_json AS resultRef FROM idempotency_records
     WHERE operation = 'message.append' AND principal_id = ?`,
    OWNER_ID,
  )!.resultRef).turnSelection, {
    modelAlias: "sol",
    reasoningEffort: "xhigh",
  });
  for (let index = 0; index < 20 && database.readOne<{ state: string }>(
    "SELECT state FROM works WHERE id = ?", submitted.work.id,
  )?.state !== "running"; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(database.readOne<{ state: string }>(
    "SELECT state FROM works WHERE id = ?", submitted.work.id,
  )?.state, "running");

  const restartedResident = new ResidentCoordinationAdapter(
    agent, createM11ResidentCoordinationPort(leases), () => new Date(AT), communications,
  );
  let recoveryIdentitySuffix = 905;
  const restartedService = createDirectMessageSubmissionService({
    messages, context: new SqliteDirectMessageContext(database, messages), work, leases,
    communications,
    authority,
    resolveResident: (residentBinding) => residentBinding === "jerry" ? {
      resident: restartedResident,
      holderInstanceId: "resident-1",
      models: agent,
      context: ({ principalId, requestId, correlationId }) => residentContext({
        residentBinding,
        principalId,
        requestId,
        correlationId,
      }),
    } : undefined,
    beginWork,
    recoveryIdentity: () => {
      const suffix = recoveryIdentitySuffix++;
      return { requestId: fixtureId("request", suffix), correlationId: fixtureId("correlation", suffix) };
    },
  });
  const recovery = await restartedService.recoverResidentWork();
  assert.deepEqual(recovery, { discovered: 1, scheduled: 1, refused: 0 });
  assert.equal(activeBackgroundWork, 2);
  assert.equal(residentAttachments, 2, "the restarted coordinator must attach to the durable turn once");
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM attempts")?.count, 1);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM leases")?.count, 1);

  resolveAgent({ text: "Canonical Jerry response.", model: "test-executor", toolCallCount: 0, durationMs: 1 });
  const response = await submitted.response;
  for (let index = 0; index < 20 && activeBackgroundWork !== 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(activeBackgroundWork, 0);
  assert.equal(response.text, "Canonical Jerry response.");
  assert.equal(response.provenance.workId, submitted.work.id);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM works")?.count, 1);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM attempts")?.count, 1);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM leases")?.count, 1);
  assert.equal(database.readOne<{ state: string }>("SELECT state FROM works WHERE id = ?", submitted.work.id)?.state, "succeeded");

  const communicationHistory = communications.history({
    afterSequence: 0,
    limit: 100,
    requestId: fixtureId("request", 901),
    conversationId: CONVERSATION_ID,
  });
  assert.equal(communicationHistory.kind, "events");
  if (communicationHistory.kind !== "events") assert.fail("communication history required");
  const submittedEvents = communicationHistory.events.filter(
    (event) => event.messageId === acceptedBody.message.id || event.workId === submitted.work.id,
  );
  assert.deepEqual(submittedEvents.map((event) => event.kind), [
    "user_message_committed",
    "receipt",
    "status",
    "receipt",
    "assistant_message_committed",
  ]);
  assert.equal(new Set(submittedEvents.map((event) => event.eventId)).size, submittedEvents.length,
    "concurrent restart attachment must deduplicate replayed resident evidence");
  const [userCommitted, selection, status, receipt, assistantCommitted] = submittedEvents;
  assert.equal(userCommitted?.actor.kind, "owner");
  assert.equal(userCommitted?.payload.text, "Jerry, answer canonically.");
  assert.equal((userCommitted?.payload.rawMessage as { clientMessageId?: string })?.clientMessageId,
    "client-m14-1");
  assert.equal(userCommitted?.payload.requestedModelAlias, "sol");
  assert.equal(userCommitted?.payload.requestedEffort, "xhigh");
  assert.deepEqual(selection?.payload, {
    requestedProvider: null,
    requestedModelAlias: "sol",
    requestedModel: null,
    requestedEffort: "xhigh",
    resolvedProvider: "openai-codex",
    resolvedModel: "gpt-5.6-sol",
    resolvedEffort: "xhigh",
    actualProvider: "openai-codex",
    actualModel: "gpt-5.6-sol",
    actualEffort: "xhigh",
  });
  assert.equal(selection?.source.sourceEventType, "turn.selection");
  assert.equal(status?.payload.status, "working");
  assert.equal(status?.source.provider, "fixture");
  assert.equal(status?.source.model, "test-executor");
  assert.equal(status?.source.reasoningEffort, "xhigh");
  assert.equal(receipt?.parentEventId, status?.eventId);
  assert.equal(receipt?.payload.status, "succeeded");
  assert.equal(assistantCommitted?.payload.text, "Canonical Jerry response.");
  assert.equal(assistantCommitted?.payload.replyToMessageId, acceptedBody.message.id);
  const communicationCountBeforeReplay = database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM events WHERE type = 'communication.recorded'",
  )?.count;

  const events = new SqliteEventRepository(database).resumeAfter(1, 100, fixtureId("request", 902));
  assert.equal(events.kind, "events");
  if (events.kind === "events") {
    assert.ok(events.events.some((event) => event.type === "message.appended" && event.correlationId === owner.correlationId));
    assert.ok(events.events.some((event) => event.type === "turn.updated" && event.correlationId === owner.correlationId));
  }
  const unread = createUnreadService({ repository: new SqliteUnreadRepository(database), participantDirectory: directory, now: () => new Date(AT) });
  assert.equal((await unread.getUnread({ context: owner, channelId: CHANNEL_ID })).unreadCount, 1);
  const read = await unread.markRead({ context: owner, channelId: CHANNEL_ID, readThroughSequence: response.sequence, idempotencyKey: "m14-read-cursor-0001" });
  assert.equal(read.unread.unreadCount, 0);

  database.reopen();
  assert.equal(database.readOne<{ state: string }>("SELECT state FROM works WHERE id = ?", submitted.work.id)?.state, "succeeded");
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM terminal_receipts WHERE work_id = ?", submitted.work.id)?.count, 1);

  const replay = await service.submitMessage({
    context: owner, channelId: CHANNEL_ID, idempotencyKey: "m14-direct-message-0001",
    body: { messageId: fixtureId("message", 900), clientMessageId: "client-m14-1",
      text: "Jerry, answer canonically.", attachmentIds: [], mentions: [], replyToMessageId: null,
      modelAlias: "sol", reasoningEffort: "xhigh" },
  });
  assert.equal((await replay.response).id, response.id);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM works")?.count, 1);
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM events WHERE type = 'communication.recorded'",
  )?.count, communicationCountBeforeReplay,
  "canonical Message and resident replay must remain idempotent after process recovery");

  const seedRecoveryPhase = async (
    suffix: number,
    phase: "queued" | "offered" | "accepted" | "completed" | "completed_mismatch",
  ) => {
    const idempotencyKey = `m14-crash-window-${suffix}`;
    const context = new SqliteDirectMessageContext(database, messages);
    const appended = await messages.sendMessage({
      context: owner,
      channelId: CHANNEL_ID,
      messageId: fixtureId("message", suffix),
      authorPrincipalId: OWNER_ID,
      idempotencyKey,
      kind: "text",
      text: `recover phase ${suffix}`,
      mentions: [],
      clientMessageId: `client-recovery-${suffix}`,
      attachmentIds: [],
      replyToMessageId: null,
      tombstonesMessageId: null,
      provenance: { roundId: null, workId: null },
    });
    const prepared = await context.prepare({
      context: owner,
      channelId: CHANNEL_ID,
      originMessage: appended.message,
      attachmentIds: [],
    });
    const identity = {
      requestId: fixtureId("request", suffix),
      correlationId: fixtureId("correlation", suffix),
    };
    const created = work.create({
      principalId: OWNER_ID,
      targetPrincipalId: BOT_ID,
      channelId: CHANNEL_ID,
      originMessageId: appended.message.id,
      roundId: null,
      kind: "resident_turn",
      idempotencyKey,
      manifest: prepared.manifest,
      maxAutomaticOffers: 1,
      ...identity,
    });
    if (phase === "queued") return created.work.id;
    const offered = leases.offer({
      workId: created.work.id,
      holderPrincipalId: BOT_ID,
      holderInstanceId: "resident-1",
      authorityReference: "resident:jerry",
      automatic: true,
      ...identity,
    });
    const binding = {
      workId: created.work.id,
      attemptId: offered.attempt.id,
      leaseId: offered.lease.id,
      holderPrincipalId: BOT_ID,
      holderInstanceId: "resident-1",
      fencingToken: offered.fencingToken,
      ...identity,
    };
    if (phase !== "offered") {
      leases.accept(binding);
    }
    if (phase === "completed" || phase === "completed_mismatch") {
      leases.start(binding);
      leases.terminalize({
        ...binding,
        receipt: {
          status: "succeeded",
          sourceReference: "resident:jerry",
          resultDigest: createHash("sha256").update(
            phase === "completed" ? "Canonical Jerry response." : "different terminal result",
          ).digest("hex"),
          artifactIds: [],
          timestamp: AT,
        },
      });
    }
    return created.work.id;
  };
  const waitForTerminal = async (workId: string) => {
    for (let index = 0; index < 40 && work.get(workId)?.state !== "succeeded"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(work.get(workId)?.state, "succeeded");
  };

  const queuedWorkId = await seedRecoveryPhase(905, "queued");
  assert.deepEqual(await restartedService.recoverResidentWork(),
    { discovered: 1, scheduled: 1, refused: 0 });
  await waitForTerminal(queuedWorkId);
  const offeredWorkId = await seedRecoveryPhase(910, "offered");
  assert.deepEqual(await restartedService.recoverResidentWork(),
    { discovered: 1, scheduled: 1, refused: 0 });
  await waitForTerminal(offeredWorkId);
  const acceptedWorkId = await seedRecoveryPhase(920, "accepted");
  assert.deepEqual(await restartedService.recoverResidentWork(),
    { discovered: 1, scheduled: 1, refused: 0 });
  await waitForTerminal(acceptedWorkId);
  const completedWorkId = await seedRecoveryPhase(930, "completed");
  assert.deepEqual(await restartedService.recoverResidentWork(),
    { discovered: 1, scheduled: 1, refused: 0 });
  for (let index = 0; index < 40 && (database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages WHERE kind = 'result' AND work_id = ?", completedWorkId,
  )?.count ?? 0) === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages WHERE kind = 'result' AND work_id = ?", completedWorkId,
  )?.count, 1);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM works")?.count, 5);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM attempts")?.count, 5);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM leases")?.count, 5);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM terminal_receipts")?.count, 5);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM messages WHERE kind = 'result'")?.count, 5);

  const tombstonedWorkId = await seedRecoveryPhase(940, "queued");
  const tombstonedOriginId = work.get(tombstonedWorkId)?.originMessageId;
  assert.ok(tombstonedOriginId);
  await messages.sendMessage({
    context: owner,
    channelId: CHANNEL_ID,
    messageId: fixtureId("message", 941),
    authorPrincipalId: OWNER_ID,
    idempotencyKey: "m14-recovery-tombstone-940",
    kind: "system",
    text: null,
    mentions: [],
    clientMessageId: null,
    attachmentIds: [],
    replyToMessageId: null,
    tombstonesMessageId: tombstonedOriginId,
    provenance: { roundId: null, workId: null },
  });
  assert.deepEqual(await restartedService.recoverResidentWork(),
    { discovered: 1, scheduled: 0, refused: 1 });
  assert.equal(work.get(tombstonedWorkId)?.state, "queued");
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM attempts WHERE work_id = ?", tombstonedWorkId,
  )?.count, 0);

  const mismatchedCompletedWorkId = await seedRecoveryPhase(950, "completed_mismatch");
  assert.deepEqual(await restartedService.recoverResidentWork(),
    { discovered: 2, scheduled: 1, refused: 1 });
  for (let index = 0; index < 40 && activeBackgroundWork !== 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(activeBackgroundWork, 0);
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages WHERE kind = 'result' AND work_id = ?",
    mismatchedCompletedWorkId,
  )?.count, 0, "a resident result must not contradict its immutable terminal digest");

  assert.throws(() => leases.assertCurrent({
    workId: submitted.work.id,
    attemptId: database.readOne<{ id: string }>("SELECT id FROM attempts WHERE work_id = ?", submitted.work.id)!.id,
    leaseId: database.readOne<{ id: string }>("SELECT id FROM leases WHERE work_id = ?", submitted.work.id)!.id,
    holderPrincipalId: BOT_ID, holderInstanceId: "resident-1", fencingToken: 0,
    requestId: fixtureId("request", 903), correlationId: owner.correlationId,
  }), (error: unknown) => error instanceof LeaseError && error.code === "stale_fence");
});
