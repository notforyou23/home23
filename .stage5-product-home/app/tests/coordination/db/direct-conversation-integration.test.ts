import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createChannelService,
  MessagingError,
  SqliteMessagingRepository,
  type MessagingParticipantDirectory,
} from "../../../src/coordination/channels/index.js";
import {
  openCoordinationDatabase,
  restoreVerifiedBackup,
  type CoordinationDatabase,
} from "../../../src/coordination/db/index.js";

const NOW = "2026-08-25T12:00:00.000Z";
const BOT_ID = "bot_0198d95f-6c00-7000-8000-000000000301";
const CHANNEL_ID = "chn_0198d95f-6c00-7000-8000-000000000302";
const CONVERSATION_ID = "cnv_0198d95f-6c00-7000-8000-000000000303";
const REQUEST_ID = "req_0198d95f-6c00-7000-8000-000000000304";
const CORRELATION_ID = "cor_0198d95f-6c00-7000-8000-000000000305";

function temporaryDatabase(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "home23-direct-integration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "coordination.sqlite3");
}

function seedOwnerAndBot(database: CoordinationDatabase): void {
  database.mutateWithEvent((transaction) => {
    transaction.run(
      "INSERT INTO principals (id, kind, created_at) VALUES ('user_owner', 'owner', ?)",
      NOW,
    );
    transaction.run(
      "INSERT INTO principals (id, kind, created_at) VALUES (?, 'bot', ?)",
      BOT_ID,
      NOW,
    );
    transaction.run(
      `INSERT INTO bots (
        id, principal_id, name, purpose, lifecycle, conversation_id,
        resident_binding, continuing_identity, durable_mailbox,
        required_capabilities_json, active_instance_id, active_key_version,
        resident_protocol_version, resident_capabilities_json,
        resident_registered_at, last_heartbeat_at, reported_availability,
        version, created_at, updated_at
      ) VALUES (?, ?, 'Jerry', 'Persistent household Bot.', 'active', NULL,
                'jerry', 1, 1, '["messages"]', NULL, NULL, NULL, '[]',
                NULL, NULL, NULL, 1, ?, ?)`,
      BOT_ID,
      BOT_ID,
      NOW,
      NOW,
    );
    return {
      value: undefined,
      event: {
        type: "bot.created",
        aggregateKind: "bot",
        aggregateId: BOT_ID,
        aggregateVersion: 1,
        channelId: null,
        actorPrincipalId: "user_owner",
        requestId: "req_0198d95f-6c00-7000-8000-000000000311",
        correlationId: "cor_0198d95f-6c00-7000-8000-000000000312",
        payload: { botId: BOT_ID, botVersion: 1 },
        createdAt: NOW,
      },
    };
  });
}

function directory(
  database: CoordinationDatabase,
  projectedVersion?: number,
  projectedResidentBinding?: string,
): MessagingParticipantDirectory {
  function record() {
    const row = database.readOne<{
      id: string;
      principalId: string;
      name: string;
      purpose: string;
      lifecycle: "active";
      conversationId: string | null;
      residentBinding: string;
      version: number;
      createdAt: string;
      updatedAt: string;
    }>(
      `SELECT id, principal_id AS principalId, name, purpose, lifecycle,
              conversation_id AS conversationId, resident_binding AS residentBinding,
              version, created_at AS createdAt, updated_at AS updatedAt
       FROM bots WHERE id = ?`,
      BOT_ID,
    )!;
    return Object.freeze({
      ...row,
      version: projectedVersion ?? row.version,
      residentBinding: projectedResidentBinding ?? row.residentBinding,
      availability: "offline" as const,
      continuingIdentity: true,
      durableMailbox: true,
      requiredCapabilities: Object.freeze(["messages"]),
      activeInstanceId: null,
      activeKeyVersion: null,
      residentProtocolVersion: null,
      residentCapabilities: Object.freeze([]),
      residentRegisteredAt: null,
      lastHeartbeatAt: null,
      reportedAvailability: null,
    });
  }
  return Object.freeze({
    listVisibleBots: async () => Object.freeze([record()]),
    resolveAlias: async (namespace: string, value: string) =>
      namespace === "resident" && value === "jerry" ? record() : null,
    getBotByResidentBinding: async (residentBinding: string) =>
      residentBinding === "jerry" ? record() : null,
  });
}

