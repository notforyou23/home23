import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  LocalArtifactStore,
  SqliteArtifactRepository,
  resolveArtifactActor,
} from "../../../src/coordination/artifacts/index.js";
import {
  SqliteBotConversationBindingAdapter,
  SqliteMessagingRepository,
} from "../../../src/coordination/channels/index.js";
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
} from "./test-fixture.js";

const AUTHORITY_REFERENCE = `resident:${BOT_ID}:resident-1`;
const HOLDER_INSTANCE_ID = "resident-1";

function createQueuedWork(database: M11TestDatabase, generateId: ReturnType<typeof createFixtureIdGenerator>, suffix: number) {
  return createWorkService({ database, generateId, now: () => new Date(AT) }).create({
    principalId: OWNER_ID,
    targetPrincipalId: BOT_ID,
    channelId: CHANNEL_ID,
    originMessageId: MESSAGE_ID,
    roundId: null,
    kind: "resident_turn",
    idempotencyKey: `m11-lease-create-${String(suffix).padStart(4, "0")}`,
    manifest: manifestInput(),
    maxAutomaticOffers: 2,
    requestId: fixtureId("request", suffix),
    correlationId: fixtureId("correlation", suffix),
  }).work;
}

function binding(workId: string, offer: { attempt: { id: string }; lease: { id: string }; fencingToken: number }, suffix: number) {
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

test("only an accepted exact current fence starts and heartbeats across process-object restart", async (t) => {
  const { LeaseError, createLeaseService } = await import("../../../src/coordination/leases/index.js")
    .catch((error: unknown) => assert.fail(`M11 Lease service is unavailable: ${String(error)}`));
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const generateId = createFixtureIdGenerator();
  const work = createQueuedWork(database, generateId, 20);
  let clock = new Date(AT);
  let leases = createLeaseService({ database, generateId, now: () => clock, leaseTtlMs: 60_000 });

  const offer = leases.offer({
    workId: work.id,
    holderPrincipalId: BOT_ID,
    holderInstanceId: HOLDER_INSTANCE_ID,
    authorityReference: AUTHORITY_REFERENCE,
    automatic: true,
    requestId: fixtureId("request", 21),
    correlationId: fixtureId("correlation", 21),
  });
  assert.equal(offer.fencingToken, 1);
  assert.equal(offer.work.state, "leased");
  assert.equal(offer.attempt.state, "offered");
  assert.equal(offer.lease.state, "offered");
  assert.throws(
    () => leases.start(binding(work.id, offer, 22)),
    (error: unknown) => error instanceof LeaseError && error.code === "illegal_state",
  );

  const accepted = leases.accept(binding(work.id, offer, 23));
  assert.equal(accepted.attempt.state, "accepted");
  assert.equal(accepted.lease.state, "active");
  database.reopen();
  leases = createLeaseService({ database, generateId, now: () => clock, leaseTtlMs: 60_000 });
  const started = leases.start(binding(work.id, offer, 24));
  assert.equal(started.work.state, "running");
  assert.equal(started.attempt.state, "running");

  const oldExpiry = started.lease.expiresAt;
  clock = new Date("2026-08-25T16:00:30.000Z");
  const heartbeat = leases.heartbeat({ ...binding(work.id, offer, 25), extendMs: 90_000 });
  assert.equal(heartbeat.lease.heartbeatAt, "2026-08-25T16:00:30.000Z");
  assert.ok(heartbeat.lease.expiresAt > oldExpiry);
  assert.throws(
    () => leases.heartbeat({ ...binding(work.id, offer, 26), fencingToken: 0, extendMs: 90_000 }),
    (error: unknown) => error instanceof LeaseError && error.code === "stale_fence",
  );
  assert.equal(
    database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM work_observations WHERE observation_kind = 'rejected_fence'",
    )?.count,
    1,
  );
});

