import type { MessagingActorContext } from "../channels/index.js";
import { MessagingError } from "../channels/index.js";
import type { AttachmentSummary } from "../artifacts/index.js";
import type { ResidentInputAttachment } from "../../coordination-adapter/index.js";
import type { M11Database } from "../work/index.js";
import type { WorkRecord } from "../work/index.js";
import { directMessageManifest, type DirectMessageContextPort } from "./direct-message.js";

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
  authorDisplayName: string;
  text: string | null;
}

type AttachmentMaterializer = (
  attachments: readonly AttachmentSummary[],
) => Promise<readonly ResidentInputAttachment[]>;

// Jerry and Forrest are permanent UDS residents. Every other lifecycle-created
// Bot is deliberately processless and is eligible for Core-owned on-demand
// execution only while its canonical mailbox identity remains active.
const ROUTABLE_DIRECT_TARGET_SQL = `
  AND (
    (
      b.resident_binding IN ('jerry', 'forrest')
      AND b.resident_protocol_version = 1
      AND EXISTS (
        SELECT 1 FROM json_each(b.resident_capabilities_json) WHERE value = 'messages'
      )
    ) OR (
      b.resident_binding NOT IN ('jerry', 'forrest')
      AND b.resident_binding LIKE 'bot-%'
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
      author: { displayName: string };
      attachments: readonly AttachmentSummary[];
    }[] }> },
    private readonly materializeAttachments?: AttachmentMaterializer,
  ) {}

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
    const transcript = boundedMessages
      .filter((message) => message.text !== null)
      .map((message) => `${message.author.displayName}: ${message.text}`)
      .join("\n");
    return Object.freeze({
      channelId: input.channelId,
      conversationId: binding.conversationId,
      targetBotId: binding.targetBotId,
      targetBotDisplayName: binding.targetBotDisplayName,
      targetPrincipalId: binding.targetPrincipalId,
      residentBinding: binding.residentBinding,
      instruction: transcript,
      attachments,
      manifest: directMessageManifest({
        channelId: input.channelId,
        messageIds: boundedMessageIds,
        attachmentIds: input.attachmentIds,
        channelSequence: input.originMessage.sequence,
        eventSequence,
      }),
    });
  }

  async recover(work: WorkRecord) {
    if (
      !["queued", "leased", "running", "succeeded"].includes(work.state) ||
      !["resident_turn", "bot_turn"].includes(work.kind) ||
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
    const expectedKind = binding?.residentBinding === "jerry" || binding?.residentBinding === "forrest"
      ? "resident_turn"
      : "bot_turn";
    if (
      !binding || binding.targetPrincipalId !== work.targetPrincipalId ||
      work.kind !== expectedKind
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
              m.author_display_name AS authorDisplayName,
              CASE WHEN EXISTS (
                SELECT 1 FROM messages tombstone WHERE tombstone.tombstones_message_id = m.id
              ) THEN NULL ELSE m.body_text END AS text
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
      originEventSequence !== manifest.eventWatermark ||
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
    const instruction = rows
      .filter((message) => message.text !== null)
      .map((message) => `${message.authorDisplayName}: ${message.text}`)
      .join("\n");
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
        attachments,
        manifest: canonicalManifest,
      }),
      originMessageId: work.originMessageId,
    });
  }
}
