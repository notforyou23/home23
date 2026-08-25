import type { CoordinationTransaction, JsonValue } from "../db/index.js";
import { SqliteMessageRepository } from "../messages/repository.js";
import type {
  AppendMessageCommit,
  AppendMessageResult,
  ListMessagesInput,
  ListMessagesResult,
  MessageProvenanceAuthorizationTransactionPort,
} from "../messages/types.js";
import { SqliteUnreadRepository } from "../unread/repository.js";
import type {
  AdvanceReadCursorInput,
  AdvanceReadCursorResult,
  InboxConversation,
  UnreadProjection,
} from "../unread/types.js";
import { isSqliteConstraint, type MessagingDatabase } from "./database.js";
import { MessagingError } from "./errors.js";
import {
  assertStoredActorBinding,
  insertMessagingIdempotency,
  mutationReceipt,
  parseMessagingEventReference,
  readMessagingIdempotency,
  replayReceipt,
} from "./mutation.js";
import type { MessagingEventReference } from "./mutation.js";
import type { ArtifactMessageLinkTransactionPort } from "../artifacts/index.js";
import type {
  BotConversationBindingResult,
  BotConversationBindingTransactionPort,
  ChannelListCursor,
  ChannelRecord,
  ChannelRepository,
  CreateChannelCommit,
  CreateDirectChannelCommit,
  CreateDirectChannelResult,
  CreateGroupChannelResult,
  ListChannelsResult,
  ResponderPolicy,
  ResolvedMessagingActor,
  UpdateChannelCommit,
  UpdateChannelResult,
} from "./types.js";

interface ChannelRow {
  id: string;
  conversationId: string;
  kind: "direct" | "group";
  title: string;
  purpose: string;
  ownerPrincipalId: "user_owner";
  responderMode: ResponderPolicy["mode"];
  coordinatorBotId: string | null;
  responseOrder: ResponderPolicy["responseOrder"];
  maxBotTurns: number;
  lifecycle: "active" | "archived";
  pinned: number;
  version: number;
  nextMessageSequence: number;
  createdAt: string;
  updatedAt: string;
}

interface MemberRow {
  principalId: string;
  kind: "owner" | "bot";
  role: "owner" | "member";
}

export interface SqliteMessagingRepositoryOptions {
  botConversationBinding: BotConversationBindingTransactionPort;
  messageProvenanceAuthorization?: MessageProvenanceAuthorizationTransactionPort;
  artifactMessageLink?: ArtifactMessageLinkTransactionPort;
}

type ChannelReader = Pick<MessagingDatabase, "readOne" | "readAll"> |
  Pick<CoordinationTransaction, "readOne" | "readAll">;

function channelSelect(where: string): string {
  return `SELECT
    c.id,
    h.id AS conversationId,
    c.kind,
    c.title,
    c.purpose,
    c.owner_principal_id AS ownerPrincipalId,
    c.responder_mode AS responderMode,
    c.coordinator_bot_id AS coordinatorBotId,
    c.response_order AS responseOrder,
    c.max_bot_turns AS maxBotTurns,
    c.lifecycle,
    c.pinned,
    c.version,
    c.next_message_sequence AS nextMessageSequence,
    c.created_at AS createdAt,
    c.updated_at AS updatedAt
  FROM channels c
  JOIN conversation_handles h ON h.channel_id = c.id
  WHERE ${where}`;
}

function channelResultRef(
  channel: ChannelRecord,
  eventReference: MessagingEventReference,
): Record<string, JsonValue> {
  return {
    eventReference,
    channel: {
      id: channel.id,
      conversationId: channel.conversationId,
      kind: channel.kind,
      title: channel.title,
      purpose: channel.purpose,
      ownerPrincipalId: channel.ownerPrincipalId,
      members: channel.members.map((member) => ({
        principalId: member.principalId,
        kind: member.kind,
        role: member.role,
      })),
      responderPolicy: {
        mode: channel.responderPolicy.mode,
        coordinatorBotId: channel.responderPolicy.coordinatorBotId,
        responseOrder: channel.responderPolicy.responseOrder,
        maxBotTurns: channel.responderPolicy.maxBotTurns,
      },
      lifecycle: channel.lifecycle,
      pinned: channel.pinned,
      version: channel.version,
      nextMessageSequence: channel.nextMessageSequence,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
    },
  };
}

