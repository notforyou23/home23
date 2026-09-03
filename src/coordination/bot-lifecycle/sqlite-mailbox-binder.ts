import type {
  CoordinationDatabase,
  CoordinationEventInput,
  CoordinationTransaction,
} from "../db/index.js";
import { assertCoordinationId, generateCoordinationId } from "../ids/index.js";
import {
  digestBotAlias,
  type BotProjection,
} from "../bots/index.js";
import { BotLifecycleError } from "./errors.js";
import {
  insertBotLifecycleReceipt,
  readBotLifecycleReceipt,
} from "./sqlite-receipt-store.js";
import type { BotLifecycleReceipt, PersistentMailboxBinder } from "./types.js";

const RESIDENT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PROCESSLESS_CAPABILITIES = Object.freeze(["messages"] as const);
const PERMANENT_RESIDENT_BINDINGS = new Set(["jerry", "forrest"]);

interface BotRow {
  id: string;
  principalId: string;
  name: string;
  purpose: string;
  lifecycle: "provisioning" | "active" | "archived" | "failed";
  conversationId: string | null;
  residentBinding: string;
  continuingIdentity: number;
  durableMailbox: number;
  requiredCapabilitiesJson: string;
  activeInstanceId: string | null;
  activeKeyVersion: number | null;
  residentProtocolVersion: number | null;
  residentCapabilitiesJson: string;
  residentRegisteredAt: string | null;
  lastHeartbeatAt: string | null;
  reportedAvailability: "starting" | "available" | "busy" | "degraded" | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const SELECT_BOT = `SELECT id, principal_id AS principalId, name, purpose, lifecycle,
  conversation_id AS conversationId, resident_binding AS residentBinding,
  continuing_identity AS continuingIdentity, durable_mailbox AS durableMailbox,
  required_capabilities_json AS requiredCapabilitiesJson,
  active_instance_id AS activeInstanceId, active_key_version AS activeKeyVersion,
  resident_protocol_version AS residentProtocolVersion,
  resident_capabilities_json AS residentCapabilitiesJson,
  resident_registered_at AS residentRegisteredAt,
  last_heartbeat_at AS lastHeartbeatAt,
  reported_availability AS reportedAvailability,
  version, created_at AS createdAt, updated_at AS updatedAt
  FROM bots`;

export interface SqlitePersistentMailboxBinderOptions {
  database: CoordinationDatabase;
  now?: () => Date;
  idGenerator?: (kind: "bot" | "alias" | "channel" | "conversation") => string;
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new BotLifecycleError("request_invalid", "Mailbox clock is invalid");
  }
  return value.toISOString();
}

