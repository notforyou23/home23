import assert from "node:assert/strict";
import test from "node:test";

import { createLeaseService } from "../../../src/coordination/leases/index.js";
import { createOutboxService } from "../../../src/coordination/outbox/index.js";
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

const HOLDER_INSTANCE_ID = "resident-1";
const AUTHORITY_REFERENCE = `resident:${BOT_ID}:resident-1`;

function identity(suffix: number) {
  return {
    requestId: fixtureId("request", suffix),
    correlationId: fixtureId("correlation", suffix),
  };
}

function createQueued(database: M11TestDatabase, generateId: ReturnType<typeof createFixtureIdGenerator>, suffix: number) {
  return createWorkService({ database, generateId, now: () => new Date(AT) }).create({
    principalId: OWNER_ID,
    targetPrincipalId: BOT_ID,
    channelId: CHANNEL_ID,
    originMessageId: MESSAGE_ID,
    roundId: null,
    kind: "resident_turn",
    idempotencyKey: `m11-recovery-create-${String(suffix).padStart(4, "0")}`,
    manifest: manifestInput(),
    maxAutomaticOffers: 2,
    ...identity(suffix),
  });
}

function offerInput(workId: string, suffix: number) {
  return {
    workId,
    holderPrincipalId: BOT_ID,
    holderInstanceId: HOLDER_INSTANCE_ID,
    authorityReference: AUTHORITY_REFERENCE,
    automatic: false,
    ...identity(suffix),
  };
}

function binding(workId: string, offer: { attempt: { id: string }; lease: { id: string }; fencingToken: number }, suffix: number) {
  return {
    workId,
    attemptId: offer.attempt.id,
    leaseId: offer.lease.id,
    holderPrincipalId: BOT_ID,
    holderInstanceId: HOLDER_INSTANCE_ID,
    fencingToken: offer.fencingToken,
    ...identity(suffix),
  };
}

function positiveTruth(
  kind: "not_started" | "running",
  workId: string,
  offer: { attempt: { id: string }; lease: { id: string }; fencingToken: number },
) {
  return {
    kind,
    workId,
    attemptId: offer.attempt.id,
    leaseId: offer.lease.id,
    holderPrincipalId: BOT_ID,
    holderInstanceId: HOLDER_INSTANCE_ID,
    authorityReference: AUTHORITY_REFERENCE,
    fencingToken: offer.fencingToken,
    evidenceDigest: kind === "running" ? "d".repeat(64) : "e".repeat(64),
  } as const;
}

test("startup never infers completion and only exact positive not-started truth requeues an accepted Attempt", async (t) => {
  const { createRecoveryService } = await import("../../../src/coordination/work/recovery-service.js")
    .catch((error: unknown) => assert.fail(`M11 recovery service is unavailable: ${String(error)}`));
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const generateId = createFixtureIdGenerator(9_000);
  const queued = createQueued(database, generateId, 300);
  let recovery = createRecoveryService({
    database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000, retryBaseMs: 1_000,
  });

  const beforeOffer = recovery.recoverStartup({ truths: [], ...identity(301) });
  assert.equal(beforeOffer.terminalized, 0);
  assert.equal(database.readOne<{ state: string }>("SELECT state FROM works WHERE id = ?", queued.work.id)?.state, "queued");
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM attempts")?.count, 0);

  let leases = createLeaseService({ database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000 });
  const first = leases.offer(offerInput(queued.work.id, 302));
  leases.accept(binding(queued.work.id, first, 303));
  database.reopen();
  recovery = createRecoveryService({
    database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000, retryBaseMs: 1_000,
  });
  const unknown = recovery.recoverStartup({
    truths: [{ kind: "unknown", workId: queued.work.id, attemptId: first.attempt.id }],
    ...identity(304),
  });
  assert.equal(unknown.ambiguous, 1);
  assert.equal(database.readOne<{ state: string }>("SELECT state FROM works WHERE id = ?", queued.work.id)?.state, "leased");

  const mismatched = recovery.recoverStartup({
    truths: [{ ...positiveTruth("not_started", queued.work.id, first), fencingToken: 999 }],
    ...identity(305),
  });
  assert.equal(mismatched.rejectedTruth, 1);
  assert.equal(database.readOne<{ state: string }>("SELECT state FROM attempts WHERE id = ?", first.attempt.id)?.state, "accepted");

  const exact = recovery.recoverStartup({
    truths: [positiveTruth("not_started", queued.work.id, first)],
    ...identity(306),
  });
  assert.equal(exact.requeued, 1);
  assert.equal(database.readOne<{ state: string }>("SELECT state FROM works WHERE id = ?", queued.work.id)?.state, "queued");
  assert.equal(database.readOne<{ state: string }>("SELECT state FROM attempts WHERE id = ?", first.attempt.id)?.state, "expired");
  leases = createLeaseService({ database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000 });
  const second = leases.offer(offerInput(queued.work.id, 307));
  assert.equal(second.fencingToken, 2);
});

