import type { MessagingActorContext } from "../channels/index.js";
import { MessagingError } from "../channels/index.js";
import type { M11Database } from "../work/index.js";
import { directMessageManifest, type DirectMessageContextPort } from "./direct-message.js";

interface DirectBindingRow {
  conversationId: string;
  targetBotId: string;
  targetPrincipalId: string;
  residentBinding: string;
}

/** Read-only M04/M07 context assembler; it never reads resident-private state. */
export class SqliteDirectMessageContext implements DirectMessageContextPort {
  constructor(
    private readonly database: M11Database,
    private readonly messages: { listMessages(input: {
      context: MessagingActorContext; channelId: string; limit: number;
    }): Promise<{ messages: readonly { id: string; sequence: number; text: string | null; author: { displayName: string } }[] }> },
  ) {}

  async prepare(input: Parameters<DirectMessageContextPort["prepare"]>[0]) {
    const binding = this.database.readOne<DirectBindingRow>(
      `SELECT h.id AS conversationId, b.id AS targetBotId,
              b.principal_id AS targetPrincipalId, b.resident_binding AS residentBinding
       FROM channels c
       JOIN conversation_handles h ON h.channel_id = c.id
       JOIN channel_members member ON member.channel_id = c.id AND member.kind = 'bot' AND member.active = 1
       JOIN bots b ON b.principal_id = member.principal_id
       WHERE c.id = ? AND c.kind = 'direct' AND c.lifecycle = 'active'
         AND b.lifecycle = 'active' AND b.continuing_identity = 1 AND b.durable_mailbox = 1
         AND b.resident_protocol_version = 1
         AND EXISTS (SELECT 1 FROM json_each(b.resident_capabilities_json) WHERE value = 'messages')`,
      input.channelId,
    );
    if (!binding) throw new MessagingError("unknown_channel");
    const page = await this.messages.listMessages({ context: input.context, channelId: input.channelId, limit: 100 });
    if (!page.messages.some((message) => message.id === input.originMessage.id)) {
      throw new MessagingError("invalid_relation");
    }
    const eventSequence = this.database.readOne<{ sequence: number }>(
      `SELECT sequence FROM events
       WHERE aggregate_kind = 'message' AND aggregate_id = ? AND type = 'message.appended'
       ORDER BY sequence ASC LIMIT 1`,
      input.originMessage.id,
    )?.sequence;
    if (eventSequence === undefined) throw new MessagingError("invalid_relation");
    const boundedMessages = page.messages.filter((message) => message.sequence <= input.originMessage.sequence);
    const transcript = boundedMessages
      .filter((message) => message.text !== null)
      .map((message) => `${message.author.displayName}: ${message.text}`)
      .join("\n");
    return Object.freeze({
      channelId: input.channelId,
      conversationId: binding.conversationId,
      targetBotId: binding.targetBotId,
      targetPrincipalId: binding.targetPrincipalId,
      residentBinding: binding.residentBinding,
      instruction: transcript,
      manifest: directMessageManifest({
        channelId: input.channelId,
        messageIds: boundedMessages.map((message) => message.id),
        attachmentIds: input.attachmentIds,
        channelSequence: input.originMessage.sequence,
        eventSequence,
      }),
    });
  }
}
