import assert from "node:assert/strict";
import test from "node:test";

import {
  MessagingError,
  createChannelService,
} from "../../../src/coordination/channels/index.js";
import { createMessageService } from "../../../src/coordination/messages/index.js";
import { createUnreadService } from "../../../src/coordination/unread/index.js";

import {
  OWNER_ID,
  createMessagingFixture,
  fixtureId,
  ownerContext,
  residentContext,
} from "./test-fixture.js";

function sendKey(suffix: number): string {
  return `m08-unread-send-${String(suffix).padStart(6, "0")}`;
}

const channelKey = (suffix: number) =>
  `m08-unread-channel-${String(suffix).padStart(6, "0")}`;
const readKey = (suffix: number) =>
  `m08-unread-cursor-${String(suffix).padStart(6, "0")}`;

test("read cursors advance monotonically and unread matches committed authorship", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const channels = createChannelService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });
  const messages = createMessageService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    now: () => fixture.clock.value,
  });
  const unread = createUnreadService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    now: () => fixture.clock.value,
  });
  const direct = await channels.createDirectConversation({
    context: ownerContext(501),
    memberBotIds: [fixture.bots.jerry.principalId],
    pinned: false,
    idempotencyKey: channelKey(501),
  });

  await messages.sendMessage({
    context: ownerContext(502),
    channelId: direct.channel.id,
    messageId: fixtureId("message", 502),
    authorPrincipalId: OWNER_ID,
    idempotencyKey: sendKey(502),
    kind: "text",
    text: "My own message is not unread to me.",
    mentions: [],
    clientMessageId: null,
    replyToMessageId: null,
    tombstonesMessageId: null,
    provenance: { roundId: null, workId: null },
  });
  for (const suffix of [503, 504]) {
    await messages.sendMessage({
      context: residentContext(fixture.bots.jerry, "jerry", suffix),
      channelId: direct.channel.id,
      messageId: fixtureId("message", suffix),
      authorPrincipalId: fixture.bots.jerry.principalId,
      idempotencyKey: sendKey(suffix),
      kind: "result",
      text: `Resident reply ${suffix}`,
      mentions: [],
      clientMessageId: null,
      replyToMessageId: fixtureId("message", 502),
      tombstonesMessageId: null,
      provenance: { roundId: null, workId: null },
    });
  }

  const initial = await unread.getUnread({
    context: ownerContext(505, ["product:read"]),
    channelId: direct.channel.id,
  });
  assert.deepEqual(
    { read: initial.readThroughSequence, unread: initial.unreadCount, latest: initial.latestSequence },
    { read: 0, unread: 2, latest: 3 },
  );

  fixture.clock.value = new Date("2026-08-25T12:05:00.000Z");
  const advanced = await unread.markRead({
    context: ownerContext(506, ["product:read"]),
    channelId: direct.channel.id,
    readThroughSequence: 2,
    idempotencyKey: readKey(506),
  });
  const eventCount = fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM events WHERE type = 'unread.updated'",
  )!.count;
  const regressed = await unread.markRead({
    context: ownerContext(507, ["product:read"]),
    channelId: direct.channel.id,
    readThroughSequence: 1,
    idempotencyKey: readKey(507),
  });

  assert.deepEqual(
    { read: advanced.unread.readThroughSequence, unread: advanced.unread.unreadCount, version: advanced.unread.version },
    { read: 2, unread: 1, version: 1 },
  );
  assert.equal(regressed.unread.readThroughSequence, advanced.unread.readThroughSequence);
  assert.equal(regressed.unread.version, advanced.unread.version);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM events WHERE type = 'unread.updated'",
  )?.count, eventCount + 1);

  const complete = await unread.markRead({
    context: ownerContext(508, ["product:read"]),
    channelId: direct.channel.id,
    readThroughSequence: 3,
    idempotencyKey: readKey(508),
  });
  assert.deepEqual(
    { read: complete.unread.readThroughSequence, unread: complete.unread.unreadCount, version: complete.unread.version },
    { read: 3, unread: 0, version: 2 },
  );
  assert.throws(
    () => fixture.database.raw.prepare(
      "UPDATE read_cursors SET read_through_sequence = 1 WHERE principal_id = ? AND channel_id = ?",
    ).run(OWNER_ID, direct.channel.id),
    /read cursors cannot regress/,
  );
  assert.throws(
    () => fixture.database.raw.prepare(
      "DELETE FROM read_cursors WHERE principal_id = ? AND channel_id = ?",
    ).run(OWNER_ID, direct.channel.id),
    /read cursors cannot be deleted/,
  );
  await assert.rejects(
    unread.markRead({
      context: ownerContext(509, ["product:read"]),
      channelId: direct.channel.id,
      readThroughSequence: 4,
      idempotencyKey: readKey(509),
    }),
    (error: unknown) => error instanceof MessagingError && error.code === "sequence_out_of_range",
  );
});

test("nonmembers cannot read or move a Channel cursor", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const channels = createChannelService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });
  const unread = createUnreadService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    now: () => fixture.clock.value,
  });
  const group = await channels.createGroupChannel({
    context: ownerContext(521),
    memberBotIds: [fixture.bots.jerry.principalId, fixture.bots.forrest.principalId],
    title: "Private membership",
    purpose: "Reject a visible Bot that is not a member.",
    pinned: false,
    responderPolicy: {
      mode: "mentions_only",
      coordinatorBotId: null,
      responseOrder: "parallel",
      maxBotTurns: 2,
    },
    idempotencyKey: channelKey(521),
  });
  const outsider = residentContext(fixture.bots.records, "records-specialist", 522);

  await assert.rejects(
    unread.getUnread({ context: outsider, channelId: group.channel.id }),
    (error: unknown) => error instanceof MessagingError && error.code === "nonmember",
  );
  await assert.rejects(
    unread.markRead({
      context: outsider,
      channelId: group.channel.id,
      readThroughSequence: 0,
      idempotencyKey: readKey(522),
    }),
    (error: unknown) => error instanceof MessagingError && error.code === "nonmember",
  );
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM read_cursors",
  )?.count, 0);
});

