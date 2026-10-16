import type { EventReadDatabase } from "../events/types.js";

/** Owner attention follows the native Inbox: active groups and active,
 * durable Bot mailboxes bound to that exact direct conversation. Membership
 * authorization remains the caller's responsibility. History is not deleted. */
export function ownerAttentionChannelPredicate(): string {
  return `(c.lifecycle = 'active' AND (
    c.kind = 'group' OR (c.kind = 'direct' AND EXISTS (
      SELECT 1 FROM bots attention_bot
      JOIN channel_members bot_member
        ON bot_member.channel_id = c.id
       AND bot_member.principal_id = attention_bot.principal_id
       AND bot_member.active = 1
      WHERE attention_bot.conversation_id = h.id
        AND attention_bot.lifecycle = 'active'
        AND attention_bot.continuing_identity = 1
        AND attention_bot.durable_mailbox = 1
    ))
  ))`;
}

/** Internal empty turn origins remain canonical evidence, not inbox messages.
 * Keep attachment-only and tombstone messages visible, including old schemas
 * that predate the attachment table. Aliases c/h/m are owned SQL, never input. */
export function ownerAttentionMessagePredicate(reader: EventReadDatabase): string {
  const hasArtifacts = reader.readAll<{ present: number }>(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'message_artifacts'",
  )[0]?.present === 1;
  const noAttachments = hasArtifacts
    ? "NOT EXISTS (SELECT 1 FROM message_artifacts link WHERE link.message_id = m.id)"
    : "1";
  return `NOT (m.author_kind = 'bot' AND m.kind = 'system'
    AND m.body_text IS NULL AND m.tombstones_message_id IS NULL AND ${noAttachments})`;
}
