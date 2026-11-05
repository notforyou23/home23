import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENT_HEARTBEAT_MS,
  EventSequenceCursor,
  ResumableSsePump,
  SqliteEventRepository,
  resolveEventResumeSequence,
  type EventEnvelope,
  type SseSink,
} from "../../../src/coordination/events/index.js";
import {
  TestMessagingDatabase,
  fixtureId,
} from "../messaging/test-fixture.js";

const RESUME_REQUEST_ID = fixtureId("request", 9901);

test("Last-Event-ID and after resolve to one strict resume cursor", () => {
  assert.equal(resolveEventResumeSequence({}), 0);
  assert.equal(resolveEventResumeSequence({ after: 7 }), 7);
  assert.equal(resolveEventResumeSequence({ lastEventId: "7" }), 7);
  assert.equal(resolveEventResumeSequence({ after: 7, lastEventId: "7" }), 7);
  assert.throws(
    () => resolveEventResumeSequence({ after: 7, lastEventId: "8" }),
    /event resume cursors disagree/,
  );
  assert.throws(
    () => resolveEventResumeSequence({ lastEventId: "7.5" }),
    /Last-Event-ID must be a decimal nonnegative safe integer/,
  );
});

function appendEvent(
  database: TestMessagingDatabase,
  suffix: number,
  aggregateVersion = 1,
) {
  return database.mutateWithEvent((transaction) => {
    transaction.run(
      "INSERT OR REPLACE INTO kernel_meta (key, value, updated_at) VALUES (?, ?, ?)",
      `event-test-${suffix}`,
      String(suffix),
      "2026-08-25T12:00:00.000Z",
    );
    return {
      value: suffix,
      event: {
        type: "activity.updated",
        aggregateKind: "event_test",
        aggregateId: `aggregate-${suffix}`,
        aggregateVersion,
        channelId: null,
        actorPrincipalId: null,
        requestId: fixtureId("request", suffix),
        correlationId: fixtureId("correlation", suffix),
        payload: { nested: { suffix }, stable: true },
        createdAt: "2026-08-25T12:00:00.000Z",
      },
    };
  }).event;
}

function firstEventAfter(
  repository: SqliteEventRepository,
  afterSequence: number,
): EventEnvelope {
  const resumed = repository.resumeAfter(afterSequence, 1, RESUME_REQUEST_ID);
  assert.equal(resumed.kind, "events");
  if (resumed.kind !== "events" || !resumed.events[0]) {
    throw new Error("expected one resumable event");
  }
  return resumed.events[0];
}

test("resume reads canonical M04 events strictly after the cursor and reconnect loses none", (t) => {
  const database = new TestMessagingDatabase();
  t.after(() => database.close());
  const first = appendEvent(database, 101);
  const second = appendEvent(database, 102);
  const third = appendEvent(database, 103);
  const repository = new SqliteEventRepository(database);

  const disconnected = repository.resumeAfter(0, 2, RESUME_REQUEST_ID);
  assert.equal(disconnected.kind, "events");
  if (disconnected.kind !== "events") return;
  assert.deepEqual(disconnected.events.map((event) => event.sequence), [
    first.sequence,
    second.sequence,
  ]);
  assert.deepEqual(disconnected.events[0]?.aggregate, {
    kind: "event_test",
    id: "aggregate-101",
    version: 1,
  });
  assert.deepEqual(disconnected.events[0]?.payload, {
    nested: { suffix: 101 },
    stable: true,
  });
  assert.equal(disconnected.hasMore, true);

  const reconnected = repository.resumeAfter(second.sequence, 10, RESUME_REQUEST_ID);
  assert.equal(reconnected.kind, "events");
  if (reconnected.kind !== "events") return;
  assert.deepEqual(reconnected.events.map((event) => event.sequence), [third.sequence]);
  assert.equal(reconnected.hasMore, false);

  const duplicateReplay = repository.resumeAfter(first.sequence, 10, RESUME_REQUEST_ID);
  assert.equal(duplicateReplay.kind, "events");
  if (duplicateReplay.kind !== "events") return;
  assert.deepEqual(duplicateReplay.events.map((event) => event.sequence), [
    second.sequence,
    third.sequence,
  ]);
  assert.equal(
    database.readOne<{ count: number }>("SELECT count(*) AS count FROM events")?.count,
    3,
  );
});

