import assert from "node:assert/strict";
import test from "node:test";

import { createWorkService } from "../../../src/coordination/work/index.js";
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

test("the exact current fence commits one immutable terminal receipt and terminal outbox atomically", async (t) => {
  const { LeaseError, createLeaseService } = await import("../../../src/coordination/leases/index.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const generateId = createFixtureIdGenerator(3_000);
  const work = createQueuedWork(database, generateId, 50);
  let leases = createLeaseService({ database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000 });
  const offer = leases.offer({
    workId: work.id, holderPrincipalId: BOT_ID, holderInstanceId: HOLDER_INSTANCE_ID,
    authorityReference: AUTHORITY_REFERENCE, automatic: false,
    requestId: fixtureId("request", 51), correlationId: fixtureId("correlation", 51),
  });
  leases.accept(binding(work.id, offer, 52));
  leases.start(binding(work.id, offer, 53));
  database.reopen();
  leases = createLeaseService({ database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000 });
  const input = {
    ...binding(work.id, offer, 54),
    receipt: {
      status: "succeeded" as const,
      sourceReference: AUTHORITY_REFERENCE,
      resultDigest: "c".repeat(64),
      artifactIds: [] as string[],
      timestamp: AT,
    },
  };
  const completed = leases.terminalize(input);
  assert.equal(completed.replayed, false);
  assert.equal(completed.work.state, "succeeded");
  assert.equal(completed.attempt.state, "succeeded");
  assert.equal(completed.lease.state, "released");
  assert.equal(completed.receipt.status, "succeeded");
  assert.match(completed.receipt.receiptDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM outbox WHERE aggregate_id = ?",
      work.id,
    )?.count,
    2,
  );

  database.reopen();
  leases = createLeaseService({ database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000 });
  const replay = leases.terminalize(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.receiptDigest, completed.receipt.receiptDigest);
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
