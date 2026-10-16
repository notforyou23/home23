import assert from "node:assert/strict";
import test from "node:test";
import { createChannelService } from "../../../src/coordination/channels/index.js";
import { createMessageService } from "../../../src/coordination/messages/index.js";
import { SqliteUnreadRepository, createUnreadService } from "../../../src/coordination/unread/index.js";
import { SqliteBootstrapRepository } from "../../../src/coordination/bootstrap/index.js";
import { OWNER_ID, createMessagingFixture, fixtureId, ownerContext, residentContext } from "./test-fixture.js";

test("owner attention excludes archived, inactive and orphan direct mailboxes without changing history or cursors", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const channels = createChannelService({ repository: fixture.repository, participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23), now: () => fixture.clock.value });
  const messages = createMessageService({ repository: fixture.repository, participantDirectory: fixture.directory,
    now: () => fixture.clock.value });
  const unread = createUnreadService({ repository: fixture.repository, participantDirectory: fixture.directory,
    now: () => fixture.clock.value });
  const direct = await channels.createDirectConversation({ context: ownerContext(801),
    memberBotIds: [fixture.bots.jerry.id], pinned: false, idempotencyKey: "attention-direct-000801" });
  await messages.sendMessage({ context: residentContext(fixture.bots.jerry, "jerry", 802),
    channelId: direct.channel.id, messageId: fixtureId("message", 802), authorPrincipalId: fixture.bots.jerry.id,
    idempotencyKey: "attention-message-000802", kind: "result", text: "Visible unread reply", mentions: [],
    clientMessageId: null, replyToMessageId: null, tombstonesMessageId: null, provenance: { roundId: null, workId: null } });
  const badges = new SqliteUnreadRepository(fixture.database);
  const projection = () => new SqliteBootstrapRepository(fixture.database).readProjection({
    principalId: OWNER_ID, at: fixture.clock.value.toISOString(),
    availabilityPolicy: { degradedAfterMs: 30_000, offlineAfterMs: 90_000 } }).snapshot;
  const attention = async (expected: number) => {
    assert.equal(badges.badgeCountForPrincipal(OWNER_ID), expected, "APNs badge");
    assert.equal(projection().unreadTotal, expected, "bootstrap/widget total");
    const inbox = await unread.listInbox({ context: ownerContext(803, ["product:read"]) });
    assert.equal(inbox.reduce((total, row) => total + row.unread.count, 0), expected, "inbox attention");
    assert.equal(fixture.database.readOne<{ count: number }>("SELECT count(*) AS count FROM messages")?.count, 1);
    assert.equal(fixture.database.readOne<{ count: number }>("SELECT count(*) AS count FROM read_cursors")?.count, 0);
  };
  await attention(1);
  for (const lifecycle of ["archived", "failed", "provisioning"]) {
    fixture.database.raw.prepare("UPDATE bots SET lifecycle = ? WHERE id = ?").run(lifecycle, fixture.bots.jerry.id);
    await attention(0);
  }
  fixture.database.raw.prepare("UPDATE bots SET lifecycle = 'active', conversation_id = NULL WHERE id = ?").run(fixture.bots.jerry.id);
  await attention(0);
  fixture.database.raw.prepare("UPDATE bots SET conversation_id = ? WHERE id = ?").run(direct.channel.conversationId, fixture.bots.jerry.id);
  await attention(1);
  fixture.database.raw.prepare("UPDATE channels SET lifecycle = 'archived' WHERE id = ?").run(direct.channel.id);
  await attention(0);
  fixture.database.raw.prepare("UPDATE channels SET lifecycle = 'active' WHERE id = ?").run(direct.channel.id);
  await attention(1);
});

test("group attention returns on restore and clears only after acknowledged reads", async (t) => {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  const channels = createChannelService({ repository: fixture.repository, participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23), now: () => fixture.clock.value });
  const messages = createMessageService({ repository: fixture.repository, participantDirectory: fixture.directory,
    now: () => fixture.clock.value });
  const unread = createUnreadService({ repository: fixture.repository, participantDirectory: fixture.directory,
    now: () => fixture.clock.value });
  const group = await channels.createGroupChannel({ context: ownerContext(811), memberBotIds: [fixture.bots.jerry.id],
    title: "Family", purpose: "A group channel", pinned: false,
    responderPolicy: { mode: "mention_or_coordinator", coordinatorBotId: fixture.bots.jerry.id, responseOrder: "sequential", maxBotTurns: 1 },
    idempotencyKey: "attention-channel-000811" });
  for (const [suffix, text] of [[812, "Visible reply"], [813, null]] as const) {
    await messages.sendMessage({ context: residentContext(fixture.bots.jerry, "jerry", suffix),
      channelId: group.channel.id, messageId: fixtureId("message", suffix), authorPrincipalId: fixture.bots.jerry.id,
      idempotencyKey: `attention-message-${suffix}`, kind: text ? "result" : "system", text, mentions: [],
      clientMessageId: null, replyToMessageId: null, tombstonesMessageId: null, provenance: { roundId: null, workId: null } });
  }
  const badges = new SqliteUnreadRepository(fixture.database);
  const count = () => new SqliteBootstrapRepository(fixture.database).readProjection({ principalId: OWNER_ID,
    at: fixture.clock.value.toISOString(), availabilityPolicy: { degradedAfterMs: 30_000, offlineAfterMs: 90_000 } }).snapshot.unreadTotal;
  assert.equal(count(), 1, "internal empty origin is not owner attention");
  assert.equal(badges.badgeCountForPrincipal(OWNER_ID), 1);
  fixture.database.raw.prepare("UPDATE channels SET lifecycle = 'archived' WHERE id = ?").run(group.channel.id);
  assert.equal(count(), 0);
  assert.equal(badges.badgeCountForPrincipal(OWNER_ID), 0);
  fixture.database.raw.prepare("UPDATE channels SET lifecycle = 'active' WHERE id = ?").run(group.channel.id);
  assert.equal(count(), 1);
  await unread.markRead({ context: ownerContext(814, ["product:read"]), channelId: group.channel.id,
    readThroughSequence: 2, idempotencyKey: "attention-read-000814" });
  assert.equal(count(), 0);
  assert.equal(badges.badgeCountForPrincipal(OWNER_ID), 0);
});
