import assert from "node:assert/strict";
import test from "node:test";

import {
  MessagingError,
  SqliteMessagingRepository,
  createChannelService,
} from "../../../src/coordination/channels/index.js";
import {
  createMessageService,
  type AppendMessageCommit,
} from "../../../src/coordination/messages/index.js";

import {
  OWNER_ID,
  createMessagingFixture,
  fixtureId,
  ownerContext,
  residentContext,
} from "./test-fixture.js";

function sendKey(suffix: number): string {
  return `m08-message-send-${String(suffix).padStart(6, "0")}`;
}

function channelKey(suffix: number): string {
  return `m08-message-channel-${String(suffix).padStart(6, "0")}`;
}

test("concurrent sends allocate unique gap-free per-Channel sequences", async (t) => {
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
  const direct = await channels.createDirectConversation({
    context: ownerContext(401),
    memberBotIds: [fixture.bots.jerry.principalId],
    pinned: false,
    idempotencyKey: channelKey(401),
  });

  const committed = await Promise.all(Array.from({ length: 24 }, (_, index) =>
    messages.sendMessage({
      context: ownerContext(410 + index),
      channelId: direct.channel.id,
      messageId: fixtureId("message", 410 + index),
      authorPrincipalId: OWNER_ID,
      idempotencyKey: sendKey(410 + index),
      kind: "text",
      text: `Ordered message ${index + 1}`,
      mentions: [],
      clientMessageId: `client-message-${index + 1}`,
      replyToMessageId: null,
      tombstonesMessageId: null,
      provenance: { roundId: null, workId: null },
    })));

  assert.deepEqual(
    committed.map((result) => result.message.sequence).sort((a, b) => a - b),
    Array.from({ length: 24 }, (_, index) => index + 1),
  );
  assert.equal(new Set(committed.map((result) => result.message.id)).size, 24);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages WHERE channel_id = ?",
    direct.channel.id,
  )?.count, 24);
  assert.equal(fixture.database.readOne<{ nextSequence: number }>(
    "SELECT next_message_sequence AS nextSequence FROM channels WHERE id = ?",
    direct.channel.id,
  )?.nextSequence, 25);
});

test("an exact send retry returns the original committed Message without another row or event", async (t) => {
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
  const direct = await channels.createDirectConversation({
    context: ownerContext(451),
    memberBotIds: [fixture.bots.jerry.principalId],
    pinned: true,
    idempotencyKey: channelKey(451),
  });
  const request = {
    context: ownerContext(452),
    channelId: direct.channel.id,
    messageId: fixtureId("message", 452),
    authorPrincipalId: OWNER_ID,
    idempotencyKey: sendKey(452),
    kind: "text" as const,
    text: "Commit this exactly once.",
    mentions: [] as const,
    clientMessageId: "client-retry-452",
    replyToMessageId: null,
    tombstonesMessageId: null,
    provenance: { roundId: null, workId: null },
    turnSelection: { modelAlias: "sol", reasoningEffort: "high" as const },
  };

  const first = await messages.sendMessage(request);
  fixture.clock.value = new Date("2026-08-25T12:05:00.000Z");
  const replay = await messages.sendMessage({
    ...request,
    context: ownerContext(453),
  });

  assert.equal(first.outcome, "committed");
  assert.equal(replay.outcome, "replayed");
  assert.deepEqual(replay.message, first.message);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages",
  )?.count, 1);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM events WHERE type = 'message.appended'",
  )?.count, 1);
  const durableIntent = JSON.parse(fixture.database.readOne<{ resultRef: string }>(
    `SELECT result_ref_json AS resultRef FROM idempotency_records
     WHERE operation = 'message.append'`,
  )!.resultRef);
  assert.deepEqual(durableIntent.turnSelection, {
    modelAlias: "sol",
    reasoningEffort: "high",
  });

  await assert.rejects(
    messages.sendMessage({ ...request, text: "A different body." }),
    (error: unknown) => error instanceof MessagingError && error.code === "idempotency_conflict",
  );
  await assert.rejects(
    messages.sendMessage({
      ...request,
      turnSelection: { modelAlias: "terra", reasoningEffort: "high" },
    }),
    (error: unknown) => error instanceof MessagingError && error.code === "idempotency_conflict",
  );
});

