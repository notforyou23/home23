import assert from "node:assert/strict";
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

const CONVERSATION_ID = "cnv_0198d95f-6c00-7000-8000-000000000901";

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
  const agent: ResidentAgentPort = {
    async runWithTurn(chatId, _text, options) {
      const turnId = "turn-direct-e2e";
      await options.onDurableStart({ turnId, chatId, persistedAt: AT });
      options.onEvent({ type: "status", status: "working" });
      return { turnId, response: Promise.resolve({ text: "Canonical Jerry response.", model: "test-executor", toolCallCount: 0, durationMs: 1 }) };
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
  const service = createDirectMessageSubmissionService({
    messages, context: new SqliteDirectMessageContext(database, messages), work, leases, resident,
    holderInstanceId: "resident-1",
    residentContext: ({ principalId, requestId, correlationId }) => ({
      principalId, requestId, correlationId,
      identity: { kind: "resident", resident: { requestId, correlationId, credential: {
        residentSlug: "jerry", role: "resident", instanceId: "resident-1", keyVersion: 1,
      } } },
    }),
  });
  let submitted!: Awaited<ReturnType<typeof service.submitMessage>>;
  const application = createCoordinationApplication({
    flags: { ...disabledCoordinationFeatureFlags(), "coordination.process.enabled": true,
      "coordination.public_api.enabled": true, "coordination.resident.jerry.enabled": true },
    services: {
      auth: { validateAccessToken: async () => owner.identity.auth },
      messageSubmission: { submitMessage: async (input) => (submitted = await service.submitMessage(input)) },
      work, leases, events: new SqliteEventRepository(database),
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
  const response = await submitted.response;
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

  assert.throws(() => leases.assertCurrent({
    workId: submitted.work.id,
    attemptId: database.readOne<{ id: string }>("SELECT id FROM attempts WHERE work_id = ?", submitted.work.id)!.id,
    leaseId: database.readOne<{ id: string }>("SELECT id FROM leases WHERE work_id = ?", submitted.work.id)!.id,
    holderPrincipalId: BOT_ID, holderInstanceId: "resident-1", fencingToken: 0,
    requestId: fixtureId("request", 903), correlationId: owner.correlationId,
  }), (error: unknown) => error instanceof LeaseError && error.code === "stale_fence");
});
