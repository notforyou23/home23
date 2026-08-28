import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import {
  CommunicationEventConflictError,
  SqliteCommunicationEventRepository,
  type AppendCommunicationEventInput,
} from "../../../src/coordination/communications/index.js";
import {
  canonicalCoordinationJson,
  openCoordinationDatabase,
} from "../../../src/coordination/db/index.js";

const UUID = "0198d95f-6c00-7000-8000-000000000021";
const UUID_2 = "0198d95f-6c00-7000-8000-000000000022";
const CONVERSATION_ID = `cnv_${UUID}`;
const CHANNEL_ID = `chn_${UUID}`;
const BOT_ID = `bot_${UUID}`;
const REQUEST_ID = `req_${UUID}`;
const CORRELATION_ID = `cor_${UUID}`;
const EVENT_ID = `cevt_${UUID}`;

function temporaryDatabase(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "home23-communications-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "coordination.sqlite3");
}

function appendInput(
  event: Partial<AppendCommunicationEventInput["event"]> = {},
): AppendCommunicationEventInput {
  return {
    requestId: REQUEST_ID,
    correlationId: CORRELATION_ID,
    event: {
      schemaVersion: 1,
      eventId: EVENT_ID,
      conversationId: CONVERSATION_ID,
      channelId: CHANNEL_ID,
      messageId: `msg_${UUID}`,
      workId: `wrk_${UUID}`,
      attemptId: `att_${UUID}`,
      turnId: "turn_resident_exact_1",
      parentEventId: null,
      actor: {
        principalId: BOT_ID,
        displayName: "Jerry",
        kind: "resident_bot",
        additionalFields: {
          futureActorReceipt: { role: "primary", rank: 1 },
        },
      },
      source: {
        system: "provider",
        provider: "openai-codex",
        model: "gpt-5.6",
        adapter: "responses_api",
        sourceEventType: "response.reasoning_text.delta",
        additionalFields: {
          providerSequence: 9_007_199_254_740_991,
        },
      },
      kind: "reasoning",
      provenance: "provider_verbatim_reasoning",
      occurredAt: "2026-08-27T12:00:00.000Z",
      payload: {
        text: "Exact provider reasoning\n/Users/jtr/private and bearer stays exact",
        nested: {
          whitespace: "  exact  ",
          values: [true, null, 42],
        },
      },
      terminal: false,
      additionalFields: {
        futureEnvelope: { exact: "retained" },
      },
      ...event,
    },
  };
}

test("lossless communication evidence is globally ordered, indexed, and durable across restart", (t) => {
  const path = temporaryDatabase(t);
  let database = openCoordinationDatabase({ path });
  let repository = new SqliteCommunicationEventRepository(database);

  const inserted = repository.append(appendInput());
  assert.equal(inserted.outcome, "inserted");
  assert.equal(inserted.event.eventSequence, 1);
  assert.equal(inserted.event.schemaVersion, 1);
  assert.deepEqual(inserted.event.additionalFields, {
    futureEnvelope: { exact: "retained" },
  });
  assert.deepEqual(inserted.event.actor.futureActorReceipt, { rank: 1, role: "primary" });
  assert.equal(inserted.event.source.providerSequence, 9_007_199_254_740_991);
  assert.equal(
    inserted.event.payload.text,
    "Exact provider reasoning\n/Users/jtr/private and bearer stays exact",
  );

  const stored = database.readOne<{
    sequence: number;
    type: string;
    aggregateKind: string;
    payload: string;
  }>(
    `SELECT sequence, type, aggregate_kind AS aggregateKind, payload_json AS payload
     FROM events WHERE sequence = 1`,
  );
  assert.equal(stored?.type, "communication.recorded");
  assert.equal(stored?.aggregateKind, "communication");
  assert.equal(
    canonicalCoordinationJson(JSON.parse(stored!.payload).communication),
    canonicalCoordinationJson({
      ...inserted.event.additionalFields,
      ...Object.fromEntries(
        Object.entries(inserted.event).filter(([key]) => key !== "additionalFields"),
      ),
    }),
  );

  database.close();
  database = openCoordinationDatabase({ path });
  repository = new SqliteCommunicationEventRepository(database);
  assert.deepEqual(repository.get(EVENT_ID), inserted.event);
  const history = repository.history({
    afterSequence: 0,
    limit: 20,
    requestId: REQUEST_ID,
  });
  assert.equal(history.kind, "events");
  if (history.kind === "events") {
    assert.deepEqual(history.events, [inserted.event]);
    assert.equal(history.throughSequence, 1);
    assert.equal(history.currentSequence, 1);
    assert.equal(history.hasMore, false);
  }
  database.close();
});

