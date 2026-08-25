import assert from "node:assert/strict";
import test from "node:test";

import {
  MESSAGING_SCHEMA_DELTA_PROPOSAL,
  MessagingError,
  SqliteMessagingRepository,
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

const key = (suffix: number) => `m08-review-key-${String(suffix).padStart(8, "0")}`;

test("M08 explicitly composes every messaging idempotency claim with accepted M06", () => {
  const delta = MESSAGING_SCHEMA_DELTA_PROPOSAL.modifiesProposedTables.find(
    (entry) => entry.name === "idempotency_records",
  );
  assert.deepEqual(delta, {
    name: "idempotency_records",
    replacesChecksFrom: "M06",
    principalCheck: "principal_id = 'user_owner' OR principal_id LIKE 'bot_%'",
    operations: [
      "pairing.issue",
      "pairing.redeem",
      "session.refresh",
      "session.revoke",
      "device.revoke",
      "channel.create",
      "channel.update",
      "message.append",
      "read_cursor.update",
    ],
    resultKinds: [
      "pairing",
      "pairing_failure",
      "redemption",
      "refresh",
      "refresh_failure",
      "revoke",
      "channel",
      "message",
      "read_cursor",
    ],
    rawIdempotencyKeyStored: false,
  });
});

test("message events preserve the locked M02 channelSequence field and mutation receipt", async (t) => {
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
    context: ownerContext(801),
    memberBotIds: [fixture.bots.jerry.principalId],
    pinned: false,
    idempotencyKey: key(801),
  });
  const sent = await messages.sendMessage({
    context: ownerContext(802),
    channelId: direct.channel.id,
    messageId: fixtureId("message", 802),
    authorPrincipalId: OWNER_ID,
    idempotencyKey: key(802),
    kind: "text",
    text: "Contract-shaped event.",
    mentions: [],
    clientMessageId: null,
    replyToMessageId: null,
    tombstonesMessageId: null,
    provenance: { roundId: null, workId: null },
  });
  const event = fixture.database.readOne<{ payload: string; sequence: number }>(
    "SELECT payload_json AS payload, sequence FROM events WHERE type = 'message.appended'",
  );
  const payload = JSON.parse(event!.payload) as Record<string, unknown>;
  assert.equal(payload.channelSequence, 1);
  assert.equal("sequence" in payload, false);
  assert.deepEqual(sent.receipt, {
    resourceVersion: 1,
    eventSequence: event!.sequence,
    requestId: ownerContext(802).requestId,
    correlationId: ownerContext(802).correlationId,
  });
});