test("misbound unknown and unverifiable truth is rejected while the real active Attempt stays ambiguous", async (t) => {
  const { createRecoveryService } = await import("../../../src/coordination/work/recovery-service.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const generateId = createFixtureIdGenerator(9_700);
  const activeWork = createQueued(database, generateId, 310);
  const wrongWork = createQueued(database, generateId, 311);
  const leases = createLeaseService({ database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000 });
  const activeOffer = leases.offer(offerInput(activeWork.work.id, 312));
  leases.accept(binding(activeWork.work.id, activeOffer, 313));
  const recovery = createRecoveryService({
    database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000, retryBaseMs: 1_000,
  });

  const receipt = recovery.recoverStartup({
    truths: [
      { kind: "unknown", workId: wrongWork.work.id, attemptId: activeOffer.attempt.id },
      { kind: "unverifiable", workId: wrongWork.work.id, attemptId: activeOffer.attempt.id },
    ],
    ...identity(314),
  });
  assert.equal(receipt.rejectedTruth, 2);
  assert.equal(receipt.ambiguous, 1);
  assert.equal(database.readOne<{ state: string }>("SELECT state FROM attempts WHERE id = ?", activeOffer.attempt.id)?.state, "accepted");
});

test("exact running continuity reattaches and an exact terminal receipt survives restart before delivery", async (t) => {
  const { createRecoveryService } = await import("../../../src/coordination/work/recovery-service.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const generateId = createFixtureIdGenerator(10_000);
  let clock = new Date(AT);
  const queued = createQueued(database, generateId, 320);
  let outbox = createOutboxService({ database, now: () => clock, retryBaseMs: 1_000 });
  const wakeClaim = outbox.claimNext({ claimant: "delivery-worker", claimTtlMs: 60_000, ...identity(321) });
  assert.ok(wakeClaim);
  outbox.settle({
    outboxId: wakeClaim.outbox.id,
    deliveryId: wakeClaim.delivery.id,
    claimant: "delivery-worker",
    claimEpoch: wakeClaim.claimEpoch,
    endpointIdempotencyKey: wakeClaim.endpointIdempotencyKey,
    disposition: "accepted",
    errorCode: null,
    ...identity(322),
  });
  const leases = createLeaseService({ database, generateId, now: () => clock, leaseTtlMs: 60_000 });
  const offer = leases.offer(offerInput(queued.work.id, 323));
  leases.accept(binding(queued.work.id, offer, 324));
  leases.start(binding(queued.work.id, offer, 325));

  let recovery = createRecoveryService({
    database, generateId, now: () => clock, leaseTtlMs: 60_000, retryBaseMs: 1_000,
  });
  const ambiguous = recovery.recoverStartup({ truths: [], ...identity(326) });
  assert.equal(ambiguous.ambiguous, 1);
  assert.equal(database.readOne<{ state: string }>("SELECT state FROM works WHERE id = ?", queued.work.id)?.state, "running");
  clock = new Date("2026-08-25T16:00:30.000Z");
  const reattached = recovery.recoverStartup({
    truths: [positiveTruth("running", queued.work.id, offer)],
    ...identity(327),
  });
  assert.equal(reattached.reattached, 1);

  const terminalTruth = {
    ...positiveTruth("running", queued.work.id, offer),
    kind: "terminal" as const,
    evidenceDigest: "f".repeat(64),
    receipt: {
      status: "succeeded" as const,
      sourceReference: AUTHORITY_REFERENCE,
      resultDigest: "c".repeat(64),
      artifactIds: [] as string[],
      timestamp: "2026-08-25T16:00:30.000Z",
    },
  };
  const terminalized = recovery.recoverStartup({ truths: [terminalTruth], ...identity(328) });
  assert.equal(terminalized.terminalized, 1);
  assert.equal(database.readOne<{ state: string }>("SELECT state FROM works WHERE id = ?", queued.work.id)?.state, "succeeded");

  outbox = createOutboxService({ database, now: () => clock, retryBaseMs: 1_000 });
  const terminalClaim = outbox.claimNext({ claimant: "delivery-worker", claimTtlMs: 60_000, ...identity(329) });
  assert.ok(terminalClaim);
  const endpointKey = terminalClaim.endpointIdempotencyKey;
  database.reopen();
  clock = new Date("2026-08-25T16:02:00.000Z");
  recovery = createRecoveryService({
    database, generateId, now: () => clock, leaseTtlMs: 60_000, retryBaseMs: 1_000,
  });
  const afterRestart = recovery.recoverStartup({ truths: [terminalTruth], ...identity(330) });
  assert.equal(afterRestart.staleOutboxClaimsReclaimed, 1);
  assert.equal(afterRestart.terminalReplays, 1);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM terminal_receipts")?.count, 1);
  outbox = createOutboxService({ database, now: () => clock, retryBaseMs: 1_000 });
  const retry = outbox.claimNext({ claimant: "delivery-worker", claimTtlMs: 60_000, ...identity(331) });
  assert.ok(retry);
  assert.equal(retry.endpointIdempotencyKey, endpointKey);
});
