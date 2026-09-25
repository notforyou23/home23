import assert from "node:assert/strict";
import test from "node:test";

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

function creationInput(
  manifest = manifestInput(),
  turnSelection?: { modelAlias: string | null; reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | "max" | null },
) {
  return {
    principalId: OWNER_ID,
    targetPrincipalId: BOT_ID,
    channelId: CHANNEL_ID,
    originMessageId: MESSAGE_ID,
    roundId: null,
    kind: "resident_turn",
    idempotencyKey: "m11-stable-create-key",
    manifest,
    maxAutomaticOffers: 2,
    requestId: fixtureId("request", 10),
    correlationId: fixtureId("correlation", 10),
    ...(turnSelection === undefined ? {} : { turnSelection }),
  };
}

test("Work creation and its one wake intent survive reopen and exact retry", async (t) => {
  const { createWorkService } = await import("../../../src/coordination/work/index.js")
    .catch((error: unknown) => assert.fail(`M11 Work service is unavailable: ${String(error)}`));
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const generateId = createFixtureIdGenerator();
  let service = createWorkService({ database, generateId, now: () => new Date(AT) });

  const selection = { modelAlias: "sol", reasoningEffort: "max" as const };
  const first = service.create(creationInput(manifestInput(), selection));
  assert.equal(first.replayed, false);
  assert.equal(first.work.state, "queued");
  assert.equal(first.work.currentAttemptId, null);
  assert.equal(first.manifest.privacy, "channel_only");
  assert.equal(first.manifest.messageCount, 1);
  assert.equal(first.manifest.artifactCount, 0);
  assert.deepEqual(service.getTurnSelection(first.work.id), selection);
  assert.equal(service.getInstructionMessageIds(first.work.id), undefined);
  assert.throws(
    () => database.raw.prepare(
      "UPDATE work_turn_selections SET requested_model_alias = 'terra' WHERE work_id = ?",
    ).run(first.work.id),
    /work turn selection is immutable/,
  );
  assert.throws(
    () => database.raw.prepare("DELETE FROM work_turn_selections WHERE work_id = ?").run(first.work.id),
    /work turn selection is immutable/,
  );

  database.reopen();
  service = createWorkService({ database, generateId, now: () => new Date(AT) });
  const replay = service.create(creationInput(manifestInput(), selection));
  assert.equal(replay.replayed, true);
  assert.equal(replay.work.id, first.work.id);
  assert.equal(replay.wakeOutboxId, first.wakeOutboxId);
  assert.deepEqual(service.getTurnSelection(first.work.id), selection);
  assert.equal(service.getInstructionMessageIds(first.work.id), undefined);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM works")?.count, 1);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM outbox")?.count, 1);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM context_manifests")?.count, 1);
  assert.equal(
    database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM works WHERE idempotency_key_digest = ?",
      first.work.idempotencyKeyDigest,
    )?.count,
    1,
  );
  assert.equal(
    database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM works WHERE idempotency_key_digest = ?",
      creationInput().idempotencyKey,
    )?.count,
    0,
  );
  const events = database.readAll<{ type: string; payloadJson: string }>(
    `SELECT type, payload_json AS payloadJson FROM events
     WHERE aggregate_kind IN ('work', 'outbox') ORDER BY sequence`,
  );
  assert.deepEqual(events.map((event) => event.type), ["turn.updated", "activity.updated"]);
  assert.doesNotMatch(JSON.stringify(events), /not exposed|m11-stable-create-key/);
});

