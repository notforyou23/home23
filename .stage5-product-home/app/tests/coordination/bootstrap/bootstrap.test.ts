import assert from "node:assert/strict";
import test from "node:test";

import { createChannelService } from "../../../src/coordination/channels/index.js";
import { createMessageService } from "../../../src/coordination/messages/index.js";
import {
  SqliteBootstrapRepository,
  createBootstrapService,
  digestBootstrapProjection,
} from "../../../src/coordination/bootstrap/index.js";
import type { EventReadDatabase } from "../../../src/coordination/events/index.js";
import {
  OWNER_ID,
  createMessagingFixture,
  fixtureId,
  ownerContext,
  residentContext,
} from "../messaging/test-fixture.js";

const bootstrapOptions = {
  home: {
    id: "home_0198d95f-6c00-7000-8000-000000000001",
    name: "Home23",
    primaryBotId: "bot_0198d95f-6c00-7000-8000-000000000001",
  },
  connection: { mode: "local", displayName: "Home Mac", reachable: true },
  capabilities: {
    channels: true,
    attachments: false,
    search: true,
    push: false,
    eventReplay: true,
    botLifecycle: false,
  },
  limits: {
    attachmentBytes: 26_214_400,
    attachmentCountPerMessage: 10,
    jsonBodyBytes: 262_144,
    idempotencyKeyMinimum: 16,
    idempotencyKeyMaximum: 128,
  },
  minimumClientBuild: 1,
  availabilityPolicy: { degradedAfterMs: 30_000, offlineAfterMs: 90_000 },
} as const;

function channelKey(suffix: number): string {
  return `m09-bootstrap-channel-${String(suffix).padStart(6, "0")}`;
}

function messageKey(suffix: number): string {
  return `m09-bootstrap-message-${String(suffix).padStart(6, "0")}`;
}

test("bootstrap returns an authorized rebuildable projection and watermark from one boundary", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const channels = createChannelService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
    idGenerator: (kind) => fixtureId(kind, 1401),
  });
  const messages = createMessageService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    now: () => fixture.clock.value,
  });
  const direct = await channels.createDirectConversation({
    context: ownerContext(1401),
    memberBotIds: [fixture.bots.jerry.id],
    pinned: true,
    idempotencyKey: channelKey(1401),
  });
  fixture.clock.value = new Date("2026-08-25T12:00:10.000Z");
  await messages.sendMessage({
    context: residentContext(fixture.bots.jerry, "jerry", 1402),
    channelId: direct.channel.id,
    messageId: fixtureId("message", 1402),
    authorPrincipalId: fixture.bots.jerry.id,
    idempotencyKey: messageKey(1402),
    kind: "text",
    text: "Bootstrap-visible reply.",
    mentions: [],
    clientMessageId: null,
    replyToMessageId: null,
    tombstonesMessageId: null,
    provenance: { roundId: null, workId: null },
  });
  const now = new Date("2026-08-25T12:00:20.000Z");
  const service = createBootstrapService({
    repository: new SqliteBootstrapRepository(fixture.database),
    participantDirectory: fixture.directory,
    now: () => now,
    ...bootstrapOptions,
    home: { ...bootstrapOptions.home, primaryBotId: fixture.bots.jerry.id },
  });

  const bootstrap = await service.getBootstrap({ context: ownerContext(1403, ["product:read"]) });
  assert.equal(bootstrap.eventCursor, bootstrap.throughEventSequence);
  assert.equal(bootstrap.client.principalId, OWNER_ID);
  assert.deepEqual(bootstrap.client.scopes, ["product:read"]);
  assert.equal(bootstrap.snapshot.channels.length, 1);
  assert.deepEqual(bootstrap.snapshot.conversations, [{
    id: direct.channel.conversationId,
    channelId: direct.channel.id,
    latestSequence: 1,
    unreadCount: 1,
    version: direct.channel.version + 1,
  }]);
  assert.equal(bootstrap.snapshot.unreadTotal, 1);
  assert.equal(
    bootstrap.snapshot.bots.find((bot) => bot.id === fixture.bots.jerry.id)?.availability,
    "starting",
  );

  const rebuilt = await service.getBootstrap({ context: ownerContext(1404, ["product:read"]) });
  const rebuildDigest = digestBootstrapProjection(rebuilt.snapshot);
  assert.equal(
    rebuildDigest,
    digestBootstrapProjection(bootstrap.snapshot),
  );
  assert.equal(
    rebuildDigest,
    "b967d8b53351f3d4a1dfbf2972199eb9a81416661667ee21c998894af46667be",
  );
});

