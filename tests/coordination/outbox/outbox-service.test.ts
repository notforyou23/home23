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
} from "../work/test-fixture.js";

function createWake(database: M11TestDatabase, generateId: ReturnType<typeof createFixtureIdGenerator>, suffix: number) {
  return createWorkService({ database, generateId, now: () => new Date(AT) }).create({
    principalId: OWNER_ID,
    targetPrincipalId: BOT_ID,
    channelId: CHANNEL_ID,
    originMessageId: MESSAGE_ID,
    roundId: null,
    kind: "resident_turn",
    idempotencyKey: `m11-outbox-create-${String(suffix).padStart(4, "0")}`,
    manifest: manifestInput(),
    maxAutomaticOffers: 2,
    requestId: fixtureId("request", suffix),
    correlationId: fixtureId("correlation", suffix),
  });
}

function identity(suffix: number) {
  return {
    requestId: fixtureId("request", suffix),
    correlationId: fixtureId("correlation", suffix),
  };
}

test("a crash after endpoint acceptance reclaims the claim and resends one stable idempotency key", async (t) => {
  const { createOutboxService } = await import("../../../src/coordination/outbox/index.js")
    .catch((error: unknown) => assert.fail(`M11 Outbox service is unavailable: ${String(error)}`));
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const generateId = createFixtureIdGenerator(7_000);
  const wake = createWake(database, generateId, 200);
  let clock = new Date(AT);
  let outbox = createOutboxService({ database, now: () => clock, retryBaseMs: 1_000 });

  const first = outbox.claimNext({ claimant: "delivery-worker-1", claimTtlMs: 60_000, ...identity(201) });
  assert.ok(first);
  assert.equal(first.outbox.id, wake.wakeOutboxId);
  assert.equal(first.outbox.state, "claimed");
  assert.equal(first.delivery.state, "sending");
  assert.equal(
    JSON.parse(database.readOne<{ payload: string }>(
      "SELECT payload_json AS payload FROM events WHERE aggregate_kind = 'outbox' AND aggregate_id = ? ORDER BY sequence DESC LIMIT 1",
      first.outbox.id,
    )!.payload).attemptCount,
    1,
  );
  const acceptedEndpointKey = first.endpointIdempotencyKey;

  database.reopen();
  clock = new Date("2026-08-25T16:02:00.000Z");
  outbox = createOutboxService({ database, now: () => clock, retryBaseMs: 1_000 });
  const reclaimed = outbox.reclaimStaleClaims(identity(202));
  assert.equal(reclaimed, 1);
  const second = outbox.claimNext({ claimant: "delivery-worker-2", claimTtlMs: 60_000, ...identity(203) });
  assert.ok(second);
  assert.equal(second.outbox.id, first.outbox.id);
  assert.equal(second.endpointIdempotencyKey, acceptedEndpointKey);
  const settled = outbox.settle({
    outboxId: second.outbox.id,
    deliveryId: second.delivery.id,
    claimant: "delivery-worker-2",
    claimEpoch: second.claimEpoch,
    endpointIdempotencyKey: acceptedEndpointKey,
    disposition: "duplicate_accepted",
    errorCode: null,
    ...identity(204),
  });
  assert.equal(settled.outbox.state, "delivered");
  assert.equal(settled.delivery.state, "delivered");
  assert.equal(settled.delivery.finalDisposition, "duplicate_accepted");
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM deliveries")?.count, 1);
  assert.deepEqual(
    database.readAll<{ disposition: string }>(
      "SELECT disposition FROM delivery_attempts ORDER BY ordinal",
    ).map((row) => row.disposition),
    ["claim_expired", "duplicate_accepted"],
  );
});

