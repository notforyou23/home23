import assert from "node:assert/strict";
import test from "node:test";

import {
  MessagingError,
  createChannelService,
} from "../../../src/coordination/channels/index.js";

import {
  OWNER_ID,
  createMessagingFixture,
  fixtureId,
  ownerContext,
  residentContext,
} from "./test-fixture.js";

const channelKey = (suffix: number) =>
  `m08-channel-mutation-${String(suffix).padStart(6, "0")}`;

test("concurrent reversed direct-pair creation returns one canonical Conversation", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const channels = createChannelService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });

  const [first, second] = await Promise.all([
    channels.createDirectConversation({
      context: ownerContext(301),
      memberBotIds: [fixture.bots.jerry.principalId],
      pinned: true,
      idempotencyKey: channelKey(301),
    }),
    channels.createDirectConversation({
      context: ownerContext(302),
      memberBotIds: [fixture.bots.jerry.principalId],
      pinned: false,
      idempotencyKey: channelKey(302),
    }),
  ]);

  assert.equal(first.channel.id, second.channel.id);
  assert.equal(first.channel.conversationId, second.channel.conversationId);
  assert.deepEqual(first.channel.members.map((member) => member.principalId), [
    OWNER_ID,
    fixture.bots.jerry.principalId,
  ]);
  assert.equal(first.outcome, "created");
  assert.equal(second.outcome, "existing");
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM channels WHERE kind = 'direct'",
  )?.count, 1);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM direct_channel_pairs",
  )?.count, 1);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM conversation_handles",
  )?.count, 1);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM events WHERE type = 'channel.created'",
  )?.count, 1);
  assert.equal(fixture.database.readOne<{ conversationId: string | null }>(
    "SELECT conversation_id AS conversationId FROM bots WHERE id = ?",
    fixture.bots.jerry.id,
  )?.conversationId, first.channel.conversationId);
  assert.equal(
    (await fixture.directory.resolveAlias("resident", "jerry"))?.conversationId,
    first.channel.conversationId,
  );
  const event = fixture.database.readOne<{ payload: string; sequence: number }>(
    "SELECT payload_json AS payload, sequence FROM events WHERE type = 'channel.created'",
  );
  const payload = JSON.parse(event!.payload) as Record<string, unknown>;
  assert.equal(payload.botId, fixture.bots.jerry.id);
  assert.equal(payload.botVersion, 3);
  assert.equal(first.receipt.eventSequence, event!.sequence);
});

