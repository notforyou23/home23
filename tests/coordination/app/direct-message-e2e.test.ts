import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ResidentCoordinationAdapter, createM11ResidentCoordinationPort } from "../../../src/coordination-adapter/index.js";
import { createCoordinationApplication, createDirectMessageSubmissionService, disabledCoordinationFeatureFlags, SqliteDirectMessageContext } from "../../../src/coordination/app/index.js";
import { createCoordinationHttpServer } from "../../../src/coordination/http/index.js";
import { SqliteBotConversationBindingAdapter, SqliteMessagingRepository } from "../../../src/coordination/channels/index.js";
import { SqliteEventRepository } from "../../../src/coordination/events/index.js";
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
  let resolveAgent!: (response: { text: string; model: string; toolCallCount: number; durationMs: number }) => void;
  const agentResponse = new Promise<{ text: string; model: string; toolCallCount: number; durationMs: number }>((resolve) => {
    resolveAgent = resolve;
  });
  let residentAttachments = 0;
  const agent: ResidentAgentPort = {
    async runWithTurn(chatId, _text, options) {
      residentAttachments += 1;
      const turnId = "turn-direct-e2e";
      await options.onDurableStart({ turnId, chatId, persistedAt: AT });
      options.onEvent({ type: "status", status: "working" });
      return { turnId, response: agentResponse };
    },
    stop: () => ({ stopped: true }),
  };
  const resident = new ResidentCoordinationAdapter(agent, createM11ResidentCoordinationPort(leases), () => new Date(AT));
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
    messages, context: new SqliteDirectMessageContext(database, messages), work, leases, resident,
    authority,
    holderInstanceId: "resident-1", beginWork, residentContext,
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
      messageSubmission: { submitMessage: async (input) => (submitted = await service.submitMessage(input)) },
      work, leases, events: new SqliteEventRepository(database),
      authorityEpochs: {
        current: () => canonicalMessagesAuthority,
        listCurrent: async () => ({ epochs: [canonicalMessagesAuthority], throughEventSequence: 41 }),
      },
    },
  });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const address = await server.start();
  const accepted = await fetch(`${address.origin}/api/v1/channels/${CHANNEL_ID}/messages`, {
    method: "POST",
    headers: { authorization: "Bearer m14-test", "content-type": "application/json",
      "idempotency-key": "m14-direct-message-0001", "x-correlation-id": owner.correlationId },
    body: JSON.stringify({ messageId: fixtureId("message", 900), clientMessageId: "client-m14-1",
      text: "Jerry, answer canonically.", attachmentIds: [], mentions: [], replyToMessageId: null }),
  });
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json() as { correlationId: string }).correlationId, owner.correlationId);
  assert.equal(activeBackgroundWork, 1, "accepted resident execution must remain enrolled in lifecycle drain");
  for (let index = 0; index < 20 && database.readOne<{ state: string }>(
    "SELECT state FROM works WHERE id = ?", submitted.work.id,
  )?.state !== "running"; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(database.readOne<{ state: string }>(
    "SELECT state FROM works WHERE id = ?", submitted.work.id,
  )?.state, "running");

  const restartedResident = new ResidentCoordinationAdapter(
    agent, createM11ResidentCoordinationPort(leases), () => new Date(AT),
  );
  let recoveryIdentitySuffix = 905;
  const restartedService = createDirectMessageSubmissionService({
    messages, context: new SqliteDirectMessageContext(database, messages), work, leases,
    authority,
    resident: restartedResident, holderInstanceId: "resident-1", beginWork, residentContext,
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
      text: "Jerry, answer canonically.", attachmentIds: [], mentions: [], replyToMessageId: null },
  });
  assert.equal((await replay.response).id, response.id);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM works")?.count, 1);

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