test("send idempotency and receipt survive repository/service restart", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const channels = createChannelService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });
  const direct = await channels.createDirectConversation({
    context: ownerContext(441),
    memberBotIds: [fixture.bots.jerry.id],
    pinned: false,
    idempotencyKey: channelKey(441),
  });
  const request = {
    context: ownerContext(442),
    channelId: direct.channel.id,
    messageId: fixtureId("message", 442),
    authorPrincipalId: OWNER_ID,
    idempotencyKey: sendKey(442),
    kind: "text" as const,
    text: "Persist the exact receipt across reconstruction.",
    mentions: [] as const,
    clientMessageId: null,
    replyToMessageId: null,
    tombstonesMessageId: null,
    provenance: { roundId: null, workId: null },
  };
  const beforeRestart = createMessageService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    now: () => fixture.clock.value,
  });
  const committed = await beforeRestart.sendMessage(request);

  const restartedRepository = new SqliteMessagingRepository(
    fixture.database,
    fixture.repositoryOptions,
  );
  const afterRestart = createMessageService({
    repository: restartedRepository,
    participantDirectory: fixture.directory,
    now: () => fixture.clock.value,
  });
  const replay = await afterRestart.sendMessage({
    ...request,
    context: ownerContext(443),
  });
  assert.equal(replay.outcome, "replayed");
  assert.deepEqual(replay.message, committed.message);
  assert.deepEqual(replay.receipt, committed.receipt);
});

test("send replay preserves the original committed response after a later tombstone", async (t) => {
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
  const direct = await channels.createDirectConversation({
    context: ownerContext(454),
    memberBotIds: [fixture.bots.jerry.principalId],
    pinned: false,
    idempotencyKey: channelKey(454),
  });
  const request = {
    context: ownerContext(455),
    channelId: direct.channel.id,
    messageId: fixtureId("message", 455),
    authorPrincipalId: OWNER_ID,
    idempotencyKey: sendKey(455),
    kind: "text" as const,
    text: "The immutable original response.",
    mentions: [] as const,
    clientMessageId: null,
    replyToMessageId: null,
    tombstonesMessageId: null,
    provenance: { roundId: null, workId: null },
  };
  const original = await messages.sendMessage(request);
  await messages.sendMessage({
    context: ownerContext(456),
    channelId: direct.channel.id,
    messageId: fixtureId("message", 456),
    authorPrincipalId: OWNER_ID,
    idempotencyKey: sendKey(456),
    kind: "system",
    text: null,
    mentions: [],
    clientMessageId: null,
    replyToMessageId: null,
    tombstonesMessageId: original.message.id,
    provenance: { roundId: null, workId: null },
  });

  const replay = await messages.sendMessage({ ...request, context: ownerContext(457) });
  assert.equal(replay.outcome, "replayed");
  assert.deepEqual(replay.message, original.message);
  const visible = await messages.listMessages({
    context: ownerContext(458, ["product:read"]),
    channelId: direct.channel.id,
    limit: 50,
  });
  assert.equal(visible.messages[0]?.visibility, "tombstoned");
  assert.equal(visible.messages[0]?.text, null);
});