test("Channel get, stable list, update, version, and replay contracts stay membership-scoped", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const channels = createChannelService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });
  const group = await channels.createGroupChannel({
    context: ownerContext(341),
    memberBotIds: [fixture.bots.jerry.id, fixture.bots.forrest.id],
    title: "Mutable metadata",
    purpose: "Membership remains stable while metadata changes.",
    pinned: false,
    responderPolicy: {
      mode: "mentions_only",
      coordinatorBotId: null,
      responseOrder: "parallel",
      maxBotTurns: 2,
    },
    idempotencyKey: channelKey(341),
  });
  await channels.createDirectConversation({
    context: ownerContext(342),
    memberBotIds: [fixture.bots.records.id],
    pinned: false,
    idempotencyKey: channelKey(342),
  });

  const ownerView = await channels.getChannel({
    context: ownerContext(343, ["product:read"]),
    channelId: group.channel.id,
  });
  assert.equal(ownerView.id, group.channel.id);
  const botView = await channels.getChannel({
    context: {
      ...ownerContext(344, ["product:read"]),
      principalId: fixture.bots.jerry.id,
      identity: {
        kind: "resident" as const,
        resident: {
          credential: {
            residentSlug: "jerry",
            role: "resident" as const,
            instanceId: "jerry-instance-1",
            keyVersion: 1,
          },
          requestId: fixtureId("request", 344),
          correlationId: fixtureId("correlation", 344),
        },
      },
    },
    channelId: group.channel.id,
  });
  assert.equal(botView.id, group.channel.id);
  await assert.rejects(
    channels.getChannel({
      context: {
        principalId: fixture.bots.records.id,
        requestId: fixtureId("request", 345),
        correlationId: fixtureId("correlation", 345),
        identity: {
          kind: "resident",
          resident: {
            credential: {
              residentSlug: "records-specialist",
              role: "resident",
              instanceId: "records-specialist-instance-1",
              keyVersion: 1,
            },
            requestId: fixtureId("request", 345),
            correlationId: fixtureId("correlation", 345),
          },
        },
      },
      channelId: group.channel.id,
    }),
    (error: unknown) => error instanceof MessagingError && error.code === "nonmember",
  );

  const firstPage = await channels.listChannels({
    context: ownerContext(346, ["product:read"]),
    cursor: null,
    limit: 1,
  });
  assert.equal(firstPage.channels.length, 1);
  assert.ok(firstPage.nextCursor);
  const secondPage = await channels.listChannels({
    context: ownerContext(347, ["product:read"]),
    cursor: firstPage.nextCursor,
    limit: 1,
  });
  assert.equal(secondPage.channels.length, 1);
  assert.notEqual(secondPage.channels[0]?.id, firstPage.channels[0]?.id);
  await assert.rejects(
    channels.listChannels({
      context: residentContext(fixture.bots.jerry, "jerry", 3471),
      cursor: firstPage.nextCursor,
      limit: 1,
    }),
    (error: unknown) => error instanceof MessagingError && error.code === "request_invalid",
  );
  const forgedCursor = Buffer.from(JSON.stringify({
    updatedAt: firstPage.channels[0]!.updatedAt,
    channelId: firstPage.channels[0]!.id,
  }), "utf8").toString("base64url");
  await assert.rejects(
    channels.listChannels({
      context: ownerContext(3472, ["product:read"]),
      cursor: forgedCursor,
      limit: 1,
    }),
    (error: unknown) => error instanceof MessagingError && error.code === "request_invalid",
  );

  fixture.clock.value = new Date("2026-08-25T12:05:00.000Z");
  const update = {
    context: ownerContext(348),
    channelId: group.channel.id,
    expectedVersion: 1,
    idempotencyKey: channelKey(348),
    title: "Updated metadata",
    purpose: "p".repeat(4_000),
    memberBotIds: [fixture.bots.jerry.id, fixture.bots.forrest.id],
    responderPolicy: {
      mode: "mention_or_coordinator" as const,
      coordinatorBotId: fixture.bots.jerry.id,
      responseOrder: "sequential" as const,
      maxBotTurns: 3,
    },
    pinned: true,
    lifecycle: "active" as const,
  };
  const committed = await channels.updateChannel(update);
  assert.equal(committed.channel.version, 2);
  assert.equal(committed.channel.purpose.length, 4_000);
  assert.equal(committed.receipt.resourceVersion, 2);
  const replay = await channels.updateChannel({
    ...update,
    context: ownerContext(349),
  });
  assert.equal(replay.outcome, "replayed");
  assert.deepEqual(replay.channel, committed.channel);
  assert.deepEqual(replay.receipt, committed.receipt);

  await assert.rejects(
    channels.updateChannel({
      ...update,
      context: ownerContext(350),
      idempotencyKey: channelKey(350),
      title: "Stale update",
    }),
    (error: unknown) => error instanceof MessagingError && error.code === "version_conflict",
  );
  await assert.rejects(
    channels.updateChannel({
      ...update,
      context: ownerContext(351),
      idempotencyKey: channelKey(351),
      expectedVersion: 2,
      memberBotIds: [fixture.bots.jerry.id],
    }),
    (error: unknown) => error instanceof MessagingError && error.code === "invalid_membership",
  );
});

