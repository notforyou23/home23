import assert from "node:assert/strict";
import test from "node:test";

import { createLeaseService } from "../../../src/coordination/leases/index.js";
import { createProductWorkControl, createWorkService, WorkError } from "../../../src/coordination/work/index.js";
import { AT, BOT_ID, CHANNEL_ID, MESSAGE_ID, M11TestDatabase, OWNER_ID, createFixtureIdGenerator, fixtureId, manifestInput } from "./test-fixture.js";

const context = (suffix: number, principalId = OWNER_ID) => ({ principalId, requestId: fixtureId("request", suffix), correlationId: fixtureId("correlation", suffix), identity: { kind: "owner" as const, auth: {} as any } });

function setup(start = 8000) {
  const database = M11TestDatabase.temporary();
  const generateId = createFixtureIdGenerator(start);
  const work = createWorkService({ database, generateId, now: () => new Date(AT) });
  const leases = createLeaseService({ database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000 });
  const control = createProductWorkControl({ database, work, leases, now: () => new Date(AT) });
  const queued = work.create({ principalId: OWNER_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID, originMessageId: MESSAGE_ID, roundId: null, kind: "resident_turn", idempotencyKey: `product-control-create-${start}`, manifest: manifestInput(), maxAutomaticOffers: 2, requestId: fixtureId("request", start), correlationId: fixtureId("correlation", start), turnSelection: { modelAlias: "sol", reasoningEffort: "xhigh" } }).work;
  return { database, generateId, work, leases, control, queued };
}

test("queued cancellation is durable, compact, and replay-safe across service restart", (t) => {
  const s = setup(); t.after(() => s.database.close());
  const first = s.control.cancel({ context: context(1), workId: s.queued.id, idempotencyKey: "cancel-product-0001" });
  assert.equal(first.outcome, "cancelled"); assert.equal(first.work.state, "cancelled"); assert.equal(first.replayed, false);
  s.database.reopen();
  const restarted = createProductWorkControl({ database: s.database, work: createWorkService({ database: s.database, generateId: s.generateId }), leases: createLeaseService({ database: s.database, generateId: s.generateId, leaseTtlMs: 60_000 }) });
  const replay = restarted.cancel({ context: context(2), workId: s.queued.id, idempotencyKey: "cancel-product-0001" });
  assert.equal(replay.replayed, true); assert.equal(s.database.readOne<{count:number}>("SELECT count(*) AS count FROM terminal_receipts WHERE work_id = ?", s.queued.id)?.count, 1);
});

test("running cancellation revokes the current fence and resident acknowledgement terminalizes", (t) => {
  const s = setup(9000); t.after(() => s.database.close());
  const offer = s.leases.offer({ workId: s.queued.id, holderPrincipalId: BOT_ID, holderInstanceId: "resident-1", authorityReference: `resident:${BOT_ID}:resident-1`, automatic: true, requestId: fixtureId("request", 90), correlationId: fixtureId("correlation", 90) });
  const binding = { workId: s.queued.id, attemptId: offer.attempt.id, leaseId: offer.lease.id, holderPrincipalId: BOT_ID, holderInstanceId: "resident-1", fencingToken: offer.fencingToken, requestId: fixtureId("request", 91), correlationId: fixtureId("correlation", 91) };
  s.leases.accept(binding); s.leases.start(binding);
  const stopped = s.control.cancel({ context: context(92), workId: s.queued.id, idempotencyKey: "cancel-running-0001" });
  assert.equal(stopped.outcome, "cancellation_requested"); assert.equal(stopped.work.state, "stopping");
  assert.equal(s.control.cancel({ context: context(93), workId: s.queued.id, idempotencyKey: "cancel-running-0001" }).replayed, true);
  const done = s.leases.terminalize({ ...binding, requestId: fixtureId("request", 94), receipt: { status: "cancelled", sourceReference: `resident:${BOT_ID}:resident-1`, resultDigest: null, artifactIds: [], timestamp: AT } });
  assert.equal(done.work.state, "cancelled");
});

test("terminal retry creates one linked queued Work and rejects nonterminal or foreign scope", (t) => {
  const s = setup(10000); t.after(() => s.database.close());
  s.control.cancel({ context: context(100), workId: s.queued.id, idempotencyKey: "cancel-before-retry" });
  const retried = s.control.retry({ context: context(101), workId: s.queued.id, idempotencyKey: "retry-product-0001" });
  assert.equal(retried.outcome, "retried"); assert.equal(retried.work.state, "queued"); assert.equal(retried.work.retryOfWorkId, s.queued.id);
  assert.deepEqual(s.work.getTurnSelection(retried.work.id), { modelAlias: "sol", reasoningEffort: "xhigh" });
  const replay = s.control.retry({ context: context(102), workId: s.queued.id, idempotencyKey: "retry-product-0001" });
  assert.equal(replay.work.id, retried.work.id); assert.equal(replay.replayed, true);
  assert.throws(() => s.control.retry({ context: context(103), workId: retried.work.id, idempotencyKey: "retry-invalid-0001" }), (error: unknown) => error instanceof WorkError && error.code === "illegal_state");
  assert.throws(() => s.control.get({ context: context(104, BOT_ID), workId: s.queued.id }), (error: unknown) => error instanceof WorkError && error.code === "ineligible");
});

test("an expired Attempt is durably closed before retrying as new Work", (t) => {
  const s = setup(11000); t.after(() => s.database.close());
  const offer = s.leases.offer({ workId: s.queued.id, holderPrincipalId: BOT_ID, holderInstanceId: "resident-1", authorityReference: `resident:${BOT_ID}:resident-1`, automatic: true, requestId: fixtureId("request", 110), correlationId: fixtureId("correlation", 110) });
  const binding = { workId: s.queued.id, attemptId: offer.attempt.id, leaseId: offer.lease.id, holderPrincipalId: BOT_ID, holderInstanceId: "resident-1", fencingToken: offer.fencingToken, requestId: fixtureId("request", 111), correlationId: fixtureId("correlation", 111) };
  s.leases.accept(binding); s.leases.expire({ ...binding, reasonCode: "positive_not_started" });
  assert.equal(s.control.get({ context: context(112), workId: s.queued.id }).retryAvailable, true);
  const retry = s.control.retry({ context: context(113), workId: s.queued.id, idempotencyKey: "retry-expired-0001" });
  assert.equal(retry.work.state, "queued"); assert.equal(s.work.get(s.queued.id)?.state, "cancelled");
});
