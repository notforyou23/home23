import type { CoordinationTransaction, JsonValue } from "../db/index.js";
import {
  isSqliteConstraint,
  type MessagingDatabase,
} from "../channels/database.js";
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
  ArtifactActor,
  ArtifactMessageLinkTransactionPort,
  AttachmentSummary,
} from "../artifacts/index.js";
import type {
  AppendMessageCommit,
  AppendMessageResult,
  GetMessageInput,
  ListMessagesInput,
  ListMessagesResult,
  MessageProjection,
  MessageProvenanceAuthorizationTransactionPort,
  MessageRepository,
} from "./types.js";

interface MessageRow {
  id: string;
  channelId: string;
  conversationId: string;
  sequence: number;
  authorPrincipalId: string;
  authorKind: "owner" | "bot";
  authorDisplayName: string;
  kind: "text" | "system" | "result";
  text: string | null;
  clientMessageId: string | null;
  replyToMessageId: string | null;
  tombstonesMessageId: string | null;
  roundId: string | null;
  workId: string | null;
  createdAt: string;
  effectiveVisibility: "visible" | "tombstoned";
}

function sameActorBinding(
  left: AppendMessageCommit["actor"],
  right: ArtifactActor,
): boolean {
  return left.principalId === right.principalId &&
    left.kind === right.kind &&
    left.displayName === right.displayName &&
    left.requestId === right.requestId &&
    left.correlationId === right.correlationId &&
    left.residentCredential?.residentBinding === right.residentCredential?.residentBinding &&
    left.residentCredential?.instanceId === right.residentCredential?.instanceId &&
    left.residentCredential?.keyVersion === right.residentCredential?.keyVersion;
}

function storedTurnSelection(value: unknown): AppendMessageCommit["turnSelection"] {
  if (value === undefined) return undefined;
  const selection = value as Record<string, unknown> | null;
  if (
    !selection || typeof selection !== "object" ||
    (selection.modelAlias !== null && typeof selection.modelAlias !== "string") ||
    (selection.reasoningEffort !== null && typeof selection.reasoningEffort !== "string")
  ) {
    throw new Error("messaging idempotency turn selection is malformed");
  }
  return Object.freeze({
    modelAlias: selection.modelAlias as string | null,
    reasoningEffort: selection.reasoningEffort as NonNullable<AppendMessageCommit["turnSelection"]>["reasoningEffort"],
  });
}

function sameTurnSelection(
  left: AppendMessageCommit["turnSelection"],
  right: AppendMessageCommit["turnSelection"],
): boolean {
  return left?.modelAlias === right?.modelAlias &&
    left?.reasoningEffort === right?.reasoningEffort;
}

function messageSelect(where: string, effectiveProjection = true): string {
  const text = effectiveProjection
    ? `CASE WHEN EXISTS (
      SELECT 1 FROM messages tombstone WHERE tombstone.tombstones_message_id = m.id
    ) THEN NULL ELSE m.body_text END`
    : "m.body_text";
  const visibility = effectiveProjection
    ? `CASE WHEN EXISTS (
      SELECT 1 FROM messages tombstone WHERE tombstone.tombstones_message_id = m.id
    ) THEN 'tombstoned' ELSE m.stored_visibility END`
    : "m.stored_visibility";
  return `SELECT
    m.id,
    m.channel_id AS channelId,
    h.id AS conversationId,
    m.channel_sequence AS sequence,
    m.author_principal_id AS authorPrincipalId,
    m.author_kind AS authorKind,
    m.author_display_name AS authorDisplayName,
    m.kind,
    ${text} AS text,
    m.client_message_id AS clientMessageId,
    m.reply_to_message_id AS replyToMessageId,
    m.tombstones_message_id AS tombstonesMessageId,
    m.round_id AS roundId,
    m.work_id AS workId,
    m.created_at AS createdAt,
    ${visibility} AS effectiveVisibility
  FROM messages m
  JOIN conversation_handles h ON h.channel_id = m.channel_id
  WHERE ${where}`;
}

export class SqliteMessageRepository implements MessageRepository {
  constructor(
    private readonly database: MessagingDatabase,
    private readonly provenanceAuthorization?: MessageProvenanceAuthorizationTransactionPort,
    private readonly artifactMessageLink?: ArtifactMessageLinkTransactionPort,
  ) {}