test("stable event identity makes exact replay a no-op and conflicting replay red", (t) => {
  const database = openCoordinationDatabase({ path: temporaryDatabase(t) });
  t.after(() => database.close());
  const repository = new SqliteCommunicationEventRepository(database);

  const first = repository.append(appendInput());
  const duplicate = repository.append(appendInput());
  assert.equal(first.outcome, "inserted");
  assert.equal(duplicate.outcome, "duplicate");
  assert.deepEqual(duplicate.event, first.event);
  assert.equal(
    database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM events WHERE type = 'communication.recorded'",
    )?.count,
    1,
  );

  assert.throws(
    () => repository.append(appendInput({ payload: { text: "conflicting value" } })),
    (error: unknown) =>
      error instanceof CommunicationEventConflictError && error.eventId === EVENT_ID,
  );
  assert.equal(
    database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM events WHERE type = 'communication.recorded'",
    )?.count,
    1,
  );
});

test("communication history shares the global cursor across unrelated durable events and paginates exactly", (t) => {
  const database = openCoordinationDatabase({ path: temporaryDatabase(t) });
  t.after(() => database.close());
  const repository = new SqliteCommunicationEventRepository(database);
  const first = repository.append(appendInput());

  database.mutateWithEvent(() => ({
    value: null,
    event: {
      type: "kernel.unrelated",
      aggregateKind: "test",
      aggregateId: "unrelated",
      aggregateVersion: 1,
      channelId: null,
      actorPrincipalId: null,
      requestId: REQUEST_ID,
      correlationId: CORRELATION_ID,
      payload: { exact: true },
      createdAt: "2026-08-27T12:00:01.000Z",
    },
  }));
  const second = repository.append(appendInput({
    eventId: `cevt_${UUID_2}`,
    kind: "future_provider_event",
    provenance: "future_provenance",
    occurredAt: "2026-08-27T12:00:02.000Z",
    payload: { future: { nested: "exact" } },
  }));
  assert.equal(first.event.eventSequence, 1);
  assert.equal(second.event.eventSequence, 3);

  const page1 = repository.history({ afterSequence: 0, limit: 1, requestId: REQUEST_ID });
  assert.equal(page1.kind, "events");
  if (page1.kind !== "events") return;
  assert.deepEqual(page1.events.map((event) => event.eventSequence), [1]);
  assert.equal(page1.throughSequence, 1);
  assert.equal(page1.hasMore, true);

  const page2 = repository.history({
    afterSequence: page1.throughSequence,
    limit: 10,
    requestId: REQUEST_ID,
  });
  assert.equal(page2.kind, "events");
  if (page2.kind !== "events") return;
  assert.deepEqual(page2.events.map((event) => event.eventSequence), [3]);
  assert.equal(page2.throughSequence, 3);
  assert.equal(page2.currentSequence, 3);
  assert.equal(page2.hasMore, false);
});

test("reasoning provenance and JSON numeric fidelity are enforced before cursor advance", (t) => {
  const database = openCoordinationDatabase({ path: temporaryDatabase(t) });
  t.after(() => database.close());
  const repository = new SqliteCommunicationEventRepository(database);

  assert.throws(
    () => repository.append(appendInput({ provenance: null })),
    /reasoning provenance must be a nonempty string/,
  );
  assert.throws(
    () => repository.append(appendInput({ payload: { unsafe: 9_007_199_254_740_992 } })),
    /payload must be a lossless JSON object/,
  );
  assert.equal(
    database.readOne<{ count: number }>("SELECT count(*) AS count FROM events")?.count,
    0,
  );
});

test("a retained global sequence gap returns explicit bootstrap-required reset", (t) => {
  const path = temporaryDatabase(t);
  let database = openCoordinationDatabase({ path });
  const repository = new SqliteCommunicationEventRepository(database);
  repository.append(appendInput());
  repository.append(appendInput({
    eventId: `cevt_${UUID_2}`,
    occurredAt: "2026-08-27T12:00:01.000Z",
  }));
  database.close();

  const tamper = new Database(path);
  tamper.prepare("DELETE FROM events WHERE sequence = 1").run();
  tamper.close();

  database = openCoordinationDatabase({ path });
  t.after(() => database.close());
  const reopened = new SqliteCommunicationEventRepository(database);
  const result = reopened.history({ afterSequence: 0, limit: 20, requestId: REQUEST_ID });
  assert.equal(result.kind, "reset");
  if (result.kind === "reset") {
    assert.equal(result.error.details.bootstrapRequired, true);
    assert.equal(result.error.details.reason, "cursor_expired");
    assert.equal(result.error.details.retentionFloorSequence, 2);
  }
});