test("direct metadata is lossless and group membership replacement is atomic", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const channels = createChannelService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });
  const direct = await channels.createDirectConversation({
    context: ownerContext(352),
    memberBotIds: [fixture.bots.jerry.id],
    title: "Jerry decisions",
    purpose: "A deliberately named direct Conversation.",
    responderPolicy: {
      mode: "mentions_only",
      coordinatorBotId: null,
      responseOrder: "parallel",
      maxBotTurns: 1,
    },
    pinned: false,
    idempotencyKey: channelKey(352),
  });
  assert.equal(direct.channel.title, "Jerry decisions");
  assert.equal(direct.channel.purpose, "A deliberately named direct Conversation.");
  assert.equal(direct.channel.responderPolicy.mode, "mentions_only");

  const group = await channels.createGroupChannel({
    context: ownerContext(353),
    memberBotIds: [fixture.bots.jerry.id, fixture.bots.forrest.id],
    title: "Membership change",
    purpose: "Exercise the accepted ChannelMutation membership field.",
    pinned: false,
    responderPolicy: {
      mode: "mentions_only",
      coordinatorBotId: null,
      responseOrder: "parallel",
      maxBotTurns: 2,
    },
    idempotencyKey: channelKey(353),
  });
  const updated = await channels.updateChannel({
    context: ownerContext(354),
    channelId: group.channel.id,
    expectedVersion: 1,
    idempotencyKey: channelKey(354),
    title: group.channel.title,
    purpose: group.channel.purpose,
    memberBotIds: [fixture.bots.jerry.id, fixture.bots.records.id],
    responderPolicy: {
      mode: "mention_or_coordinator",
      coordinatorBotId: fixture.bots.records.id,
      responseOrder: "sequential",
      maxBotTurns: 2,
    },
    pinned: false,
    lifecycle: "active",
  });
  assert.deepEqual(updated.channel.members.map((member) => member.principalId), [
    OWNER_ID,
    fixture.bots.jerry.id,
    fixture.bots.records.id,
  ]);
  await assert.rejects(
    channels.getChannel({
      context: residentContext(fixture.bots.forrest, "forrest", 355),
      channelId: group.channel.id,
    }),
    (error: unknown) => error instanceof MessagingError && error.code === "nonmember",
  );
  assert.equal((await channels.getChannel({
    context: residentContext(fixture.bots.records, "records-specialist", 356),
    channelId: group.channel.id,
  })).id, group.channel.id);
  assert.throws(
    () => fixture.database.raw.prepare(
      `INSERT INTO messages (
        id, channel_id, channel_sequence, author_principal_id, author_kind,
        author_display_name, kind, body_text, stored_visibility,
        client_message_id, reply_to_message_id, tombstones_message_id,
        round_id, work_id, created_at
      ) VALUES (?, ?, 1, ?, 'bot', 'Forrest', 'text', 'inactive forge',
                'visible', NULL, NULL, NULL, NULL, NULL, ?)`,
    ).run(
      fixtureId("message", 356),
      group.channel.id,
      fixture.bots.forrest.id,
      fixture.clock.value.toISOString(),
    ),
    /message author must be an active Channel member/,
  );
});

test("group membership remove and rejoin preserves each committed interval", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const channels = createChannelService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });
  const group = await channels.createGroupChannel({
    context: ownerContext(357),
    memberBotIds: [fixture.bots.jerry.id, fixture.bots.forrest.id],
    title: "Membership intervals",
    purpose: "Retain removal and rejoin history.",
    pinned: false,
    responderPolicy: {
      mode: "mentions_only",
      coordinatorBotId: null,
      responseOrder: "parallel",
      maxBotTurns: 2,
    },
    idempotencyKey: channelKey(357),
  });

  fixture.clock.value = new Date("2026-08-25T12:01:00.000Z");
  const removed = await channels.updateChannel({
    context: ownerContext(358),
    channelId: group.channel.id,
    expectedVersion: 1,
    idempotencyKey: channelKey(358),
    title: group.channel.title,
    purpose: group.channel.purpose,
    memberBotIds: [fixture.bots.jerry.id, fixture.bots.records.id],
    responderPolicy: group.channel.responderPolicy,
    pinned: group.channel.pinned,
    lifecycle: group.channel.lifecycle,
  });

  fixture.clock.value = new Date("2026-08-25T12:02:00.000Z");
  await channels.updateChannel({
    context: ownerContext(359),
    channelId: group.channel.id,
    expectedVersion: removed.channel.version,
    idempotencyKey: channelKey(359),
    title: group.channel.title,
    purpose: group.channel.purpose,
    memberBotIds: [fixture.bots.jerry.id, fixture.bots.forrest.id],
    responderPolicy: group.channel.responderPolicy,
    pinned: group.channel.pinned,
    lifecycle: group.channel.lifecycle,
  });

  assert.deepEqual(fixture.database.readAll<{
    joinedChannelVersion: number;
    leftChannelVersion: number | null;
    joinedAt: string;
    leftAt: string | null;
  }>(
    `SELECT joined_channel_version AS joinedChannelVersion,
            left_channel_version AS leftChannelVersion,
            joined_at AS joinedAt, left_at AS leftAt
     FROM channel_membership_history
     WHERE channel_id = ? AND principal_id = ?
     ORDER BY joined_channel_version`,
    group.channel.id,
    fixture.bots.forrest.id,
  ), [
    {
      joinedChannelVersion: 1,
      leftChannelVersion: 2,
      joinedAt: "2026-08-25T12:00:00.000Z",
      leftAt: "2026-08-25T12:01:00.000Z",
    },
    {
      joinedChannelVersion: 3,
      leftChannelVersion: null,
      joinedAt: "2026-08-25T12:02:00.000Z",
      leftAt: null,
    },
  ]);
});