test("repository callers cannot forge a Message author and rollback stays complete", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const channels = createChannelService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });
  const direct = await channels.createDirectConversation({
    context: ownerContext(811),
    memberBotIds: [fixture.bots.jerry.principalId],
    pinned: false,
    idempotencyKey: key(811),
  });
  const before = fixture.database.readOne<{ next: number }>(
    "SELECT next_message_sequence AS next FROM channels WHERE id = ?",
    direct.channel.id,
  )!.next;

  await assert.rejects(
    fixture.repository.appendMessage({
      actor: {
        principalId: OWNER_ID,
        kind: "owner",
        displayName: "Owner",
        requestId: fixtureId("request", 812),
        correlationId: fixtureId("correlation", 812),
        residentCredential: null,
      },
      message: {
        id: fixtureId("message", 812),
        channelId: direct.channel.id,
        author: {
          principalId: fixture.bots.jerry.principalId,
          kind: "bot",
          displayName: fixture.bots.jerry.name,
        },
        kind: "text",
        text: "Forged author.",
        mentions: [],
        clientMessageId: null,
        replyToMessageId: null,
        tombstonesMessageId: null,
        provenance: { roundId: null, workId: null },
        createdAt: fixture.clock.value.toISOString(),
      },
      idempotency: {
        operation: "message.append",
        keyDigest: "a".repeat(64),
        requestDigest: "b".repeat(64),
      },
    }),
    (error: unknown) => error instanceof MessagingError &&
      error.code === "identity_context_mismatch",
  );
  await assert.rejects(
    fixture.repository.appendMessage({
      actor: {
        principalId: OWNER_ID,
        kind: "owner",
        displayName: "Impostor",
        requestId: fixtureId("request", 813),
        correlationId: fixtureId("correlation", 813),
        residentCredential: null,
      },
      message: {
        id: fixtureId("message", 813),
        channelId: direct.channel.id,
        author: {
          principalId: OWNER_ID,
          kind: "owner",
          displayName: "Impostor",
        },
        kind: "text",
        text: "Forged owner attribution.",
        mentions: [],
        clientMessageId: null,
        replyToMessageId: null,
        tombstonesMessageId: null,
        provenance: { roundId: null, workId: null },
        createdAt: fixture.clock.value.toISOString(),
      },
      idempotency: {
        operation: "message.append",
        keyDigest: "c".repeat(64),
        requestDigest: "d".repeat(64),
      },
    }),
    (error: unknown) => error instanceof MessagingError &&
      error.code === "identity_context_mismatch",
  );
  await assert.rejects(
    fixture.repository.appendMessage({
      actor: {
        principalId: fixture.bots.jerry.id,
        kind: "bot",
        displayName: "Impostor",
        requestId: fixtureId("request", 814),
        correlationId: fixtureId("correlation", 814),
        residentCredential: {
          residentBinding: "jerry",
          instanceId: fixture.bots.jerry.activeInstanceId!,
          keyVersion: fixture.bots.jerry.activeKeyVersion!,
        },
      },
      message: {
        id: fixtureId("message", 814),
        channelId: direct.channel.id,
        author: {
          principalId: fixture.bots.jerry.id,
          kind: "bot",
          displayName: "Impostor",
        },
        kind: "text",
        text: "Forged resident attribution.",
        mentions: [],
        clientMessageId: null,
        replyToMessageId: null,
        tombstonesMessageId: null,
        provenance: { roundId: null, workId: null },
        createdAt: fixture.clock.value.toISOString(),
      },
      idempotency: {
        operation: "message.append",
        keyDigest: "e".repeat(64),
        requestDigest: "f".repeat(64),
      },
    }),
    (error: unknown) => error instanceof MessagingError &&
      error.code === "identity_context_mismatch",
  );
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages",
  )!.count, 0);
  assert.equal(fixture.database.readOne<{ next: number }>(
    "SELECT next_message_sequence AS next FROM channels WHERE id = ?",
    direct.channel.id,
  )!.next, before);
});

test("a noncanonical M07 binding event rolls back Bot, Channel, idempotency, and event truth", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const failingRepository = new SqliteMessagingRepository(fixture.database, {
    botConversationBinding: {
      bindDirectConversation: (transaction, input) => {
        transaction.run(
          `UPDATE bots SET conversation_id = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ?`,
          input.conversationId,
          input.updatedAt,
          input.botId,
          input.expectedBotVersion,
        );
        const botVersion = input.expectedBotVersion + 1;
        return {
          botId: input.botId,
          botVersion,
          event: {
            type: "bot.created",
            aggregateKind: "bot",
            aggregateId: input.botId,
            aggregateVersion: botVersion,
            channelId: input.channelId,
            actorPrincipalId: input.actorPrincipalId,
            requestId: input.requestId,
            correlationId: input.correlationId,
            payload: { botId: input.botId, botVersion },
            createdAt: input.updatedAt,
          },
        };
      },
    },
  });
  const channels = createChannelService({
    repository: failingRepository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });
  const before = {
    bot: fixture.database.readOne<{ conversationId: string | null; version: number }>(
      "SELECT conversation_id AS conversationId, version FROM bots WHERE id = ?",
      fixture.bots.records.id,
    ),
    channels: fixture.database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM channels",
    )!.count,
    claims: fixture.database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM idempotency_records",
    )!.count,
    events: fixture.database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM events",
    )!.count,
  };
  await assert.rejects(
    channels.createDirectConversation({
      context: ownerContext(815),
      memberBotIds: [fixture.bots.records.id],
      pinned: false,
      idempotencyKey: key(815),
    }),
    (error: unknown) => error instanceof MessagingError && error.code === "storage_conflict",
  );
  assert.deepEqual(
    fixture.database.readOne<{ conversationId: string | null; version: number }>(
      "SELECT conversation_id AS conversationId, version FROM bots WHERE id = ?",
      fixture.bots.records.id,
    ),
    before.bot,
  );
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM channels",
  )!.count, before.channels);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM idempotency_records",
  )!.count, before.claims);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM events",
  )!.count, before.events);
});

