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

function creationInput(manifest = manifestInput()) {
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
  };
}

test("Work creation and its one wake intent survive reopen and exact retry", async (t) => {
  const { createWorkService } = await import("../../../src/coordination/work/index.js")
    .catch((error: unknown) => assert.fail(`M11 Work service is unavailable: ${String(error)}`));
  const database = M11TestDatabase.temporary();
  t.after(() => database.close());
  const generateId = createFixtureIdGenerator();
  let service = createWorkService({ database, generateId, now: () => new Date(AT) });

  const first = service.create(creationInput());
  assert.equal(first.replayed, false);
  assert.equal(first.work.state, "queued");
  assert.equal(first.work.currentAttemptId, null);
  assert.equal(first.manifest.privacy, "channel_only");
  assert.equal(first.manifest.messageCount, 1);
  assert.equal(first.manifest.artifactCount, 0);

  database.reopen();
  service = createWorkService({ database, generateId, now: () => new Date(AT) });
  const replay = service.create(creationInput());
  assert.equal(replay.replayed, true);
  assert.equal(replay.work.id, first.work.id);
  assert.equal(replay.wakeOutboxId, first.wakeOutboxId);
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
  service.create(creationInput());

  assert.throws(
    () => service.create({ ...creationInput(), kind: "different_turn" }),
    (error: unknown) => error instanceof WorkError && error.code === "idempotency_conflict",
  );
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM works")?.count, 1);
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM outbox")?.count, 1);
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