test("an idempotency retry with a different request is rejected without duplicate durable intent", async (t) => {
  const { WorkError, createWorkService } = await import("../../../src/coordination/work/index.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const service = createWorkService({
    database,
    generateId: createFixtureIdGenerator(),
    now: () => new Date(AT),
  });
  service.create(creationInput(manifestInput(), { modelAlias: "sol", reasoningEffort: "high" }));

  assert.throws(
    () => service.create({
      ...creationInput(manifestInput(), { modelAlias: "sol", reasoningEffort: "high" }),
      kind: "different_turn",
    }),
    (error: unknown) => error instanceof WorkError && error.code === "idempotency_conflict",
  );
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM works")?.count, 1);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM outbox")?.count, 1);
  assert.throws(
    () => service.create(creationInput(manifestInput(), {
      modelAlias: "terra",
      reasoningEffort: "high",
    })),
    (error: unknown) => error instanceof WorkError && error.code === "idempotency_conflict",
  );
  assert.deepEqual(service.getTurnSelection(
    database.readOne<{ id: string }>("SELECT id FROM works")!.id,
  ), { modelAlias: "sol", reasoningEffort: "high" });
});

test("legacy Work creation defaults to an explicit durable no-override selection", async (t) => {
  const { createWorkService, WorkError } = await import("../../../src/coordination/work/index.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const service = createWorkService({
    database,
    generateId: createFixtureIdGenerator(),
    now: () => new Date(AT),
  });
  const created = service.create(creationInput());
  assert.equal(service.getInstructionMessageIds(created.work.id), undefined);
  assert.deepEqual(service.getTurnSelection(created.work.id), {
    modelAlias: null,
    reasoningEffort: null,
  });
  assert.throws(
    () => service.create(creationInput(manifestInput(), {
      modelAlias: "sol\nsmuggled",
      reasoningEffort: "high",
    })),
    (error: unknown) => error instanceof WorkError && error.code === "invalid_request",
  );
});

test("context manifests reject IDs, counts, privacy, and content-bearing or locator fields", async (t) => {
  const { WorkError, createWorkService } = await import("../../../src/coordination/work/index.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const service = createWorkService({
    database,
    generateId: createFixtureIdGenerator(),
    now: () => new Date(AT),
  });

  const invalid = [
    manifestInput({ privacy: "resident_private" }),
    manifestInput({ messageIds: ["msg_not-an-id"] }),
    manifestInput({ counts: { messages: 2, artifacts: 0 } }),
    { ...manifestInput(), body: "must not persist" },
    { ...manifestInput(), workspacePath: "/private/work" },
    manifestInput({ artifactIds: [fixtureId("message", 99)] }),
  ];
  for (const manifest of invalid) {
    assert.throws(
      () => service.create(creationInput(manifest)),
      (error: unknown) => error instanceof WorkError && error.code === "invalid_manifest",
    );
  }
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM works")?.count, 0);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM outbox")?.count, 0);
});

