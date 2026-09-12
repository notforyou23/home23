import { boundHistoricalContext } from "../../agent/historical-context.js";
import type { MessagingActorContext } from "../channels/index.js";
import { MessagingError } from "../channels/index.js";
import type { AttachmentSummary } from "../artifacts/index.js";
import type { ResidentInputAttachment } from "../../coordination-adapter/index.js";
import type { M11Database } from "../work/index.js";
import type { WorkRecord } from "../work/index.js";
import { readInheritedWorkInstructionMessageIds } from "../work/service.js";
import { assertCoordinationId } from "../ids/index.js";
import {
  directMessageManifest,
  type DirectMessageContextPort,
  type DirectMessageHistoryEntry,
} from "./direct-message.js";

interface DirectBindingRow {
  conversationId: string;
  targetBotId: string;
  targetBotDisplayName: string;
  targetPrincipalId: string;
  residentBinding: string;
}

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
  text: string | null;
  createdAt: string;
}

type AttachmentMaterializer = (
  attachments: readonly AttachmentSummary[],
) => Promise<readonly ResidentInputAttachment[]>;

// Configured, registered residents use UDS. Every lifecycle-created
// Bot is deliberately processless and is eligible for Core-owned on-demand
// execution only while its canonical mailbox identity remains active.
const ROUTABLE_DIRECT_TARGET_SQL = `
  AND (
    (
      b.resident_binding NOT LIKE 'bot-%'
      AND b.resident_protocol_version = 1
      AND EXISTS (
        SELECT 1 FROM json_each(b.resident_capabilities_json) WHERE value = 'messages'
      )
    ) OR (
      b.resident_binding LIKE 'bot-%'
      AND EXISTS (
        SELECT 1 FROM json_each(b.required_capabilities_json) WHERE value = 'messages'
      )
      AND b.active_instance_id IS NULL
      AND b.active_key_version IS NULL
      AND b.resident_protocol_version IS NULL
      AND b.resident_registered_at IS NULL
      AND json_array_length(b.resident_capabilities_json) = 0
    )
  )`;