test("a duplicate is a no-op and a sequence jump orders reset instead of fabricated state", (t) => {
  const database = new TestMessagingDatabase();
  t.after(() => database.close());
  const first = appendEvent(database, 111);
  const second = appendEvent(database, 112);
  const third = appendEvent(database, 113);
  const repository = new SqliteEventRepository(database);
  const cursor = new EventSequenceCursor(first.sequence);
  const secondEnvelope = firstEventAfter(repository, first.sequence);
  const thirdEnvelopeBeforeGap = firstEventAfter(repository, second.sequence);

  assert.deepEqual(cursor.accept(secondEnvelope), {
    action: "apply",
    sequence: second.sequence,
  });
  assert.deepEqual(cursor.accept(secondEnvelope), {
    action: "duplicate",
    sequence: second.sequence,
  });
  assert.deepEqual(cursor.accept(thirdEnvelopeBeforeGap), {
    action: "apply",
    sequence: third.sequence,
  });

  database.raw.prepare("DELETE FROM events WHERE sequence = ?").run(second.sequence);
  const gap = repository.resumeAfter(first.sequence, 10, RESUME_REQUEST_ID);
  assert.equal(gap.kind, "reset");
  if (gap.kind !== "reset") return;
  assert.equal(gap.error.code, "cursor_expired");
  assert.equal(gap.error.requestId, RESUME_REQUEST_ID);
  assert.deepEqual(gap.error.details, {
    bootstrapRequired: true,
    requestedAfterSequence: first.sequence,
    retentionFloorSequence: first.sequence,
    currentSequence: third.sequence,
    reason: "sequence_gap",
  });

  const missingCursor = repository.resumeAfter(second.sequence, 10, RESUME_REQUEST_ID);
  assert.equal(missingCursor.kind, "reset");
  if (missingCursor.kind !== "reset") return;
  assert.equal(missingCursor.error.details.reason, "sequence_gap");

  const freshCursor = new EventSequenceCursor(first.sequence);
  assert.deepEqual(freshCursor.accept(thirdEnvelopeBeforeGap), {
    action: "reset",
    expectedSequence: second.sequence,
    receivedSequence: third.sequence,
  });

  database.raw.prepare("DELETE FROM events WHERE sequence = ?").run(third.sequence);
  const missingTailCursor = repository.resumeAfter(third.sequence, 10, RESUME_REQUEST_ID);
  assert.equal(missingTailCursor.kind, "reset");
  if (missingTailCursor.kind !== "reset") return;
  assert.equal(missingTailCursor.error.details.reason, "sequence_gap");
});

test("a malformed envelope is rejected without advancing while an unknown valid type advances", (t) => {
  const database = new TestMessagingDatabase();
  t.after(() => database.close());
  const first = appendEvent(database, 116);
  appendEvent(database, 117);
  const repository = new SqliteEventRepository(database);
  const next = firstEventAfter(repository, first.sequence);
  const cursor = new EventSequenceCursor(first.sequence);

  assert.throws(
    () => cursor.accept({ ...next, requestId: "not-a-request-id" }),
    /event envelope request ID is invalid/,
  );
  assert.throws(
    () => cursor.accept({ ...next, type: "future.ok\ndata: injected" }),
    /event envelope type cannot contain SSE line breaks/,
  );
  assert.throws(
    () => cursor.accept({
      ...next,
      payload: { observedAt: new Date("2026-08-25T12:00:00.000Z") },
    } as unknown as EventEnvelope),
    /event envelope payload must be a JSON object/,
  );
  assert.equal(cursor.throughSequence, first.sequence);
  assert.deepEqual(cursor.accept({ ...next, type: "future.contract_event" }), {
    action: "apply",
    sequence: next.sequence,
  });
});

