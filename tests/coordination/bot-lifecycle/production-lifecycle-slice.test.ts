import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCoordinationApplication,
  createCoordinationProcess,
  disabledCoordinationFeatureFlags,
} from "../../../src/coordination/app/index.js";
import {
  BotLifecycleError,
  createBotLifecycleService,
  derivePersistentBotBinding,
  SqliteBotLifecycleReceiptStore,
  SqlitePersistentMailboxBinder,
  type PersistentBotControlRequest,
  type PersistentBotCreateRequest,
} from "../../../src/coordination/bot-lifecycle/index.js";
import { openCoordinationDatabase } from "../../../src/coordination/db/index.js";
import {
  COORDINATION_BOT_LIFECYCLE_WRITER,
  COORDINATION_MESSAGES_WRITER,
  type AuthorityEpoch,
} from "../../../src/coordination/epochs/index.js";
import { generateCoordinationId } from "../../../src/coordination/ids/index.js";
import { bootstrapJerry } from "../../../src/coordination/operations/index.js";
import { classifyPolicy, type PolicyRequest } from "../../../src/coordination/policy/index.js";

const NOW = "2026-09-02T16:00:00.000Z";
const FLAGS = Object.freeze({
  ...disabledCoordinationFeatureFlags(),
  "coordination.process.enabled": true,
  "coordination.public_api.enabled": true,
  "coordination.bot_lifecycle.enabled": true,
});

function policy(operation: string, target: string): PolicyRequest {
  return {
    action: { actorPrincipalId: "user_owner", operation, target, parameters: {} },
    factSource: {
      kind: "trusted_policy_boundary",
      reference: "home23:authenticated-owner-bot-lifecycle:v1",
    },
    standing: {
      scope: "within",
      delegation: "within",
      budget: "within",
      audience: "within",
      allowlist: "within",
    },
    impactClasses: [],
    contextAccess: { kind: "none" },
  };
}

function canonicalEpoch(capability: "messages" | "bot_lifecycle"): AuthorityEpoch {
  return {
    capability,
    epoch: 3,
    mode: "canonical",
    writer: capability === "messages"
      ? COORDINATION_MESSAGES_WRITER
      : COORDINATION_BOT_LIFECYCLE_WRITER,
    effectiveAtEventSequence: 1,
    rollbackEpoch: 1,
  };
}

