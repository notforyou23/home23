import { assertCoordinationId } from "../ids/index.js";
import { MessagingError } from "./errors.js";
import type {
  BotConversationBindingResult,
  BotConversationBindingTransactionPort,
} from "./types.js";

interface StoredBotBinding {
  id: string;
  principalId: string;
  residentBinding: string;
  lifecycle: string;
  conversationId: string | null;
  continuingIdentity: number;
  durableMailbox: number;
  version: number;
}

export class SqliteBotConversationBindingAdapter
implements BotConversationBindingTransactionPort {
  bindDirectConversation(
    transaction: Parameters<
      BotConversationBindingTransactionPort["bindDirectConversation"]
    >[0],
    input: Parameters<
      BotConversationBindingTransactionPort["bindDirectConversation"]
    >[1],
  ): BotConversationBindingResult {
    try {
      assertCoordinationId("bot", input.botId);
      assertCoordinationId("principal", input.botPrincipalId);
      assertCoordinationId("channel", input.channelId);
      assertCoordinationId("conversation", input.conversationId);
      assertCoordinationId("principal", input.actorPrincipalId);
      assertCoordinationId("request", input.requestId);
      assertCoordinationId("correlation", input.correlationId);
    } catch {
      throw new MessagingError("request_invalid");
    }
    const timestamp = new Date(input.updatedAt);
    if (
      input.botId !== input.botPrincipalId ||
      input.actorPrincipalId !== "user_owner" ||
      typeof input.residentBinding !== "string" ||
      input.residentBinding.length < 1 ||
      input.residentBinding.length > 63 ||
      !Number.isSafeInteger(input.expectedBotVersion) ||
      input.expectedBotVersion < 1 ||
      Number.isNaN(timestamp.valueOf()) ||
      timestamp.toISOString() !== input.updatedAt
    ) {
      throw new MessagingError("request_invalid");
    }

    const handle = transaction.readOne<{ channelId: string }>(
      "SELECT channel_id AS channelId FROM conversation_handles WHERE id = ?",
      input.conversationId,
    );
    const bot = transaction.readOne<StoredBotBinding>(
      `SELECT id, principal_id AS principalId, resident_binding AS residentBinding,
              lifecycle, conversation_id AS conversationId,
              continuing_identity AS continuingIdentity,
              durable_mailbox AS durableMailbox, version
       FROM bots WHERE id = ?`,
      input.botId,
    );
    if (
      handle?.channelId !== input.channelId ||
      !bot ||
      bot.id !== input.botId ||
      bot.principalId !== input.botPrincipalId ||
      bot.residentBinding !== input.residentBinding ||
      bot.lifecycle !== "active" ||
      bot.conversationId !== null ||
      bot.continuingIdentity !== 1 ||
      bot.durableMailbox !== 1 ||
      bot.version !== input.expectedBotVersion
    ) {
      throw new MessagingError("storage_conflict");
    }

    const botVersion = input.expectedBotVersion + 1;
    const updated = transaction.run(
      `UPDATE bots SET conversation_id = ?, version = ?, updated_at = ?
       WHERE id = ? AND principal_id = ? AND resident_binding = ?
         AND lifecycle = 'active' AND conversation_id IS NULL
         AND continuing_identity = 1 AND durable_mailbox = 1 AND version = ?`,
      input.conversationId,
      botVersion,
      input.updatedAt,
      input.botId,
      input.botPrincipalId,
      input.residentBinding,
      input.expectedBotVersion,
    );
    if (updated.changes !== 1) throw new MessagingError("storage_conflict");

    return Object.freeze({
      botId: input.botId,
      botVersion,
      event: Object.freeze({
        type: "bot.updated",
        aggregateKind: "bot",
        aggregateId: input.botId,
        aggregateVersion: botVersion,
        channelId: input.channelId,
        actorPrincipalId: input.actorPrincipalId,
        requestId: input.requestId,
        correlationId: input.correlationId,
        payload: Object.freeze({
          botId: input.botId,
          botVersion,
          channelId: input.channelId,
          conversationId: input.conversationId,
          change: "direct_conversation_bound",
        }),
        createdAt: input.updatedAt,
      }),
    });
  }
}