function parseChannelResultRef(value: string): {
  channel: ChannelRecord;
  eventReference: MessagingEventReference;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("messaging Channel idempotency result is malformed");
  }
  const result = parsed as {
    channel?: ChannelRecord;
    eventReference?: unknown;
  } | null;
  const channel = result?.channel;
  if (
    !channel ||
    typeof channel.id !== "string" ||
    typeof channel.conversationId !== "string" ||
    !Array.isArray(channel.members) ||
    typeof channel.version !== "number" ||
    typeof channel.nextMessageSequence !== "number"
  ) {
    throw new Error("messaging Channel idempotency result has no Channel");
  }
  const eventReference = parseMessagingEventReference(
    result?.eventReference,
    "messaging Channel idempotency result has no exact event reference",
  );
  return Object.freeze({
    channel: Object.freeze({
      ...channel,
      members: Object.freeze(channel.members.map((member) => Object.freeze({ ...member }))),
      responderPolicy: Object.freeze({ ...channel.responderPolicy }),
    }),
    eventReference,
  });
}

export class SqliteMessagingRepository implements ChannelRepository {
  private readonly messages: SqliteMessageRepository;
  private readonly unread: SqliteUnreadRepository;

  constructor(
    private readonly database: MessagingDatabase,
    private readonly options: SqliteMessagingRepositoryOptions,
  ) {
    if (!options?.botConversationBinding) {
      throw new TypeError("M07/M04 direct Conversation binding adapter is required");
    }
    this.messages = new SqliteMessageRepository(
      database,
      options.messageProvenanceAuthorization,
      options.artifactMessageLink,
    );
    this.unread = new SqliteUnreadRepository(database);
  }

  async replayChannelMutation(input: {
    actor: ResolvedMessagingActor;
    idempotency: CreateChannelCommit["idempotency"];
  }) {
    if (
      input.idempotency.operation !== "channel.create" &&
      input.idempotency.operation !== "channel.update"
    ) {
      throw new MessagingError("request_invalid");
    }
    assertStoredActorBinding(this.database, input.actor);
    return this.resolveChannelReplay(input);
  }

  async getChannelForActor(
    channelId: string,
    actor: ResolvedMessagingActor,
  ): Promise<ChannelRecord | null> {
    assertStoredActorBinding(this.database, actor);
    const channel = this.readChannel(this.database, channelId);
    if (!channel) return null;
    if (!channel.members.some((member) => member.principalId === actor.principalId)) {
      throw new MessagingError("nonmember");
    }
    return channel;
  }

  async listChannels(input: {
    actor: ResolvedMessagingActor;
    cursor: ChannelListCursor | null;
    limit: number;
  }): Promise<ListChannelsResult> {
    assertStoredActorBinding(this.database, input.actor);
    const cursorSql = input.cursor
      ? "AND (c.updated_at < ? OR (c.updated_at = ? AND c.id > ?))"
      : "";
    const parameters = input.cursor
      ? [
          input.actor.principalId,
          input.cursor.updatedAt,
          input.cursor.updatedAt,
          input.cursor.channelId,
          input.limit + 1,
        ]
      : [input.actor.principalId, input.limit + 1];
    const rows = this.database.readAll<ChannelRow>(
      `${channelSelect(`EXISTS (
        SELECT 1 FROM channel_members member
        WHERE member.channel_id = c.id AND member.principal_id = ? AND member.active = 1
      ) ${cursorSql}`)}
       ORDER BY c.updated_at DESC, c.id ASC
       LIMIT ?`,
      ...parameters,
    );
    const page = rows.slice(0, input.limit);
    const channels = page.map((row) => this.hydrateChannel(this.database, row));
    const last = page.at(-1);
    return Object.freeze({
      channels: Object.freeze(channels),
      nextCursor: rows.length > input.limit && last
        ? Object.freeze({ updatedAt: last.updatedAt, channelId: last.id })
        : null,
    });
  }