test("an unknown final-claim crash gets one separately bounded stable-key duplicate probe", async (t) => {
  const { createOutboxService } = await import("../../../src/coordination/outbox/index.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const generateId = createFixtureIdGenerator(8_500);
  const wake = createWake(database, generateId, 250);
  database.raw.prepare("UPDATE outbox SET max_attempts = 1 WHERE id = ?").run(wake.wakeOutboxId);
  let clock = new Date(AT);
  const outbox = createOutboxService({ database, now: () => clock, retryBaseMs: 1_000 });
  const claim = outbox.claimNext({ claimant: "delivery-worker", claimTtlMs: 60_000, ...identity(251) });
  assert.ok(claim);

  clock = new Date("2026-08-25T16:02:00.000Z");
  assert.equal(outbox.reclaimStaleClaims(identity(252)), 1);
  const probe = outbox.claimNext({ claimant: "delivery-worker", claimTtlMs: 60_000, ...identity(253) });
  assert.ok(probe);
  assert.equal(probe.claimKind, "duplicate_probe");
  assert.equal(probe.endpointIdempotencyKey, claim.endpointIdempotencyKey);
  const settled = outbox.settle({
    outboxId: probe.outbox.id,
    deliveryId: probe.delivery.id,
    claimant: "delivery-worker",
    claimEpoch: probe.claimEpoch,
    endpointIdempotencyKey: probe.endpointIdempotencyKey,
    disposition: "duplicate_accepted",
    errorCode: null,
    ...identity(254),
  });
  assert.equal(settled.outbox.state, "delivered");
  assert.equal(settled.delivery.finalDisposition, "duplicate_accepted");
  assert.equal(settled.outbox.attemptCount, 1, "the recovery probe is outside the ordinary retry budget");
  assert.equal(
    database.readOne<{ count: number }>("SELECT count(*) AS count FROM delivery_attempts")?.count,
    2,
  );
});

test("a repeated unknown crash exhausts the one duplicate probe and dead-letters", async (t) => {
  const { createOutboxService } = await import("../../../src/coordination/outbox/index.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const wake = createWake(database, createFixtureIdGenerator(8_700), 260);
  database.raw.prepare("UPDATE outbox SET max_attempts = 1 WHERE id = ?").run(wake.wakeOutboxId);
  let clock = new Date(AT);
  const outbox = createOutboxService({ database, now: () => clock, retryBaseMs: 1_000 });
  assert.ok(outbox.claimNext({ claimant: "delivery-worker", claimTtlMs: 60_000, ...identity(261) }));

  clock = new Date("2026-08-25T16:02:00.000Z");
  assert.equal(outbox.reclaimStaleClaims(identity(262)), 1);
  const probe = outbox.claimNext({ claimant: "delivery-worker", claimTtlMs: 60_000, ...identity(263) });
  assert.ok(probe);
  assert.equal(probe.claimKind, "duplicate_probe");

  clock = new Date("2026-08-25T16:04:00.000Z");
  assert.equal(outbox.reclaimStaleClaims(identity(264)), 1);
  assert.deepEqual(
    database.readOne<{ outboxState: string; deliveryState: string; finalDisposition: string }>(
      `SELECT o.state AS outboxState, d.state AS deliveryState,
              d.final_disposition AS finalDisposition
       FROM outbox o JOIN deliveries d ON d.outbox_id = o.id WHERE o.id = ?`,
      wake.wakeOutboxId,
    ),
    {
      outboxState: "dead_letter",
      deliveryState: "permanent_failure",
      finalDisposition: "recovery_probe_exhausted",
    },
  );
  assert.equal(outbox.claimNext({ claimant: "delivery-worker", claimTtlMs: 60_000, ...identity(265) }), null);
});

test("settlement is fenced by claim epoch even when the same claimant reclaims the delivery", async (t) => {
  const { OutboxError, createOutboxService } = await import("../../../src/coordination/outbox/index.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  createWake(database, createFixtureIdGenerator(8_900), 270);
  let clock = new Date(AT);
  const outbox = createOutboxService({ database, now: () => clock, retryBaseMs: 1_000 });
  const first = outbox.claimNext({ claimant: "same-worker", claimTtlMs: 60_000, ...identity(271) });
  assert.ok(first);

  clock = new Date("2026-08-25T16:02:00.000Z");
  assert.equal(outbox.reclaimStaleClaims(identity(272)), 1);
  const second = outbox.claimNext({ claimant: "same-worker", claimTtlMs: 60_000, ...identity(273) });
  assert.ok(second);
  assert.ok(second.claimEpoch > first.claimEpoch);
  assert.equal(second.delivery.activeClaimEpoch, second.claimEpoch);

  assert.throws(
    () => outbox.settle({
      outboxId: first.outbox.id,
      deliveryId: first.delivery.id,
      claimant: "same-worker",
      claimEpoch: first.claimEpoch,
      endpointIdempotencyKey: first.endpointIdempotencyKey,
      disposition: "accepted",
      errorCode: null,
      ...identity(274),
    }),
    (error: unknown) => error instanceof OutboxError && error.code === "illegal_state" && /current claim/.test(error.message),
  );
  const settled = outbox.settle({
    outboxId: second.outbox.id,
    deliveryId: second.delivery.id,
    claimant: "same-worker",
    claimEpoch: second.claimEpoch,
    endpointIdempotencyKey: second.endpointIdempotencyKey,
    disposition: "accepted",
    errorCode: null,
    ...identity(275),
  });
  assert.equal(settled.outbox.state, "delivered");
  assert.equal(settled.delivery.activeClaimEpoch, null);
});

test("settlement at claim-expiry equality is rejected", async (t) => {
  const { OutboxError, createOutboxService } = await import("../../../src/coordination/outbox/index.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  createWake(database, createFixtureIdGenerator(9_100), 280);
  let clock = new Date(AT);
  const outbox = createOutboxService({ database, now: () => clock, retryBaseMs: 1_000 });
  const claim = outbox.claimNext({ claimant: "delivery-worker", claimTtlMs: 60_000, ...identity(281) });
  assert.ok(claim);
  clock = new Date(claim.outbox.claimExpiresAt!);
  assert.throws(
    () => outbox.settle({
      outboxId: claim.outbox.id,
      deliveryId: claim.delivery.id,
      claimant: "delivery-worker",
      claimEpoch: claim.claimEpoch,
      endpointIdempotencyKey: claim.endpointIdempotencyKey,
      disposition: "accepted",
      errorCode: null,
      ...identity(282),
    }),
    (error: unknown) => error instanceof OutboxError && error.code === "illegal_state" && /expired/.test(error.message),
  );
});

test("retryable delivery is deterministic and bounded before exact M02 dead-letter states", async (t) => {
  const { OutboxError, createOutboxService } = await import("../../../src/coordination/outbox/index.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const generateId = createFixtureIdGenerator(8_000);
  const wake = createWake(database, generateId, 220);
  let clock = new Date(AT);
  const outbox = createOutboxService({ database, now: () => clock, retryBaseMs: 1_000 });
  const observedKeys: string[] = [];
  const observedDelays: number[] = [];
  let finalState = "";

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const claim = outbox.claimNext({
      claimant: "delivery-worker",
      claimTtlMs: 60_000,
      ...identity(220 + attempt * 2),
    });
    assert.ok(claim);
    observedKeys.push(claim.endpointIdempotencyKey);
    const settled = outbox.settle({
      outboxId: claim.outbox.id,
      deliveryId: claim.delivery.id,
      claimant: "delivery-worker",
      claimEpoch: claim.claimEpoch,
      endpointIdempotencyKey: claim.endpointIdempotencyKey,
      disposition: "retryable_failure",
      errorCode: "endpoint_unavailable",
      ...identity(221 + attempt * 2),
    });
    finalState = settled.outbox.state;
    if (attempt < 4) {
      assert.equal(settled.outbox.state, "retry");
      assert.equal(settled.delivery.state, "retry_wait");
      observedDelays.push(new Date(settled.outbox.notBefore).valueOf() - clock.valueOf());
      clock = new Date(settled.outbox.notBefore);
    }
  }

  assert.equal(finalState, "dead_letter");
  assert.equal(new Set(observedKeys).size, 1);
  assert.deepEqual(observedDelays, [1_000, 2_000, 4_000]);
  assert.equal(
    database.readOne<{ state: string }>("SELECT state FROM deliveries WHERE outbox_id = ?", wake.wakeOutboxId)?.state,
    "permanent_failure",
  );
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM delivery_attempts")?.count, 4);
  assert.equal(outbox.claimNext({ claimant: "delivery-worker", claimTtlMs: 60_000, ...identity(240) }), null);
  assert.throws(
    () => outbox.settle({
      outboxId: wake.wakeOutboxId,
      deliveryId: fixtureId("delivery", 999),
      claimant: "delivery-worker",
      claimEpoch: 1,
      endpointIdempotencyKey: observedKeys[0]!,
      disposition: "accepted",
      errorCode: null,
      ...identity(241),
    }),
    (error: unknown) => error instanceof OutboxError && error.code === "illegal_state",
  );
});