test("the proposed SQLite boundary rejects in-place Message update and delete", async (t) => {
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
  const direct = await channels.createDirectConversation({
    context: ownerContext(459),
    memberBotIds: [fixture.bots.jerry.principalId],
    pinned: false,
    idempotencyKey: channelKey(459),
  });
  const committed = await messages.sendMessage({
    context: ownerContext(460),
    channelId: direct.channel.id,
    messageId: fixtureId("message", 460),
    authorPrincipalId: OWNER_ID,
    idempotencyKey: sendKey(460),
    kind: "text",
    text: "Immutable body.",
    mentions: [fixture.bots.jerry.id],
    clientMessageId: null,
    replyToMessageId: null,
    tombstonesMessageId: null,
    provenance: { roundId: null, workId: null },
  });

  assert.throws(
    () => fixture.database.raw.prepare(
      "UPDATE messages SET body_text = 'mutated' WHERE id = ?",
    ).run(committed.message.id),
    /messages are immutable/,
  );
  assert.throws(
    () => fixture.database.raw.prepare(
      "UPDATE mentions SET mentioned_principal_id = ? WHERE message_id = ?",
    ).run(fixture.bots.jerry.id, committed.message.id),
    /mentions are immutable/,
  );
  assert.throws(
    () => fixture.database.raw.prepare(
      "DELETE FROM mentions WHERE message_id = ?",
    ).run(committed.message.id),
    /mentions are immutable/,
  );
  assert.throws(
    () => fixture.database.raw.prepare(
      `INSERT INTO messages (
        id, channel_id, channel_sequence, author_principal_id, author_kind,
        author_display_name, kind, body_text, stored_visibility,
        client_message_id, reply_to_message_id, tombstones_message_id,
        round_id, work_id, created_at
      ) VALUES (?, ?, 2, ?, 'bot', 'Records', 'text', 'forged', 'visible',
                NULL, NULL, NULL, NULL, NULL, ?)`,
    ).run(
      fixtureId("message", 4610),
      direct.channel.id,
      fixture.bots.records.id,
      fixture.clock.value.toISOString(),
    ),
    /message author must be an active Channel member/,
  );
  assert.throws(
    () => fixture.database.raw.prepare("DELETE FROM messages WHERE id = ?")
      .run(committed.message.id),
    /messages are immutable/,
  );
  assert.equal(fixture.database.readOne<{ body: string }>(
    "SELECT body_text AS body FROM messages WHERE id = ?",
    committed.message.id,
  )?.body, "Immutable body.");
});

test("nonmembers and identity/context mismatches cannot send or list Messages", async (t) => {
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
  const group = await channels.createGroupChannel({
    context: ownerContext(461),
    memberBotIds: [fixture.bots.jerry.principalId, fixture.bots.forrest.principalId],
    title: "Members only",
    purpose: "Prove send and read membership.",
    pinned: false,
    responderPolicy: {
      mode: "mentions_only",
      coordinatorBotId: null,
      responseOrder: "parallel",
      maxBotTurns: 2,
    },
    idempotencyKey: channelKey(461),
  });
  const outsider = residentContext(fixture.bots.records, "records-specialist", 462);

  await assert.rejects(
    messages.sendMessage({
      context: outsider,
      channelId: group.channel.id,
      messageId: fixtureId("message", 462),
      authorPrincipalId: fixture.bots.records.principalId,
      idempotencyKey: sendKey(462),
      kind: "text",
      text: "I am not a member.",
      mentions: [],
      clientMessageId: null,
      replyToMessageId: null,
      tombstonesMessageId: null,
      provenance: { roundId: null, workId: null },
    }),
    (error: unknown) => error instanceof MessagingError && error.code === "nonmember",
  );
  await assert.rejects(
    messages.listMessages({ context: outsider, channelId: group.channel.id, limit: 50 }),
    (error: unknown) => error instanceof MessagingError && error.code === "nonmember",
  );
  await assert.rejects(
    messages.sendMessage({
      context: ownerContext(463),
      channelId: group.channel.id,
      messageId: fixtureId("message", 463),
      authorPrincipalId: fixture.bots.jerry.principalId,
      idempotencyKey: sendKey(463),
      kind: "text",
      text: "Mismatched author.",
      mentions: [],
      clientMessageId: null,
      replyToMessageId: null,
      tombstonesMessageId: null,
      provenance: { roundId: null, workId: null },
    }),
    (error: unknown) => error instanceof MessagingError && error.code === "identity_context_mismatch",
  );
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages",
  )?.count, 0);
});

