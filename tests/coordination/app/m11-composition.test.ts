import assert from "node:assert/strict";
import test from "node:test";

import {
  createCoordinationApplication,
  disabledCoordinationFeatureFlags,
} from "../../../src/coordination/app/index.js";
import { projectTrustedM11Activity } from "../../../src/coordination/activity/index.js";
import { createLeaseService, LeaseError } from "../../../src/coordination/leases/index.js";
import { createWorkService, WorkError } from "../../../src/coordination/work/index.js";
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

const enabledShellFlags = Object.freeze({
  ...disabledCoordinationFeatureFlags(),
  "coordination.process.enabled": true,
  "coordination.public_api.enabled": true,
});

function auth() {
  return {
    validateAccessToken: async () => {
      throw new Error("unused");
    },
  };
}

function directWorkInput() {
  return {
    principalId: OWNER_ID,
    targetPrincipalId: BOT_ID,
    channelId: CHANNEL_ID,
    originMessageId: MESSAGE_ID,
    roundId: null,
    kind: "resident_turn",
    idempotencyKey: "m11-application-direct-work",
    manifest: manifestInput(),
    maxAutomaticOffers: 2,
    requestId: fixtureId("request", 501),
    correlationId: fixtureId("correlation", 501),
  };
}

test("real M11 services compose without dishonestly advertising public Work", (t) => {
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const generateId = createFixtureIdGenerator(20_000);
  const work = createWorkService({ database, generateId, now: () => new Date(AT) });
  const leases = createLeaseService({
    database,
    generateId,
    now: () => new Date(AT),
    leaseTtlMs: 60_000,
  });
  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    services: { auth: auth(), work, leases, activity: projectTrustedM11Activity },
  });

  assert.equal(application.services.work, work);
  assert.equal(application.services.leases, leases);
  assert.equal(application.services.activity, projectTrustedM11Activity);
  assert.equal(application.capabilities().capabilities.work, false);
  assert.equal(application.capabilities().capabilities.workMutation, false);
  assert.equal(application.capabilities().capabilities.messageSubmission, false);
  assert.equal(application.capabilities().capabilities.activity, false);
});

test("direct Work keeps M11 idempotency boundaries through the application seam", (t) => {
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const work = createWorkService({
    database,
    generateId: createFixtureIdGenerator(21_000),
    now: () => new Date(AT),
  });
  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    services: { auth: auth(), work },
  });

  const first = application.services.work!.create(directWorkInput());
  const replay = application.services.work!.create(directWorkInput());
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.work.id, first.work.id);
  assert.equal(replay.wakeOutboxId, first.wakeOutboxId);
  assert.throws(
    () => application.services.work!.create({ ...directWorkInput(), kind: "different_turn" }),
    (error: unknown) => error instanceof WorkError && error.code === "idempotency_conflict",
  );
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM works")?.count, 1);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM outbox")?.count, 1);
});

test("stale fences are rejected through the composed application seam", (t) => {
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const generateId = createFixtureIdGenerator(22_000);
  const work = createWorkService({ database, generateId, now: () => new Date(AT) });
  const leases = createLeaseService({
    database,
    generateId,
    now: () => new Date(AT),
    leaseTtlMs: 60_000,
  });
  const application = createCoordinationApplication({
    flags: enabledShellFlags,
    services: { auth: auth(), work, leases },
  });
  const queued = application.services.work!.create(directWorkInput()).work;
  const offer = application.services.leases!.offer({
    workId: queued.id,
    holderPrincipalId: BOT_ID,
    holderInstanceId: "resident-1",
    authorityReference: `resident:${BOT_ID}:resident-1`,
    automatic: true,
    requestId: fixtureId("request", 502),
    correlationId: fixtureId("correlation", 502),
  });
  const binding = {
    workId: queued.id,
    attemptId: offer.attempt.id,
    leaseId: offer.lease.id,
    holderPrincipalId: BOT_ID,
    holderInstanceId: "resident-1",
    fencingToken: offer.fencingToken,
    requestId: fixtureId("request", 503),
    correlationId: fixtureId("correlation", 503),
  };
  application.services.leases!.accept(binding);
  application.services.leases!.start(binding);

  assert.throws(
    () => application.services.leases!.heartbeat({
      ...binding,
      fencingToken: 0,
      extendMs: 60_000,
    }),
    (error: unknown) => error instanceof LeaseError && error.code === "stale_fence",
  );
  assert.equal(
    database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM work_observations WHERE observation_kind = 'rejected_fence'",
    )?.count,
    1,
  );
});
