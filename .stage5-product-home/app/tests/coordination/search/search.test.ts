import assert from "node:assert/strict";
import test from "node:test";

import {
  MessagingError,
  createChannelService,
} from "../../../src/coordination/channels/index.js";
import { createMessageService } from "../../../src/coordination/messages/index.js";
import {
  CANONICAL_SEARCH_SCHEMA_DELTA_SQL,
  CANONICAL_SEARCH_INDEX_REBUILD_SQL,
  CanonicalSearchError,
  SqliteCanonicalSearchRepository,
  createCanonicalSearchService,
} from "../../../src/coordination/search/index.js";
import { SearchCursorCodec } from "../../../src/coordination/search/cursor.js";
import {
  OWNER_ID,
  createMessagingFixture,
  fixtureId,
  ownerContext,
  residentContext,
} from "../messaging/test-fixture.js";

const channelKey = (suffix: number) =>
  `m09-search-channel-${String(suffix).padStart(6, "0")}`;
const messageKey = (suffix: number) =>
  `m09-search-message-${String(suffix).padStart(6, "0")}`;

async function createSearchFixture(t: test.TestContext) {
  const fixture = await createMessagingFixture();
  t.after(fixture.close);
  fixture.database.raw.exec(CANONICAL_SEARCH_SCHEMA_DELTA_SQL);
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
  const jerry = await channels.createDirectConversation({
    context: ownerContext(2001),
    memberBotIds: [fixture.bots.jerry.id],
    pinned: false,
    idempotencyKey: channelKey(2001),
  });
  const records = await channels.createDirectConversation({
    context: ownerContext(2002),
    memberBotIds: [fixture.bots.records.id],
    pinned: false,
    idempotencyKey: channelKey(2002),
  });

  async function send(
    suffix: number,
    channelId: string,
    text: string,
  ) {
    fixture.clock.value = new Date(`2026-08-25T12:0${suffix - 2002}:00.000Z`);
    return messages.sendMessage({
      context: ownerContext(suffix),
      channelId,
      messageId: fixtureId("message", suffix),
      authorPrincipalId: OWNER_ID,
      idempotencyKey: messageKey(suffix),
      kind: "text",
      text,
      mentions: [],
      clientMessageId: null,
      replyToMessageId: null,
      tombstonesMessageId: null,
      provenance: { roundId: null, workId: null },
    });
  }

  const canary = await send(
    2003,
    jerry.channel.id,
    "M09 cobalt canary proves the canonical search route.",
  );
  const visible = await send(
    2004,
    jerry.channel.id,
    "The bluebird source receipt crossed into canonical search.",
  );
  const privateMessage = await send(
    2005,
    records.channel.id,
    "The apricot dossier belongs only to this Channel.",
  );
  const service = createCanonicalSearchService({
    repository: new SqliteCanonicalSearchRepository(fixture.database),
    participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x42),
    resolveCanary: ({ principalId, scope }) => {
      if (
        scope.kind === "channel" && scope.channelId === records.channel.id &&
        principalId === OWNER_ID
      ) {
        return {
          id: "m09-records-channel-canary",
          messageId: privateMessage.message.id,
          channelId: records.channel.id,
          query: "apricot dossier",
        };
      }
      if (
        (scope.kind === "all" || scope.channelId === jerry.channel.id) &&
        (principalId === OWNER_ID || principalId === fixture.bots.jerry.id)
      ) {
        return {
          id: "m09-canonical-message-canary",
          messageId: canary.message.id,
          channelId: jerry.channel.id,
          query: "cobalt canary",
        };
      }
      return null;
    },
    now: () => new Date("2026-08-25T12:10:00.000Z"),
  });
  return { fixture, service, jerry, records, canary, visible, privateMessage };
}