test("reply, tombstone, mention, and terminal provenance relations stay bounded to one Channel", async (t) => {
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
  const group = await channels.createGroupChannel({
    context: ownerContext(471),
    memberBotIds: [fixture.bots.jerry.principalId, fixture.bots.forrest.principalId],
    title: "Relations",
    purpose: "Exercise immutable message relations.",
    pinned: false,
    responderPolicy: {
      mode: "mention_or_coordinator",
      coordinatorBotId: fixture.bots.jerry.id,
      responseOrder: "sequential",
      maxBotTurns: 3,
    },
    idempotencyKey: channelKey(471),
  });
  const other = await channels.createDirectConversation({
    context: ownerContext(472),
    memberBotIds: [fixture.bots.records.principalId],
    pinned: false,
    idempotencyKey: channelKey(472),
  });
  const terminalProvenance = {
    roundId: fixtureId("round", 473),
    workId: fixtureId("work", 473),
  };
  fixture.allowMessageProvenance({
    principalId: OWNER_ID,
    channelId: group.channel.id,
    provenance: terminalProvenance,
  });
  fixture.allowMessageProvenance({
    principalId: fixture.bots.forrest.id,
    channelId: group.channel.id,
    provenance: terminalProvenance,
  });
  const root = await messages.sendMessage({
    context: ownerContext(473),
    channelId: group.channel.id,
    messageId: fixtureId("message", 473),
    authorPrincipalId: OWNER_ID,
    idempotencyKey: sendKey(473),
    kind: "text",
    text: "Forrest, verify the receipt.",
    mentions: [fixture.bots.forrest.principalId],
    clientMessageId: "client-root-473",
    replyToMessageId: null,
    tombstonesMessageId: null,
    provenance: { roundId: fixtureId("round", 473), workId: fixtureId("work", 473) },
  });
  fixture.clock.value = new Date("2026-08-25T12:01:00.000Z");
  const reply = await messages.sendMessage({
    context: residentContext(fixture.bots.forrest, "forrest", 474),
    channelId: group.channel.id,
    messageId: fixtureId("message", 474),
    authorPrincipalId: fixture.bots.forrest.principalId,
    idempotencyKey: sendKey(474),
    kind: "result",
    text: "The receipt matches the terminal provenance.",
    mentions: [],
    clientMessageId: null,
    replyToMessageId: root.message.id,
    tombstonesMessageId: null,
    provenance: { roundId: fixtureId("round", 473), workId: fixtureId("work", 473) },
  });
  fixture.clock.value = new Date("2026-08-25T12:02:00.000Z");
  const tombstone = await messages.sendMessage({
    context: ownerContext(475),
    channelId: group.channel.id,
    messageId: fixtureId("message", 475),
    authorPrincipalId: OWNER_ID,
    idempotencyKey: sendKey(475),
    kind: "system",
    text: null,
    mentions: [],
    clientMessageId: null,
    replyToMessageId: null,
    tombstonesMessageId: reply.message.id,
    provenance: { roundId: fixtureId("round", 473), workId: fixtureId("work", 473) },
  });

  const listed = await messages.listMessages({
    context: ownerContext(476, ["product:read"]),
    channelId: group.channel.id,
    limit: 50,
  });
  assert.deepEqual(listed.messages.map((message) => message.sequence), [1, 2, 3]);
  assert.deepEqual(listed.messages[0]?.mentions, [fixture.bots.forrest.principalId]);
  assert.equal(listed.messages[1]?.visibility, "tombstoned");
  assert.equal(listed.messages[1]?.text, null);
  assert.equal(listed.messages[1]?.provenance.workId, fixtureId("work", 473));
  assert.equal(listed.messages[2]?.tombstonesMessageId, reply.message.id);
  assert.equal(tombstone.message.tombstonesMessageId, reply.message.id);
  assert.equal(fixture.database.readOne<{ body: string; workId: string }>(
    "SELECT body_text AS body, work_id AS workId FROM messages WHERE id = ?",
    reply.message.id,
  )?.body, "The receipt matches the terminal provenance.");

  const invalidRequests = [
    {
      suffix: 477,
      patch: { mentions: [fixture.bots.records.principalId] },
      code: "invalid_mention",
    },
    {
      suffix: 478,
      patch: { mentions: [fixture.bots.jerry.principalId, fixture.bots.jerry.principalId] },
      code: "invalid_mention",
    },
    {
      suffix: 479,
      patch: { replyToMessageId: fixtureId("message", 999) },
      code: "invalid_relation",
    },
    {
      suffix: 480,
      patch: { replyToMessageId: reply.message.id },
      code: "invalid_relation",
    },
    {
      suffix: 481,
      patch: { tombstonesMessageId: reply.message.id, kind: "system", text: null },
      code: "invalid_relation",
    },
  ] as const;
  for (const invalid of invalidRequests) {
    await assert.rejects(
      messages.sendMessage({
        context: ownerContext(invalid.suffix),
        channelId: invalid.suffix === 480 ? other.channel.id : group.channel.id,
        messageId: fixtureId("message", invalid.suffix),
        authorPrincipalId: OWNER_ID,
        idempotencyKey: sendKey(invalid.suffix),
        kind: "text",
        text: "Invalid relation must roll back.",
        mentions: [],
        clientMessageId: null,
        replyToMessageId: null,
        tombstonesMessageId: null,
        provenance: { roundId: null, workId: null },
        ...invalid.patch,
      }),
      (error: unknown) => error instanceof MessagingError && error.code === invalid.code,
    );
  }
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages WHERE channel_id = ?",
    group.channel.id,
  )?.count, 3);
});