  async appendMessage(input: AppendMessageCommit): Promise<AppendMessageResult> {
    if (
      input.message.author.principalId !== input.actor.principalId ||
      input.message.author.kind !== input.actor.kind ||
      input.message.author.displayName !== input.actor.displayName
    ) {
      throw new MessagingError("identity_context_mismatch");
    }
    if (input.artifactActor && !sameActorBinding(input.actor, input.artifactActor)) {
      throw new MessagingError("identity_context_mismatch");
    }
    if (input.idempotency.operation !== "message.append") {
      throw new MessagingError("request_invalid");
    }
    assertStoredActorBinding(this.database, input.actor);
    const replay = this.resolveMessageReplay(input);
    if (replay) return replay;
    try {
      const result = this.database.mutateWithEvent((transaction) => {
        assertStoredActorBinding(transaction, input.actor);
        const channel = transaction.readOne<{
          conversationId: string;
          lifecycle: "active" | "archived";
          nextSequence: number;
          version: number;
        }>(
          `SELECT h.id AS conversationId, c.lifecycle,
                  c.next_message_sequence AS nextSequence, c.version
           FROM channels c
           JOIN conversation_handles h ON h.channel_id = c.id
           WHERE c.id = ?`,
          input.message.channelId,
        );
        if (!channel) throw new MessagingError("unknown_channel");
        if (channel.lifecycle !== "active") throw new MessagingError("channel_archived");
        const member = transaction.readOne<{ kind: "owner" | "bot" }>(
          `SELECT kind FROM channel_members
           WHERE channel_id = ? AND principal_id = ? AND active = 1`,
          input.message.channelId,
          input.actor.principalId,
        );
        if (!member) throw new MessagingError("nonmember");
        if (member.kind !== input.actor.kind) {
          throw new MessagingError("identity_context_mismatch");
        }
        if (transaction.readOne<{ present: number }>(
          "SELECT 1 AS present FROM messages WHERE id = ?",
          input.message.id,
        )) {
          throw new MessagingError("message_id_conflict");
        }
        if (
          input.message.provenance.roundId !== null ||
          input.message.provenance.workId !== null
        ) {
          if (!this.provenanceAuthorization) {
            throw new MessagingError("invalid_relation");
          }
          this.provenanceAuthorization.assertAuthorized(transaction, {
            actor: input.actor,
            channelId: input.message.channelId,
            provenance: input.message.provenance,
          });
        }
        this.assertMessageRelations(transaction, input);
        for (const principalId of input.message.mentions) {
          const mentioned = transaction.readOne<{ kind: string }>(
            `SELECT member.kind
             FROM channel_members member
             JOIN bots bot ON bot.id = member.principal_id
             WHERE member.channel_id = ? AND member.principal_id = ?
               AND member.active = 1
               AND bot.lifecycle = 'active'
               AND bot.continuing_identity = 1
               AND bot.durable_mailbox = 1`,
            input.message.channelId,
            principalId,
          );
          if (mentioned?.kind !== "bot") throw new MessagingError("invalid_mention");
        }
        const attachmentIds = input.attachmentIds ?? [];
        if (attachmentIds.length > 0 && !this.artifactMessageLink) {
          throw new MessagingError("invalid_relation");
        }
        const sequence = channel.nextSequence;
        const channelUpdate = transaction.run(
          `UPDATE channels
           SET next_message_sequence = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND next_message_sequence = ?`,
          sequence + 1,
          input.message.createdAt,
          input.message.channelId,
          sequence,
        );
        if (channelUpdate.changes !== 1) throw new MessagingError("storage_conflict");
        const channelVersion = channel.version + 1;
        transaction.run(
          `INSERT INTO messages (
            id, channel_id, channel_sequence, author_principal_id, author_kind,
            author_display_name, kind, body_text, stored_visibility,
            client_message_id, reply_to_message_id, tombstones_message_id,
            round_id, work_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'visible', ?, ?, ?, ?, ?, ?)`,
          input.message.id,
          input.message.channelId,
          sequence,
          input.message.author.principalId,
          input.message.author.kind,
          input.message.author.displayName,
          input.message.kind,
          input.message.text,
          input.message.clientMessageId,
          input.message.replyToMessageId,
          input.message.tombstonesMessageId,
          input.message.provenance.roundId,
          input.message.provenance.workId,
          input.message.createdAt,
        );
        const attachments = this.artifactMessageLink?.linkReadyArtifacts(transaction, {
          messageId: input.message.id,
          channelId: input.message.channelId,
          artifactIds: attachmentIds,
          actor: input.artifactActor ?? input.actor,
          linkedAt: input.message.createdAt,
        }) ?? Object.freeze([]);
        for (const principalId of input.message.mentions) {
          transaction.run(
            "INSERT INTO mentions (message_id, channel_id, mentioned_principal_id) VALUES (?, ?, ?)",
            input.message.id,
            input.message.channelId,
            principalId,
          );
        }
        insertMessagingIdempotency(transaction, {
          actor: input.actor,
          claim: input.idempotency,
          resultKind: "message",
          resultRef: {
            messageId: input.message.id,
            eventReference: {
              aggregateKind: "message",
              aggregateId: input.message.id,
              aggregateVersion: 1,
            },
            ...(input.turnSelection ? {
              turnSelection: { ...input.turnSelection },
            } : {}),
          },
          createdAt: input.message.createdAt,
        });
        const message = this.projectPendingMessage(
          input,
          channel.conversationId,
          sequence,
          attachments,
        );
        return {
          value: message,
          event: {
            type: "message.appended",
            aggregateKind: "message",
            aggregateId: input.message.id,
            aggregateVersion: 1,
            channelId: input.message.channelId,
            actorPrincipalId: input.actor.principalId,
            requestId: input.actor.requestId,
            correlationId: input.actor.correlationId,
            payload: {
              messageId: input.message.id,
              channelId: input.message.channelId,
              conversationId: channel.conversationId,
              channelSequence: sequence,
              channelVersion,
              messageVersion: 1,
              authorPrincipalId: input.actor.principalId,
              mentions: [...input.message.mentions],
              replyToMessageId: input.message.replyToMessageId,
              tombstonesMessageId: input.message.tombstonesMessageId,
              roundId: input.message.provenance.roundId,
              workId: input.message.provenance.workId,
            } as Record<string, JsonValue>,
            createdAt: input.message.createdAt,
          },
        };
      });
      return Object.freeze({
        outcome: "committed" as const,
        message: result.value,
        receipt: mutationReceipt(result.event, 1),
      });
    } catch (error) {
      if (isSqliteConstraint(error)) {
        const replayed = this.resolveMessageReplay(input);
        if (replayed) return replayed;
        if (this.database.readOne<{ present: number }>(
          "SELECT 1 AS present FROM messages WHERE id = ?",
          input.message.id,
        )) {
          throw new MessagingError("message_id_conflict");
        }
        throw new MessagingError("storage_conflict");
      }
      throw error;
    }
  }