function ownerContext() {
  return {
    principalId: "user_owner",
    requestId: REQUEST_ID,
    correlationId: CORRELATION_ID,
    identity: {
      kind: "owner" as const,
      auth: {
        principalId: "user_owner" as const,
        deviceId: "dev_0198d95f-6c00-7000-8000-000000000306",
        sessionId: "ses_0198d95f-6c00-7000-8000-000000000307",
        scopes: ["product:read", "message:send"] as const,
      },
    },
  };
}

async function productionAdapter() {
  const module = await import("../../../src/coordination/channels/index.js") as Record<
    string,
    unknown
  >;
  assert.equal(typeof module.SqliteBotConversationBindingAdapter, "function");
  const Adapter = module.SqliteBotConversationBindingAdapter as new () => object;
  return new Adapter();
}

test("production direct creation binds the Bot and appends Bot then Channel events exactly once", async (t) => {
  const path = temporaryDatabase(t);
  const database = openCoordinationDatabase({ path });
  seedOwnerAndBot(database);
  const adapter = await productionAdapter();
  const repository = new SqliteMessagingRepository(database, {
    botConversationBinding: adapter as never,
  });
  const service = createChannelService({
    repository,
    participantDirectory: directory(database),
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => new Date(NOW),
    idGenerator: (kind) => kind === "channel" ? CHANNEL_ID : CONVERSATION_ID,
  });
  const input = {
    context: ownerContext(),
    memberBotIds: [BOT_ID],
    pinned: false,
    idempotencyKey: "m04-production-direct-creation",
  } as const;

  const created = await service.createDirectConversation(input);
  assert.equal(created.outcome, "created");
  assert.equal(created.channel.id, CHANNEL_ID);
  assert.equal(created.receipt.eventSequence, 3);
  assert.deepEqual(
    database.readOne<{ conversationId: string | null; version: number }>(
      "SELECT conversation_id AS conversationId, version FROM bots WHERE id = ?",
      BOT_ID,
    ),
    { conversationId: CONVERSATION_ID, version: 2 },
  );
  assert.deepEqual(
    database.readAll<{
      sequence: number;
      type: string;
      aggregateKind: string;
      aggregateId: string;
      aggregateVersion: number;
      requestId: string;
      correlationId: string;
    }>(
      `SELECT sequence, type, aggregate_kind AS aggregateKind,
              aggregate_id AS aggregateId, aggregate_version AS aggregateVersion,
              request_id AS requestId, correlation_id AS correlationId
       FROM events ORDER BY sequence`,
    ),
    [
      {
        sequence: 1,
        type: "bot.created",
        aggregateKind: "bot",
        aggregateId: BOT_ID,
        aggregateVersion: 1,
        requestId: "req_0198d95f-6c00-7000-8000-000000000311",
        correlationId: "cor_0198d95f-6c00-7000-8000-000000000312",
      },
      {
        sequence: 2,
        type: "bot.updated",
        aggregateKind: "bot",
        aggregateId: BOT_ID,
        aggregateVersion: 2,
        requestId: REQUEST_ID,
        correlationId: CORRELATION_ID,
      },
      {
        sequence: 3,
        type: "channel.created",
        aggregateKind: "channel",
        aggregateId: CHANNEL_ID,
        aggregateVersion: 1,
        requestId: REQUEST_ID,
        correlationId: CORRELATION_ID,
      },
    ],
  );
  const claim = database.readOne<{ resultRefJson: string }>(
    `SELECT result_ref_json AS resultRefJson FROM idempotency_records
     WHERE principal_id = 'user_owner' AND operation = 'channel.create'`,
  )!;
  assert.deepEqual(JSON.parse(claim.resultRefJson).eventReference, {
    aggregateKind: "channel",
    aggregateId: CHANNEL_ID,
    aggregateVersion: 1,
  });

  const replayed = await service.createDirectConversation(input);
  assert.equal(replayed.outcome, "replayed");
  assert.equal(replayed.receipt.eventSequence, 3);
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM events",
  )?.count, 3);
  database.close();

  const reopened = openCoordinationDatabase({ path });
  const reopenedRepository = new SqliteMessagingRepository(reopened, {
    botConversationBinding: await productionAdapter() as never,
  });
  const reopenedService = createChannelService({
    repository: reopenedRepository,
    participantDirectory: directory(reopened),
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => new Date(NOW),
    idGenerator: (kind) => kind === "channel" ? CHANNEL_ID : CONVERSATION_ID,
  });
  const restartReplay = await reopenedService.createDirectConversation(input);
  assert.equal(restartReplay.outcome, "replayed");
  assert.equal(restartReplay.receipt.eventSequence, 3);
  assert.deepEqual(reopened.readAll("PRAGMA foreign_key_check"), []);
  const expectedProductState = Object.freeze({
    bot: reopened.readOne(
      "SELECT conversation_id, version FROM bots WHERE id = ?",
      BOT_ID,
    ),
    channel: reopened.readOne(
      `SELECT channels.id, conversation_handles.id AS conversation_id, channels.version
       FROM channels JOIN conversation_handles
         ON conversation_handles.channel_id = channels.id
       WHERE channels.id = ?`,
      CHANNEL_ID,
    ),
    idempotency: reopened.readOne(
      `SELECT principal_id, operation, idempotency_key_digest, request_digest, request_id,
              correlation_id, result_kind, result_ref_json
       FROM idempotency_records WHERE operation = 'channel.create'`,
    ),
    events: reopened.readAll("SELECT * FROM events ORDER BY sequence"),
  });
  const backupPath = `${path}.backup`;
  const restoredPath = `${path}.restored`;
  const backup = await reopened.createVerifiedBackup({ path: backupPath });
  assert.equal(backup.eventSequence, 3);
  reopened.close();

  const restoredReceipt = await restoreVerifiedBackup({
    backupPath,
    destinationPath: restoredPath,
    expectedSha256: backup.sha256,
  });
  assert.equal(restoredReceipt.eventSequence, 3);
  const restored = openCoordinationDatabase({ path: restoredPath });
  assert.deepEqual(restored.readOne(
    "SELECT conversation_id, version FROM bots WHERE id = ?",
    BOT_ID,
  ), expectedProductState.bot);
  assert.deepEqual(restored.readOne(
    `SELECT channels.id, conversation_handles.id AS conversation_id, channels.version
     FROM channels JOIN conversation_handles
       ON conversation_handles.channel_id = channels.id
     WHERE channels.id = ?`,
    CHANNEL_ID,
  ), expectedProductState.channel);
  assert.deepEqual(restored.readOne(
    `SELECT principal_id, operation, idempotency_key_digest, request_digest, request_id,
            correlation_id, result_kind, result_ref_json
     FROM idempotency_records WHERE operation = 'channel.create'`,
  ), expectedProductState.idempotency);
  assert.deepEqual(
    restored.readAll("SELECT * FROM events ORDER BY sequence"),
    expectedProductState.events,
  );
  assert.deepEqual(restored.readAll("PRAGMA foreign_key_check"), []);
  restored.close();
});

