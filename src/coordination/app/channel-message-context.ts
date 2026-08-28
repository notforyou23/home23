import {
  ChannelCoordinatorError,
} from "../channel-coordinator/index.js";
import { MessagingError, type MessagingActorContext } from "../channels/index.js";
import type { MessageProjection } from "../messages/index.js";
import type { M11Database, WorkRecord } from "../work/index.js";
import { directMessageManifest } from "./direct-message.js";
import type {
  GroupChannelMessageContextPort,
  GroupChannelPreparedContext,
  GroupChannelResidentTarget,
} from "./channel-message.js";

interface GroupChannelRow {
  conversationId: string;
  responderMode: "mentions_only" | "mention_or_coordinator";
  coordinatorBotId: string | null;
  responseOrder: "parallel" | "sequential";
  version: number;
}

interface GroupTargetRow extends GroupChannelResidentTarget {}

interface RecoveryManifestRow {
  messageRefsJson: string;
  artifactRefsJson: string;
  messageCount: number;
  artifactCount: number;
  channelWatermark: number;
  eventWatermark: number;
  contextDigest: string;
  sourceDigest: string;
}

interface RecoveryMessageRow {
  id: string;
  sequence: number;
  authorDisplayName: string;
  text: string | null;
}

const WORK_SELECT = `
SELECT id, principal_id AS principalId, target_principal_id AS targetPrincipalId,
       channel_id AS channelId, origin_message_id AS originMessageId,
       round_id AS roundId, context_manifest_id AS contextManifestId, kind,
       idempotency_key_digest AS idempotencyKeyDigest, request_digest AS requestDigest,
       state, current_attempt_id AS currentAttemptId,
       next_fencing_token AS nextFencingToken,
       automatic_offer_count AS automaticOfferCount,
       max_automatic_offers AS maxAutomaticOffers, terminal_reason AS terminalReason,
       terminal_receipt_digest AS terminalReceiptDigest, version,
       created_at AS createdAt, updated_at AS updatedAt, terminal_at AS terminalAt
FROM works`;