test("Inbox ordering and unread are derived exactly from committed Channel and Message rows", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const channels = createChannelService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });
  const messages = createMessageService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    now: () => fixture.clock.value,
  });
  const unread = createUnreadService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    now: () => fixture.clock.value,
  });
  const jerry = await channels.createDirectConversation({
    context: ownerContext(531),
    memberBotIds: [fixture.bots.jerry.principalId],
    pinned: false,
    idempotencyKey: channelKey(531),
  });
  const forrest = await channels.createDirectConversation({
    context: ownerContext(532),
    memberBotIds: [fixture.bots.forrest.principalId],
    pinned: true,
    idempotencyKey: channelKey(532),
  });
  const group = await channels.createGroupChannel({
    context: ownerContext(533),
    memberBotIds: [fixture.bots.jerry.principalId, fixture.bots.forrest.principalId],
    title: "Latest group",
    purpose: "Newest unpinned conversation.",
    pinned: false,
    responderPolicy: {
      mode: "mentions_only",
      coordinatorBotId: null,
      responseOrder: "parallel",
      maxBotTurns: 2,
    },
    idempotencyKey: channelKey(533),
  });

  const sends = [
    { suffix: 534, channelId: jerry.channel.id, bot: fixture.bots.jerry, slug: "jerry", text: "Jerry row" },
    { suffix: 535, channelId: forrest.channel.id, bot: fixture.bots.forrest, slug: "forrest", text: "Forrest row" },
    { suffix: 536, channelId: group.channel.id, bot: fixture.bots.jerry, slug: "jerry", text: "Newest group row" },
  ];
  for (const [index, send] of sends.entries()) {
    fixture.clock.value = new Date(Date.parse("2026-08-25T12:10:00.000Z") + index * 60_000);
    await messages.sendMessage({
      context: residentContext(send.bot, send.slug, send.suffix),
      channelId: send.channelId,
      messageId: fixtureId("message", send.suffix),
      authorPrincipalId: send.bot.principalId,
      idempotencyKey: sendKey(send.suffix),
      kind: "result",
      text: send.text,
      mentions: [],
      clientMessageId: null,
      replyToMessageId: null,
      tombstonesMessageId: null,
      provenance: { roundId: null, workId: null },
    });
  }
  await unread.markRead({
    context: ownerContext(537, ["product:read"]),
    channelId: group.channel.id,
    readThroughSequence: 1,
    idempotencyKey: readKey(537),
  });

  const inbox = await unread.listInbox({ context: ownerContext(538, ["product:read"]) });
  assert.deepEqual(inbox.map((conversation) => conversation.channelId), [
    forrest.channel.id,
    group.channel.id,
    jerry.channel.id,
  ]);
  assert.deepEqual(inbox.map((conversation) => ({
    title: conversation.title,
    preview: conversation.latestMessage?.preview,
    unread: conversation.unread.count,
  })), [
    { title: "Forrest", preview: "Forrest row", unread: 1 },
    { title: "Latest group", preview: "Newest group row", unread: 0 },
    { title: "Jerry", preview: "Jerry row", unread: 1 },
  ]);
  assert.equal(inbox.some((conversation) =>
    "residentBinding" in conversation || "privateMemory" in conversation), false);

  const committedUnread = fixture.database.readAll<{
    channelId: string;
    count: number;
  }>(
    `SELECT m.channel_id AS channelId, count(*) AS count
     FROM messages m
     LEFT JOIN read_cursors r
       ON r.channel_id = m.channel_id AND r.principal_id = 'user_owner'
     WHERE m.author_principal_id <> 'user_owner'
       AND m.channel_sequence > coalesce(r.read_through_sequence, 0)
     GROUP BY m.channel_id
     ORDER BY m.channel_id`,
  );
  assert.deepEqual(
    inbox.filter((conversation) => conversation.unread.count > 0)
      .map((conversation) => ({ channelId: conversation.channelId, count: conversation.unread.count }))
      .sort((left, right) => left.channelId.localeCompare(right.channelId)),
    committedUnread,
  );
});

test("Inbox clears an old failed Work after a newer successful Work", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  fixture.database.raw.exec(`CREATE TABLE works (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    terminal_at TEXT
  ) STRICT;`);
  const channels = createChannelService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });
  const unread = createUnreadService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    now: () => fixture.clock.value,
  });
  const direct = await channels.createDirectConversation({
    context: ownerContext(541),
    memberBotIds: [fixture.bots.jerry.principalId],
    pinned: false,
    idempotencyKey: channelKey(541),
  });
  const insertTerminalWork = (
    suffix: number,
    state: "failed" | "succeeded",
    createdAt: string,
  ) => {
    fixture.database.raw.prepare(
      "INSERT INTO works (id, channel_id, state, created_at, terminal_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      fixtureId("work", suffix),
      direct.channel.id,
      state,
      createdAt,
      createdAt,
    );
  };

  insertTerminalWork(542, "failed", "2026-08-25T12:10:00.000Z");
  let inbox = await unread.listInbox({ context: ownerContext(543, ["product:read"]) });
  assert.equal(inbox[0]?.activity.state, "attention");

  insertTerminalWork(544, "succeeded", "2026-08-25T12:11:00.000Z");
  inbox = await unread.listInbox({ context: ownerContext(545, ["product:read"]) });
  assert.deepEqual(inbox[0]?.activity, { state: "idle", label: null, workId: null });
});