  async listMessages(input: ListMessagesInput): Promise<ListMessagesResult> {
    assertStoredActorBinding(this.database, input.actor);
    const channel = this.database.readOne<{ nextSequence: number }>(
      "SELECT next_message_sequence AS nextSequence FROM channels WHERE id = ?",
      input.channelId,
    );
    if (!channel) throw new MessagingError("unknown_channel");
    const member = this.database.readOne<{ kind: "owner" | "bot" }>(
      `SELECT kind FROM channel_members
       WHERE channel_id = ? AND principal_id = ? AND active = 1`,
      input.channelId,
      input.actor.principalId,
    );
    if (!member) {
      throw new MessagingError("nonmember");
    }
    if (member.kind !== input.actor.kind) {
      throw new MessagingError("identity_context_mismatch");
    }
    const before = input.beforeSequence ?? channel.nextSequence;
    const rows = this.database.readAll<MessageRow>(
      `SELECT * FROM (${messageSelect("m.channel_id = ? AND m.channel_sequence < ?")} ORDER BY sequence DESC LIMIT ?)
       ORDER BY sequence ASC`,
      input.channelId,
      before,
      input.limit,
    );
    const messages = rows.map((row) => this.hydrateMessage(row));
    const first = messages[0]?.sequence;
    return Object.freeze({
      messages: Object.freeze(messages),
      nextBeforeSequence: messages.length === input.limit && first && first > 1 ? first : null,
    });
  }

  async getMessage(input: GetMessageInput): Promise<MessageProjection | null> {
    assertStoredActorBinding(this.database, input.actor);
    const message = this.readMessage(input.messageId);
    if (!message) return null;
    const member = this.database.readOne<{ kind: "owner" | "bot" }>(
      `SELECT kind FROM channel_members
       WHERE channel_id = ? AND principal_id = ? AND active = 1`,
      message.channelId,
      input.actor.principalId,
    );
    if (!member) throw new MessagingError("nonmember");
    if (member.kind !== input.actor.kind) {
      throw new MessagingError("identity_context_mismatch");
    }
    return message;
  }