test("a stale Bot version loses the binding race and rolls back every direct-creation effect", async (t) => {
  const path = temporaryDatabase(t);
  const database = openCoordinationDatabase({ path });
  seedOwnerAndBot(database);
  database.mutateWithEvent((transaction) => {
    transaction.run(
      "UPDATE bots SET purpose = ?, version = 2, updated_at = ? WHERE id = ? AND version = 1",
      "Purpose changed after roster resolution.",
      NOW,
      BOT_ID,
    );
    return {
      value: undefined,
      event: {
        type: "bot.updated",
        aggregateKind: "bot",
        aggregateId: BOT_ID,
        aggregateVersion: 2,
        channelId: null,
        actorPrincipalId: "user_owner",
        requestId: "req_0198d95f-6c00-7000-8000-000000000321",
        correlationId: "cor_0198d95f-6c00-7000-8000-000000000322",
        payload: { botId: BOT_ID, botVersion: 2, change: "purpose" },
        createdAt: NOW,
      },
    };
  });
  const repository = new SqliteMessagingRepository(database, {
    botConversationBinding: await productionAdapter() as never,
  });
  const service = createChannelService({
    repository,
    participantDirectory: directory(database, 1),
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => new Date(NOW),
    idGenerator: (kind) => kind === "channel" ? CHANNEL_ID : CONVERSATION_ID,
  });

  await assert.rejects(
    service.createDirectConversation({
      context: ownerContext(),
      memberBotIds: [BOT_ID],
      pinned: false,
      idempotencyKey: "m04-stale-bot-binding-race",
    }),
    (error: unknown) =>
      error instanceof MessagingError && error.code === "storage_conflict",
  );
  assert.deepEqual(
    database.readOne<{ conversationId: string | null; version: number }>(
      "SELECT conversation_id AS conversationId, version FROM bots WHERE id = ?",
      BOT_ID,
    ),
    { conversationId: null, version: 2 },
  );
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM channels",
  )?.count, 0);
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM conversation_handles",
  )?.count, 0);
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM idempotency_records",
  )?.count, 0);
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM events",
  )?.count, 2);
  database.close();
});