test("recovery refusals are durable: permanent ones leave the recovery lists, transient ones count toward the limit", async (t) => {
  const { RECOVERY_REFUSAL_LIMIT, WorkError, createWorkService } = await import("../../../src/coordination/work/index.js");
  const { createLeaseService } = await import("../../../src/coordination/leases/index.js");
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const generateId = createFixtureIdGenerator();
  let service = createWorkService({ database, generateId, now: () => new Date(AT) });
  const leases = createLeaseService({ database, generateId, now: () => new Date(AT), leaseTtlMs: 60_000 });
  const identity = (suffix: number) => ({
    requestId: fixtureId("request", suffix), correlationId: fixtureId("correlation", suffix),
  });
  const listed = (workId: string) =>
    service.listResidentRecoverable("resident_turn").some((work) => work.id === workId);

  const transient = service.create({ ...creationInput(), idempotencyKey: "refusal-transient" }).work;
  assert.equal(listed(transient.id), true);
  assert.equal(service.getRecoveryRefusal(transient.id), null);
  for (let count = 1; count < RECOVERY_REFUSAL_LIMIT; count += 1) {
    const recorded = service.recordRecoveryRefusal({
      workId: transient.id, reasonCode: "recovery_failed", permanent: false,
      message: "direct-message target is not enabled", ...identity(100 + count),
    });
    assert.deepEqual(recorded, {
      workId: transient.id, reasonCode: "recovery_failed", permanent: false,
      refusalCount: count, message: "direct-message target is not enabled", recordedAt: AT,
    });
    assert.equal(listed(transient.id), true, "a transient refusal keeps the Work discoverable");
    assert.deepEqual(service.getRecoveryRefusal(transient.id), recorded);
  }
  const limit = service.recordRecoveryRefusal({
    workId: transient.id, reasonCode: "recovery_failed", permanent: false,
    message: "direct-message target is not enabled", ...identity(110),
  });
  assert.equal(limit.refusalCount, RECOVERY_REFUSAL_LIMIT);
  assert.equal(limit.permanent, true, "the refusal limit makes a repeated transient refusal permanent");
  assert.equal(listed(transient.id), false);
  assert.equal(service.get(transient.id)?.state, "queued", "a refusal records evidence, never a fabricated transition");

  const permanent = service.create({
    ...creationInput(), idempotencyKey: "refusal-permanent", originMessageId: MESSAGE_ID,
  }).work;
  assert.equal(listed(permanent.id), true);
  const first = service.recordRecoveryRefusal({
    workId: permanent.id, reasonCode: "context_unrecoverable", permanent: true,
    message: "invalid_relation", ...identity(120),
  });
  assert.equal(first.refusalCount, 1);
  assert.equal(first.permanent, true);
  assert.equal(listed(permanent.id), false, "a permanent refusal leaves the recovery list at once");

  const completed = service.create({ ...creationInput(), idempotencyKey: "refusal-completed" }).work;
  const offered = leases.offer({
    workId: completed.id, holderPrincipalId: BOT_ID, holderInstanceId: "resident-1",
    authorityReference: "resident:jerry", automatic: true, ...identity(130),
  });
  const binding = {
    workId: completed.id, attemptId: offered.attempt.id, leaseId: offered.lease.id,
    holderPrincipalId: BOT_ID, holderInstanceId: "resident-1", fencingToken: offered.fencingToken,
    ...identity(131),
  };
  leases.accept(binding);
  leases.start(binding);
  leases.terminalize({ ...binding, receipt: {
    status: "succeeded", sourceReference: "resident:jerry", resultDigest: "c".repeat(64),
    artifactIds: [], timestamp: AT,
  } });
  assert.equal(service.listSucceededMissingResult("resident_turn").some((work) => work.id === completed.id), true);
  service.recordRecoveryRefusal({
    workId: completed.id, reasonCode: "unsupported_attachments", permanent: true,
    message: "direct-message Work contains unsupported attachments", ...identity(132),
  });
  assert.equal(service.listSucceededMissingResult("resident_turn").some((work) => work.id === completed.id), false);

  // The refusal is evidence on the Work, so it survives a Core restart.
  database.reopen();
  service = createWorkService({ database, generateId, now: () => new Date(AT) });
  assert.deepEqual(service.listResidentRecoverable("resident_turn").map((work) => work.id), []);
  assert.deepEqual(service.listSucceededMissingResult("resident_turn").map((work) => work.id), []);
  assert.equal(service.getRecoveryRefusal(permanent.id)?.reasonCode, "context_unrecoverable");
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM events WHERE aggregate_kind = 'work_recovery_refusal'",
  )?.count, RECOVERY_REFUSAL_LIMIT + 2);

  assert.throws(() => service.recordRecoveryRefusal({
    workId: fixtureId("work", 999), reasonCode: "recovery_failed", permanent: false, message: "", ...identity(140),
  }), (error: unknown) => error instanceof WorkError && error.code === "not_found");
  assert.throws(() => service.recordRecoveryRefusal({
    workId: permanent.id, reasonCode: "Not A Code", permanent: true, message: "", ...identity(141),
  }), (error: unknown) => error instanceof WorkError && error.code === "invalid_request");
});
