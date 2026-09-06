import assert from "node:assert/strict";
import test from "node:test";

import {
  SqliteBotConversationBindingAdapter,
  SqliteMessagingRepository,
} from "../../../src/coordination/channels/index.js";
import { workResultIdempotencyKey } from "../../../src/coordination/contracts/resident-presence.js";
import {
  EventSequenceCursor,
  SqliteEventRepository,
} from "../../../src/coordination/events/index.js";
import { LeaseError, createLeaseService } from "../../../src/coordination/leases/index.js";
import { createMessageService } from "../../../src/coordination/messages/index.js";
import {
  createWorkService,
  M11MessageProvenanceAuthority,
} from "../../../src/coordination/work/index.js";
import {
  AT,
  BOT_ID,
  CHANNEL_ID,
  MESSAGE_ID,
  M11TestDatabase,
  OWNER_ID,
  createFixtureIdGenerator,
  fixtureId,
  manifestInput,
} from "../work/test-fixture.js";

const AUTHORITY_REFERENCE = `resident:${BOT_ID}:resident-1`;
const HOLDER_INSTANCE_ID = "resident-1";
const CONVERSATION_ID = "cnv_0198d95f-6c00-7000-8000-000000000050";

function ownerContext(suffix: number) {
  return {
    principalId: OWNER_ID,
    requestId: fixtureId("request", suffix),
    correlationId: fixtureId("correlation", suffix),
    identity: {
      kind: "owner" as const,
      auth: {
        principalId: OWNER_ID as "user_owner",
        deviceId: "dev_0198d95f-6c00-7000-8000-000000000900",
        sessionId: "ses_0198d95f-6c00-7000-8000-000000000900",
        scopes: ["product:read", "message:send"] as const,
      },
    },
  };
}

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
          instanceId: HOLDER_INSTANCE_ID,
          keyVersion: 1,
        },
      },
    },
  };
}

function leaseBinding(
  workId: string,
  offer: { attempt: { id: string }; lease: { id: string }; fencingToken: number },
  suffix: number,
) {
  return {
    workId,
    attemptId: offer.attempt.id,
    leaseId: offer.lease.id,
    holderPrincipalId: BOT_ID,
    holderInstanceId: HOLDER_INSTANCE_ID,
    fencingToken: offer.fencingToken,
    requestId: fixtureId("request", suffix),
    correlationId: fixtureId("correlation", suffix),
  };
}