function projection(row: BotRow): BotProjection {
  return Object.freeze({
    id: row.id,
    principalId: row.principalId,
    name: row.name,
    purpose: row.purpose,
    lifecycle: row.lifecycle,
    // This adapter is a lifecycle command boundary. Product availability is
    // projected by BotDirectory; newly created on-demand Bots have no daemon.
    availability: "offline",
    conversationId: row.conversationId,
    residentBinding: row.residentBinding,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function nextEventVersion(
  transaction: CoordinationTransaction,
  aggregateKind: string,
  aggregateId: string,
): number {
  return (transaction.readOne<{ version: number | null }>(
    `SELECT max(aggregate_version) AS version FROM events
     WHERE aggregate_kind = ? AND aggregate_id = ?`,
    aggregateKind,
    aggregateId,
  )?.version ?? 0) + 1;
}

function canonicalText(value: string, maximum: number): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > maximum || result.includes("\0")) {
    throw new BotLifecycleError("request_invalid");
  }
  return result;
}

function receiptEvent(
  receipt: BotLifecycleReceipt,
  keyDigest: string,
  eventRequestId: string,
): CoordinationEventInput {
  return {
    type: "bot_lifecycle.receipt_recorded",
    aggregateKind: "botLifecycleReceipt",
    aggregateId: keyDigest,
    aggregateVersion: 1,
    channelId: null,
    actorPrincipalId: "user_owner",
    requestId: eventRequestId,
    correlationId: receipt.correlationId,
    payload: {
      requestKeyDigest: keyDigest,
      requestDigest: receipt.requestDigest,
      operation: receipt.operation,
      outcome: receipt.outcome,
    },
    createdAt: receipt.createdAt,
  };
}

function assertMatchingClaim(
  prior: BotLifecycleReceipt,
  operation: BotLifecycleReceipt["operation"],
  digest: string,
): void {
  if (prior.operation !== operation || prior.requestDigest !== digest) {
    throw new BotLifecycleError("request_id_conflict");
  }
}

export class SqlitePersistentMailboxBinder implements PersistentMailboxBinder {
  private readonly database: CoordinationDatabase;
  private readonly now: () => Date;
  private readonly idGenerator: NonNullable<SqlitePersistentMailboxBinderOptions["idGenerator"]>;

  constructor(options: SqlitePersistentMailboxBinderOptions) {
    if (!options?.database) throw new TypeError("Mailbox binder requires the coordination database");
    this.database = options.database;
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? ((kind) => generateCoordinationId(kind));
  }

  async bindDurableBot(input: Parameters<PersistentMailboxBinder["bindDurableBot"]>[0]) {
    assertCoordinationId("request", input.requestId);
    assertCoordinationId("correlation", input.correlationId);
    if (
      input.actorPrincipalId !== "user_owner" ||
      !RESIDENT.test(input.residentBinding) ||
      !input.residentBinding.startsWith("bot-") ||
      PERMANENT_RESIDENT_BINDINGS.has(input.residentBinding)
    ) throw new BotLifecycleError("request_invalid");
    const displayName = canonicalText(input.displayName, 128);
    const purpose = canonicalText(input.purpose, 512);
    const priorReceipt = readBotLifecycleReceipt(
      this.database,
      input.atomicReceipt.requestId,
    );
    if (priorReceipt) {
      assertMatchingClaim(priorReceipt, "create", input.atomicReceipt.requestDigest);
      if (!priorReceipt.botId) throw new BotLifecycleError("request_id_conflict");
      const replayed = this.database.readOne<BotRow>(
        `${SELECT_BOT} WHERE id = ?`,
        priorReceipt.botId,
      );
      if (!replayed) throw new Error("Lifecycle receipt lost its durable Bot");
      this.assertExisting(replayed, displayName, purpose);
      this.assertDurableDirectBinding(replayed);
      return projection(replayed);
    }
    const existing = this.database.readOne<BotRow>(
      `${SELECT_BOT} WHERE resident_binding = ?`,
      input.residentBinding,
    );
    if (existing?.conversationId) {
      this.assertExisting(existing, displayName, purpose);
      this.assertDurableDirectBinding(existing);
      return projection(existing);
    }

    const at = timestamp(this.now);
    const botId = existing?.id ?? this.makeId("bot");
    const channelId = this.makeId("channel");
    const conversationId = this.makeId("conversation");
    const alias = {
      namespace: "resident",
      digest: digestBotAlias("resident", input.residentBinding),
      id: this.makeId("alias"),
    };
    const result = this.database.mutateWithEvent<BotRow>((transaction) => {
      const racedReceipt = readBotLifecycleReceipt(
        transaction,
        input.atomicReceipt.requestId,
      );
      if (racedReceipt) {
        assertMatchingClaim(racedReceipt, "create", input.atomicReceipt.requestDigest);
        throw new BotLifecycleError("request_id_conflict", "Lifecycle request must be replayed");
      }
      const stored = transaction.readOne<BotRow>(
        `${SELECT_BOT} WHERE resident_binding = ?`,
        input.residentBinding,
      );
      if (stored) {
        this.assertExisting(stored, displayName, purpose);
        if (stored.conversationId) {
          throw Object.assign(new Error("Mailbox was bound by another executor"), {
            code: "mailbox_binding_conflict",
          });
        }
      }
      const targetId = stored?.id ?? botId;
      const collision = transaction.readOne<{ targetId: string }>(
        `SELECT target_id AS targetId FROM aliases
         WHERE namespace = ? AND alias_digest = ?`,
        alias.namespace,
        alias.digest,
      );
      if (collision && collision.targetId !== targetId) {
        throw new BotLifecycleError("request_invalid", "Resident alias collision");
      }

      transaction.run(
        "INSERT OR IGNORE INTO principals (id, kind, created_at) VALUES ('user_owner', 'owner', ?)",
        at,
      );
      const events: CoordinationEventInput[] = [];
      let botVersion: number;
      if (!stored) {
        transaction.run("INSERT INTO principals (id, kind, created_at) VALUES (?, 'bot', ?)", botId, at);
        transaction.run(
          `INSERT INTO bots (
             id, principal_id, name, purpose, lifecycle, conversation_id,
             resident_binding, continuing_identity, durable_mailbox,
             required_capabilities_json, active_instance_id, active_key_version,
             resident_protocol_version, resident_capabilities_json,
             resident_registered_at, last_heartbeat_at, reported_availability,
             version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'active', NULL, ?, 1, 1, ?, NULL, NULL, NULL,
                     '[]', NULL, NULL, NULL, 1, ?, ?)`,
          botId,
          botId,
          displayName,
          purpose,
          input.residentBinding,
          JSON.stringify(PROCESSLESS_CAPABILITIES),
          at,
          at,
        );
        events.push({
          type: "bot.created",
          aggregateKind: "bot",
          aggregateId: botId,
          aggregateVersion: nextEventVersion(transaction, "bot", botId),
          channelId: null,
          actorPrincipalId: "user_owner",
          requestId: input.requestId,
          correlationId: input.correlationId,
          payload: {
            botId,
            residentBinding: input.residentBinding,
            continuingIdentity: true,
            durableMailbox: true,
            runtime: "on_demand",
          },
          createdAt: at,
        });
        botVersion = 2;
      } else {
        botVersion = stored.version + 1;
      }

      transaction.run(
        `INSERT OR IGNORE INTO aliases (
           id, namespace, alias_digest, target_type, target_id, active, created_at, updated_at
         ) VALUES (?, ?, ?, 'bot', ?, 1, ?, ?)`,
        alias.id,
        alias.namespace,
        alias.digest,
        targetId,
        at,
        at,
      );
      const bound = transaction.readOne<{ targetType: string; targetId: string; active: number }>(
        `SELECT target_type AS targetType, target_id AS targetId, active
         FROM aliases WHERE namespace = ? AND alias_digest = ?`,
        alias.namespace,
        alias.digest,
      );
      if (!bound || bound.targetType !== "bot" || bound.targetId !== targetId || bound.active !== 1) {
        throw Object.assign(new Error("Resident alias binding could not be established"), {
          code: "mailbox_binding_conflict",
        });
      }

      transaction.run(
        `INSERT INTO channels (
           id, kind, title, purpose, owner_principal_id, responder_mode,
           coordinator_bot_id, response_order, max_bot_turns, lifecycle,
           pinned, version, next_message_sequence, created_at, updated_at
         ) VALUES (?, 'direct', ?, ?, 'user_owner', 'mention_or_coordinator', ?,
                   'sequential', 1, 'active', 1, 1, 1, ?, ?)`,
        channelId,
        displayName.slice(0, 120),
        `Direct durable conversation with ${displayName}.`.slice(0, 4000),
        targetId,
        at,
        at,
      );
      transaction.run(
        "INSERT INTO conversation_handles (id, channel_id, created_at) VALUES (?, ?, ?)",
        conversationId,
        channelId,
        at,
      );
      for (const member of [
        { principalId: "user_owner", kind: "owner", role: "owner" },
        { principalId: targetId, kind: "bot", role: "member" },
      ] as const) {
        transaction.run(
          `INSERT INTO channel_members (
             channel_id, principal_id, kind, role, active, joined_at, left_at
           ) VALUES (?, ?, ?, ?, 1, ?, NULL)`,
          channelId,
          member.principalId,
          member.kind,
          member.role,
          at,
        );
        transaction.run(
          `INSERT INTO channel_membership_history (
             channel_id, principal_id, kind, role, active,
             joined_channel_version, left_channel_version, joined_at, left_at
           ) VALUES (?, ?, ?, ?, 1, 1, NULL, ?, NULL)`,
          channelId,
          member.principalId,
          member.kind,
          member.role,
          at,
        );
      }
      const pair = ["user_owner", targetId].sort();
      transaction.run(
        `INSERT INTO direct_channel_pairs (
           first_principal_id, second_principal_id, channel_id, created_at
         ) VALUES (?, ?, ?, ?)`,
        pair[0]!,
        pair[1]!,
        channelId,
        at,
      );
      const updated = transaction.run(
        `UPDATE bots SET conversation_id = ?, version = ?, updated_at = ?
         WHERE id = ? AND resident_binding = ? AND lifecycle = 'active'
           AND conversation_id IS NULL AND continuing_identity = 1
           AND durable_mailbox = 1 AND version = ?`,
        conversationId,
        botVersion,
        at,
        targetId,
        input.residentBinding,
        stored?.version ?? 1,
      );
      if (updated.changes !== 1) {
        throw Object.assign(new Error("Bot mailbox binding conflicted"), {
          code: "mailbox_binding_conflict",
        });
      }
      const botEventVersion = nextEventVersion(transaction, "bot", targetId) + events.length;
      if (botEventVersion !== botVersion) {
        throw new Error("Bot row and append-only event versions diverged");
      }
      events.push({
        type: "bot.updated",
        aggregateKind: "bot",
        aggregateId: targetId,
        aggregateVersion: botEventVersion,
        channelId,
        actorPrincipalId: "user_owner",
        requestId: input.requestId,
        correlationId: input.correlationId,
        payload: {
          botId: targetId,
          botVersion,
          channelId,
          conversationId,
          change: "direct_conversation_bound",
        },
        createdAt: at,
      });
      events.push({
        type: "channel.created",
        aggregateKind: "channel",
        aggregateId: channelId,
        aggregateVersion: 1,
        channelId,
        actorPrincipalId: "user_owner",
        requestId: input.requestId,
        correlationId: input.correlationId,
        payload: {
          channelId,
          conversationId,
          kind: "direct",
          memberPrincipalIds: ["user_owner", targetId],
          botId: targetId,
          botVersion,
          channelVersion: 1,
        },
        createdAt: at,
      });
      const row = transaction.readOne<BotRow>(`${SELECT_BOT} WHERE id = ?`, targetId);
      if (!row) throw new Error("Atomic mailbox binding lost its Bot row");
      const storedReceipt = insertBotLifecycleReceipt(transaction, {
        ...input.atomicReceipt,
        correlationId: input.correlationId,
        operation: "create",
        residentBinding: input.residentBinding,
        botId: row.id,
        mailboxId: row.conversationId,
        outcome: "succeeded",
        completedPhases: ["authorized", "mailbox_bound"],
        failure: null,
        createdAt: at,
      });
      if (!storedReceipt.inserted) throw new BotLifecycleError("request_id_conflict");
      events.push(receiptEvent(storedReceipt.receipt, storedReceipt.keyDigest, input.requestId));
      return {
        value: row,
        events: events as [CoordinationEventInput, ...CoordinationEventInput[]],
      };
    }).value;
    return projection(result);
  }

  async getByBotId(botId: string): Promise<BotProjection | null> {
    assertCoordinationId("bot", botId);
    const row = this.database.readOne<BotRow>(`${SELECT_BOT} WHERE id = ?`, botId);
    return row ? projection(row) : null;
  }

  async transitionLifecycle(input: Parameters<PersistentMailboxBinder["transitionLifecycle"]>[0]) {
    assertCoordinationId("bot", input.botId);
    assertCoordinationId("request", input.requestId);
    assertCoordinationId("correlation", input.correlationId);
    if (input.actorPrincipalId !== "user_owner") throw new BotLifecycleError("request_invalid");
    const changedAt = new Date(input.changedAt);
    if (!Number.isFinite(changedAt.getTime()) || changedAt.toISOString() !== input.changedAt) {
      throw new BotLifecycleError("request_invalid");
    }
    const operation = input.to === "archived" ? "archive" : "restore";
    const priorReceipt = readBotLifecycleReceipt(
      this.database,
      input.atomicReceipt.requestId,
    );
    if (priorReceipt) {
      assertMatchingClaim(priorReceipt, operation, input.atomicReceipt.requestDigest);
      if (!priorReceipt.botId) throw new BotLifecycleError("request_id_conflict");
      const replayed = this.database.readOne<BotRow>(
        `${SELECT_BOT} WHERE id = ?`,
        priorReceipt.botId,
      );
      if (!replayed) throw new Error("Lifecycle receipt lost its durable Bot");
      return projection(replayed);
    }
    const before = this.database.readOne<BotRow>(`${SELECT_BOT} WHERE id = ?`, input.botId);
    if (!before) throw new BotLifecycleError("bot_not_found");
    if (PERMANENT_RESIDENT_BINDINGS.has(before.residentBinding)) {
      throw new BotLifecycleError("permanent_resident_protected");
    }
    this.assertDurableDirectBinding(before);
    if (before.lifecycle === input.to) return projection(before);
    if (before.lifecycle !== input.from) {
      throw new BotLifecycleError("request_invalid", "Bot lifecycle transition conflicted");
    }
    const updated = this.database.mutateWithEvent<BotRow>((transaction) => {
      const racedReceipt = readBotLifecycleReceipt(
        transaction,
        input.atomicReceipt.requestId,
      );
      if (racedReceipt) {
        assertMatchingClaim(racedReceipt, operation, input.atomicReceipt.requestDigest);
        throw new BotLifecycleError("request_id_conflict", "Lifecycle request must be replayed");
      }
      const row = transaction.readOne<BotRow>(`${SELECT_BOT} WHERE id = ?`, input.botId);
      if (!row || row.lifecycle !== input.from || row.version !== before.version) {
        throw Object.assign(new Error("Bot lifecycle transition conflicted"), {
          code: "mailbox_transition_conflict",
        });
      }
      if (input.to === "archived" && transaction.readOne(
        `SELECT id FROM works pending
         WHERE pending.target_principal_id = ?
           AND pending.kind IN ('bot_turn', 'channel.bot_turn')
           AND (pending.state IN ('queued', 'leased', 'running', 'cancelling') OR (
             pending.state = 'succeeded' AND NOT EXISTS (
               SELECT 1 FROM messages result
               WHERE result.id = 'msg_' || substr(pending.id, 5)
                 AND result.work_id = pending.id AND result.kind = 'result'
             ) AND (
               pending.kind = 'bot_turn' OR NOT EXISTS (
                 SELECT 1 FROM rounds settled_round
                 WHERE settled_round.id = pending.round_id
                   AND settled_round.state IN ('completed', 'failed', 'cancelled')
               )
             )
           )) LIMIT 1`,
        row.principalId,
      )) {
        throw Object.assign(new Error("Bot has unsettled work"), {
          code: "bot_has_unsettled_work",
        });
      }
      const version = row.version + 1;
      const eventVersion = nextEventVersion(transaction, "bot", row.id);
      if (eventVersion !== version) throw new Error("Bot lifecycle event version diverged");
      const result = transaction.run(
        `UPDATE bots SET lifecycle = ?, active_instance_id = NULL,
           active_key_version = NULL, resident_protocol_version = NULL,
           resident_capabilities_json = '[]', resident_registered_at = NULL,
           last_heartbeat_at = NULL, reported_availability = NULL,
           version = ?, updated_at = ?
         WHERE id = ? AND lifecycle = ? AND version = ?`,
        input.to,
        version,
        input.changedAt,
        input.botId,
        input.from,
        row.version,
      );
      if (result.changes !== 1) throw new Error("Bot lifecycle transition conflicted");
      const value = transaction.readOne<BotRow>(`${SELECT_BOT} WHERE id = ?`, input.botId);
      if (!value) throw new Error("Bot lifecycle transition lost its Bot row");
      const storedReceipt = insertBotLifecycleReceipt(transaction, {
        ...input.atomicReceipt,
        correlationId: input.correlationId,
        operation,
        residentBinding: value.residentBinding,
        botId: value.id,
        mailboxId: value.conversationId,
        outcome: "succeeded",
        completedPhases: [
          "authorized",
          operation === "archive" ? "mailbox_archived" : "mailbox_restored",
        ],
        failure: null,
        createdAt: input.changedAt,
      });
      if (!storedReceipt.inserted) throw new BotLifecycleError("request_id_conflict");
      return {
        value,
        events: [{
          type: "bot.updated",
          aggregateKind: "bot",
          aggregateId: input.botId,
          aggregateVersion: eventVersion,
          channelId: null,
          actorPrincipalId: "user_owner",
          requestId: input.requestId,
          correlationId: input.correlationId,
          payload: {
            botId: input.botId,
            lifecycle: input.to,
            conversationId: value.conversationId,
            residentBinding: value.residentBinding,
          },
          createdAt: input.changedAt,
        }, receiptEvent(storedReceipt.receipt, storedReceipt.keyDigest, input.requestId)],
      };
    }).value;
    this.assertDurableDirectBinding(updated);
    return projection(updated);
  }

  private makeId(kind: "bot" | "alias" | "channel" | "conversation"): string {
    const id = this.idGenerator(kind);
    assertCoordinationId(kind, id);
    return id;
  }

  private assertExisting(row: BotRow, displayName: string, purpose: string): void {
    if (
      row.lifecycle !== "active" || row.principalId !== row.id ||
      row.name !== displayName || row.purpose !== purpose ||
      row.continuingIdentity !== 1 || row.durableMailbox !== 1 ||
      row.requiredCapabilitiesJson !== JSON.stringify(PROCESSLESS_CAPABILITIES) ||
      row.activeInstanceId !== null || row.activeKeyVersion !== null ||
      row.residentProtocolVersion !== null || row.residentRegisteredAt !== null ||
      row.lastHeartbeatAt !== null || row.reportedAvailability !== null ||
      row.residentCapabilitiesJson !== "[]"
    ) {
      throw new BotLifecycleError(
        "request_invalid",
        "Resident binding belongs to a different Bot",
      );
    }
  }

  private assertDurableDirectBinding(row: BotRow): void {
    if (!row.conversationId) throw new Error("Stored Bot mailbox has no conversation");
    const binding = this.database.readOne<{
      conversationId: string;
      channelId: string;
      botMember: string;
      ownerMember: string;
      pairChannelId: string;
      kind: string;
    }>(
      `SELECT handle.id AS conversationId, channel.id AS channelId, channel.kind,
              bot_member.principal_id AS botMember,
              owner_member.principal_id AS ownerMember,
              pair.channel_id AS pairChannelId
       FROM conversation_handles handle
       JOIN channels channel ON channel.id = handle.channel_id
       JOIN channel_members bot_member ON bot_member.channel_id = channel.id
         AND bot_member.principal_id = ? AND bot_member.kind = 'bot'
         AND bot_member.active = 1
       JOIN channel_members owner_member ON owner_member.channel_id = channel.id
         AND owner_member.principal_id = 'user_owner' AND owner_member.kind = 'owner'
         AND owner_member.active = 1
       JOIN direct_channel_pairs pair ON pair.channel_id = channel.id
       WHERE handle.id = ?`,
      row.id,
      row.conversationId,
    );
    if (
      !binding || binding.conversationId !== row.conversationId ||
      binding.botMember !== row.id || binding.ownerMember !== "user_owner" ||
      binding.pairChannelId !== binding.channelId || binding.kind !== "direct"
    ) throw new Error("Stored Bot mailbox binding is not durable and direct");
  }
}