test("resident sends require the current M07 registration instance and key", async (t) => {
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
    context: ownerContext(821),
    memberBotIds: [fixture.bots.jerry.principalId],
    pinned: false,
    idempotencyKey: key(821),
  });

  fixture.database.raw.prepare(
    `UPDATE bots SET active_instance_id = NULL, active_key_version = NULL,
                     resident_protocol_version = NULL, resident_capabilities_json = '[]',
                     resident_registered_at = NULL, last_heartbeat_at = NULL,
                     reported_availability = NULL, version = version + 1
     WHERE id = ?`,
  ).run(fixture.bots.jerry.id);

  await assert.rejects(
    messages.sendMessage({
      context: residentContext(fixture.bots.jerry, "jerry", 822),
      channelId: direct.channel.id,
      messageId: fixtureId("message", 822),
      authorPrincipalId: fixture.bots.jerry.principalId,
      idempotencyKey: key(822),
      kind: "text",
      text: "An unregistered resident must not author.",
      mentions: [],
      clientMessageId: null,
      replyToMessageId: null,
      tombstonesMessageId: null,
      provenance: { roundId: null, workId: null },
    }),
    (error: unknown) => error instanceof MessagingError &&
      error.code === "identity_context_mismatch",
  );
});

test("a superseded M07 resident instance cannot author after a higher-key replacement", async (t) => {
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
    context: ownerContext(825),
    memberBotIds: [fixture.bots.jerry.id],
    pinned: false,
    idempotencyKey: key(825),
  });
  const replacement = residentContext(fixture.bots.jerry, "jerry", 826, {
    instanceId: "jerry-instance-2",
    keyVersion: 2,
  });
  if (replacement.identity.kind !== "resident") {
    throw new Error("resident context construction failed");
  }
  await fixture.directory.registerResident({
    context: replacement.identity.resident,
    botBinding: "jerry",
    protocolVersion: 1,
    capabilities: ["messages"],
  });

  const send = {
    channelId: direct.channel.id,
    authorPrincipalId: fixture.bots.jerry.id,
    kind: "text" as const,
    text: "Only the replacement may author this.",
    mentions: [] as const,
    clientMessageId: null,
    replyToMessageId: null,
    tombstonesMessageId: null,
    provenance: { roundId: null, workId: null },
  };
  await assert.rejects(
    messages.sendMessage({
      ...send,
      context: residentContext(fixture.bots.jerry, "jerry", 827),
      messageId: fixtureId("message", 827),
      idempotencyKey: key(827),
    }),
    (error: unknown) => error instanceof MessagingError &&
      error.code === "identity_context_mismatch",
  );
  const committed = await messages.sendMessage({
    ...send,
    context: replacement,
    messageId: fixtureId("message", 828),
    idempotencyKey: key(828),
  });
  assert.equal(committed.outcome, "committed");
});

test("resident replacement racing after service authorization is rejected inside the Message transaction", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const channels = createChannelService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });
  const direct = await channels.createDirectConversation({
    context: ownerContext(829),
    memberBotIds: [fixture.bots.jerry.id],
    pinned: false,
    idempotencyKey: key(829),
  });
  let replaced = false;
  const racingDirectory = {
    ...fixture.directory,
    getBotByResidentBinding: async (residentBinding: string) => {
      const authorized = await fixture.residentAuthority.getBotByResidentBinding(
        residentBinding,
      );
      if (!replaced) {
        replaced = true;
        fixture.database.raw.prepare(
          `UPDATE bots SET active_instance_id = 'jerry-instance-raced',
                           active_key_version = 2, version = version + 1
           WHERE resident_binding = ?`,
        ).run(residentBinding);
      }
      return authorized;
    },
  };
  const messages = createMessageService({
    repository: fixture.repository,
    participantDirectory: racingDirectory,
    now: () => fixture.clock.value,
  });
  const before = {
    messages: fixture.database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM messages",
    )!.count,
    events: fixture.database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM events",
    )!.count,
  };
  await assert.rejects(
    messages.sendMessage({
      context: residentContext(fixture.bots.jerry, "jerry", 830),
      channelId: direct.channel.id,
      messageId: fixtureId("message", 830),
      authorPrincipalId: fixture.bots.jerry.id,
      idempotencyKey: key(830),
      kind: "text",
      text: "This credential lost the race.",
      mentions: [],
      clientMessageId: null,
      replyToMessageId: null,
      tombstonesMessageId: null,
      provenance: { roundId: null, workId: null },
    }),
    (error: unknown) => error instanceof MessagingError &&
      error.code === "identity_context_mismatch",
  );
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages",
  )!.count, before.messages);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM events",
  )!.count, before.events);
  assert.equal(fixture.database.readOne<{ next: number }>(
    "SELECT next_message_sequence AS next FROM channels WHERE id = ?",
    direct.channel.id,
  )!.next, 1);
});

