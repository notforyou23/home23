import type { CoordinationTransaction } from "../db/index.js";
import type { MessagingDatabase } from "../channels/database.js";
import { MessagingError } from "../channels/errors.js";
import {
  assertStoredActorBinding,
  insertMessagingIdempotency,
  mutationReceipt,
  parseMessagingEventReference,
  readMessagingIdempotency,
  replayReceipt,
} from "../channels/mutation.js";
import type { MessagingEventReference } from "../channels/mutation.js";
import type {
  AdvanceReadCursorInput,
  AdvanceReadCursorResult,
  InboxConversation,
  InboxLatestMessage,
  UnreadProjection,
  UnreadRepository,
} from "./types.js";
import type { ResolvedMessagingActor } from "../channels/types.js";

interface UnreadChannelRow {
  conversationId: string;
  latestSequence: number;
  createdAt: string;
  readThroughSequence: number | null;
  cursorVersion: number | null;
  cursorUpdatedAt: string | null;
}

interface InboxChannelRow {
  id: string;
  conversationId: string;
  kind: "direct" | "group";
  title: string;
  lifecycle: "active" | "archived";
  pinned: number;
  version: number;
  updatedAt: string;
}

function unreadResultRef(
  unread: UnreadProjection,
  eventReference: MessagingEventReference,
) {
  return {
    eventReference,
    unread: {
      principalId: unread.principalId,
      channelId: unread.channelId,
      conversationId: unread.conversationId,
      readThroughSequence: unread.readThroughSequence,
      unreadCount: unread.unreadCount,
      latestSequence: unread.latestSequence,
      version: unread.version,
      updatedAt: unread.updatedAt,
    },
  };
}

function parseUnreadResultRef(value: string): {
  unread: UnreadProjection;
  eventReference: MessagingEventReference;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("messaging read-cursor idempotency result is malformed");
  }
  const result = parsed as {
    unread?: UnreadProjection;
    eventReference?: unknown;
  } | null;
  const unread = result?.unread;
  if (
    !unread ||
    typeof unread.principalId !== "string" ||
    typeof unread.channelId !== "string" ||
    typeof unread.version !== "number" ||
    typeof unread.readThroughSequence !== "number"
  ) {
    throw new Error("messaging read-cursor idempotency result has no projection");
  }
  const eventReference = parseMessagingEventReference(
    result?.eventReference,
    "messaging read-cursor idempotency result has no exact event reference",
  );
  return Object.freeze({
    unread: Object.freeze({ ...unread }),
    eventReference,
  });
}

export class SqliteUnreadRepository implements UnreadRepository {
  constructor(private readonly database: MessagingDatabase) {}

  async getUnread(
    channelId: string,
    actor: ResolvedMessagingActor,
  ): Promise<UnreadProjection> {
    assertStoredActorBinding(this.database, actor);
    return this.readUnread(this.database, channelId, actor.principalId);
  }

  async advanceReadCursor(
    input: AdvanceReadCursorInput,
  ): Promise<AdvanceReadCursorResult> {
    if (input.idempotency.operation !== "read_cursor.update") {
      throw new MessagingError("request_invalid");
    }
    if (
      !Number.isSafeInteger(input.readThroughSequence) ||
      input.readThroughSequence < 0
    ) {
      throw new MessagingError("request_invalid");
    }
    assertStoredActorBinding(this.database, input.actor);
    const replay = this.resolveReadReplay(input);
    if (replay) return replay;
    try {
      const result = this.database.mutateWithEvent((transaction) => {
        assertStoredActorBinding(transaction, input.actor);
        const inside = this.readUnread(
          transaction,
          input.channelId,
          input.actor.principalId,
        );
        if (input.readThroughSequence > inside.latestSequence) {
          throw new MessagingError("sequence_out_of_range");
        }
        const advanced = input.readThroughSequence > inside.readThroughSequence;
        if (advanced) {
          const cursorWrite = transaction.run(
            `INSERT INTO read_cursors (
              principal_id, channel_id, read_through_sequence, version, updated_at
            ) VALUES (?, ?, ?, 1, ?)
            ON CONFLICT(principal_id, channel_id) DO UPDATE SET
              read_through_sequence = excluded.read_through_sequence,
              version = read_cursors.version + 1,
              updated_at = excluded.updated_at
            WHERE excluded.read_through_sequence > read_cursors.read_through_sequence`,
            input.actor.principalId,
            input.channelId,
            input.readThroughSequence,
            input.updatedAt,
          );
          if (cursorWrite.changes !== 1) throw new MessagingError("storage_conflict");
        }
        const projection = this.readUnread(
          transaction,
          input.channelId,
          input.actor.principalId,
        );
        const eventAggregateId = advanced
          ? `${input.actor.principalId}:${input.channelId}`
          : `${input.actor.principalId}:${input.idempotency.keyDigest}`;
        insertMessagingIdempotency(transaction, {
          actor: input.actor,
          claim: input.idempotency,
          resultKind: "read_cursor",
          resultRef: unreadResultRef(projection, {
            aggregateKind: advanced ? "read_cursor" : "read_cursor_request",
            aggregateId: eventAggregateId,
            aggregateVersion: advanced ? projection.version : 1,
          }),
          createdAt: input.updatedAt,
        });
        return {
          value: projection,
          event: {
            type: "unread.updated",
            aggregateKind: advanced ? "read_cursor" : "read_cursor_request",
            aggregateId: eventAggregateId,
            aggregateVersion: advanced ? projection.version : 1,
            channelId: input.channelId,
            actorPrincipalId: input.actor.principalId,
            requestId: input.actor.requestId,
            correlationId: input.actor.correlationId,
            payload: {
              principalId: input.actor.principalId,
              channelId: input.channelId,
              conversationId: projection.conversationId,
              readThroughSequence: projection.readThroughSequence,
              unreadCount: projection.unreadCount,
              latestSequence: projection.latestSequence,
              readCursorVersion: projection.version,
              advanced,
            },
            createdAt: input.updatedAt,
          },
        };
      });
      return Object.freeze({
        outcome: "committed" as const,
        unread: result.value,
        receipt: mutationReceipt(result.event, result.value.version),
      });
    } catch (error) {
      if (error instanceof Error && "code" in error &&
        String(error.code).startsWith("SQLITE_CONSTRAINT")) {
        const replayed = this.resolveReadReplay(input);
        if (replayed) return replayed;
        throw new MessagingError("storage_conflict");
      }
      throw error;
    }
  }