  async createDirectChannel(
    input: CreateDirectChannelCommit,
  ): Promise<CreateDirectChannelResult> {
    this.assertCreateChannelCommit(input, "direct");
    assertStoredActorBinding(this.database, input.actor);
    const replay = this.resolveChannelReplay(input);
    if (replay) return { outcome: "replayed", ...replay };
    const pair = input.channel.members.map((member) => member.principalId).sort();
    try {
      const result = this.database.mutateWithEvent<{
        outcome: "created" | "existing";
        channel: ChannelRecord;
      }>((transaction) => {
        assertStoredActorBinding(transaction, input.actor);
        const insideReplay = readMessagingIdempotency(
          transaction,
          input.actor.principalId,
          input.idempotency,
        );
        if (insideReplay) throw new MessagingError("storage_conflict");
        this.assertTransactionVisibleBotMembers(transaction, input.channel);
        const existingPair = transaction.readOne<{ channelId: string }>(
          `SELECT channel_id AS channelId FROM direct_channel_pairs
           WHERE first_principal_id = ? AND second_principal_id = ?`,
          pair[0]!,
          pair[1]!,
        );
        if (existingPair) {
          const existing = this.readChannel(transaction, existingPair.channelId);
          if (!existing) throw new MessagingError("storage_conflict");
          insertMessagingIdempotency(transaction, {
            actor: input.actor,
            claim: input.idempotency,
            resultKind: "channel",
            resultRef: channelResultRef(
              existing,
              {
                aggregateKind: "conversation_request",
                aggregateId: this.directPairRequestAggregateId(input),
                aggregateVersion: 1,
              },
            ),
            createdAt: input.channel.createdAt,
          });
          return {
            value: { outcome: "existing" as const, channel: existing },
            event: this.directPairReusedEvent(existing, input),
          };
        }
        this.insertChannel(transaction, input.channel);
        const botMember = input.channel.members.find((member) => member.kind === "bot");
        if (!botMember) throw new MessagingError("invalid_membership");
        const botBinding = this.options.botConversationBinding.bindDirectConversation(
          transaction,
          {
            botId: botMember.principalId,
            botPrincipalId: botMember.principalId,
            residentBinding: input.expectedBot.residentBinding,
            expectedBotVersion: input.expectedBot.version,
            channelId: input.channel.id,
            conversationId: input.channel.conversationId,
            actorPrincipalId: input.actor.principalId,
            requestId: input.actor.requestId,
            correlationId: input.actor.correlationId,
            updatedAt: input.channel.createdAt,
          },
        );
        if (
          botBinding.botId !== botMember.principalId ||
          !Number.isSafeInteger(botBinding.botVersion) ||
          botBinding.botVersion !== input.expectedBot.version + 1 ||
          !botBinding.event ||
          botBinding.event.type !== "bot.updated" ||
          botBinding.event.aggregateKind !== "bot" ||
          botBinding.event.aggregateId !== botMember.principalId ||
          botBinding.event.aggregateVersion !== botBinding.botVersion ||
          botBinding.event.channelId !== input.channel.id ||
          botBinding.event.actorPrincipalId !== input.actor.principalId ||
          botBinding.event.requestId !== input.actor.requestId ||
          botBinding.event.correlationId !== input.actor.correlationId ||
          botBinding.event.createdAt !== input.channel.createdAt ||
          botBinding.event.payload.botId !== botMember.principalId ||
          botBinding.event.payload.botVersion !== botBinding.botVersion ||
          botBinding.event.payload.channelId !== input.channel.id ||
          botBinding.event.payload.conversationId !== input.channel.conversationId ||
          botBinding.event.payload.change !== "direct_conversation_bound"
        ) {
          throw new MessagingError("storage_conflict");
        }
        const boundBot = transaction.readOne<{
          conversationId: string | null;
          version: number;
        }>(
          `SELECT conversation_id AS conversationId, version
           FROM bots WHERE id = ? AND principal_id = ?`,
          botMember.principalId,
          botMember.principalId,
        );
        if (
          boundBot?.conversationId !== input.channel.conversationId ||
          boundBot.version !== botBinding.botVersion
        ) {
          throw new MessagingError("storage_conflict");
        }
        transaction.run(
          `INSERT INTO direct_channel_pairs (
            first_principal_id, second_principal_id, channel_id, created_at
          ) VALUES (?, ?, ?, ?)`,
          pair[0]!,
          pair[1]!,
          input.channel.id,
          input.channel.createdAt,
        );
        insertMessagingIdempotency(transaction, {
          actor: input.actor,
          claim: input.idempotency,
          resultKind: "channel",
          resultRef: channelResultRef(input.channel, {
            aggregateKind: "channel",
            aggregateId: input.channel.id,
            aggregateVersion: input.channel.version,
          }),
          createdAt: input.channel.createdAt,
        });
        return {
          value: { outcome: "created" as const, channel: input.channel },
          events: [
            botBinding.event,
            this.channelCreatedEvent(input, botBinding),
          ],
        };
      });
      return Object.freeze({
        ...result.value,
        receipt: mutationReceipt(result.event, result.value.channel.version),
      });
    } catch (error) {
      if (error instanceof MessagingError && error.code === "storage_conflict") {
        const replayed = this.resolveChannelReplay(input);
        if (replayed) return { outcome: "replayed", ...replayed };
      }
      if (isSqliteConstraint(error)) {
        const replayed = this.resolveChannelReplay(input);
        if (replayed) return { outcome: "replayed", ...replayed };
        const existing = this.findDirectPair(pair[0]!, pair[1]!);
        if (existing) return this.claimExistingDirect(input, existing);
        return { outcome: "identity_collision" };
      }
      throw error;
    }
  }