function appendAuthorityHistory(databasePath: string): void {
  const database = openCoordinationDatabase({ path: databasePath });
  try {
    const append = (
      capability: "messages" | "bot_lifecycle",
      epoch: number,
      mode: "legacy" | "shadow" | "canonical",
      writer: string,
      rollbackEpoch: number | null = null,
    ) => {
      const sequence = database.readOne<{ sequence: number }>(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events",
      )?.sequence ?? 0;
      const createdAt = new Date(Date.parse(NOW) + sequence + 1).toISOString();
      database.mutateWithEvent((transaction) => {
        transaction.run(
          `INSERT INTO authority_epochs
             (capability, epoch, mode, writer, effective_at_event_sequence,
              rollback_epoch, receipt_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          capability, epoch, mode, writer, mode === "canonical" ? sequence : null,
          rollbackEpoch, JSON.stringify({ kind: "test", epoch }), createdAt,
        );
        return { value: undefined, event: {
          type: "authority.epoch_changed", aggregateKind: "authorityEpoch",
          aggregateId: `authority:${capability}`, aggregateVersion: epoch,
          channelId: null, actorPrincipalId: "user_owner",
          requestId: generateCoordinationId("request"),
          correlationId: generateCoordinationId("correlation"),
          payload: { capability, epoch, mode, writer }, createdAt,
        } };
      });
    };
    append("messages", 2, "shadow", "legacy-conversation-writer");
    append("messages", 3, "canonical", COORDINATION_MESSAGES_WRITER, 1);
    append("bot_lifecycle", 1, "legacy", "legacy-bot-lifecycle-writer");
    append("bot_lifecycle", 2, "shadow", "legacy-bot-lifecycle-writer");
    append("bot_lifecycle", 3, "canonical", COORDINATION_BOT_LIFECYCLE_WRITER, 1);
  } finally {
    database.close();
  }
}

test("production lightweight Bot lifecycle is durable, atomic, replay-safe, and authority-reversible", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-lightweight-bot-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "coordination.sqlite3");
  await bootstrapJerry({
    databasePath,
    apply: true,
    authority: {
      approved: true,
      kind: "m14-bootstrap",
      operator: "user_owner",
      resident: "jerry",
      legacyWriterAuthoritative: true,
      coordinationFlagsAllFalse: true,
    },
    serverInstanceId: "home23-jerry-harness",
    keyVersion: 1,
    now: () => new Date(NOW),
  });
  appendAuthorityHistory(databasePath);

  let database = openCoordinationDatabase({ path: databasePath, now: () => new Date(NOW) });
  const binder = new SqlitePersistentMailboxBinder({
    database,
    now: () => new Date(NOW),
  });
  const service = createBotLifecycleService({
    authority: {
      enabled: () => true,
      currentEpoch: async () => canonicalEpoch("bot_lifecycle"),
      decide: (request) => classifyPolicy(request, new Date(NOW)),
    },
    mailboxBinder: binder,
    receipts: new SqliteBotLifecycleReceiptStore(database),
    canonicalWriter: COORDINATION_BOT_LIFECYCLE_WRITER,
    now: () => new Date(NOW),
  });
  const createKey = "lightweight-bot-create-0001";
  const displayName = "Roadie";
  const target = derivePersistentBotBinding({ requestId: createKey, displayName });
  const createRequest: PersistentBotCreateRequest = {
    requestId: createKey,
    correlationId: generateCoordinationId("correlation"),
    actorPrincipalId: "user_owner",
    displayName,
    purpose: "Help with one bounded music project",
    policy: policy("bot_lifecycle.create", target),
    expectedAuthorityEpoch: 3,
  };
  const created = await service.create(createRequest);
  const retryCorrelation = generateCoordinationId("correlation");
  const replayed = await service.create({
    ...createRequest,
    correlationId: retryCorrelation,
    expectedAuthorityEpoch: 99,
  });
  assert.deepEqual(replayed, created);
  assert.equal(replayed.correlationId, createRequest.correlationId);
  assert.notEqual(replayed.correlationId, retryCorrelation);
  await assert.rejects(
    service.create({ ...createRequest, purpose: "A different request body" }),
    (error: unknown) => error instanceof BotLifecycleError && error.code === "request_id_conflict",
  );

  const mailboxSnapshot = () => database.readOne<{
    members: number;
    history: number;
    pairs: number;
    aliases: number;
  }>(
    `SELECT
       (SELECT count(*) FROM channel_members member JOIN conversation_handles handle
          ON handle.channel_id = member.channel_id WHERE handle.id = ?) AS members,
       (SELECT count(*) FROM channel_membership_history history JOIN conversation_handles handle
          ON handle.channel_id = history.channel_id WHERE handle.id = ?) AS history,
       (SELECT count(*) FROM direct_channel_pairs pair JOIN conversation_handles handle
          ON handle.channel_id = pair.channel_id WHERE handle.id = ?) AS pairs,
       (SELECT count(*) FROM aliases WHERE target_id = ?) AS aliases`,
    created.mailboxId!,
    created.mailboxId!,
    created.mailboxId!,
    created.botId!,
  )!;
  const originalMailbox = mailboxSnapshot();
  assert.deepEqual(originalMailbox, {
    members: 2,
    history: 2,
    pairs: 1,
    aliases: 1,
  });
  const storedReceipt = database.readOne<{ keyDigest: string; receiptJson: string }>(
    `SELECT request_key_digest AS keyDigest, receipt_json AS receiptJson
     FROM bot_lifecycle_receipts WHERE operation = 'create'`,
  )!;
  assert.match(storedReceipt.keyDigest, /^[0-9a-f]{64}$/);
  assert.equal(storedReceipt.receiptJson.includes(createKey), false);
  assert.equal(database.readOne<{ count: number }>(
    `SELECT count(*) AS count FROM events
     WHERE (type LIKE 'bot_lifecycle.%' OR aggregate_id = ? OR channel_id = (
       SELECT channel_id FROM conversation_handles WHERE id = ?
     )) AND request_id NOT LIKE 'req_%'`,
    created.botId!,
    created.mailboxId!,
  )!.count, 0);

  const control = (
    operation: PersistentBotControlRequest["operation"],
    requestId: string,
    botId = created.botId!,
  ): PersistentBotControlRequest => ({
    requestId,
    correlationId: generateCoordinationId("correlation"),
    actorPrincipalId: "user_owner",
    botId,
    operation,
    policy: policy(`bot_lifecycle.${operation}`, botId),
    expectedAuthorityEpoch: 3,
  });
  const archived = await service.control(control("archive", "lightweight-bot-archive-0001"));
  const restored = await service.control(control("restore", "lightweight-bot-restore-0001"));
  assert.deepEqual(
    [archived.botId, archived.mailboxId, restored.botId, restored.mailboxId],
    [created.botId, created.mailboxId, created.botId, created.mailboxId],
  );
  assert.deepEqual(mailboxSnapshot(), originalMailbox);
  const jerry = database.readOne<{ id: string }>(
    "SELECT id FROM bots WHERE resident_binding = 'jerry'",
  )!;
  await assert.rejects(
    service.control(control("archive", "permanent-jerry-archive-0001", jerry.id)),
    (error: unknown) =>
      error instanceof BotLifecycleError && error.code === "permanent_resident_protected",
  );

  const reservedAliasId = generateCoordinationId("alias");
  database.mutateWithEvent((transaction) => {
    transaction.run(
      `INSERT INTO aliases (
         id, namespace, alias_digest, target_type, target_id, active, created_at, updated_at
       ) VALUES (?, 'fixture', ?, 'fixture', 'reserved', 1, ?, ?)`,
      reservedAliasId,
      "f".repeat(64),
      NOW,
      NOW,
    );
    return {
      value: undefined,
      event: {
        type: "fixture.alias_reserved",
        aggregateKind: "fixture",
        aggregateId: reservedAliasId,
        aggregateVersion: 1,
        channelId: null,
        actorPrincipalId: "user_owner",
        requestId: generateCoordinationId("request"),
        correlationId: generateCoordinationId("correlation"),
        payload: {},
        createdAt: NOW,
      },
    };
  });
  const rollbackIds = {
    bot: generateCoordinationId("bot"),
    alias: reservedAliasId,
    channel: generateCoordinationId("channel"),
    conversation: generateCoordinationId("conversation"),
  };
  const failingBinder = new SqlitePersistentMailboxBinder({
    database,
    now: () => new Date(NOW),
    idGenerator: (kind) => rollbackIds[kind],
  });
  await assert.rejects(failingBinder.bindDurableBot({
    requestId: generateCoordinationId("request"),
    correlationId: generateCoordinationId("correlation"),
    actorPrincipalId: "user_owner",
    residentBinding: "bot-rollback-proof",
    displayName: "Rollback Proof",
    purpose: "Prove the whole mailbox mutation rolls back",
    atomicReceipt: {
      requestId: "lightweight-bot-rollback-0001",
      requestDigest: "e".repeat(64),
      authorityEpoch: 3,
      policyDecision: classifyPolicy(
        policy("bot_lifecycle.create", "bot-rollback-proof"),
        new Date(NOW),
      ),
    },
  }), { code: "mailbox_binding_conflict" });
  assert.deepEqual(database.readOne<{ bots: number; channels: number }>(
    `SELECT
       (SELECT count(*) FROM bots WHERE id = ?) AS bots,
       (SELECT count(*) FROM channels WHERE id = ?) AS channels`,
    rollbackIds.bot,
    rollbackIds.channel,
  ), { bots: 0, channels: 0 });

  database.close();
  const authorityRowsBefore = (() => {
    const check = openCoordinationDatabase({ path: databasePath });
    try {
      return check.readOne<{ count: number }>(
        "SELECT count(*) AS count FROM authority_epochs",
      )!.count;
    } finally {
      check.close();
    }
  })();
  const process = createCoordinationProcess({
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    databasePath,
    botRootDirectory: join(root, "bots"),
    socketPath: join(root, "coordination.sock"),
    capabilityToken: "a".repeat(64),
    residents: {
      jerry: {
        enabled: false,
        socketPath: join(root, "jerry.sock"),
        serverInstanceId: "home23-jerry-harness",
        clientInstanceId: "home23-jerry-harness",
        keyVersion: 1,
        key: "",
      },
      forrest: {
        enabled: false,
        socketPath: join(root, "forrest.sock"),
        serverInstanceId: "home23-forrest-harness",
        clientInstanceId: "home23-forrest-harness",
        keyVersion: 1,
        key: "",
      },
    },
    flags: FLAGS,
  });
  assert.equal(process.capabilities().capabilities.botLifecycle, true);
  await process.drain();
  database = openCoordinationDatabase({ path: databasePath });
  assert.equal(database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM authority_epochs",
  )!.count, authorityRowsBefore);
  database.close();

  let messagesEpoch = canonicalEpoch("messages");
  let lifecycleEpoch = canonicalEpoch("bot_lifecycle");
  const application = createCoordinationApplication({
    flags: FLAGS,
    services: {
      auth: { validateAccessToken: async () => { throw new Error("unused"); } },
      botLifecycleApi: {
        create: async () => { throw new Error("unused"); },
        control: async () => { throw new Error("unused"); },
      },
      authorityEpochs: {
        current: (capability) => capability === "messages"
          ? messagesEpoch
          : capability === "bot_lifecycle" ? lifecycleEpoch : null,
        listCurrent: async () => ({
          epochs: [messagesEpoch, lifecycleEpoch],
          throughEventSequence: 1,
        }),
      },
    },
  });
  assert.equal(application.capabilities().capabilities.botLifecycle, true);
  messagesEpoch = { ...messagesEpoch, epoch: 4, mode: "legacy" };
  assert.equal(application.capabilities().capabilities.botLifecycle, false);
  messagesEpoch = { ...messagesEpoch, epoch: 5, mode: "canonical", rollbackEpoch: 4 };
  lifecycleEpoch = { ...lifecycleEpoch, epoch: 4, mode: "legacy" };
  assert.equal(application.capabilities().capabilities.botLifecycle, false);
});