test("rejection expiry and revoke invalidate old fences and every later offer is larger after reopen", async (t) => {
  const { LeaseError, createLeaseService } = await import("../../../src/coordination/leases/index.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const generateId = createFixtureIdGenerator(2_000);
  const work = createQueuedWork(database, generateId, 30);
  let leases = createLeaseService({ database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000 });

  const first = leases.offer({
    workId: work.id, holderPrincipalId: BOT_ID, holderInstanceId: HOLDER_INSTANCE_ID,
    authorityReference: AUTHORITY_REFERENCE, automatic: true,
    requestId: fixtureId("request", 31), correlationId: fixtureId("correlation", 31),
  });
  leases.reject({ ...binding(work.id, first, 32), reasonCode: "resident_rejected" });
  database.reopen();
  leases = createLeaseService({ database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000 });
  const second = leases.offer({
    workId: work.id, holderPrincipalId: BOT_ID, holderInstanceId: HOLDER_INSTANCE_ID,
    authorityReference: AUTHORITY_REFERENCE, automatic: true,
    requestId: fixtureId("request", 33), correlationId: fixtureId("correlation", 33),
  });
  assert.equal(second.fencingToken, 2);
  leases.accept(binding(work.id, second, 34));
  leases.expire({ ...binding(work.id, second, 35), reasonCode: "positive_not_started" });
  assert.throws(
    () => leases.offer({
      workId: work.id, holderPrincipalId: BOT_ID, holderInstanceId: HOLDER_INSTANCE_ID,
      authorityReference: AUTHORITY_REFERENCE, automatic: true,
      requestId: fixtureId("request", 36), correlationId: fixtureId("correlation", 36),
    }),
    (error: unknown) => error instanceof LeaseError && error.code === "retry_budget_exhausted",
  );
  const third = leases.offer({
    workId: work.id, holderPrincipalId: BOT_ID, holderInstanceId: HOLDER_INSTANCE_ID,
    authorityReference: AUTHORITY_REFERENCE, automatic: false,
    requestId: fixtureId("request", 37), correlationId: fixtureId("correlation", 37),
  });
  assert.equal(third.fencingToken, 3);
  leases.accept(binding(work.id, third, 38));
  leases.start(binding(work.id, third, 39));
  const cancelling = leases.revoke({ ...binding(work.id, third, 40), reasonCode: "operator_cancel" });
  assert.equal(cancelling.work.state, "cancelling");
  assert.equal(cancelling.attempt.state, "cancel_requested");
  assert.equal(cancelling.lease.state, "revoked");
  assert.throws(
    () => leases.heartbeat({ ...binding(work.id, first, 41), extendMs: 60_000 }),
    (error: unknown) => error instanceof LeaseError && error.code === "stale_fence",
  );
});

test("exhausted queued Work cancels exactly once after reopen without inventing an execution fence", async (t) => {
  const { LeaseError, createLeaseService } = await import("../../../src/coordination/leases/index.js");
  const { WorkError } = await import("../../../src/coordination/work/index.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const generateId = createFixtureIdGenerator(2_500);
  const work = createQueuedWork(database, generateId, 45);
  let leases = createLeaseService({ database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000 });

  const first = leases.offer({
    workId: work.id, holderPrincipalId: BOT_ID, holderInstanceId: HOLDER_INSTANCE_ID,
    authorityReference: AUTHORITY_REFERENCE, automatic: true,
    requestId: fixtureId("request", 46), correlationId: fixtureId("correlation", 46),
  });
  leases.reject({ ...binding(work.id, first, 47), reasonCode: "resident_rejected" });
  const second = leases.offer({
    workId: work.id, holderPrincipalId: BOT_ID, holderInstanceId: HOLDER_INSTANCE_ID,
    authorityReference: AUTHORITY_REFERENCE, automatic: true,
    requestId: fixtureId("request", 48), correlationId: fixtureId("correlation", 48),
  });
  leases.accept(binding(work.id, second, 49));
  leases.expire({ ...binding(work.id, second, 50), reasonCode: "positive_not_started" });
  assert.throws(
    () => leases.offer({
      workId: work.id, holderPrincipalId: BOT_ID, holderInstanceId: HOLDER_INSTANCE_ID,
      authorityReference: AUTHORITY_REFERENCE, automatic: true,
      requestId: fixtureId("request", 51), correlationId: fixtureId("correlation", 51),
    }),
    (error: unknown) => error instanceof LeaseError && error.code === "retry_budget_exhausted",
  );

  database.reopen();
  let works = createWorkService({ database, generateId, now: () => new Date(AT) });
  const cancelInput = {
    workId: work.id,
    actorPrincipalId: OWNER_ID,
    reasonCode: "operator_cancel",
    sourceReference: "coordination:owner-cancel",
    timestamp: AT,
    requestId: fixtureId("request", 52),
    correlationId: fixtureId("correlation", 52),
  };
  const cancelled = works.cancelQueued(cancelInput);
  assert.equal(cancelled.replayed, false);
  assert.equal(cancelled.work.state, "cancelled");
  assert.equal(cancelled.work.currentAttemptId, null);
  assert.equal(cancelled.work.terminalReason, "operator_cancel");
  assert.equal(cancelled.receipt.attemptId, null);
  assert.equal(cancelled.receipt.fencingToken, 0);
  assert.equal(cancelled.receipt.status, "cancelled");
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM attempts")?.count, 2);
  assert.equal(
    database.readOne<{ count: number }>("SELECT count(*) AS count FROM outbox WHERE aggregate_id = ?", work.id)?.count,
    2,
  );

  database.reopen();
  works = createWorkService({ database, generateId, now: () => new Date(AT) });
  const replay = works.cancelQueued({
    ...cancelInput,
    requestId: fixtureId("request", 53),
    correlationId: fixtureId("correlation", 53),
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.receiptDigest, cancelled.receipt.receiptDigest);
  assert.throws(
    () => works.cancelQueued({
      ...cancelInput,
      reasonCode: "different_cancel",
      requestId: fixtureId("request", 54),
      correlationId: fixtureId("correlation", 54),
    }),
    (error: unknown) => error instanceof WorkError && error.code === "terminal_conflict",
  );
  assert.throws(
    () => database.raw.prepare("UPDATE works SET updated_at = ? WHERE id = ?")
      .run("2026-08-25T17:00:00.000Z", work.id),
    /terminal Work is immutable/,
  );
});

test("a successful terminal receipt holds ordered artifacts across 24h recovery until Message link", async (t) => {
  const { LeaseError, createLeaseService } = await import("../../../src/coordination/leases/index.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const rootDirectory = await mkdtemp(join(tmpdir(), "home23-terminal-artifact-hold-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const conversationId = "cnv_0198d95f-6c00-7000-8000-000000000050";
  database.raw.prepare("INSERT INTO conversation_handles (id, channel_id, created_at) VALUES (?, ?, ?)")
    .run(conversationId, CHANNEL_ID, AT);
  database.raw.prepare(
    `UPDATE bots SET conversation_id = ?, required_capabilities_json = ?,
                     resident_capabilities_json = ? WHERE id = ?`,
  ).run(
    conversationId,
    JSON.stringify(["attachments", "messages"]),
    JSON.stringify(["attachments", "messages"]),
    BOT_ID,
  );
  const botRecord = Object.freeze({
    id: BOT_ID, principalId: BOT_ID, name: "Jerry", purpose: "Persistent resident",
    lifecycle: "active" as const, conversationId, residentBinding: "jerry",
    continuingIdentity: true, durableMailbox: true,
    requiredCapabilities: Object.freeze(["attachments", "messages"]),
    activeInstanceId: HOLDER_INSTANCE_ID, activeKeyVersion: 1, residentProtocolVersion: 1,
    residentCapabilities: Object.freeze(["attachments", "messages"]), residentRegisteredAt: AT,
    lastHeartbeatAt: AT, reportedAvailability: "available" as const,
    availability: "available" as const, version: 1, createdAt: AT, updatedAt: AT,
  });
  const directory = {
    listVisibleBots: async () => [botRecord],
    resolveAlias: async (namespace: string, value: string) =>
      namespace === "resident" && value === "jerry" ? botRecord : null,
    getBotByResidentBinding: async (value: string) => value === "jerry" ? botRecord : null,
  };
  const residentContext = (suffix: number) => {
    const requestId = fixtureId("request", suffix);
    const correlationId = fixtureId("correlation", suffix);
    return {
      principalId: BOT_ID,
      requestId,
      correlationId,
      identity: { kind: "resident" as const, resident: {
        requestId,
        correlationId,
        credential: {
          residentSlug: "jerry", role: "resident" as const,
          instanceId: HOLDER_INSTANCE_ID, keyVersion: 1,
        },
      } },
    };
  };
  let clock = new Date(AT);
  const artifactRepository = new SqliteArtifactRepository(database);
  const store = await LocalArtifactStore.open({
    rootDirectory,
    repository: artifactRepository,
    now: () => clock,
    quarantineId: () => "terminal-receipt-hold",
  });
  const artifactActor = await resolveArtifactActor(residentContext(49), directory);
  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const imageDigest = createHash("sha256").update(imageBytes).digest("hex");
  const artifactIds = [
    "art_0198d95f-6c00-7000-8000-000000000052",
    "art_0198d95f-6c00-7000-8000-000000000051",
  ];
  const unacceptedArtifactId = "art_0198d95f-6c00-7000-8000-000000000055";
  for (const [index, artifactId] of [...artifactIds, unacceptedArtifactId].entries()) {
    await store.ingest({
      artifactId,
      actor: artifactActor,
      originalName: `answer-${index}.png`,
      declaredContentType: "image/png",
      expectedSha256: imageDigest,
      content: Readable.from([imageBytes]),
    });
  }
  const generateId = createFixtureIdGenerator(3_000);
  const work = createQueuedWork(database, generateId, 50);
  let leases = createLeaseService({ database, generateId, now: () => clock, leaseTtlMs: 60_000 });
  const offer = leases.offer({
    workId: work.id, holderPrincipalId: BOT_ID, holderInstanceId: HOLDER_INSTANCE_ID,
    authorityReference: AUTHORITY_REFERENCE, automatic: false,
    requestId: fixtureId("request", 51), correlationId: fixtureId("correlation", 51),
  });
  leases.accept(binding(work.id, offer, 52));
  leases.start(binding(work.id, offer, 53));
  database.reopen();
  leases = createLeaseService({ database, generateId, now: () => clock, leaseTtlMs: 60_000 });
  const input = {
    ...binding(work.id, offer, 54),
    receipt: {
      status: "succeeded" as const,
      sourceReference: AUTHORITY_REFERENCE,
      resultDigest: "c".repeat(64),
      artifactIds,
      timestamp: AT,
    },
  };
  const completed = leases.terminalize(input);
  assert.equal(completed.replayed, false);
  assert.equal(completed.work.state, "succeeded");
  assert.equal(completed.attempt.state, "succeeded");
  assert.equal(completed.lease.state, "released");
  assert.equal(completed.receipt.status, "succeeded");
  assert.deepEqual(completed.receipt.artifactIds, artifactIds);
  assert.match(completed.receipt.receiptDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM outbox WHERE aggregate_id = ?",
      work.id,
    )?.count,
    2,
  );
  assert.deepEqual(database.readAll<{ id: string; expiresAt: string | null }>(
    `SELECT id, expires_at AS expiresAt FROM artifacts
     WHERE id IN (?, ?, ?) ORDER BY id`,
    ...artifactIds,
    unacceptedArtifactId,
  ), [
    { id: artifactIds[1], expiresAt: null },
    { id: artifactIds[0], expiresAt: null },
    { id: unacceptedArtifactId, expiresAt: "2026-08-26T16:00:00.000Z" },
  ]);

  database.reopen();
  clock = new Date("2026-08-27T16:00:00.000Z");
  leases = createLeaseService({ database, generateId, now: () => clock, leaseTtlMs: 60_000 });
  const replay = leases.terminalize(input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt.artifactIds, artifactIds);
  assert.equal(replay.receipt.receiptDigest, completed.receipt.receiptDigest);
  assert.deepEqual(
    (await store.expireDueDrafts({ actor: artifactActor })).expiredArtifactIds,
    [unacceptedArtifactId],
  );
  const messages = createMessageService({
    repository: new SqliteMessagingRepository(database, {
      botConversationBinding: new SqliteBotConversationBindingAdapter(),
      messageProvenanceAuthorization: new M11MessageProvenanceAuthority(),
      artifactMessageLink: artifactRepository,
    }),
    participantDirectory: directory,
    resolveAttachmentActor: (context) => resolveArtifactActor(context, directory),
    now: () => clock,
  });
  const result = await messages.sendMessage({
    context: residentContext(56),
    channelId: CHANNEL_ID,
    messageId: fixtureId("message", 56),
    authorPrincipalId: BOT_ID,
    idempotencyKey: "terminal-held-artifact-result",
    kind: "result",
    text: null,
    mentions: [],
    attachmentIds: artifactIds,
    clientMessageId: null,
    replyToMessageId: MESSAGE_ID,
    tombstonesMessageId: null,
    provenance: { roundId: null, workId: work.id },
  });
  assert.deepEqual(result.message.attachments.map((attachment) => attachment.id), artifactIds);
  const download = await store.openDownload({ artifactId: artifactIds[0], actor: artifactActor });
  const chunks: Buffer[] = [];
  for await (const chunk of download.content) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), imageBytes);
  assert.throws(
    () => leases.terminalize({
      ...input,
      receipt: { ...input.receipt, resultDigest: "d".repeat(64) },
    }),
    (error: unknown) => error instanceof LeaseError && error.code === "terminal_conflict",
  );
  assert.throws(
    () => database.raw.prepare("UPDATE works SET updated_at = ? WHERE id = ?")
      .run("2026-08-25T17:00:00.000Z", work.id),
    /terminal Work is immutable/,
  );
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM terminal_receipts")?.count, 1);
});

test("terminal replay still requires the exact binding and revocation can finish with one cancellation receipt", async (t) => {
  const { LeaseError, createLeaseService } = await import("../../../src/coordination/leases/index.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const generateId = createFixtureIdGenerator(3_500);
  const leases = createLeaseService({ database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000 });

  const completedWork = createQueuedWork(database, generateId, 60);
  const completedOffer = leases.offer({
    workId: completedWork.id, holderPrincipalId: BOT_ID, holderInstanceId: HOLDER_INSTANCE_ID,
    authorityReference: AUTHORITY_REFERENCE, automatic: false,
    requestId: fixtureId("request", 61), correlationId: fixtureId("correlation", 61),
  });
  leases.accept(binding(completedWork.id, completedOffer, 62));
  leases.start(binding(completedWork.id, completedOffer, 63));
  const completedInput = {
    ...binding(completedWork.id, completedOffer, 64),
    receipt: {
      status: "succeeded" as const,
      sourceReference: AUTHORITY_REFERENCE,
      resultDigest: "c".repeat(64),
      artifactIds: [] as string[],
      timestamp: AT,
    },
  };
  leases.terminalize(completedInput);
  assert.throws(
    () => leases.terminalize({ ...completedInput, holderInstanceId: "resident-stale" }),
    (error: unknown) => error instanceof LeaseError && error.code === "stale_fence",
  );
  assert.equal(
    database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM work_observations WHERE work_id = ? AND observation_kind = 'rejected_fence'",
      completedWork.id,
    )?.count,
    1,
  );

  const cancelledWork = createQueuedWork(database, generateId, 70);
  const cancelledOffer = leases.offer({
    workId: cancelledWork.id, holderPrincipalId: BOT_ID, holderInstanceId: HOLDER_INSTANCE_ID,
    authorityReference: AUTHORITY_REFERENCE, automatic: false,
    requestId: fixtureId("request", 71), correlationId: fixtureId("correlation", 71),
  });
  leases.accept(binding(cancelledWork.id, cancelledOffer, 72));
  leases.start(binding(cancelledWork.id, cancelledOffer, 73));
  leases.revoke({ ...binding(cancelledWork.id, cancelledOffer, 74), reasonCode: "operator_cancel" });
  const cancelled = leases.terminalize({
    ...binding(cancelledWork.id, cancelledOffer, 75),
    receipt: {
      status: "cancelled",
      sourceReference: AUTHORITY_REFERENCE,
      resultDigest: null,
      artifactIds: [],
      timestamp: AT,
    },
  });
  assert.equal(cancelled.work.state, "cancelled");
  assert.equal(cancelled.attempt.state, "cancelled");
  assert.equal(cancelled.lease.state, "revoked");
  assert.equal(cancelled.receipt.status, "cancelled");
});