  async createGroupChannel(
    input: CreateChannelCommit,
  ): Promise<CreateGroupChannelResult> {
    this.assertCreateChannelCommit(input, "group");
    assertStoredActorBinding(this.database, input.actor);
    const replay = this.resolveChannelReplay(input);
    if (replay) return { outcome: "replayed", ...replay };
    try {
      const result = this.database.mutateWithEvent((transaction) => {
        assertStoredActorBinding(transaction, input.actor);
        this.assertTransactionVisibleBotMembers(transaction, input.channel);
        this.insertChannel(transaction, input.channel);
        insertMessagingIdempotency(transaction, {
          actor: input.actor,
          claim: input.idempotency,
          resultKind: "channel",
          resultRef: channelResultRef(input.channel, {
            aggregateKind: "channel",
            aggregateId: input.channel.id,
            aggregateVersion: input.channel.version,
          }),
          createdAt: input.channel.createdAt,
        });
        return {
          value: input.channel,
          event: this.channelCreatedEvent(input, null),
        };
      });
      return Object.freeze({
        outcome: "created" as const,
        channel: result.value,
        receipt: mutationReceipt(result.event, result.value.version),
      });
    } catch (error) {
      if (isSqliteConstraint(error)) {
        const replayed = this.resolveChannelReplay(input);
        if (replayed) return { outcome: "replayed", ...replayed };
        return { outcome: "identity_collision" };
      }
      throw error;
    }
  }

  async updateChannel(input: UpdateChannelCommit): Promise<UpdateChannelResult> {
    if (input.idempotency.operation !== "channel.update") {
      throw new MessagingError("request_invalid");
    }
    this.assertChannelMembershipShape(input.channel, input.channel.kind);
    if (input.channel.version !== input.expectedVersion + 1) {
      throw new MessagingError("version_conflict");
    }
    assertStoredActorBinding(this.database, input.actor);
    const replay = this.resolveChannelReplay(input);
    if (replay) return { outcome: "replayed", ...replay };
    try {
      const result = this.database.mutateWithEvent((transaction) => {
        assertStoredActorBinding(transaction, input.actor);
        const current = this.readChannel(transaction, input.channel.id);
        if (!current) throw new MessagingError("unknown_channel");
        if (!current.members.some((member) => member.principalId === input.actor.principalId)) {
          throw new MessagingError("nonmember");
        }
        if (input.actor.kind !== "owner" || input.actor.principalId !== "user_owner") {
          throw new MessagingError("identity_context_mismatch");
        }
        if (current.version !== input.expectedVersion) {
          throw new MessagingError("version_conflict");
        }
        this.assertStableChannelIdentity(current, input.channel);
        this.assertTransactionVisibleBotMembers(transaction, input.channel);
        const update = transaction.run(
          `UPDATE channels SET
            title = ?, purpose = ?, responder_mode = ?, coordinator_bot_id = ?,
            response_order = ?, max_bot_turns = ?, lifecycle = ?, pinned = ?,
            version = ?, updated_at = ?
           WHERE id = ? AND version = ?`,
          input.channel.title,
          input.channel.purpose,
          input.channel.responderPolicy.mode,
          input.channel.responderPolicy.coordinatorBotId,
          input.channel.responderPolicy.responseOrder,
          input.channel.responderPolicy.maxBotTurns,
          input.channel.lifecycle,
          input.channel.pinned ? 1 : 0,
          input.channel.version,
          input.channel.updatedAt,
          input.channel.id,
          input.expectedVersion,
        );
        if (update.changes !== 1) throw new MessagingError("version_conflict");
        this.replaceActiveMembers(transaction, current, input.channel);
        insertMessagingIdempotency(transaction, {
          actor: input.actor,
          claim: input.idempotency,
          resultKind: "channel",
          resultRef: channelResultRef(input.channel, {
            aggregateKind: "channel",
            aggregateId: input.channel.id,
            aggregateVersion: input.channel.version,
          }),
          createdAt: input.channel.updatedAt,
        });
        return {
          value: input.channel,
          event: this.channelEvent(
            "channel.updated",
            input.channel,
            input,
            { channelVersion: input.channel.version },
          ),
        };
      });
      return Object.freeze({
        outcome: "committed" as const,
        channel: result.value,
        receipt: mutationReceipt(result.event, result.value.version),
      });
    } catch (error) {
      if (error instanceof MessagingError && error.code === "version_conflict") {
        const replayed = this.resolveChannelReplay(input);
        if (replayed) return { outcome: "replayed", ...replayed };
        return { outcome: "version_conflict" };
      }
      if (isSqliteConstraint(error)) {
        const replayed = this.resolveChannelReplay(input);
        if (replayed) return { outcome: "replayed", ...replayed };
        return { outcome: "identity_collision" };
      }
      throw error;
    }
  }