test("an event append failure rolls back Message, mentions, idempotency, and sequence allocation", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const channels = createChannelService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });
  const direct = await channels.createDirectConversation({
    context: ownerContext(491),
    memberBotIds: [fixture.bots.jerry.principalId],
    pinned: false,
    idempotencyKey: channelKey(491),
  });
  const idempotencyCountBefore = fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM idempotency_records",
  )!.count;
  const eventCountBefore = fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM events",
  )!.count;
  const commit: AppendMessageCommit = {
    message: {
      id: fixtureId("message", 492),
      channelId: direct.channel.id,
      author: { principalId: OWNER_ID, kind: "owner", displayName: "Owner" },
      kind: "text",
      text: "This row must be rolled back.",
      mentions: [fixture.bots.jerry.principalId],
      clientMessageId: null,
      replyToMessageId: null,
      tombstonesMessageId: null,
      provenance: { roundId: null, workId: null },
      createdAt: fixture.clock.value.toISOString(),
    },
    actor: {
      principalId: OWNER_ID,
      kind: "owner",
      displayName: "Owner",
      requestId: "req_not-valid-but-prefix-shaped",
      correlationId: fixtureId("correlation", 492),
      residentCredential: null,
    },
    idempotency: {
      operation: "message.append",
      keyDigest: "a".repeat(64),
      requestDigest: "b".repeat(64),
    },
  };

  await assert.rejects(fixture.repository.appendMessage(commit), /invalid request ID/);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages",
  )?.count, 0);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM mentions",
  )?.count, 0);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM idempotency_records",
  )?.count, idempotencyCountBefore);
  assert.equal(fixture.database.readOne<{ nextSequence: number }>(
    "SELECT next_message_sequence AS nextSequence FROM channels WHERE id = ?",
    direct.channel.id,
  )?.nextSequence, 1);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM events",
  )?.count, eventCountBefore);
});