/** Trusted SQLite assembler for owner-authored group Channel turns. */
export class SqliteGroupChannelMessageContext
implements GroupChannelMessageContextPort {
  constructor(
    private readonly database: M11Database,
    private readonly messages: { listMessages(input: {
      context: MessagingActorContext;
      channelId: string;
      beforeSequence?: number;
      limit: number;
    }): Promise<{ messages: readonly MessageProjection[] }> },
  ) {}

  private channel(channelId: string, principalId?: string): GroupChannelRow {
    const row = this.database.readOne<GroupChannelRow>(
      `SELECT h.id AS conversationId, c.responder_mode AS responderMode,
              c.coordinator_bot_id AS coordinatorBotId,
              c.response_order AS responseOrder, c.version
       FROM channels c
       JOIN conversation_handles h ON h.channel_id = c.id
       ${principalId === undefined
         ? ""
         : `JOIN channel_members actor ON actor.channel_id = c.id
              AND actor.principal_id = ? AND actor.active = 1`}
       WHERE c.id = ? AND c.kind = 'group' AND c.lifecycle = 'active'`,
      ...(principalId === undefined ? [channelId] : [principalId, channelId]),
    );
    if (!row) throw new MessagingError("unknown_channel");
    return row;
  }

  private targets(channelId: string): readonly GroupTargetRow[] {
    return Object.freeze(this.database.readAll<GroupTargetRow>(
      `SELECT b.id AS targetBotId, b.name AS targetBotDisplayName,
              b.principal_id AS targetPrincipalId,
              b.resident_binding AS residentBinding
       FROM channel_members member
       JOIN bots b ON b.principal_id = member.principal_id
       WHERE member.channel_id = ? AND member.kind = 'bot' AND member.active = 1
         AND b.lifecycle = 'active' AND b.continuing_identity = 1
         AND b.durable_mailbox = 1 AND b.resident_protocol_version = 1
         AND EXISTS (
           SELECT 1 FROM json_each(b.resident_capabilities_json)
           WHERE value = 'messages'
         )
       ORDER BY b.id`,
      channelId,
    ).map((row) => Object.freeze(row)));
  }

  private eventFor(messageId: string, eventSequence?: number): {
    eventId: string;
    eventSequence: number;
  } {
    const event = this.database.readOne<{ eventId: string; eventSequence: number }>(
      `SELECT id AS eventId, sequence AS eventSequence FROM events
       WHERE aggregate_kind = 'message' AND aggregate_id = ?
         AND type = 'message.appended'
         ${eventSequence === undefined ? "" : "AND sequence = ?"}
       ORDER BY sequence ASC LIMIT 1`,
      ...(eventSequence === undefined ? [messageId] : [messageId, eventSequence]),
    );
    if (!event) throw new MessagingError("invalid_relation");
    return event;
  }

  private async snapshot(input: {
    context: MessagingActorContext;
    channelId: string;
    originMessage: MessageProjection;
    attachmentIds: readonly string[];
    eventSequence: number;
  }): Promise<GroupChannelPreparedContext> {
    if (
      input.context.identity.kind !== "owner" ||
      input.context.principalId !== "user_owner" ||
      input.originMessage.author.kind !== "owner" ||
      input.originMessage.author.principalId !== input.context.principalId ||
      input.originMessage.channelId !== input.channelId ||
      input.originMessage.text === null
    ) {
      throw new MessagingError("invalid_relation");
    }
    const channel = this.channel(input.channelId, input.context.principalId);
    const page = await this.messages.listMessages({
      context: input.context,
      channelId: input.channelId,
      beforeSequence: input.originMessage.sequence + 1,
      limit: 100,
    });
    const projectedOrigin = page.messages.find(
      (message) => message.id === input.originMessage.id,
    );
    if (
      !projectedOrigin ||
      projectedOrigin.sequence !== input.originMessage.sequence ||
      projectedOrigin.text !== input.originMessage.text ||
      projectedOrigin.author.principalId !== input.originMessage.author.principalId
    ) {
      throw new MessagingError("invalid_relation");
    }
    const projectedAttachmentIds = projectedOrigin.attachments
      .map((attachment) => attachment.id)
      .sort();
    const requestedAttachmentIds = [...input.attachmentIds].sort();
    if (
      projectedAttachmentIds.length !== requestedAttachmentIds.length ||
      projectedAttachmentIds.some((id, index) => id !== requestedAttachmentIds[index])
    ) {
      throw new MessagingError("invalid_relation");
    }
    const event = this.eventFor(input.originMessage.id, input.eventSequence);
    const boundedMessages = page.messages.filter(
      (message) => message.sequence <= input.originMessage.sequence,
    );
    const boundedMessageIds = boundedMessages.map((message) => message.id);
    if (boundedMessageIds.length === 0) throw new MessagingError("invalid_relation");
    const placeholders = boundedMessageIds.map(() => "?").join(",");
    const tombstonedAfterSnapshot = this.database.readOne<{ count: number }>(
      `SELECT count(*) AS count FROM messages tombstone
       WHERE tombstone.channel_id = ?
         AND tombstone.tombstones_message_id IN (${placeholders})
         AND tombstone.channel_sequence > ?`,
      input.channelId,
      ...boundedMessageIds,
      input.originMessage.sequence,
    )?.count ?? 0;
    if (tombstonedAfterSnapshot !== 0) throw new MessagingError("invalid_relation");
    const availableTargets = this.targets(input.channelId);
    const byBot = new Map(availableTargets.map((target) => [target.targetBotId, target]));
    const selectedBotIds = input.originMessage.mentions.length > 0
      ? [...input.originMessage.mentions]
      : channel.responderMode === "mention_or_coordinator" && channel.coordinatorBotId
        ? [channel.coordinatorBotId]
        : [];
    const selectedTargets = selectedBotIds.map((botId) => {
      const target = byBot.get(botId);
      if (!target) {
        throw new ChannelCoordinatorError(
          "ineligible",
          "selected Channel Bot is not a persistent message resident",
        );
      }
      return target;
    });
    const instruction = boundedMessages
      .filter((message) => message.text !== null)
      .map((message) => `${message.author.displayName}: ${message.text}`)
      .join("\n");
    if (!instruction) throw new MessagingError("invalid_relation");
    return Object.freeze({
      channelId: input.channelId,
      conversationId: channel.conversationId,
      originMessageId: input.originMessage.id,
      originEventId: event.eventId,
      actorPrincipalId: input.originMessage.author.principalId,
      visibleParticipantIds: Object.freeze(
        availableTargets.map((target) => target.targetBotId),
      ),
      selectedTargets: Object.freeze(selectedTargets),
      responseOrder: channel.responseOrder,
      standingReference:
        `canonical-channel-membership:${input.channelId}:version:${channel.version}`,
      instruction,
      manifest: directMessageManifest({
        channelId: input.channelId,
        messageIds: boundedMessageIds,
        attachmentIds: input.attachmentIds,
        channelSequence: input.originMessage.sequence,
        eventSequence: event.eventSequence,
      }),
    });
  }

  async loadOrigin(input: Parameters<GroupChannelMessageContextPort["loadOrigin"]>[0]) {
    this.channel(input.channelId, input.context.principalId);
    const stored = this.database.readOne<{ sequence: number }>(
      `SELECT channel_sequence AS sequence FROM messages
       WHERE id = ? AND channel_id = ? AND author_principal_id = ?
         AND author_kind = 'owner' AND stored_visibility = 'visible'`,
      input.messageId,
      input.channelId,
      input.context.principalId,
    );
    if (!stored) throw new MessagingError("unknown_message");
    const page = await this.messages.listMessages({
      context: input.context,
      channelId: input.channelId,
      beforeSequence: stored.sequence + 1,
      limit: 100,
    });
    const message = page.messages.find((candidate) => candidate.id === input.messageId);
    if (!message) throw new MessagingError("invalid_relation");
    const event = this.eventFor(message.id);
    return Object.freeze({
      message,
      attachmentIds: Object.freeze(message.attachments.map((attachment) => attachment.id)),
      eventSequence: event.eventSequence,
    });
  }

  prepare(input: Parameters<GroupChannelMessageContextPort["prepare"]>[0]) {
    return this.snapshot(input);
  }

  async recover(work: WorkRecord): Promise<GroupChannelPreparedContext> {
    if (
      work.kind !== "channel.bot_turn" ||
      work.originMessageId === null ||
      work.roundId === null
    ) {
      throw new MessagingError("invalid_relation");
    }
    const channel = this.channel(work.channelId);
    const target = this.targets(work.channelId).find(
      (candidate) => candidate.targetPrincipalId === work.targetPrincipalId,
    );
    if (!target) throw new MessagingError("unknown_principal");
    const manifest = this.database.readOne<RecoveryManifestRow>(
      `SELECT message_refs_json AS messageRefsJson,
              artifact_refs_json AS artifactRefsJson,
              message_count AS messageCount, artifact_count AS artifactCount,
              channel_watermark AS channelWatermark,
              event_watermark AS eventWatermark,
              context_digest AS contextDigest, source_digest AS sourceDigest
       FROM context_manifests WHERE id = ? AND channel_id = ?`,
      work.contextManifestId,
      work.channelId,
    );
    if (!manifest) throw new MessagingError("invalid_relation");
    let messageIds: string[];
    let artifactIds: string[];
    try {
      messageIds = JSON.parse(manifest.messageRefsJson) as string[];
      artifactIds = JSON.parse(manifest.artifactRefsJson) as string[];
    } catch {
      throw new MessagingError("invalid_relation");
    }
    if (
      !Array.isArray(messageIds) || messageIds.length === 0 ||
      !messageIds.every((id) => typeof id === "string") ||
      !Array.isArray(artifactIds) ||
      !artifactIds.every((id) => typeof id === "string") ||
      messageIds.length !== manifest.messageCount ||
      artifactIds.length !== manifest.artifactCount ||
      !messageIds.includes(work.originMessageId)
    ) {
      throw new MessagingError("invalid_relation");
    }
    const placeholders = messageIds.map(() => "?").join(",");
    const rows = this.database.readAll<RecoveryMessageRow>(
      `SELECT m.id, m.channel_sequence AS sequence,
              m.author_display_name AS authorDisplayName,
              CASE WHEN EXISTS (
                SELECT 1 FROM messages tombstone
                WHERE tombstone.tombstones_message_id = m.id
              ) THEN NULL ELSE m.body_text END AS text
       FROM messages m
       WHERE m.channel_id = ? AND m.id IN (${placeholders})
       ORDER BY m.channel_sequence ASC`,
      work.channelId,
      ...messageIds,
    );
    const event = this.eventFor(work.originMessageId, manifest.eventWatermark);
    const tombstonedAfterSnapshot = this.database.readOne<{ count: number }>(
      `SELECT count(*) AS count FROM messages tombstone
       WHERE tombstone.channel_id = ?
         AND tombstone.tombstones_message_id IN (${placeholders})
         AND tombstone.channel_sequence > ?`,
      work.channelId,
      ...messageIds,
      manifest.channelWatermark,
    )?.count ?? 0;
    const canonicalManifest = directMessageManifest({
      channelId: work.channelId,
      messageIds: rows.map((row) => row.id),
      attachmentIds: artifactIds,
      channelSequence: manifest.channelWatermark,
      eventSequence: manifest.eventWatermark,
    });
    if (
      rows.length !== messageIds.length ||
      rows.some((row) => !messageIds.includes(row.id)) ||
      rows.at(-1)?.id !== work.originMessageId ||
      rows.at(-1)?.sequence !== manifest.channelWatermark ||
      tombstonedAfterSnapshot !== 0 ||
      canonicalManifest.digests.context !== manifest.contextDigest ||
      canonicalManifest.digests.source !== manifest.sourceDigest
    ) {
      throw new MessagingError("invalid_relation");
    }
    const origin = this.database.readOne<{ authorPrincipalId: string }>(
      `SELECT author_principal_id AS authorPrincipalId FROM messages
       WHERE id = ? AND channel_id = ?`,
      work.originMessageId,
      work.channelId,
    );
    if (!origin) throw new MessagingError("invalid_relation");
    const instruction = rows
      .filter((message) => message.text !== null)
      .map((message) => `${message.authorDisplayName}: ${message.text}`)
      .join("\n");
    if (!instruction) throw new MessagingError("invalid_relation");
    return Object.freeze({
      channelId: work.channelId,
      conversationId: channel.conversationId,
      originMessageId: work.originMessageId,
      originEventId: event.eventId,
      actorPrincipalId: origin.authorPrincipalId,
      visibleParticipantIds: Object.freeze(
        this.targets(work.channelId).map((candidate) => candidate.targetBotId),
      ),
      selectedTargets: Object.freeze([target]),
      responseOrder: channel.responseOrder,
      standingReference:
        `canonical-channel-membership:${work.channelId}:version:${channel.version}`,
      instruction,
      manifest: canonicalManifest,
    });
  }

  listRecoveryRoundIds(limit: number): readonly string[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Channel recovery limit is invalid");
    }
    return Object.freeze(this.database.readAll<{ roundId: string }>(
      `SELECT r.id AS roundId FROM rounds r
       WHERE r.state IN ('open', 'coordinating', 'waiting')
         AND EXISTS (
           SELECT 1 FROM works w
           WHERE w.round_id = r.id AND w.kind = 'channel.bot_turn'
         )
       ORDER BY r.created_at, r.id LIMIT ?`,
      limit,
    ).map((row) => row.roundId));
  }

  listRoundWorks(roundId: string): readonly WorkRecord[] {
    return Object.freeze(this.database.readAll<WorkRecord>(
      `${WORK_SELECT}
       WHERE round_id = ? AND kind = 'channel.bot_turn'
       ORDER BY target_principal_id, created_at, id`,
      roundId,
    ).map((work) => Object.freeze(work)));
  }

  responseOrder(roundId: string): "parallel" | "sequential" {
    const row = this.database.readOne<{ responseOrder: "parallel" | "sequential" }>(
      `SELECT c.response_order AS responseOrder
       FROM rounds r JOIN channels c ON c.id = r.channel_id
       WHERE r.id = ? AND c.kind = 'group'`,
      roundId,
    );
    if (!row) throw new MessagingError("invalid_relation");
    return row.responseOrder;
  }

  hasResult(workId: string): boolean {
    const count = this.database.readOne<{ count: number }>(
      `SELECT count(*) AS count FROM messages
       WHERE work_id = ? AND kind = 'result' AND stored_visibility = 'visible'`,
      workId,
    )?.count ?? 0;
    if (count > 1) throw new Error("Channel Work has multiple canonical results");
    return count === 1;
  }
}