  appendMessage(input: AppendMessageCommit): Promise<AppendMessageResult> {
    return this.messages.appendMessage(input);
  }

  listMessages(input: ListMessagesInput): Promise<ListMessagesResult> {
    return this.messages.listMessages(input);
  }

  getUnread(channelId: string, actor: ResolvedMessagingActor): Promise<UnreadProjection> {
    return this.unread.getUnread(channelId, actor);
  }

  advanceReadCursor(input: AdvanceReadCursorInput): Promise<AdvanceReadCursorResult> {
    return this.unread.advanceReadCursor(input);
  }

  listInbox(actor: ResolvedMessagingActor): Promise<readonly InboxConversation[]> {
    return this.unread.listInbox(actor);
  }

  private async claimExistingDirect(
    input: CreateDirectChannelCommit,
    existing: ChannelRecord,
  ): Promise<CreateDirectChannelResult> {
    try {
      const result = this.database.mutateWithEvent((transaction) => {
        assertStoredActorBinding(transaction, input.actor);
        this.assertTransactionVisibleBotMembers(transaction, input.channel);
        const replay = readMessagingIdempotency(
          transaction,
          input.actor.principalId,
          input.idempotency,
        );
        if (replay) throw new MessagingError("storage_conflict");
        insertMessagingIdempotency(transaction, {
          actor: input.actor,
          claim: input.idempotency,
          resultKind: "channel",
          resultRef: channelResultRef(
            existing,
            {
              aggregateKind: "conversation_request",
              aggregateId: this.directPairRequestAggregateId(input),
              aggregateVersion: 1,
            },
          ),
          createdAt: input.channel.createdAt,
        });
        return {
          value: existing,
          event: this.directPairReusedEvent(existing, input),
        };
      });
      return Object.freeze({
        outcome: "existing" as const,
        channel: result.value,
        receipt: mutationReceipt(result.event, result.value.version),
      });
    } catch (error) {
      if (
        isSqliteConstraint(error) ||
        (error instanceof MessagingError && error.code === "storage_conflict")
      ) {
        const replayed = this.resolveChannelReplay(input);
        if (replayed) return { outcome: "replayed", ...replayed };
      }
      throw error;
    }
  }

  private resolveChannelReplay(
    input: Pick<CreateChannelCommit, "actor" | "idempotency"> |
      Pick<UpdateChannelCommit, "actor" | "idempotency">,
  ): { channel: ChannelRecord; receipt: ReturnType<typeof replayReceipt> } | null {
    const row = readMessagingIdempotency(
      this.database,
      input.actor.principalId,
      input.idempotency,
    );
    if (!row) return null;
    const stored = parseChannelResultRef(row.resultRefJson);
    return Object.freeze({
      channel: stored.channel,
      receipt: replayReceipt(
        this.database,
        row,
        stored.eventReference,
        stored.channel.version,
      ),
    });
  }

