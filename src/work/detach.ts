/**
 * Conversation vs Attempt identity.
 *
 * Long assignments must leave the conversational foreground before they
 * execute. The Attempt runs on a Work-scoped chat so `agent.isRunning` /
 * router `activeRuns` for the conversation chat stay clear.
 */
import { isHumanOrigin } from './types.js';

/** Chat a human is speaking in — Telegram, iOS, or Mac. */
export function isConversationForegroundChat(chatId: string): boolean {
  return isHumanOrigin(chatId);
}

/**
 * Already-detached execution chats. Waiting here does not occupy the
 * conversation run lock.
 */
export function isDetachedAttemptChat(chatId: string): boolean {
  return chatId.startsWith('coordination:')
    || chatId.startsWith('subagent:')
    || chatId.startsWith('workreview:')
    || chatId.startsWith('cron-');
}

/** True when a long tool/operation must return before it executes. */
export function mustDetachLongTool(chatId: string): boolean {
  return isConversationForegroundChat(chatId);
}

/** Jerry's own bounded Work branch — same resident, not a second identity. */
export function residentAttemptChatId(channelId: string, workId: string): string {
  return `coordination:${channelId}:${workId}`;
}

/** Scoped delegated hand under the parent Work. */
export function delegatedAttemptChatId(
  channelId: string,
  workId: string,
  suffix: string,
): string {
  return `subagent:coordination:${channelId}:${workId}:${suffix}`;
}

export function conversationRunLockHeld(
  conversationChatId: string,
  isRunning: (chatId: string) => boolean,
): boolean {
  return isRunning(conversationChatId);
}