test("canonical FTS is maintained by the M08 transaction and search enforces membership and scope", async (t) => {
  const { service, fixture, jerry, records, visible, privateMessage } =
    await createSearchFixture(t);

  const found = await service.search({
    context: residentContext(fixture.bots.jerry, "jerry", 2051),
    query: "bluebird source receipt",
    scope: { kind: "all" },
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(found.results.map((result) => result.id), [visible.message.id]);
  assert.equal("nextBoundary" in found, false);
  assert.equal(found.results[0]?.excerpt.includes("bluebird source receipt"), true);
  assert.equal(found.completeness.respondingRoute, "/api/v1/search");
  assert.equal(found.completeness.authoritativeSource, "coordination.messages");
  assert.equal(found.completeness.indexRoute, "sqlite_fts5");
  assert.equal(found.completeness.samePathCanary.found, true);
  assert.deepEqual(found.completeness.samePathCanary, {
    id: "m09-canonical-message-canary",
    found: true,
    checkedAt: "2026-08-25T12:10:00.000Z",
  });
  assert.equal(found.completeness.sourceEventSequence,
    found.completeness.indexedThroughEventSequence);
  assert.equal(found.completeness.crossingProof.sourceRows,
    found.completeness.crossingProof.indexedRows);
  assert.deepEqual(found.completeness.filters, {
    principalId: fixture.bots.jerry.id,
    scope: "all",
    channelId: null,
    sourceClasses: ["coordination.messages"],
    membership: "active",
    visibility: "visible_not_tombstoned",
  });

  const hidden = await service.search({
    context: residentContext(fixture.bots.jerry, "jerry", 2052),
    query: "apricot dossier",
    scope: { kind: "all" },
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(hidden.results, []);
  assert.equal(hidden.completeness.verdict, "scoped_empty");
  assert.match(hidden.completeness.reason, /authorized canonical scope/);
  assert.equal(hidden.completeness.samePathCanary.found, true);

  await assert.rejects(
    service.search({
      context: residentContext(fixture.bots.jerry, "jerry", 2053),
      query: "apricot",
      scope: { kind: "channel", channelId: records.channel.id },
      cursor: null,
      limit: 10,
    }),
    (error: unknown) => {
      assert.equal(error instanceof CanonicalSearchError, true);
      if (!(error instanceof CanonicalSearchError)) return false;
      assert.equal(error.code, "scope_denied");
      assert.equal(error.httpStatus, 403);
      assert.equal(error.retryable, false);
      assert.deepEqual(error.details, {});
      return true;
    },
  );

  const ownerResult = await service.search({
    context: ownerContext(2054, ["product:read"]),
    query: "apricot dossier",
    scope: { kind: "channel", channelId: records.channel.id },
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(ownerResult.results.map((result) => result.id), [
    privateMessage.message.id,
  ]);
  assert.equal(
    ownerResult.completeness.samePathCanary.id,
    "m09-records-channel-canary",
  );
  assert.equal(ownerResult.completeness.samePathCanary.found, true);
  assert.equal(ownerResult.scope, `channel:${records.channel.id}`);
  assert.notEqual(jerry.channel.id, records.channel.id);
});

test("zero-result receipts distinguish an empty authorized scope from a blind route", async (t) => {
  const { service, fixture, canary, visible } = await createSearchFixture(t);
  const empty = await service.search({
    context: ownerContext(2101, ["product:read"]),
    query: "term-that-is-not-present",
    scope: { kind: "all" },
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(empty.results, []);
  assert.equal(empty.completeness.status, "complete");
  assert.equal(empty.completeness.verdict, "scoped_empty");
  assert.equal(empty.completeness.samePathCanary.found, true);
  assert.equal(empty.throughEventSequence >= empty.completeness.sourceEventSequence, true);

  fixture.database.raw.prepare(
    "UPDATE message_fts SET body_text = ? WHERE message_id = ?",
  ).run("Stale indexed text with unchanged row counts.", visible.message.id);
  const staleCrossing = await service.search({
    context: ownerContext(2102, ["product:read"]),
    query: "bluebird source receipt",
    scope: { kind: "all" },
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(staleCrossing.results, []);
  assert.equal(staleCrossing.completeness.verdict, "route_blind");
  assert.equal(staleCrossing.completeness.samePathCanary.found, true);
  assert.deepEqual(staleCrossing.completeness.crossingProof, {
    sourceRows: 3,
    indexedRows: 2,
    checkedAt: "2026-08-25T12:10:00.000Z",
  });

  fixture.database.raw.prepare("DELETE FROM message_fts WHERE message_id = ?")
    .run(canary.message.id);
  fixture.database.raw.prepare(
    "DELETE FROM search_watermarks WHERE source_class = 'coordination.messages'",
  ).run();
  const blind = await service.search({
    context: ownerContext(2103, ["product:read"]),
    query: "term-that-is-not-present",
    scope: { kind: "all" },
    cursor: null,
    limit: 10,
  });
  assert.deepEqual(blind.results, []);
  assert.equal(blind.completeness.status, "partial");
  assert.equal(blind.completeness.verdict, "route_blind");
  assert.equal(blind.completeness.samePathCanary.found, false);
  assert.match(blind.completeness.reason, /does not prove reality is empty/);

  fixture.database.raw.transaction(() => {
    fixture.database.raw.exec(CANONICAL_SEARCH_INDEX_REBUILD_SQL);
  }).immediate();
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM search_watermarks WHERE source_class = 'coordination.messages'",
  )?.count, 1);
  const rebuilt = await service.search({
    context: ownerContext(2104, ["product:read"]),
    query: "term-that-is-not-present",
    scope: { kind: "all" },
    cursor: null,
    limit: 10,
  });
  assert.equal(rebuilt.completeness.verdict, "scoped_empty");
  assert.equal(rebuilt.completeness.samePathCanary.found, true);
  assert.deepEqual(rebuilt.completeness.crossingProof, {
    sourceRows: 3,
    indexedRows: 3,
    checkedAt: "2026-08-25T12:10:00.000Z",
  });
});

test("search cursors are stable and bound to route, principal, query, and scope", async (t) => {
  const { service, fixture, jerry } = await createSearchFixture(t);
  const first = await service.search({
    context: ownerContext(2121, ["product:read"]),
    query: "canonical",
    scope: { kind: "all" },
    cursor: null,
    limit: 1,
  });
  assert.equal(first.results.length, 1);
  assert.ok(first.nextCursor);
  const second = await service.search({
    context: ownerContext(2122, ["product:read"]),
    query: "canonical",
    scope: { kind: "all" },
    cursor: first.nextCursor,
    limit: 1,
  });
  assert.equal(second.results.length, 1);
  assert.notEqual(second.results[0]?.id, first.results[0]?.id);
  assert.equal(second.nextCursor, null);

  await assert.rejects(
    service.search({
      context: residentContext(fixture.bots.jerry, "jerry", 2123),
      query: "canonical",
      scope: { kind: "all" },
      cursor: first.nextCursor,
      limit: 1,
    }),
    (error: unknown) =>
      error instanceof CanonicalSearchError && error.code === "cursor_invalid",
  );
  await assert.rejects(
    service.search({
      context: ownerContext(2124, ["product:read"]),
      query: "canonical",
      scope: { kind: "channel", channelId: jerry.channel.id },
      cursor: first.nextCursor,
      limit: 1,
    }),
    (error: unknown) =>
      error instanceof CanonicalSearchError && error.code === "cursor_invalid",
  );
  await assert.rejects(
    service.search({
      context: ownerContext(2125, ["product:read"]),
      query: "canonical",
      scope: { kind: "all" },
      cursor: `${first.nextCursor.slice(0, -1)}x`,
      limit: 1,
    }),
    (error: unknown) =>
      error instanceof CanonicalSearchError && error.code === "cursor_invalid",
  );
});

test("search cursor envelopes bind direction and validate their signed boundary", () => {
  const codec = new SearchCursorCodec(Buffer.alloc(32, 0x51));
  const messageId = fixtureId("message", 2141);
  const cursor = codec.encode(
    { createdAt: "2026-08-25T12:14:00.000Z", messageId },
    OWNER_ID,
    "a".repeat(64),
    { kind: "all" },
  );
  const payload = JSON.parse(
    Buffer.from(cursor.split(".")[0]!, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  assert.equal(payload.direction, "forward");
  assert.deepEqual(codec.decode(cursor, OWNER_ID, "a".repeat(64), { kind: "all" }), {
    createdAt: "2026-08-25T12:14:00.000Z",
    messageId,
  });
  assert.throws(
    () => codec.encode(
      { createdAt: "not-a-timestamp", messageId },
      OWNER_ID,
      "a".repeat(64),
      { kind: "all" },
    ),
    (error: unknown) =>
      error instanceof CanonicalSearchError && error.code === "cursor_invalid",
  );
  assert.throws(
    () => codec.encode(
      { createdAt: "2026-08-25T12:14:00.000Z", messageId: "not-a-message" },
      OWNER_ID,
      "a".repeat(64),
      { kind: "all" },
    ),
    (error: unknown) =>
      error instanceof CanonicalSearchError && error.code === "cursor_invalid",
  );
});

test("FTS writes roll back when the canonical event append fails", async (t) => {
  const { fixture, jerry } = await createSearchFixture(t);
  const messageId = fixtureId("message", 2151);

  assert.throws(() => fixture.database.mutateWithEvent((transaction) => {
    transaction.run(
      `INSERT INTO messages (
        id, channel_id, channel_sequence, author_principal_id, author_kind,
        author_display_name, kind, body_text, stored_visibility,
        client_message_id, reply_to_message_id, tombstones_message_id,
        round_id, work_id, created_at
      ) VALUES (?, ?, 3, ?, 'owner', 'Owner', 'text', ?, 'visible',
                NULL, NULL, NULL, NULL, NULL, ?)`,
      messageId,
      jerry.channel.id,
      OWNER_ID,
      "This trigger write must roll back.",
      "2026-08-25T12:15:00.000Z",
    );
    return {
      value: undefined,
      event: {
        type: "message.appended",
        aggregateKind: "message",
        aggregateId: messageId,
        aggregateVersion: 2,
        channelId: jerry.channel.id,
        actorPrincipalId: OWNER_ID,
        requestId: fixtureId("request", 2151),
        correlationId: fixtureId("correlation", 2151),
        payload: { messageId },
        createdAt: "2026-08-25T12:15:00.000Z",
      },
    };
  }), /aggregate version is not gap-free/);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM messages WHERE id = ?",
    messageId,
  )?.count, 0);
  assert.equal(fixture.database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM message_fts WHERE message_id = ?",
    messageId,
  )?.count, 0);
});

test("resident search rechecks the stored M08 actor binding after directory resolution", async (t) => {
  const { fixture } = await createSearchFixture(t);
  let raced = false;
  const participantDirectory = {
    ...fixture.directory,
    getBotByResidentBinding: async (binding: string) => {
      const authorized = await fixture.residentAuthority.getBotByResidentBinding(binding);
      if (!raced) {
        raced = true;
        fixture.database.raw.prepare(
          `UPDATE bots
           SET active_instance_id = 'jerry-instance-rotated',
               active_key_version = 2,
               version = version + 1
           WHERE resident_binding = ?`,
        ).run(binding);
      }
      return authorized;
    },
  };
  const service = createCanonicalSearchService({
    repository: new SqliteCanonicalSearchRepository(fixture.database),
    participantDirectory,
    cursorSigningKey: Buffer.alloc(32, 0x52),
    resolveCanary: () => null,
  });

  await assert.rejects(
    service.search({
      context: residentContext(fixture.bots.jerry, "jerry", 2161),
      query: "cobalt canary",
      scope: { kind: "all" },
      cursor: null,
      limit: 10,
    }),
    (error: unknown) =>
      error instanceof MessagingError && error.code === "identity_context_mismatch",
  );
});