test("Channel creation and read-cursor mutations replay exactly and expose receipts", async (t) => {
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
  const create = {
    context: ownerContext(831),
    memberBotIds: [fixture.bots.jerry.principalId, fixture.bots.forrest.principalId],
    title: "Idempotent group",
    purpose: "One group for one mutation identity.",
    pinned: false,
    responderPolicy: {
      mode: "mentions_only" as const,
      coordinatorBotId: null,
      responseOrder: "parallel" as const,
      maxBotTurns: 2,
    },
    idempotencyKey: key(831),
  };
  const first = await channels.createGroupChannel(create);
  const replay = await channels.createGroupChannel({
    ...create,
    context: ownerContext(832),
  });
  assert.equal(first.channel.id, replay.channel.id);
  assert.equal(replay.outcome, "replayed");
  assert.deepEqual(replay.receipt, first.receipt);
  await assert.rejects(
    channels.createGroupChannel({
      ...create,
      context: ownerContext(836),
      title: "Conflicting group body",
    }),
    (error: unknown) => error instanceof MessagingError &&
      error.code === "idempotency_conflict",
  );

  await messages.sendMessage({
    context: ownerContext(833),
    channelId: first.channel.id,
    messageId: fixtureId("message", 833),
    authorPrincipalId: OWNER_ID,
    idempotencyKey: key(833),
    kind: "text",
    text: "Advance through this row.",
    mentions: [],
    clientMessageId: null,
    replyToMessageId: null,
    tombstonesMessageId: null,
    provenance: { roundId: null, workId: null },
  });
  const read = {
    context: ownerContext(834, ["product:read"]),
    channelId: first.channel.id,
    readThroughSequence: 1,
    idempotencyKey: key(834),
  };
  const readFirst = await unread.markRead(read);
  const readReplay = await unread.markRead({
    ...read,
    context: ownerContext(835, ["product:read"]),
  });
  assert.equal(readReplay.outcome, "replayed");
  assert.deepEqual(readReplay.unread, readFirst.unread);
  assert.deepEqual(readReplay.receipt, readFirst.receipt);
  await assert.rejects(
    unread.markRead({
      ...read,
      context: ownerContext(837, ["product:read"]),
      readThroughSequence: 0,
    }),
    (error: unknown) => error instanceof MessagingError &&
      error.code === "idempotency_conflict",
  );
});

test("idempotent replay resolves the exact event when transport IDs are reused", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const channels = createChannelService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });
  const created = await channels.createGroupChannel({
    context: ownerContext(870),
    memberBotIds: [fixture.bots.jerry.id, fixture.bots.forrest.id],
    title: "Receipt identity",
    purpose: "Bind replay to one committed event.",
    pinned: false,
    responderPolicy: {
      mode: "mentions_only",
      coordinatorBotId: null,
      responseOrder: "parallel",
      maxBotTurns: 2,
    },
    idempotencyKey: key(870),
  });
  const sharedContext = ownerContext(871);
  const firstInput = {
    context: sharedContext,
    channelId: created.channel.id,
    expectedVersion: 1,
    idempotencyKey: key(871),
    title: "Receipt identity v2",
    purpose: created.channel.purpose,
    memberBotIds: [fixture.bots.jerry.id, fixture.bots.forrest.id],
    responderPolicy: created.channel.responderPolicy,
    pinned: created.channel.pinned,
    lifecycle: created.channel.lifecycle,
  };
  const first = await channels.updateChannel(firstInput);
  const secondInput = {
    ...firstInput,
    expectedVersion: first.channel.version,
    idempotencyKey: key(872),
    title: "Receipt identity v3",
  };
  const second = await channels.updateChannel(secondInput);
  const replay = await channels.updateChannel(secondInput);

  assert.notEqual(first.receipt.eventSequence, second.receipt.eventSequence);
  assert.equal(replay.outcome, "replayed");
  assert.deepEqual(replay.receipt, second.receipt);
  assert.equal(replay.receipt.resourceVersion, replay.channel.version);
});