  private assertMessageRelations(
    transaction: CoordinationTransaction,
    input: AppendMessageCommit,
  ): void {
    const relationId = input.message.replyToMessageId ?? input.message.tombstonesMessageId;
    if (!relationId) return;
    const target = transaction.readOne<{
      channelId: string;
      authorPrincipalId: string;
      tombstonesMessageId: string | null;
      storedVisibility: "visible" | "tombstoned";
      tombstoned: number;
    }>(
      `SELECT m.channel_id AS channelId,
              m.author_principal_id AS authorPrincipalId,
              m.tombstones_message_id AS tombstonesMessageId,
              m.stored_visibility AS storedVisibility,
              EXISTS (
                SELECT 1 FROM messages tombstone
                WHERE tombstone.tombstones_message_id = m.id
              ) AS tombstoned
       FROM messages m WHERE m.id = ?`,
      relationId,
    );
    if (
      !target ||
      target.channelId !== input.message.channelId ||
      target.tombstoned === 1 ||
      target.storedVisibility === "tombstoned"
    ) {
      throw new MessagingError("invalid_relation");
    }
    if (input.message.tombstonesMessageId) {
      if (
        target.tombstonesMessageId !== null ||
        (input.actor.principalId !== "user_owner" &&
          target.authorPrincipalId !== input.actor.principalId)
      ) {
        throw new MessagingError("invalid_relation");
      }
    }
  }

  private resolveMessageReplay(input: AppendMessageCommit): AppendMessageResult | null {
    const idempotency = readMessagingIdempotency(
      this.database,
      input.actor.principalId,
      input.idempotency,
    );
    if (!idempotency) return null;
    let messageId: unknown;
    let eventReference: MessagingEventReference;
    try {
      const result = JSON.parse(idempotency.resultRefJson) as {
        messageId?: unknown;
        eventReference?: unknown;
        turnSelection?: unknown;
      };
      messageId = result.messageId;
      if (!sameTurnSelection(storedTurnSelection(result.turnSelection), input.turnSelection)) {
        throw new Error("messaging idempotency turn selection differs from its request");
      }
      eventReference = parseMessagingEventReference(
        result.eventReference,
        "messaging idempotency result has no exact message event reference",
      );
    } catch {
      throw new Error("messaging idempotency result is malformed");
    }
    if (typeof messageId !== "string") {
      throw new Error("messaging idempotency result has no message event reference");
    }
    const message = this.readMessage(messageId, false);
    if (!message) throw new Error("messaging idempotency result references a missing message");
    return Object.freeze({
      outcome: "replayed" as const,
      message,
      receipt: replayReceipt(this.database, idempotency, eventReference, 1),
    });
  }

  private readMessage(
    messageId: string,
    effectiveProjection = true,
  ): MessageProjection | null {
    const row = this.database.readOne<MessageRow>(
      messageSelect("m.id = ?", effectiveProjection),
      messageId,
    );
    return row ? this.hydrateMessage(row) : null;
  }

  private hydrateMessage(row: MessageRow): MessageProjection {
    const mentions = this.database.readAll<{ principalId: string }>(
      "SELECT mentioned_principal_id AS principalId FROM mentions WHERE message_id = ? ORDER BY mentioned_principal_id",
      row.id,
    ).map((mention) => mention.principalId);
    const attachments = this.artifactMessageLink
      ? this.database.readAll<AttachmentSummary>(
          `SELECT artifact.id, artifact.original_name AS name,
                  artifact.detected_content_type AS contentType,
                  artifact.byte_count AS byteCount, artifact.sha256
           FROM message_artifacts link JOIN artifacts artifact ON artifact.id = link.artifact_id
           WHERE link.message_id = ? ORDER BY link.ordinal ASC`,
          row.id,
        )
      : [];
    return Object.freeze({
      id: row.id,
      channelId: row.channelId,
      conversationId: row.conversationId,
      sequence: row.sequence,
      author: Object.freeze({
        principalId: row.authorPrincipalId,
        kind: row.authorKind,
        displayName: row.authorDisplayName,
      }),
      kind: row.kind,
      text: row.text,
      mentions: Object.freeze(mentions),
      attachments: Object.freeze(attachments.map((attachment) => Object.freeze({ ...attachment }))),
      replyToMessageId: row.replyToMessageId,
      tombstonesMessageId: row.tombstonesMessageId,
      visibility: row.effectiveVisibility,
      clientMessageId: row.clientMessageId,
      provenance: Object.freeze({ roundId: row.roundId, workId: row.workId }),
      createdAt: row.createdAt,
    });
  }

  private projectPendingMessage(
    input: AppendMessageCommit,
    conversationId: string,
    sequence: number,
    attachments: readonly AttachmentSummary[],
  ): MessageProjection {
    return Object.freeze({
      ...input.message,
      author: Object.freeze({ ...input.message.author }),
      mentions: Object.freeze([...input.message.mentions]),
      provenance: Object.freeze({ ...input.message.provenance }),
      conversationId,
      sequence,
      attachments: Object.freeze([...attachments]),
      visibility: "visible" as const,
    });
  }
}