  private findDirectPair(first: string, second: string): ChannelRecord | null {
    const row = this.database.readOne<ChannelRow>(
      channelSelect(`c.id = (
        SELECT channel_id FROM direct_channel_pairs
        WHERE first_principal_id = ? AND second_principal_id = ?
      )`),
      first,
      second,
    );
    return row ? this.hydrateChannel(this.database, row) : null;
  }

  private readChannel(reader: ChannelReader, channelId: string): ChannelRecord | null {
    const row = reader.readOne<ChannelRow>(channelSelect("c.id = ?"), channelId);
    return row ? this.hydrateChannel(reader, row) : null;
  }

  private hydrateChannel(reader: ChannelReader, row: ChannelRow): ChannelRecord {
    const members = reader.readAll<MemberRow>(
      `SELECT principal_id AS principalId, kind, role
       FROM channel_members
       WHERE channel_id = ? AND active = 1
       ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, principal_id`,
      row.id,
    );
    return Object.freeze({
      id: row.id,
      conversationId: row.conversationId,
      kind: row.kind,
      title: row.title,
      purpose: row.purpose,
      ownerPrincipalId: row.ownerPrincipalId,
      members: Object.freeze(members.map((member) => Object.freeze({ ...member }))),
      responderPolicy: Object.freeze({
        mode: row.responderMode,
        coordinatorBotId: row.coordinatorBotId,
        responseOrder: row.responseOrder,
        maxBotTurns: row.maxBotTurns,
      }),
      lifecycle: row.lifecycle,
      pinned: row.pinned === 1,
      version: row.version,
      nextMessageSequence: row.nextMessageSequence,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  private insertChannel(
    transaction: CoordinationTransaction,
    channel: ChannelRecord,
  ): void {
    transaction.run(
      `INSERT INTO channels (
        id, kind, title, purpose, owner_principal_id, responder_mode,
        coordinator_bot_id, response_order, max_bot_turns, lifecycle, pinned,
        version, next_message_sequence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      channel.id,
      channel.kind,
      channel.title,
      channel.purpose,
      channel.ownerPrincipalId,
      channel.responderPolicy.mode,
      channel.responderPolicy.coordinatorBotId,
      channel.responderPolicy.responseOrder,
      channel.responderPolicy.maxBotTurns,
      channel.lifecycle,
      channel.pinned ? 1 : 0,
      channel.version,
      channel.nextMessageSequence,
      channel.createdAt,
      channel.updatedAt,
    );
    transaction.run(
      "INSERT INTO conversation_handles (id, channel_id, created_at) VALUES (?, ?, ?)",
      channel.conversationId,
      channel.id,
      channel.createdAt,
    );
    for (const member of channel.members) {
      transaction.run(
      `INSERT INTO channel_members (
          channel_id, principal_id, kind, role, active, joined_at, left_at
        ) VALUES (?, ?, ?, ?, 1, ?, NULL)`,
        channel.id,
        member.principalId,
        member.kind,
        member.role,
        channel.createdAt,
      );
      transaction.run(
        `INSERT INTO channel_membership_history (
           channel_id, principal_id, kind, role, active,
           joined_channel_version, left_channel_version, joined_at, left_at
         ) VALUES (?, ?, ?, ?, 1, ?, NULL, ?, NULL)`,
        channel.id,
        member.principalId,
        member.kind,
        member.role,
        channel.version,
        channel.createdAt,
      );
    }
  }

  private assertStableChannelIdentity(
    current: ChannelRecord,
    next: ChannelRecord,
  ): void {
    if (
      current.id !== next.id ||
      current.conversationId !== next.conversationId ||
      current.kind !== next.kind ||
      current.ownerPrincipalId !== next.ownerPrincipalId ||
      current.createdAt !== next.createdAt ||
      current.nextMessageSequence !== next.nextMessageSequence ||
      (current.kind === "direct" &&
        JSON.stringify(current.members) !== JSON.stringify(next.members))
    ) {
      throw new MessagingError("identity_context_mismatch");
    }
  }

  private replaceActiveMembers(
    transaction: CoordinationTransaction,
    current: ChannelRecord,
    next: ChannelRecord,
  ): void {
    const nextBotIds = new Set(
      next.members.filter((member) => member.kind === "bot")
        .map((member) => member.principalId),
    );
    for (const member of current.members) {
      if (member.kind !== "bot" || nextBotIds.has(member.principalId)) continue;
      const retired = transaction.run(
        `UPDATE channel_members SET active = 0, left_at = ?
         WHERE channel_id = ? AND principal_id = ? AND kind = 'bot' AND active = 1`,
        next.updatedAt,
        next.id,
        member.principalId,
      );
      if (retired.changes !== 1) throw new MessagingError("storage_conflict");
      const closedInterval = transaction.run(
        `UPDATE channel_membership_history
         SET active = 0, left_channel_version = ?, left_at = ?
         WHERE channel_id = ? AND principal_id = ? AND kind = 'bot' AND active = 1`,
        next.version,
        next.updatedAt,
        next.id,
        member.principalId,
      );
      if (closedInterval.changes !== 1) throw new MessagingError("storage_conflict");
    }
    const currentBotIds = new Set(
      current.members.filter((member) => member.kind === "bot")
        .map((member) => member.principalId),
    );
    for (const member of next.members) {
      if (member.kind !== "bot" || currentBotIds.has(member.principalId)) continue;
      transaction.run(
        `INSERT INTO channel_members (
           channel_id, principal_id, kind, role, active, joined_at, left_at
         ) VALUES (?, ?, 'bot', 'member', 1, ?, NULL)
         ON CONFLICT(channel_id, principal_id) DO UPDATE SET
           active = 1, joined_at = excluded.joined_at, left_at = NULL`,
        next.id,
        member.principalId,
        next.updatedAt,
      );
      transaction.run(
        `INSERT INTO channel_membership_history (
           channel_id, principal_id, kind, role, active,
           joined_channel_version, left_channel_version, joined_at, left_at
         ) VALUES (?, ?, 'bot', 'member', 1, ?, NULL, ?, NULL)`,
        next.id,
        member.principalId,
        next.version,
        next.updatedAt,
      );
    }
  }

  private assertTransactionVisibleBotMembers(
    transaction: CoordinationTransaction,
    channel: ChannelRecord,
  ): void {
    for (const member of channel.members) {
      if (member.kind !== "bot") continue;
      const bot = transaction.readOne<{ present: number }>(
        `SELECT 1 AS present FROM bots
         WHERE id = ? AND principal_id = ? AND lifecycle = 'active'
           AND continuing_identity = 1 AND durable_mailbox = 1`,
        member.principalId,
        member.principalId,
      );
      if (!bot) {
        throw new MessagingError("unknown_principal", {
          principalId: member.principalId,
        });
      }
    }
  }

  private assertCreateChannelCommit(
    input: CreateChannelCommit | CreateDirectChannelCommit,
    expectedKind: "direct" | "group",
  ): void {
    this.assertChannelMembershipShape(input.channel, expectedKind);
    const ownerMembers = input.channel.members.filter((member) =>
      member.principalId === "user_owner" &&
      member.kind === "owner" &&
      member.role === "owner"
    );
    const botMembers = input.channel.members.filter((member) =>
      member.principalId.startsWith("bot_") &&
      member.kind === "bot" &&
      member.role === "member"
    );
    const memberIds = input.channel.members.map((member) => member.principalId);
    const coordinator = input.channel.responderPolicy.coordinatorBotId;
    const expectedBot = "expectedBot" in input ? input.expectedBot : null;
    if (
      input.actor.kind !== "owner" ||
      input.actor.principalId !== "user_owner" ||
      input.actor.residentCredential !== null ||
      input.idempotency.operation !== "channel.create" ||
      input.channel.kind !== expectedKind ||
      input.channel.ownerPrincipalId !== "user_owner" ||
      input.channel.lifecycle !== "active" ||
      input.channel.version !== 1 ||
      input.channel.nextMessageSequence !== 1 ||
      ownerMembers.length !== 1 ||
      ownerMembers.length + botMembers.length !== input.channel.members.length ||
      new Set(memberIds).size !== memberIds.length ||
      (expectedKind === "direct" && botMembers.length !== 1) ||
      (expectedKind === "direct" && (
        !expectedBot ||
        expectedBot.id !== botMembers[0]?.principalId ||
        expectedBot.principalId !== botMembers[0]?.principalId ||
        typeof expectedBot.residentBinding !== "string" ||
        expectedBot.residentBinding.length < 1 ||
        expectedBot.residentBinding.length > 63 ||
        !Number.isSafeInteger(expectedBot.version) ||
        expectedBot.version < 1
      )) ||
      (expectedKind === "group" && expectedBot !== null) ||
      (expectedKind === "group" && botMembers.length < 2) ||
      (input.channel.responderPolicy.mode === "mentions_only" && coordinator !== null) ||
      (input.channel.responderPolicy.mode === "mention_or_coordinator" &&
        (coordinator === null || !botMembers.some((member) =>
          member.principalId === coordinator
        )))
    ) {
      throw new MessagingError("invalid_membership");
    }
  }

  private assertChannelMembershipShape(
    channel: ChannelRecord,
    expectedKind: "direct" | "group",
  ): void {
    const ownerMembers = channel.members.filter((member) =>
      member.principalId === "user_owner" &&
      member.kind === "owner" &&
      member.role === "owner"
    );
    const botMembers = channel.members.filter((member) =>
      member.principalId.startsWith("bot_") &&
      member.kind === "bot" &&
      member.role === "member"
    );
    const memberIds = channel.members.map((member) => member.principalId);
    const policy = channel.responderPolicy;
    if (
      channel.kind !== expectedKind ||
      channel.ownerPrincipalId !== "user_owner" ||
      ownerMembers.length !== 1 ||
      ownerMembers.length + botMembers.length !== channel.members.length ||
      new Set(memberIds).size !== memberIds.length ||
      (expectedKind === "direct" && botMembers.length !== 1) ||
      (expectedKind === "group" && botMembers.length < 2) ||
      (policy.mode !== "mentions_only" && policy.mode !== "mention_or_coordinator") ||
      (policy.responseOrder !== "parallel" && policy.responseOrder !== "sequential") ||
      !Number.isSafeInteger(policy.maxBotTurns) ||
      policy.maxBotTurns < 1 ||
      policy.maxBotTurns > 8 ||
      (policy.mode === "mentions_only" && policy.coordinatorBotId !== null) ||
      (policy.mode === "mention_or_coordinator" &&
        (policy.coordinatorBotId === null || !botMembers.some((member) =>
          member.principalId === policy.coordinatorBotId
        )))
    ) {
      throw new MessagingError("invalid_membership");
    }
  }

  private channelCreatedEvent(
    input: CreateChannelCommit,
    botBinding: BotConversationBindingResult | null,
  ) {
    return this.channelEvent(
      "channel.created",
      input.channel,
      input,
      {
        channelVersion: input.channel.version,
        ...(botBinding
          ? { botId: botBinding.botId, botVersion: botBinding.botVersion }
          : {}),
      },
    );
  }

  private directPairReusedEvent(
    channel: ChannelRecord,
    input: CreateChannelCommit,
  ) {
    return {
      type: "conversation.updated",
      aggregateKind: "conversation_request",
      aggregateId: this.directPairRequestAggregateId(input),
      aggregateVersion: 1,
      channelId: channel.id,
      actorPrincipalId: input.actor.principalId,
      requestId: input.actor.requestId,
      correlationId: input.actor.correlationId,
      payload: {
        channelId: channel.id,
        conversationId: channel.conversationId,
        kind: channel.kind,
        directPairReused: true,
        channelVersion: channel.version,
      } as Record<string, JsonValue>,
      createdAt: input.channel.createdAt,
    };
  }

  private directPairRequestAggregateId(input: CreateChannelCommit): string {
    return `${input.actor.principalId}:${input.idempotency.keyDigest}`;
  }

  private channelEvent(
    type: "channel.created" | "channel.updated" | "conversation.updated",
    channel: ChannelRecord,
    input: Pick<CreateChannelCommit, "actor"> | Pick<UpdateChannelCommit, "actor">,
    extra: Record<string, JsonValue>,
  ) {
    return {
      type,
      aggregateKind: "channel",
      aggregateId: channel.id,
      aggregateVersion: channel.version,
      channelId: channel.id,
      actorPrincipalId: input.actor.principalId,
      requestId: input.actor.requestId,
      correlationId: input.actor.correlationId,
      payload: {
        channelId: channel.id,
        conversationId: channel.conversationId,
        kind: channel.kind,
        memberPrincipalIds: channel.members.map((member) => member.principalId),
        ...extra,
      } as Record<string, JsonValue>,
      createdAt: channel.updatedAt,
    };
  }
}