test("event reads reject a payload whose stored digest no longer matches", (t) => {
  const database = new TestMessagingDatabase();
  t.after(() => database.close());
  appendEvent(database, 121);
  database.raw.prepare("UPDATE events SET payload_json = ? WHERE sequence = 1")
    .run('{"tampered":true}');

  assert.throws(
    () => new SqliteEventRepository(database).resumeAfter(0, 10, RESUME_REQUEST_ID),
    /payload digest mismatch at sequence 1/,
  );
});

test("SSE replay stops at transport backpressure, drains, then heartbeats at the contract interval", async (t) => {
  const database = new TestMessagingDatabase();
  t.after(() => database.close());
  appendEvent(database, 131);
  appendEvent(database, 132);
  const chunks: string[] = [];
  let releaseDrain!: () => void;
  const drain = new Promise<void>((resolve) => {
    releaseDrain = resolve;
  });
  let writes = 0;
  const sink: SseSink = {
    write(chunk) {
      chunks.push(chunk);
      writes += 1;
      return writes !== 1;
    },
    waitForDrain: () => drain,
  };
  let nowMs = 0;
  const pump = new ResumableSsePump({
    repository: new SqliteEventRepository(database),
    sink,
    now: () => nowMs,
    batchSize: 10,
    requestId: RESUME_REQUEST_ID,
  });

  const replaying = pump.replay(0);
  await Promise.resolve();
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]!, /^id: 1\nevent: activity\.updated\ndata: /);
  releaseDrain();
  const replay = await replaying;
  assert.deepEqual(replay, { kind: "ready", throughSequence: 2, eventsWritten: 2 });
  assert.equal(chunks.length, 2);

  nowMs = EVENT_HEARTBEAT_MS - 1;
  assert.equal(await pump.heartbeatIfDue(), false);
  nowMs = EVENT_HEARTBEAT_MS;
  assert.equal(await pump.heartbeatIfDue(), true);
  assert.equal(chunks.at(-1), ": heartbeat\n\n");
});

test("heartbeat writes serialize behind a replay waiting for transport drain", async (t) => {
  const database = new TestMessagingDatabase();
  t.after(() => database.close());
  appendEvent(database, 141);
  const chunks: string[] = [];
  let releaseDrain!: () => void;
  const drain = new Promise<void>((resolve) => {
    releaseDrain = resolve;
  });
  const sink: SseSink = {
    write(chunk) {
      chunks.push(chunk);
      return chunks.length !== 1;
    },
    waitForDrain: () => drain,
  };
  let nowMs = 0;
  const pump = new ResumableSsePump({
    repository: new SqliteEventRepository(database),
    sink,
    now: () => nowMs,
    requestId: RESUME_REQUEST_ID,
  });

  const replaying = pump.replay(0);
  await Promise.resolve();
  assert.equal(chunks.length, 1);
  nowMs = EVENT_HEARTBEAT_MS;
  const heartbeating = pump.heartbeatIfDue();
  await Promise.resolve();
  assert.equal(chunks.length, 1, "no write may bypass a pending drain");

  releaseDrain();
  assert.deepEqual(await replaying, {
    kind: "ready",
    throughSequence: 1,
    eventsWritten: 1,
  });
  assert.equal(await heartbeating, true);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1], ": heartbeat\n\n");
});

test("SSE detects a retained gap beyond the first DB page before writing partial state", async (t) => {
  const database = new TestMessagingDatabase();
  t.after(() => database.close());
  appendEvent(database, 151);
  appendEvent(database, 152);
  const missing = appendEvent(database, 153);
  appendEvent(database, 154);
  database.raw.prepare("DELETE FROM events WHERE sequence = ?").run(missing.sequence);
  const chunks: string[] = [];
  const pump = new ResumableSsePump({
    repository: new SqliteEventRepository(database),
    sink: {
      write(chunk) {
        chunks.push(chunk);
        return true;
      },
      waitForDrain: async () => undefined,
    },
    batchSize: 2,
    requestId: RESUME_REQUEST_ID,
  });

  const result = await pump.replay(0);
  assert.equal(result.kind, "reset");
  if (result.kind !== "reset") return;
  assert.equal(result.error.details.reason, "sequence_gap");
  assert.deepEqual(chunks, []);
});