test("exact Channel, update, and Message retries survive participant visibility drift", async (t) => {
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
  const create = {
    context: ownerContext(841),
    memberBotIds: [fixture.bots.jerry.id, fixture.bots.forrest.id],
    title: "Visibility drift",
    purpose: "Committed requests remain replayable.",
    pinned: false,
    responderPolicy: {
      mode: "mentions_only" as const,
      coordinatorBotId: null,
      responseOrder: "parallel" as const,
      maxBotTurns: 2,
    },
    idempotencyKey: key(841),
  };
  const created = await channels.createGroupChannel(create);
  const update = {
    context: ownerContext(842),
    channelId: created.channel.id,
    expectedVersion: 1,
    idempotencyKey: key(842),
    title: "Visibility drift committed",
    purpose: create.purpose,
    memberBotIds: create.memberBotIds,
    responderPolicy: create.responderPolicy,
    pinned: true,
    lifecycle: "active" as const,
  };
  const updated = await channels.updateChannel(update);
  const send = {
    context: ownerContext(843),
    channelId: created.channel.id,
    messageId: fixtureId("message", 843),
    authorPrincipalId: OWNER_ID,
    idempotencyKey: key(843),
    kind: "text" as const,
    text: "Forrest remains in the immutable committed request.",
    mentions: [fixture.bots.forrest.id],
    clientMessageId: null,
    replyToMessageId: null,
    tombstonesMessageId: null,
    provenance: { roundId: null, workId: null },
  };
  const sent = await messages.sendMessage(send);
  fixture.database.raw.prepare(
    "UPDATE bots SET lifecycle = 'archived', version = version + 1 WHERE id = ?",
  ).run(fixture.bots.forrest.id);

  const createReplay = await channels.createGroupChannel({
    ...create,
    context: ownerContext(844),
  });
  const updateReplay = await channels.updateChannel({
    ...update,
    context: ownerContext(845),
  });
  const sendReplay = await messages.sendMessage({
    ...send,
    context: ownerContext(846),
  });
  assert.equal(createReplay.outcome, "replayed");
  assert.deepEqual(createReplay.channel, created.channel);
  assert.equal(updateReplay.outcome, "replayed");
  assert.deepEqual(updateReplay.channel, updated.channel);
  assert.equal(sendReplay.outcome, "replayed");
  assert.deepEqual(sendReplay.message, sent.message);

  await assert.rejects(
    messages.sendMessage({
      ...send,
      context: ownerContext(847),
      messageId: fixtureId("message", 847),
      idempotencyKey: key(847),
    }),
    (error: unknown) => error instanceof MessagingError && error.code === "invalid_mention",
  );
});