test("group membership admits only owner plus unique visible persistent Bots", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const channels = createChannelService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });

  const group = await channels.createGroupChannel({
    context: ownerContext(311),
    memberBotIds: [
      fixture.bots.forrest.principalId,
      fixture.bots.jerry.principalId,
    ],
    title: "House planning",
    purpose: "Coordinate bounded work among local persistent Bots.",
    pinned: false,
    responderPolicy: {
      mode: "mention_or_coordinator",
      coordinatorBotId: fixture.bots.jerry.id,
      responseOrder: "sequential",
      maxBotTurns: 4,
    },
    idempotencyKey: channelKey(311),
  });

  assert.equal(group.channel.kind, "group");
  assert.deepEqual(group.channel.members.map((member) => member.principalId), [
    OWNER_ID,
    fixture.bots.jerry.principalId,
    fixture.bots.forrest.principalId,
  ]);
  assert.equal(group.channel.responderPolicy.coordinatorBotId, fixture.bots.jerry.id);

  const invalidMemberships: Array<readonly string[]> = [
    [fixture.bots.jerry.principalId],
    [fixture.bots.jerry.principalId, fixture.bots.jerry.principalId],
    [],
    [fixture.bots.jerry.principalId, fixtureId("bot", 999)],
  ];
  for (const [index, participantIds] of invalidMemberships.entries()) {
    await assert.rejects(
      channels.createGroupChannel({
        context: ownerContext(320 + index),
        memberBotIds: participantIds,
        title: "Invalid group",
        purpose: "This must not commit.",
        pinned: false,
        responderPolicy: {
          mode: "mentions_only",
          coordinatorBotId: null,
          responseOrder: "parallel",
          maxBotTurns: 2,
        },
        idempotencyKey: channelKey(320 + index),
      }),
      (error: unknown) => error instanceof MessagingError &&
        (error.code === "invalid_membership" || error.code === "unknown_principal"),
    );
  }
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM channels WHERE kind = 'group'",
  )?.count, 1);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM bots WHERE conversation_id IS NOT NULL",
  )?.count, 0);
});

test("malformed IDs, invalid coordinator policy, and non-owner creation fail closed", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const channels = createChannelService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });

  await assert.rejects(
    channels.createDirectConversation({
      context: ownerContext(331),
      memberBotIds: ["bot_not-a-uuid"],
      pinned: false,
      idempotencyKey: channelKey(331),
    }),
    (error: unknown) => error instanceof MessagingError && error.code === "request_invalid",
  );
  await assert.rejects(
    channels.createGroupChannel({
      context: { ...ownerContext(332), principalId: fixture.bots.jerry.principalId },
      memberBotIds: [fixture.bots.jerry.principalId, fixture.bots.forrest.principalId],
      title: "Mismatch",
      purpose: "Identity mismatch must fail.",
      pinned: false,
      responderPolicy: {
        mode: "mention_or_coordinator",
        coordinatorBotId: fixture.bots.jerry.id,
        responseOrder: "sequential",
        maxBotTurns: 2,
      },
      idempotencyKey: channelKey(332),
    }),
    (error: unknown) => error instanceof MessagingError && error.code === "identity_context_mismatch",
  );
  await assert.rejects(
    channels.createGroupChannel({
      context: ownerContext(333),
      memberBotIds: [fixture.bots.jerry.principalId, fixture.bots.forrest.principalId],
      title: "Bad coordinator",
      purpose: "Coordinator must be a member.",
      pinned: false,
      responderPolicy: {
        mode: "mention_or_coordinator",
        coordinatorBotId: fixture.bots.records.id,
        responseOrder: "sequential",
        maxBotTurns: 2,
      },
      idempotencyKey: channelKey(333),
    }),
    (error: unknown) => error instanceof MessagingError && error.code === "invalid_membership",
  );
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM channels",
  )?.count, 0);
});