function exactAttachmentIDs(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Read-only M04/M07 context assembler; it never reads resident-private state. */
export class SqliteDirectMessageContext implements DirectMessageContextPort {
  constructor(
    private readonly database: M11Database,
    private readonly messages: { listMessages(input: {
      context: MessagingActorContext; channelId: string; limit: number;
    }): Promise<{ messages: readonly {
      id: string;
      sequence: number;
      text: string | null;
      createdAt: string;
      author: { principalId: string; displayName: string };
      attachments: readonly AttachmentSummary[];
    }[] }> },
    private readonly materializeAttachments?: AttachmentMaterializer,
  ) {}

  findWorkIdByIdempotency(principalId: string, keyDigest: string): string | null {
    return this.database.readOne<{ id: string }>(
      "SELECT id FROM works WHERE principal_id = ? AND idempotency_key_digest = ?",
      principalId, keyDigest,
    )?.id ?? null;
  }

  private instructionRows(input: {
    ids: readonly string[]; principalId: string; channelId: string; originMessageId: string;
    manifestIds: readonly string[];
  }): readonly { id: string; sequence: number; text: string }[] {
    const { ids } = input;
    if (input.principalId !== "user_owner" || !Array.isArray(ids) || ids.length < 1 || ids.length > 100 ||
        new Set(ids).size !== ids.length || ids.at(-1) !== input.originMessageId ||
        ids.some(id => !input.manifestIds.includes(id))) throw new MessagingError("invalid_relation");
    try { for (const id of ids) assertCoordinationId("message", id); }
    catch { throw new MessagingError("invalid_relation"); }
    const rows = this.database.readAll<{ id: string; sequence: number; text: string }>(
      `SELECT m.id, m.channel_sequence AS sequence, m.body_text AS text FROM messages m
       WHERE m.channel_id=? AND m.id IN (${ids.map(() => "?").join(",")})
         AND m.author_principal_id=? AND m.author_kind='owner' AND m.kind='text'
         AND m.body_text IS NOT NULL AND length(trim(m.body_text))>0 AND m.stored_visibility='visible'
         AND NOT EXISTS(SELECT 1 FROM messages t WHERE t.tombstones_message_id=m.id)
         AND NOT EXISTS(SELECT 1 FROM message_artifacts a WHERE a.message_id=m.id)
       ORDER BY m.channel_sequence ASC`, input.channelId, ...ids, input.principalId);
    if (rows.length !== ids.length || rows.some((row, index) => row.id !== ids[index] ||
        (index > 0 && row.sequence <= rows[index - 1]!.sequence))) throw new MessagingError("invalid_relation");
    return rows;
  }

  private async materialize(
    attachments: readonly AttachmentSummary[],
  ): Promise<readonly ResidentInputAttachment[]> {
    if (attachments.length === 0) return Object.freeze([]);
    if (!this.materializeAttachments) throw new MessagingError("invalid_relation");
    const materialized = await this.materializeAttachments(attachments);
    if (
      materialized.length !== attachments.length ||
      materialized.some((value, index) =>
        value.artifactId !== attachments[index]?.id ||
        value.name !== attachments[index]?.name ||
        value.contentType !== attachments[index]?.contentType ||
        value.byteCount !== attachments[index]?.byteCount ||
        value.sha256 !== attachments[index]?.sha256
      )
    ) {
      throw new MessagingError("invalid_relation");
    }
    return Object.freeze(materialized.map((value) => Object.freeze({ ...value })));
  }

  async resolveTarget(input: Parameters<DirectMessageContextPort["resolveTarget"]>[0]) {
    const binding = this.database.readOne<DirectBindingRow>(
      `SELECT h.id AS conversationId, b.id AS targetBotId, b.name AS targetBotDisplayName,
              b.principal_id AS targetPrincipalId, b.resident_binding AS residentBinding
       FROM channels c
       JOIN conversation_handles h ON h.channel_id = c.id
       JOIN channel_members owner ON owner.channel_id = c.id
         AND owner.principal_id = ? AND owner.active = 1
       JOIN channel_members member ON member.channel_id = c.id
         AND member.kind = 'bot' AND member.active = 1
       JOIN bots b ON b.principal_id = member.principal_id
       WHERE c.id = ? AND c.kind = 'direct' AND c.lifecycle = 'active'
         AND b.lifecycle = 'active' AND b.continuing_identity = 1 AND b.durable_mailbox = 1
         ${ROUTABLE_DIRECT_TARGET_SQL}`,
      input.context.principalId,
      input.channelId,
    );
    if (!binding) throw new MessagingError("unknown_channel");
    return Object.freeze({ channelId: input.channelId, ...binding });
  }

  async prepare(input: Parameters<DirectMessageContextPort["prepare"]>[0]) {
    const binding = this.database.readOne<DirectBindingRow>(
      `SELECT h.id AS conversationId, b.id AS targetBotId, b.name AS targetBotDisplayName,
              b.principal_id AS targetPrincipalId, b.resident_binding AS residentBinding
       FROM channels c
       JOIN conversation_handles h ON h.channel_id = c.id
       JOIN channel_members member ON member.channel_id = c.id AND member.kind = 'bot' AND member.active = 1
       JOIN bots b ON b.principal_id = member.principal_id
       WHERE c.id = ? AND c.kind = 'direct' AND c.lifecycle = 'active'
         AND b.lifecycle = 'active' AND b.continuing_identity = 1 AND b.durable_mailbox = 1
         ${ROUTABLE_DIRECT_TARGET_SQL}`,
      input.channelId,
    );
    if (!binding) throw new MessagingError("unknown_channel");
    const page = await this.messages.listMessages({ context: input.context, channelId: input.channelId, limit: 100 });
    const projectedOrigin = page.messages.find((message) => message.id === input.originMessage.id);
    if (
      !projectedOrigin || projectedOrigin.sequence !== input.originMessage.sequence ||
      projectedOrigin.text !== input.originMessage.text ||
      !exactAttachmentIDs(
        projectedOrigin.attachments.map((attachment) => attachment.id),
        input.attachmentIds,
      )
    ) {
      throw new MessagingError("invalid_relation");
    }
    const attachments = await this.materialize(projectedOrigin.attachments);
    const eventSequence = this.database.readOne<{ sequence: number }>(
      `SELECT sequence FROM events
       WHERE aggregate_kind = 'message' AND aggregate_id = ? AND type = 'message.appended'
       ORDER BY sequence ASC LIMIT 1`,
      input.originMessage.id,
    )?.sequence;
    if (eventSequence === undefined) throw new MessagingError("invalid_relation");
    const boundedMessages = page.messages.filter((message) => message.sequence <= input.originMessage.sequence);
    const boundedMessageIds = boundedMessages.map((message) => message.id);
    const placeholders = boundedMessageIds.map(() => "?").join(",");
    const tombstonedAfterSnapshot = this.database.readOne<{ count: number }>(
      `SELECT count(*) AS count FROM messages tombstone
       WHERE tombstone.channel_id = ? AND tombstone.tombstones_message_id IN (${placeholders})
         AND tombstone.channel_sequence > ?`,
      input.channelId,
      ...boundedMessageIds,
      input.originMessage.sequence,
    )?.count ?? 0;
    if (tombstonedAfterSnapshot !== 0) throw new MessagingError("invalid_relation");
    const transcript = boundedMessages.filter((message) => message.text !== null);
    if (input.instructionMessageIds !== undefined && !Array.isArray(input.instructionMessageIds)) {
      throw new MessagingError("invalid_relation");
    }
    const instructionMessageIds = input.instructionMessageIds === undefined
      ? undefined : Object.freeze([...input.instructionMessageIds]);
    if (instructionMessageIds !== undefined && (input.context.identity?.kind !== "owner" ||
        input.context.identity.auth.principalId !== input.context.principalId)) throw new MessagingError("identity_context_mismatch");
    const selected = instructionMessageIds === undefined ? undefined : this.instructionRows({
      ids: instructionMessageIds, principalId: input.context.principalId, channelId: input.channelId,
      originMessageId: input.originMessage.id, manifestIds: boundedMessageIds,
    });
    // A trusted speech partition may span multiple canonical owner rows. All other
    // requests remain historical context and never become instructions implicitly.
    const instruction = selected?.map(row => row.text).join("\n") ?? projectedOrigin.text ?? "";
    const historyBackfill: readonly DirectMessageHistoryEntry[] = Object.freeze(transcript
      .filter((message) => !(instructionMessageIds ?? [input.originMessage.id]).includes(message.id))
      .map((message) => Object.freeze({
        messageId: message.id,
        sequence: message.sequence,
        role: message.author.principalId === binding.targetPrincipalId
          ? "assistant" as const
          : "user" as const,
        text: message.text!,
        createdAt: message.createdAt,
      })));
    return Object.freeze({
      channelId: input.channelId,
      conversationId: binding.conversationId,
      targetBotId: binding.targetBotId,
      targetBotDisplayName: binding.targetBotDisplayName,
      targetPrincipalId: binding.targetPrincipalId,
      residentBinding: binding.residentBinding,
      instruction,
      ...(instructionMessageIds === undefined ? {} : { instructionMessageIds }),
      historyBackfill: binding.residentBinding.startsWith("bot-") ? historyBackfill : boundHistoricalContext(historyBackfill),
      attachments,
      manifest: directMessageManifest({
        channelId: input.channelId,
        messageIds: boundedMessageIds,
        attachmentIds: input.attachmentIds,
        channelSequence: input.originMessage.sequence,
        eventSequence,
        ...(instructionMessageIds === undefined ? {} : { instructionMessageIds }),
      }),
    });
  }

  async recover(work: WorkRecord) {
    if (
      !["queued", "leased", "running", "succeeded"].includes(work.state) ||
      !["resident_turn", "bot_turn", "resident_work_thread"].includes(work.kind) ||
      work.originMessageId === null || work.roundId !== null
    ) {
      throw new MessagingError("invalid_relation");
    }
    const binding = this.database.readOne<DirectBindingRow>(
      `SELECT h.id AS conversationId, b.id AS targetBotId, b.name AS targetBotDisplayName,
              b.principal_id AS targetPrincipalId, b.resident_binding AS residentBinding
       FROM channels c
       JOIN conversation_handles h ON h.channel_id = c.id
       JOIN channel_members member ON member.channel_id = c.id AND member.kind = 'bot' AND member.active = 1
       JOIN bots b ON b.principal_id = member.principal_id
       WHERE c.id = ? AND c.kind = 'direct' AND c.lifecycle = 'active'
         AND b.id = ? AND b.lifecycle = 'active' AND b.continuing_identity = 1
         AND b.durable_mailbox = 1
         ${ROUTABLE_DIRECT_TARGET_SQL}`,
      work.channelId,
      work.targetPrincipalId,
    );
    const expectedKind = binding && !binding.residentBinding.startsWith("bot-")
      ? "resident_turn"
      : "bot_turn";
    if (
      !binding || binding.targetPrincipalId !== work.targetPrincipalId ||
      (work.kind !== expectedKind && !(work.kind === "resident_work_thread" && expectedKind === "resident_turn"))
    ) {
      throw new MessagingError("unknown_channel");
    }
    const manifest = this.database.readOne<RecoveryManifestRow>(
      `SELECT message_refs_json AS messageRefsJson, artifact_refs_json AS artifactRefsJson,
              message_count AS messageCount, artifact_count AS artifactCount,
              channel_watermark AS channelWatermark, event_watermark AS eventWatermark,
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
      !Array.isArray(messageIds) || !messageIds.every((id) => typeof id === "string") ||
      !Array.isArray(artifactIds) || !artifactIds.every((id) => typeof id === "string") ||
      messageIds.length !== manifest.messageCount || artifactIds.length !== manifest.artifactCount ||
      !messageIds.includes(work.originMessageId) || messageIds.length === 0
    ) {
      throw new MessagingError("invalid_relation");
    }
    const placeholders = messageIds.map(() => "?").join(",");
    const rows = this.database.readAll<RecoveryMessageRow>(
      `SELECT m.id, m.channel_sequence AS sequence,
              m.author_principal_id AS authorPrincipalId,
              m.author_display_name AS authorDisplayName,
              CASE WHEN EXISTS (
                SELECT 1 FROM messages tombstone WHERE tombstone.tombstones_message_id = m.id
              ) THEN NULL ELSE m.body_text END AS text,
              m.created_at AS createdAt
       FROM messages m
       WHERE m.channel_id = ? AND m.id IN (${placeholders})
       ORDER BY m.channel_sequence ASC`,
      work.channelId,
      ...messageIds,
    );
    const originEventSequence = this.database.readOne<{ sequence: number }>(
      `SELECT sequence FROM events
       WHERE aggregate_kind = 'message' AND aggregate_id = ? AND type = 'message.appended'
       ORDER BY sequence ASC LIMIT 1`,
      work.originMessageId,
    )?.sequence;
    const tombstonedAfterSnapshot = this.database.readOne<{ count: number }>(
      `SELECT count(*) AS count FROM messages tombstone
       WHERE tombstone.channel_id = ? AND tombstone.tombstones_message_id IN (${placeholders})
         AND tombstone.channel_sequence > ?`,
      work.channelId,
      ...messageIds,
      manifest.channelWatermark,
    )?.count ?? 0;
    // Review descendants inherit a later, coordinator-saved context snapshot.
    // Bind it through canonical parent lineage; do not relax ordinary foreground recovery.
    let reviewSnapshot: { instruction: string; originalOwnerRequest?: string; instructionMessageIds?: readonly string[]; manifest: { messageIds: string[]; digests: { context: string; source: string }; watermarks: { channelSequence: number; eventSequence: number } }; channelId: string; targetPrincipalId: string } | undefined;
    if (this.database.readOne("SELECT name FROM sqlite_master WHERE type='table' AND name='resident_outcomes'")) {
      const saved = this.database.readOne<{ prepared: string }>(`
        WITH RECURSIVE lineage(id, depth) AS (
          SELECT ?, 0 UNION ALL
          SELECT p.parent_work_id, l.depth + 1 FROM lineage l
          JOIN work_planned_invocations p ON p.work_id = l.id
          JOIN works parent ON parent.id = p.parent_work_id
          WHERE l.depth < 64 AND parent.channel_id = ? AND parent.target_principal_id = ?
            AND parent.principal_id = ? AND parent.origin_message_id = ?
        ) SELECT o.prepared_json AS prepared FROM lineage l
          JOIN resident_outcomes o ON o.review_work_id = l.id
          WHERE o.prepared_json IS NOT NULL ORDER BY l.depth LIMIT 1`,
        work.id, work.channelId, work.targetPrincipalId, work.principalId, work.originMessageId);
      if (saved) {
        const value = JSON.parse(saved.prepared);
        if (value.channelId !== work.channelId || value.targetPrincipalId !== work.targetPrincipalId ||
            value.manifest?.digests?.context !== manifest.contextDigest ||
            value.manifest?.digests?.source !== manifest.sourceDigest ||
            value.manifest?.watermarks?.channelSequence !== manifest.channelWatermark ||
            value.manifest?.watermarks?.eventSequence !== manifest.eventWatermark ||
            typeof value.instruction !== 'string' ||
            (value.originalOwnerRequest !== undefined && typeof value.originalOwnerRequest !== 'string') ||
            !Array.isArray(value.manifest.messageIds) ||
            value.manifest.messageIds.length !== messageIds.length ||
            !value.manifest.messageIds.every((id: string) => messageIds.includes(id))) throw new MessagingError('invalid_relation');
        reviewSnapshot = value;
      }
    }
    let recordedInstructionMessageIds: readonly string[] | undefined;
    try { recordedInstructionMessageIds = readInheritedWorkInstructionMessageIds(this.database, work); }
    catch { throw new MessagingError("invalid_relation"); }
    const instructionMessageIds = reviewSnapshot?.instructionMessageIds ?? recordedInstructionMessageIds;
    const selected = instructionMessageIds === undefined ? undefined : this.instructionRows({
      ids: instructionMessageIds, principalId: work.principalId, channelId: work.channelId,
      originMessageId: work.originMessageId, manifestIds: messageIds,
    });
    const canonicalManifest = directMessageManifest({
      channelId: work.channelId,
      messageIds: reviewSnapshot ? reviewSnapshot.manifest.messageIds : rows.map((row) => row.id),
      attachmentIds: artifactIds,
      channelSequence: manifest.channelWatermark,
      eventSequence: manifest.eventWatermark,
      ...(instructionMessageIds === undefined ? {} : { instructionMessageIds }),
    });
    if (
      rows.length !== messageIds.length ||
      rows.some((row) => !messageIds.includes(row.id)) ||
      (!reviewSnapshot && rows.at(-1)?.id !== work.originMessageId) ||
      rows.at(-1)?.sequence !== manifest.channelWatermark ||
      (!reviewSnapshot && originEventSequence !== manifest.eventWatermark) ||
      tombstonedAfterSnapshot !== 0 ||
      canonicalManifest.digests.context !== manifest.contextDigest ||
      canonicalManifest.digests.source !== manifest.sourceDigest
    ) {
      throw new MessagingError("invalid_relation");
    }
    const attachmentRows = this.database.readAll<AttachmentSummary>(
      `SELECT artifact.id, artifact.original_name AS name,
              artifact.detected_content_type AS contentType,
              artifact.byte_count AS byteCount, artifact.sha256
       FROM message_artifacts link
       JOIN artifacts artifact ON artifact.id = link.artifact_id
       WHERE link.message_id = ? AND link.channel_id = ? AND artifact.state = 'ready'
       ORDER BY link.ordinal ASC`,
      work.originMessageId,
      work.channelId,
    );
    if (!exactAttachmentIDs(
      [...attachmentRows.map((attachment) => attachment.id)].sort(),
      [...artifactIds].sort(),
    )) {
      throw new MessagingError("invalid_relation");
    }
    const attachments = await this.materialize(attachmentRows);
    const transcript = rows.filter((message) => message.text !== null);
    const origin = rows.find(row => row.id === work.originMessageId)!;
    const instruction = reviewSnapshot?.instruction ?? selected?.map(row => row.text).join("\n") ?? origin.text ?? "";
    const historyBackfill: readonly DirectMessageHistoryEntry[] = Object.freeze(transcript
      .filter((message) => !(instructionMessageIds ?? [work.originMessageId]).includes(message.id))
      .map((message) => Object.freeze({
        messageId: message.id,
        sequence: message.sequence,
        role: message.authorPrincipalId === binding.targetPrincipalId
          ? "assistant" as const
          : "user" as const,
        text: message.text!,
        createdAt: message.createdAt,
      })));
    if (!instruction && attachments.length === 0) throw new MessagingError("invalid_relation");
    return Object.freeze({
      prepared: Object.freeze({
        channelId: work.channelId,
        conversationId: binding.conversationId,
        targetBotId: binding.targetBotId,
        targetBotDisplayName: binding.targetBotDisplayName,
        targetPrincipalId: binding.targetPrincipalId,
        residentBinding: binding.residentBinding,
        instruction,
        ...(reviewSnapshot?.originalOwnerRequest === undefined ? {} : { originalOwnerRequest: reviewSnapshot.originalOwnerRequest }),
        ...(instructionMessageIds === undefined ? {} : { instructionMessageIds }),
        historyBackfill: binding.residentBinding.startsWith("bot-") ? historyBackfill : boundHistoricalContext(historyBackfill),
        attachments,
        manifest: canonicalManifest,
      }),
      originMessageId: work.originMessageId,
    });
  }
}
