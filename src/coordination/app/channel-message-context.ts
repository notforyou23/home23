import {
  ChannelCoordinatorError,
  listRecoverableCoordinatorAdmissionRoundIds,
  readCoordinatorAdmissionPlan,
  type CoordinatorAdmissionPlan,
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
  authorPrincipalId: string;
  authorDisplayName: string;
  kind: "text" | "system" | "result";
  text: string | null;
  replyToMessageId: string | null;
  roundId: string | null;
  workId: string | null;
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

  private selectedTargets(
    channelId: string,
    channel: GroupChannelRow,
    mentionedBotIds: readonly string[],
  ): readonly GroupTargetRow[] {
    const availableTargets = this.targets(channelId);
    const byBot = new Map(availableTargets.map((target) => [target.targetBotId, target]));
    const selectedBotIds = mentionedBotIds.length > 0
      ? [...mentionedBotIds]
      : channel.responderMode === "mention_or_coordinator" && channel.coordinatorBotId
        ? [channel.coordinatorBotId]
        : [];
    return Object.freeze(selectedBotIds.map((botId) => {
      const target = byBot.get(botId);
      if (!target) {
        throw new ChannelCoordinatorError(
          "ineligible",
          "selected Channel Bot is not a persistent message resident",
        );
      }
      return target;
    }));
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

  private preparedFromAdmissionPlan(
    plan: CoordinatorAdmissionPlan,
  ): GroupChannelPreparedContext {
    const messageIds = [...plan.manifest.messageIds];
    if (messageIds.length === 0) throw new MessagingError("invalid_relation");
    const placeholders = messageIds.map(() => "?").join(",");
    const rows = this.database.readAll<RecoveryMessageRow>(
      `SELECT m.id, m.channel_sequence AS sequence,
              m.author_principal_id AS authorPrincipalId,
              m.author_display_name AS authorDisplayName, m.kind,
              CASE WHEN EXISTS (
                SELECT 1 FROM messages tombstone
                WHERE tombstone.tombstones_message_id = m.id
              ) THEN NULL ELSE m.body_text END AS text,
              m.reply_to_message_id AS replyToMessageId,
              m.round_id AS roundId, m.work_id AS workId
       FROM messages m
       WHERE m.channel_id = ? AND m.id IN (${placeholders})
       ORDER BY m.channel_sequence ASC`,
      plan.channelId,
      ...messageIds,
    );
    const boundary = rows.at(-1);
    const event = this.eventFor(plan.originMessageId, plan.manifest.watermarks.eventSequence);
    const tombstonedAfterSnapshot = this.database.readOne<{ count: number }>(
      `SELECT count(*) AS count FROM messages tombstone
       WHERE tombstone.channel_id = ?
         AND tombstone.tombstones_message_id IN (${placeholders})
         AND tombstone.channel_sequence > ?`,
      plan.channelId,
      ...messageIds,
      plan.manifest.watermarks.channelSequence,
    )?.count ?? 0;
    const canonicalManifest = directMessageManifest({
      channelId: plan.channelId,
      messageIds: rows.map((row) => row.id),
      attachmentIds: plan.manifest.artifactIds,
      channelSequence: plan.manifest.watermarks.channelSequence,
      eventSequence: plan.manifest.watermarks.eventSequence,
    });
    if (
      rows.length !== messageIds.length ||
      rows.some((row) => !messageIds.includes(row.id)) ||
      boundary?.id !== plan.originMessageId ||
      boundary?.sequence !== plan.manifest.watermarks.channelSequence ||
      event.eventId !== plan.originEventId || tombstonedAfterSnapshot !== 0 ||
      canonicalManifest.digests.context !== plan.manifest.digests.context ||
      canonicalManifest.digests.source !== plan.manifest.digests.source
    ) {
      throw new MessagingError("invalid_relation");
    }
    const instruction = rows
      .filter((message) => message.text !== null)
      .map((message) => `${message.authorDisplayName}: ${message.text}`)
      .join("\n");
    if (!instruction) throw new MessagingError("invalid_relation");
    return Object.freeze({
      channelId: plan.channelId,
      conversationId: plan.conversationId,
      originMessageId: plan.originMessageId,
      originEventId: plan.originEventId,
      actorPrincipalId: plan.actorPrincipalId,
      visibleParticipantIds: plan.visibleParticipantIds,
      selectedTargets: plan.selectedTargets,
      responseOrder: plan.responseOrder,
      standingReference: plan.standingReference,
      instruction,
      manifest: canonicalManifest,
    });
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
    const selectedTargets = this.selectedTargets(
      input.channelId,
      channel,
      input.originMessage.mentions,
    );
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

  async prepareSequentialTurn(
    input: Parameters<GroupChannelMessageContextPort["prepareSequentialTurn"]>[0],
  ): Promise<GroupChannelPreparedContext> {
    if (input.plan.responseOrder !== "sequential") {
      throw new MessagingError("invalid_relation");
    }
    const round = this.database.readOne<{ channelId: string }>(
      "SELECT channel_id AS channelId FROM rounds WHERE id = ?",
      input.roundId,
    );
    if (!round || round.channelId !== input.plan.channelId) {
      throw new MessagingError("invalid_relation");
    }
    const targetIndex = input.plan.selectedTargets.findIndex(
      (candidate) => candidate.targetBotId === input.targetBotId,
    );
    if (targetIndex < 1) throw new MessagingError("invalid_relation");
    const target = input.plan.selectedTargets[targetIndex]!;

    const precedingTargets = input.plan.selectedTargets.slice(0, targetIndex);
    const works = this.listRoundWorks(input.roundId);
    const byTarget = new Map<string, WorkRecord>();
    for (const work of works) {
      if (byTarget.has(work.targetPrincipalId)) {
        throw new MessagingError("invalid_relation");
      }
      byTarget.set(work.targetPrincipalId, work);
    }
    if (
      works.length !== precedingTargets.length ||
      precedingTargets.some((candidate) => {
        const work = byTarget.get(candidate.targetPrincipalId);
        return !work || !["succeeded", "failed", "cancelled"].includes(work.state);
      })
    ) {
      throw new MessagingError("invalid_relation");
    }

    const precedingWorkIds = precedingTargets.map((candidate) =>
      byTarget.get(candidate.targetPrincipalId)!.id
    );
    const resultRows = precedingWorkIds.length === 0
      ? []
      : this.database.readAll<RecoveryMessageRow>(
          `SELECT m.id, m.channel_sequence AS sequence,
                  m.author_principal_id AS authorPrincipalId,
                  m.author_display_name AS authorDisplayName, m.kind,
                  CASE WHEN EXISTS (
                    SELECT 1 FROM messages tombstone
                    WHERE tombstone.tombstones_message_id = m.id
                  ) THEN NULL ELSE m.body_text END AS text,
                  m.reply_to_message_id AS replyToMessageId,
                  m.round_id AS roundId, m.work_id AS workId
           FROM messages m
           WHERE m.channel_id = ? AND m.kind = 'result' AND m.round_id = ?
             AND m.work_id IN (${precedingWorkIds.map(() => "?").join(",")})
           ORDER BY m.channel_sequence ASC`,
          input.plan.channelId,
          input.roundId,
          ...precedingWorkIds,
        );
    if (
      resultRows.some((row) =>
        row.replyToMessageId !== input.plan.originMessageId ||
        row.roundId !== input.roundId || row.workId === null ||
        byTarget.get(row.authorPrincipalId)?.id !== row.workId ||
        byTarget.get(row.authorPrincipalId)?.state !== "succeeded"
      ) ||
      new Set(resultRows.map((row) => row.workId)).size !== resultRows.length
    ) {
      throw new MessagingError("invalid_relation");
    }

    const messageIds = [...input.plan.manifest.messageIds, ...resultRows.map((row) => row.id)];
    const boundedMessageIds = messageIds.slice(-100);
    if (!boundedMessageIds.includes(input.plan.originMessageId)) {
      throw new MessagingError("invalid_relation");
    }
    const rows = this.database.readAll<RecoveryMessageRow>(
      `SELECT m.id, m.channel_sequence AS sequence,
              m.author_principal_id AS authorPrincipalId,
              m.author_display_name AS authorDisplayName, m.kind,
              CASE WHEN EXISTS (
                SELECT 1 FROM messages tombstone
                WHERE tombstone.tombstones_message_id = m.id
              ) THEN NULL ELSE m.body_text END AS text,
              m.reply_to_message_id AS replyToMessageId,
              m.round_id AS roundId, m.work_id AS workId
       FROM messages m
       WHERE m.channel_id = ?
         AND m.id IN (${boundedMessageIds.map(() => "?").join(",")})
       ORDER BY m.channel_sequence ASC`,
      input.plan.channelId,
      ...boundedMessageIds,
    );
    const boundary = rows.at(-1);
    if (
      rows.length !== boundedMessageIds.length || !boundary ||
      !rows.some((row) => row.id === input.plan.originMessageId)
    ) {
      throw new MessagingError("invalid_relation");
    }
    const boundaryEvent = this.eventFor(boundary.id);
    const instruction = rows
      .filter((message) => message.text !== null)
      .map((message) => `${message.authorDisplayName}: ${message.text}`)
      .join("\n");
    if (!instruction) throw new MessagingError("invalid_relation");
    return Object.freeze({
      ...input.plan,
      selectedTargets: Object.freeze([target]),
      responseOrder: input.plan.responseOrder,
      instruction,
      manifest: directMessageManifest({
        channelId: input.plan.channelId,
        messageIds: rows.map((row) => row.id),
        attachmentIds: input.plan.manifest.artifactIds,
        channelSequence: boundary.sequence,
        eventSequence: boundaryEvent.eventSequence,
      }),
    });
  }

  async recover(work: WorkRecord): Promise<GroupChannelPreparedContext> {
    if (
      work.kind !== "channel.bot_turn" ||
      work.originMessageId === null ||
      work.roundId === null
    ) {
      throw new MessagingError("invalid_relation");
    }
    const admission = readCoordinatorAdmissionPlan(this.database, work.roundId);
    if (
      admission.channelId !== work.channelId ||
      admission.originMessageId !== work.originMessageId ||
      admission.actorPrincipalId !== work.principalId
    ) {
      throw new MessagingError("invalid_relation");
    }
    const target = admission.selectedTargets.find(
      (candidate) => candidate.targetPrincipalId === work.targetPrincipalId,
    );
    if (!target) throw new MessagingError("invalid_relation");
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
              m.author_principal_id AS authorPrincipalId,
              m.author_display_name AS authorDisplayName, m.kind,
              CASE WHEN EXISTS (
                SELECT 1 FROM messages tombstone
                WHERE tombstone.tombstones_message_id = m.id
              ) THEN NULL ELSE m.body_text END AS text,
              m.reply_to_message_id AS replyToMessageId,
              m.round_id AS roundId, m.work_id AS workId
       FROM messages m
       WHERE m.channel_id = ? AND m.id IN (${placeholders})
       ORDER BY m.channel_sequence ASC`,
      work.channelId,
      ...messageIds,
    );
    const boundary = rows.at(-1);
    const event = boundary
      ? this.eventFor(boundary.id, manifest.eventWatermark)
      : null;
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
      !rows.some((row) => row.id === work.originMessageId) ||
      boundary?.sequence !== manifest.channelWatermark ||
      event === null ||
      tombstonedAfterSnapshot !== 0 ||
      canonicalManifest.digests.context !== manifest.contextDigest ||
      canonicalManifest.digests.source !== manifest.sourceDigest
    ) {
      throw new MessagingError("invalid_relation");
    }
    for (const row of rows.filter((candidate) => candidate.sequence >
      rows.find((candidate) => candidate.id === work.originMessageId)!.sequence)) {
      const sourceWork = row.workId === null
        ? undefined
        : this.database.readOne<{ targetPrincipalId: string; state: string }>(
            `SELECT target_principal_id AS targetPrincipalId, state FROM works
             WHERE id = ? AND round_id = ? AND channel_id = ?`,
            row.workId,
            work.roundId,
            work.channelId,
          );
      if (
        row.kind !== "result" || row.roundId !== work.roundId ||
        row.replyToMessageId !== work.originMessageId || !sourceWork ||
        sourceWork.targetPrincipalId !== row.authorPrincipalId ||
        sourceWork.state !== "succeeded"
      ) {
        throw new MessagingError("invalid_relation");
      }
    }
    const instruction = rows
      .filter((message) => message.text !== null)
      .map((message) => `${message.authorDisplayName}: ${message.text}`)
      .join("\n");
    if (!instruction) throw new MessagingError("invalid_relation");
    return Object.freeze({
      channelId: work.channelId,
      conversationId: admission.conversationId,
      originMessageId: work.originMessageId,
      originEventId: admission.originEventId,
      actorPrincipalId: admission.actorPrincipalId,
      visibleParticipantIds: admission.visibleParticipantIds,
      selectedTargets: Object.freeze([target]),
      responseOrder: admission.responseOrder,
      standingReference: admission.standingReference,
      instruction,
      manifest: canonicalManifest,
    });
  }

  async recoverPlan(roundId: string) {
    const admission = readCoordinatorAdmissionPlan(this.database, roundId);
    return Object.freeze({
      prepared: this.preparedFromAdmissionPlan(admission),
      turnSelection: admission.turnSelection,
    });
  }

  listRecoveryRoundIds(limit: number): readonly string[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Channel recovery limit is invalid");
    }
    return listRecoverableCoordinatorAdmissionRoundIds(this.database, limit);
  }

  listRoundWorks(roundId: string): readonly WorkRecord[] {
    return Object.freeze(this.database.readAll<WorkRecord>(
      `${WORK_SELECT}
       WHERE round_id = ? AND kind = 'channel.bot_turn'
       ORDER BY target_principal_id, created_at, id`,
      roundId,
    ).map((work) => Object.freeze(work)));
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
