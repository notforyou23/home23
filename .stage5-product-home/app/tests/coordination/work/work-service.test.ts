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