test("isolated SQL store admits a Message while Work is active and posts one result", async (t) => {
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  database.raw.prepare("INSERT INTO conversation_handles (id, channel_id, created_at) VALUES (?, ?, ?)")
    .run(CONVERSATION_ID, CHANNEL_ID, AT);
  database.raw.prepare("UPDATE bots SET conversation_id = ? WHERE id = ?").run(CONVERSATION_ID, BOT_ID);

  const botRecord = Object.freeze({
    id: BOT_ID,
    principalId: BOT_ID,
    name: "Jerry",
    purpose: "Persistent resident",
    lifecycle: "active" as const,
    conversationId: CONVERSATION_ID,
    residentBinding: "jerry",
    continuingIdentity: true,
    durableMailbox: true,
    requiredCapabilities: Object.freeze(["messages"]),
    activeInstanceId: HOLDER_INSTANCE_ID,
    activeKeyVersion: 1,
    residentProtocolVersion: 1,
    residentCapabilities: Object.freeze(["messages"]),
    residentRegisteredAt: AT,
    lastHeartbeatAt: AT,
    reportedAvailability: "available" as const,
    availability: "available" as const,
    version: 1,
    createdAt: AT,
    updatedAt: AT,
  });
  const directory = {
    listVisibleBots: async () => [botRecord],
    resolveAlias: async (namespace: string, value: string) =>
      namespace === "resident" && value === "jerry" ? botRecord : null,
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
  const generateId = createFixtureIdGenerator(40_000);
  const work = createWorkService({ database, generateId, now: () => new Date(AT) });
  const leases = createLeaseService({
    database,
    generateId,
    now: () => new Date(AT),
    leaseTtlMs: 60_000,
  });

  const created = work.create({
    principalId: OWNER_ID,
    targetPrincipalId: BOT_ID,
    channelId: CHANNEL_ID,
    originMessageId: MESSAGE_ID,
    roundId: null,
    kind: "resident_turn",
    idempotencyKey: "resident-presence-origin-work-0001",
    manifest: manifestInput(),
    maxAutomaticOffers: 2,
    requestId: fixtureId("request", 40_100),
    correlationId: fixtureId("correlation", 40_100),
  });
  const offer = leases.offer({
    workId: created.work.id,
    holderPrincipalId: BOT_ID,
    holderInstanceId: HOLDER_INSTANCE_ID,
    authorityReference: AUTHORITY_REFERENCE,
    automatic: false,
    requestId: fixtureId("request", 40_101),
    correlationId: fixtureId("correlation", 40_101),
  });
  leases.accept(leaseBinding(created.work.id, offer, 40_102));
  leases.start(leaseBinding(created.work.id, offer, 40_103));
  assert.equal(work.get(created.work.id)?.state, "running");

  const admitted = await messages.sendMessage({
    context: ownerContext(40_110),
    channelId: CHANNEL_ID,
    messageId: fixtureId("message", 40_110),
    authorPrincipalId: OWNER_ID,
    idempotencyKey: "resident-presence-admit-while-work",
    kind: "text",
    text: "Ask something unrelated while that assignment is still running.",
    mentions: [],
    clientMessageId: "client-rp-admitted",
    replyToMessageId: null,
    tombstonesMessageId: null,
    provenance: { roundId: null, workId: null },
  });
  assert.equal(admitted.outcome, "committed");
  assert.equal(admitted.message.provenance.workId, null);
  assert.equal(work.get(created.work.id)?.state, "running");
  assert.equal(created.work.originMessageId, MESSAGE_ID);
  assert.equal(created.work.targetPrincipalId, BOT_ID);

  const foreground = work.create({
    principalId: OWNER_ID,
    targetPrincipalId: BOT_ID,
    channelId: CHANNEL_ID,
    originMessageId: admitted.message.id,
    roundId: null,
    kind: "resident_turn",
    idempotencyKey: "resident-presence-foreground-work-0001",
    manifest: manifestInput({
      messageIds: [MESSAGE_ID, admitted.message.id],
      counts: { messages: 2, artifacts: 0 },
      watermarks: { channelSequence: 2, eventSequence: admitted.receipt.eventSequence },
      digests: { context: "c".repeat(64), source: "d".repeat(64) },
    }),
    maxAutomaticOffers: 1,
    requestId: fixtureId("request", 40_111),
    correlationId: fixtureId("correlation", 40_111),
  });
  assert.equal(foreground.work.originMessageId, admitted.message.id);
  assert.notEqual(foreground.work.id, created.work.id);
  assert.equal(work.get(created.work.id)?.state, "running");

  const stale = leaseBinding(created.work.id, offer, 40_120);
  assert.throws(
    () => leases.terminalize({
      ...stale,
      fencingToken: offer.fencingToken - 1,
      receipt: {
        status: "succeeded",
        sourceReference: AUTHORITY_REFERENCE,
        resultDigest: "c".repeat(64),
        artifactIds: [],
        timestamp: AT,
      },
    }),
    (error: unknown) => error instanceof LeaseError && error.code === "stale_fence",
  );
  assert.equal(work.get(created.work.id)?.state, "running");

  leases.terminalize({
    ...leaseBinding(created.work.id, offer, 40_121),
    receipt: {
      status: "succeeded",
      sourceReference: AUTHORITY_REFERENCE,
      resultDigest: "c".repeat(64),
      artifactIds: [],
      timestamp: AT,
    },
  });
  assert.equal(work.get(created.work.id)?.state, "succeeded");

  const resultKey = workResultIdempotencyKey(created.work.id);
  const resultRequest = {
    context: residentContext(40_130),
    channelId: CHANNEL_ID,
    messageId: fixtureId("message", 40_130),
    authorPrincipalId: BOT_ID,
    idempotencyKey: resultKey,
    kind: "result" as const,
    text: "The assignment finished once.",
    mentions: [] as const,
    clientMessageId: null,
    replyToMessageId: MESSAGE_ID,
    tombstonesMessageId: null,
    provenance: { roundId: null, workId: created.work.id },
  };
  const posted = await messages.sendMessage(resultRequest);
  const replayed = await messages.sendMessage({
    ...resultRequest,
    context: residentContext(40_131),
  });
  assert.equal(posted.outcome, "committed");
  assert.equal(posted.message.kind, "result");
  assert.equal(replayed.outcome, "replayed");
  assert.equal(replayed.message.id, posted.message.id);
  assert.equal(
    database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM messages WHERE work_id = ? AND kind = 'result'",
      created.work.id,
    )?.count,
    1,
  );

  const events = new SqliteEventRepository(database);
  const afterAdmission = events.resumeAfter(admitted.receipt.eventSequence, 20, fixtureId("request", 40_140));
  assert.equal(afterAdmission.kind, "events");
  if (afterAdmission.kind !== "events") return;
  assert.ok(afterAdmission.events.every((event) => event.sequence > admitted.receipt.eventSequence));
  assert.ok(afterAdmission.events.some((event) => event.aggregate.id === posted.message.id));

  const cursor = new EventSequenceCursor(admitted.receipt.eventSequence);
  const firstAfter = afterAdmission.events[0];
  assert.ok(firstAfter);
  assert.equal(cursor.accept(firstAfter).action, "apply");
  assert.equal(cursor.accept(firstAfter).action, "duplicate");

  const conversationIds = database.readAll<{ id: string; kind: string }>(
    "SELECT id, kind FROM messages WHERE channel_id = ? ORDER BY channel_sequence",
    CHANNEL_ID,
  );
  assert.ok(conversationIds.some((row) => row.id === admitted.message.id && row.kind === "text"));
  assert.ok(conversationIds.some((row) => row.id === posted.message.id && row.kind === "result"));
  assert.equal(
    database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM work_observations WHERE work_id = ?",
      created.work.id,
    )?.count !== undefined,
    true,
  );
  assert.ok(
    database.readOne<{ count: number }>("SELECT count(*) AS count FROM events")!.count >=
      conversationIds.length,
  );
});