test("a mutation immediately after the snapshot statement cannot leak past its watermark", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const channels = createChannelService({
    repository: fixture.repository,
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => fixture.clock.value,
  });
  const direct = await channels.createDirectConversation({
    context: ownerContext(1451),
    memberBotIds: [fixture.bots.jerry.id],
    pinned: false,
    idempotencyKey: channelKey(1451),
  });
  const beforeSequence = fixture.database.readOne<{ sequence: number }>(
    "SELECT max(sequence) AS sequence FROM events",
  )!.sequence;
  let injected = false;
  const boundaryProbe: EventReadDatabase = {
    readAll: <T>(sql: string, ...parameters: Array<string | number | bigint | Buffer | null>) => {
      const rows = fixture.database.readAll<T>(sql, ...parameters);
      if (!injected) {
        injected = true;
        fixture.database.mutateWithEvent((transaction) => {
          transaction.run(
            `INSERT INTO messages (
              id, channel_id, channel_sequence, author_principal_id, author_kind,
              author_display_name, kind, body_text, stored_visibility,
              client_message_id, reply_to_message_id, tombstones_message_id,
              round_id, work_id, created_at
            ) VALUES (?, ?, 1, ?, 'bot', 'Jerry', 'text', ?, 'visible',
                      NULL, NULL, NULL, NULL, NULL, ?)`,
            fixtureId("message", 1452),
            direct.channel.id,
            fixture.bots.jerry.id,
            "Committed immediately after the bootstrap read.",
            "2026-08-25T12:01:00.000Z",
          );
          transaction.run(
            "UPDATE channels SET next_message_sequence = 2, version = version + 1, updated_at = ? WHERE id = ?",
            "2026-08-25T12:01:00.000Z",
            direct.channel.id,
          );
          return {
            value: undefined,
            event: {
              type: "message.appended",
              aggregateKind: "message",
              aggregateId: fixtureId("message", 1452),
              aggregateVersion: 1,
              channelId: direct.channel.id,
              actorPrincipalId: fixture.bots.jerry.id,
              requestId: fixtureId("request", 1452),
              correlationId: fixtureId("correlation", 1452),
              payload: {
                messageId: fixtureId("message", 1452),
                channelId: direct.channel.id,
                conversationId: direct.channel.conversationId,
                channelSequence: 1,
              },
              createdAt: "2026-08-25T12:01:00.000Z",
            },
          };
        });
      }
      return rows;
    },
  };
  const repository = new SqliteBootstrapRepository(boundaryProbe);

  const first = repository.readProjection({
    principalId: OWNER_ID,
    at: "2026-08-25T12:01:00.000Z",
    availabilityPolicy: bootstrapOptions.availabilityPolicy,
  });
  assert.equal(first.throughEventSequence, beforeSequence);
  assert.equal(first.snapshot.conversations[0]?.latestSequence, 0);

  const second = new SqliteBootstrapRepository(fixture.database).readProjection({
    principalId: OWNER_ID,
    at: "2026-08-25T12:01:00.000Z",
    availabilityPolicy: bootstrapOptions.availabilityPolicy,
  });
  assert.equal(second.throughEventSequence, beforeSequence + 1);
  assert.equal(second.snapshot.conversations[0]?.latestSequence, 1);
  assert.equal(second.snapshot.unreadTotal, 1);
});

test("bootstrap bot visibility and availability match the authoritative M07 projection", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  fixture.database.raw.prepare(
    "UPDATE bots SET lifecycle = 'archived' WHERE id = ?",
  ).run(fixture.bots.records.id);
  fixture.database.raw.prepare(
    `UPDATE bots
     SET name = 'alpha', last_heartbeat_at = ?, reported_availability = 'available'
     WHERE id = ?`,
  ).run("2026-08-25T12:10:00.000Z", fixture.bots.jerry.id);
  fixture.database.raw.prepare(
    `UPDATE bots
     SET name = 'Beta', resident_capabilities_json = '[]', reported_availability = 'available'
     WHERE id = ?`,
  ).run(fixture.bots.forrest.id);

  const projection = new SqliteBootstrapRepository(fixture.database).readProjection({
    principalId: OWNER_ID,
    at: "2026-08-25T12:00:00.000Z",
    availabilityPolicy: bootstrapOptions.availabilityPolicy,
  });

  assert.equal(
    projection.snapshot.bots.some((bot) => bot.id === fixture.bots.records.id),
    false,
  );
  assert.deepEqual(
    projection.snapshot.bots.map((bot) => bot.id),
    [fixture.bots.forrest.id, fixture.bots.jerry.id],
  );
  assert.equal(
    projection.snapshot.bots.find((bot) => bot.id === fixture.bots.jerry.id)?.availability,
    "degraded",
  );
  assert.equal(
    projection.snapshot.bots.find((bot) => bot.id === fixture.bots.forrest.id)?.availability,
    "degraded",
  );
});