  private resolveReadReplay(
    input: AdvanceReadCursorInput,
  ): AdvanceReadCursorResult | null {
    const row = readMessagingIdempotency(
      this.database,
      input.actor.principalId,
      input.idempotency,
    );
    if (!row) return null;
    const stored = parseUnreadResultRef(row.resultRefJson);
    return Object.freeze({
      outcome: "replayed" as const,
      unread: stored.unread,
      receipt: replayReceipt(
        this.database,
        row,
        stored.eventReference,
        stored.unread.version,
      ),
    });
  }

  async listInbox(
    actor: ResolvedMessagingActor,
  ): Promise<readonly InboxConversation[]> {
    assertStoredActorBinding(this.database, actor);
    const principalId = actor.principalId;
    const channels = this.database.readAll<InboxChannelRow>(
      `SELECT c.id,
              h.id AS conversationId,
              c.kind,
              c.title,
              c.lifecycle,
              c.pinned,
              c.version,
              c.updated_at AS updatedAt
       FROM channels c
       JOIN conversation_handles h ON h.channel_id = c.id
       JOIN channel_members member
         ON member.channel_id = c.id AND member.principal_id = ? AND member.active = 1
       ORDER BY c.pinned DESC, c.updated_at DESC, c.id ASC`,
      principalId,
    );
    return Object.freeze(channels.map((channel) => {
      const unread = this.readUnread(this.database, channel.id, principalId);
      const latest = this.database.readOne<{
        id: string;
        sequence: number;
        preview: string | null;
        authorPrincipalId: string;
        createdAt: string;
      }>(
        `SELECT m.id,
                m.channel_sequence AS sequence,
                CASE WHEN EXISTS (
                  SELECT 1 FROM messages tombstone
                  WHERE tombstone.tombstones_message_id = m.id
                ) THEN NULL ELSE substr(m.body_text, 1, 160) END AS preview,
                m.author_principal_id AS authorPrincipalId,
                m.created_at AS createdAt
         FROM messages m
         WHERE m.channel_id = ?
         ORDER BY m.channel_sequence DESC
         LIMIT 1`,
        channel.id,
      );
      const latestMessage: InboxLatestMessage | null = latest
        ? Object.freeze({ ...latest })
        : null;
      return Object.freeze({
        id: channel.conversationId,
        channelId: channel.id,
        kind: channel.kind,
        title: channel.title,
        latestMessage,
        unread: Object.freeze({
          count: unread.unreadCount,
          readThroughSequence: unread.readThroughSequence,
        }),
        activity: Object.freeze({ state: "idle" as const, label: null, workId: null }),
        pinned: channel.pinned === 1,
        archived: channel.lifecycle === "archived",
        version: channel.version,
        updatedAt: channel.updatedAt,
      });
    }));
  }

  private readUnread(
    reader: Pick<MessagingDatabase, "readOne"> | Pick<CoordinationTransaction, "readOne">,
    channelId: string,
    principalId: string,
  ): UnreadProjection {
    const channel = reader.readOne<UnreadChannelRow>(
      `SELECT h.id AS conversationId,
              c.next_message_sequence - 1 AS latestSequence,
              c.created_at AS createdAt,
              r.read_through_sequence AS readThroughSequence,
              r.version AS cursorVersion,
              r.updated_at AS cursorUpdatedAt
       FROM channels c
       JOIN conversation_handles h ON h.channel_id = c.id
       LEFT JOIN read_cursors r
         ON r.channel_id = c.id AND r.principal_id = ?
       WHERE c.id = ?`,
      principalId,
      channelId,
    );
    if (!channel) throw new MessagingError("unknown_channel");
    if (!reader.readOne<{ present: number }>(
      `SELECT 1 AS present FROM channel_members
       WHERE channel_id = ? AND principal_id = ? AND active = 1`,
      channelId,
      principalId,
    )) {
      throw new MessagingError("nonmember");
    }
    const readThroughSequence = channel.readThroughSequence ?? 0;
    const unread = reader.readOne<{ count: number }>(
      `SELECT count(*) AS count
       FROM messages m
       WHERE m.channel_id = ?
         AND m.channel_sequence > ?
         AND m.author_principal_id <> ?
         AND m.stored_visibility = 'visible'
         AND NOT EXISTS (
           SELECT 1 FROM messages tombstone
           WHERE tombstone.tombstones_message_id = m.id
         )`,
      channelId,
      readThroughSequence,
      principalId,
    );
    return Object.freeze({
      principalId,
      channelId,
      conversationId: channel.conversationId,
      readThroughSequence,
      unreadCount: unread?.count ?? 0,
      latestSequence: channel.latestSequence,
      version: channel.cursorVersion ?? 1,
      updatedAt: channel.cursorUpdatedAt ?? channel.createdAt,
    });
  }
}