test("stale M07 resident credentials cannot replay mutations or cross repository read fences", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const channels = createChannelService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });
  const direct = await channels.createDirectConversation({
    context: ownerContext(851),
    memberBotIds: [fixture.bots.jerry.id],
    pinned: false,
    idempotencyKey: key(851),
  });
  const originalMessages = createMessageService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    now: () => fixture.clock.value,
  });
  const send = {
    context: residentContext(fixture.bots.jerry, "jerry", 852),
    channelId: direct.channel.id,
    messageId: fixtureId("message", 852),
    authorPrincipalId: fixture.bots.jerry.id,
    idempotencyKey: key(852),
    kind: "text" as const,
    text: "The original credential committed this once.",
    mentions: [] as const,
    clientMessageId: null,
    replyToMessageId: null,
    tombstonesMessageId: null,
    provenance: { roundId: null, workId: null },
  };
  await originalMessages.sendMessage(send);

  const restoreCredential = () => fixture.database.raw.prepare(
    `UPDATE bots SET active_instance_id = 'jerry-instance-1', active_key_version = 1,
                     version = version + 1 WHERE id = ?`,
  ).run(fixture.bots.jerry.id);
  const racingDirectory = () => {
    let raced = false;
    return {
      ...fixture.directory,
      getBotByResidentBinding: async (binding: string) => {
        const authorized = await fixture.residentAuthority.getBotByResidentBinding(binding);
        if (!raced) {
          raced = true;
          fixture.database.raw.prepare(
            `UPDATE bots SET active_instance_id = 'jerry-instance-raced',
                             active_key_version = 2, version = version + 1
             WHERE resident_binding = ?`,
          ).run(binding);
        }
        return authorized;
      },
    };
  };
  const staleContext = residentContext(fixture.bots.jerry, "jerry", 853);
  const staleMessages = createMessageService({
    repository: fixture.repository,
    participantDirectory: racingDirectory(),
    now: () => fixture.clock.value,
  });
  await assert.rejects(
    staleMessages.sendMessage({ ...send, context: staleContext }),
    (error: unknown) => error instanceof MessagingError &&
      error.code === "identity_context_mismatch",
  );

  restoreCredential();
  const readMessages = createMessageService({
    repository: fixture.repository,
    participantDirectory: racingDirectory(),
    now: () => fixture.clock.value,
  });
  await assert.rejects(
    readMessages.listMessages({
      context: residentContext(fixture.bots.jerry, "jerry", 854),
      channelId: direct.channel.id,
      limit: 10,
    }),
    (error: unknown) => error instanceof MessagingError &&
      error.code === "identity_context_mismatch",
  );

  restoreCredential();
  const unread = createUnreadService({
    repository: fixture.repository,
    participantDirectory: racingDirectory(),
    now: () => fixture.clock.value,
  });
  await assert.rejects(
    unread.getUnread({
      context: residentContext(fixture.bots.jerry, "jerry", 855),
      channelId: direct.channel.id,
    }),
    (error: unknown) => error instanceof MessagingError &&
      error.code === "identity_context_mismatch",
  );

  restoreCredential();
  const readChannels = createChannelService({
    repository: fixture.repository,
    participantDirectory: racingDirectory(),
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });
  await assert.rejects(
    readChannels.getChannel({
      context: residentContext(fixture.bots.jerry, "jerry", 856),
      channelId: direct.channel.id,
    }),
    (error: unknown) => error instanceof MessagingError &&
      error.code === "identity_context_mismatch",
  );

  restoreCredential();
  const inbox = createUnreadService({
    repository: fixture.repository,
    participantDirectory: racingDirectory(),
    now: () => fixture.clock.value,
  });
  await assert.rejects(
    inbox.listInbox({
      context: residentContext(fixture.bots.jerry, "jerry", 857),
    }),
    (error: unknown) => error instanceof MessagingError &&
      error.code === "identity_context_mismatch",
  );

  restoreCredential();
  const listedChannels = createChannelService({
    repository: fixture.repository,
    participantDirectory: racingDirectory(),
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });
  await assert.rejects(
    listedChannels.listChannels({
      context: residentContext(fixture.bots.jerry, "jerry", 858),
      cursor: null,
      limit: 10,
    }),
    (error: unknown) => error instanceof MessagingError &&
      error.code === "identity_context_mismatch",
  );
});

test("resident Work and Round provenance is denied without transaction-bound authorization", async (t) => {
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
    context: ownerContext(861),
    memberBotIds: [fixture.bots.jerry.id],
    pinned: false,
    idempotencyKey: key(861),
  });
  const beforeEvents = fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM events",
  )!.count;
  await assert.rejects(
    messages.sendMessage({
      context: residentContext(fixture.bots.jerry, "jerry", 862),
      channelId: direct.channel.id,
      messageId: fixtureId("message", 862),
      authorPrincipalId: fixture.bots.jerry.id,
      idempotencyKey: key(862),
      kind: "result",
      text: "Unbound provenance must not become product truth.",
      mentions: [],
      clientMessageId: null,
      replyToMessageId: null,
      tombstonesMessageId: null,
      provenance: {
        roundId: fixtureId("round", 862),
        workId: fixtureId("work", 862),
      },
    }),
    (error: unknown) => error instanceof MessagingError && error.code === "invalid_relation",
  );
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages WHERE channel_id = ?",
    direct.channel.id,
  )!.count, 0);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM events",
  )!.count, beforeEvents);
});