test("the production adapter rejects a mismatched resident binding without partial state", async (t) => {
  const path = temporaryDatabase(t);
  const database = openCoordinationDatabase({ path });
  seedOwnerAndBot(database);
  const repository = new SqliteMessagingRepository(database, {
    botConversationBinding: await productionAdapter() as never,
  });
  const service = createChannelService({
    repository,
    participantDirectory: directory(database, undefined, "forged-jerry"),
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => new Date(NOW),
    idGenerator: (kind) => kind === "channel" ? CHANNEL_ID : CONVERSATION_ID,
  });

  await assert.rejects(
    service.createDirectConversation({
      context: ownerContext(),
      memberBotIds: [BOT_ID],
      pinned: false,
      idempotencyKey: "m04-wrong-resident-binding",
    }),
    (error: unknown) =>
      error instanceof MessagingError && error.code === "storage_conflict",
  );
  assert.deepEqual(
    database.readOne<{ conversationId: string | null; version: number }>(
      "SELECT conversation_id AS conversationId, version FROM bots WHERE id = ?",
      BOT_ID,
    ),
    { conversationId: null, version: 1 },
  );
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM channels",
  )?.count, 0);
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM idempotency_records",
  )?.count, 0);
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM events",
  )?.count, 1);
  database.close();
});

test("a later Channel event failure rolls back the preceding Bot event and every row", async (t) => {
  const path = temporaryDatabase(t);
  const database = openCoordinationDatabase({ path });
  seedOwnerAndBot(database);
  database.mutateWithEvent((transaction) => {
    transaction.run(
      "INSERT INTO kernel_meta (key, value, updated_at) VALUES (?, ?, ?)",
      "test.induced-channel-event-collision",
      CHANNEL_ID,
      NOW,
    );
    return {
      value: undefined,
      event: {
        type: "channel.created",
        aggregateKind: "channel",
        aggregateId: CHANNEL_ID,
        aggregateVersion: 1,
        channelId: CHANNEL_ID,
        actorPrincipalId: "user_owner",
        requestId: "req_0198d95f-6c00-7000-8000-000000000331",
        correlationId: "cor_0198d95f-6c00-7000-8000-000000000332",
        payload: { inducedCollision: true },
        createdAt: NOW,
      },
    };
  });
  const repository = new SqliteMessagingRepository(database, {
    botConversationBinding: await productionAdapter() as never,
  });
  const service = createChannelService({
    repository,
    participantDirectory: directory(database),
    cursorSigningKey: Buffer.alloc(32, 0x23),
    now: () => new Date(NOW),
    idGenerator: (kind) => kind === "channel" ? CHANNEL_ID : CONVERSATION_ID,
  });

  await assert.rejects(
    service.createDirectConversation({
      context: ownerContext(),
      memberBotIds: [BOT_ID],
      pinned: false,
      idempotencyKey: "m04-induced-channel-event-collision",
    }),
    /aggregate version.*expected 2.*received 1/,
  );
  assert.deepEqual(
    database.readOne<{ conversationId: string | null; version: number }>(
      "SELECT conversation_id AS conversationId, version FROM bots WHERE id = ?",
      BOT_ID,
    ),
    { conversationId: null, version: 1 },
  );
  for (const table of [
    "channels",
    "conversation_handles",
    "channel_members",
    "direct_channel_pairs",
    "idempotency_records",
  ]) {
    assert.equal(database.readOne<{ count: number }>(
      `SELECT count(*) AS count FROM ${table}`,
    )?.count, 0, `${table} must roll back`);
  }
  assert.deepEqual(
    database.readAll<{ sequence: number; type: string }>(
      "SELECT sequence, type FROM events ORDER BY sequence",
    ),
    [
      { sequence: 1, type: "bot.created" },
      { sequence: 2, type: "channel.created" },
    ],
  );
  database.close();
});
