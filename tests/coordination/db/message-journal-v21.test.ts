import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import { runMutationWithEvent, type CoordinationEventInput } from "../../../src/coordination/db/transaction.js";
import { COORDINATION_MIGRATIONS } from "../../../src/coordination/migrations/index.js";

const TIME = "2026-09-24T04:00:00.000Z";
const CHANNEL = "chn_0198d95f-6c00-7000-8000-000000001001";
const ID = (prefix: string, number: number) =>
  `${prefix}_0198d95f-6c00-7000-8000-${String(number).padStart(12, "0")}`;

function fixture(t: test.TestContext): Database.Database {
  const db = new Database(":memory:");
  t.after(() => db.close());
  db.pragma("foreign_keys = ON");
  for (const migration of COORDINATION_MIGRATIONS) db.exec(migration.sql);
  db.pragma("user_version = 21");
  db.prepare("INSERT INTO principals (id, kind, created_at) VALUES ('user_owner', 'owner', ?)").run(TIME);
  db.prepare(`INSERT INTO channels (
    id, kind, title, purpose, owner_principal_id, responder_mode,
    coordinator_bot_id, response_order, max_bot_turns, lifecycle, pinned,
    version, next_message_sequence, created_at, updated_at
  ) VALUES (?, 'direct', 'Home', '', 'user_owner', 'mentions_only', NULL,
    'parallel', 1, 'active', 0, 1, 1, ?, ?)`).run(CHANNEL, TIME, TIME);
  db.prepare(`INSERT INTO channel_members (
    channel_id, principal_id, kind, role, active, joined_at, left_at
  ) VALUES (?, 'user_owner', 'owner', 'owner', 1, ?, NULL)`).run(CHANNEL, TIME);
  return db;
}

function addMessage(db: Database.Database, number: number, body: string | null = "hello", tombstone: string | null = null): void {
  db.prepare(`INSERT INTO messages (
    id, channel_id, channel_sequence, author_principal_id, author_kind,
    author_display_name, kind, body_text, stored_visibility, client_message_id,
    reply_to_message_id, tombstones_message_id, round_id, work_id, created_at
  ) VALUES (?, ?, ?, 'user_owner', 'owner', 'Owner', ?, ?, 'visible',
    NULL, NULL, ?, NULL, NULL, ?)`).run(
    ID("msg", number), CHANNEL, number, tombstone ? "system" : "text", body,
    tombstone, TIME,
  );
}

function event(number: number, type = "message.appended"): CoordinationEventInput {
  const message = type === "message.appended";
  return {
    type,
    aggregateKind: message ? "message" : "channel",
    aggregateId: message ? ID("msg", number) : CHANNEL,
    aggregateVersion: message ? 1 : number,
    channelId: CHANNEL,
    actorPrincipalId: "user_owner",
    requestId: ID("req", number), correlationId: ID("cor", number),
    payload: { number }, createdAt: TIME,
  };
}

function watermark(db: Database.Database): { sourceRows: number; indexedRows: number } {
  return db.prepare(`SELECT source_rows AS sourceRows, indexed_rows AS indexedRows
    FROM search_watermarks WHERE source_class = 'coordination.messages'`).get() as never;
}

test("v21 ordinary events do not scan historical Messages", (t) => {
  const db = fixture(t);
  runMutationWithEvent(db, () => ({ value: null, event: event(1, "bot.updated") }));
  const sql = db.prepare(`SELECT sql FROM sqlite_schema
    WHERE name = 'event_requires_canonical_message_journal'`).get() as { sql: string };
  assert.match(sql.sql, /message_journal_pending/);
  assert.doesNotMatch(sql.sql, /FROM messages/);
  assert.equal(db.prepare("SELECT count(*) AS count FROM message_journal_pending").get()?.count, 0);
});

test("v21 journals one and several Messages and advances the search watermark", (t) => {
  const db = fixture(t);
  runMutationWithEvent(db, () => {
    addMessage(db, 1);
    return { value: null, event: event(1) };
  });
  assert.deepEqual(watermark(db), { sourceRows: 1, indexedRows: 1 });
  runMutationWithEvent(db, () => {
    addMessage(db, 2, "second");
    addMessage(db, 3, "third");
    return { value: null, events: [event(2), {
      ...event(3), requestId: ID("req", 2), correlationId: ID("cor", 2),
    }] as const };
  });
  assert.deepEqual(watermark(db), { sourceRows: 3, indexedRows: 3 });
  assert.equal(db.prepare("SELECT count(*) AS count FROM message_journal_pending").get()?.count, 0);
  runMutationWithEvent(db, () => {
    addMessage(db, 4, null, ID("msg", 1));
    return { value: null, event: event(4) };
  });
  assert.deepEqual(watermark(db), { sourceRows: 2, indexedRows: 2 });
  assert.equal(db.prepare("SELECT count(*) AS count FROM message_fts").get()?.count, 2);
});

test("v21 rolls back missing, forged, and unindexed Message events", (t) => {
  const db = fixture(t);
  assert.throws(() => runMutationWithEvent(db, () => {
    addMessage(db, 1);
    addMessage(db, 2);
    return { value: null, event: event(1) };
  }), /every Message requires one exact canonical journal event/);
  assert.equal(db.prepare("SELECT count(*) AS count FROM messages").get()?.count, 0);
  assert.throws(() => runMutationWithEvent(db, () => {
    addMessage(db, 1);
    return { value: null, event: event(1, "channel.updated") };
  }), /every Message requires one exact canonical journal event/);
  assert.throws(() => runMutationWithEvent(db, () => {
    addMessage(db, 1);
    return { value: null, event: { ...event(1), aggregateId: ID("msg", 99) } };
  }), /exact canonical search projection/);
  assert.throws(() => runMutationWithEvent(db, () => {
    addMessage(db, 1);
    db.prepare("UPDATE message_fts SET body_text = 'forged' WHERE message_id = ?").run(ID("msg", 1));
    return { value: null, event: event(1) };
  }), /exact canonical search projection/);
  assert.equal(db.prepare("SELECT count(*) AS count FROM messages").get()?.count, 0);
  assert.deepEqual(watermark(db), { sourceRows: 0, indexedRows: 0 });
});
