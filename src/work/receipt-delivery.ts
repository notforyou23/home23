/**
 * Receipt routing for terminal async work (supersedes src/acp/result-delivery.ts).
 *
 * Routes on the record's ROOT origin conversation:
 *   numeric       → Telegram (full text)
 *   ios_ / mac_   → APNs async_work push (concise line; chatId + workId, never a turnId)
 *   anything else → history only
 * The full receipt text always lands in the origin conversation's history.
 * Branches are mutually exclusive — at most one push per work item. Missing
 * sinks degrade to history-only; nothing here throws.
 */
import type { AsyncWorkRecord } from './types.js';

export type WorkDeliveryRoute = 'none' | 'telegram' | 'ios';

export interface ReceiptSinks {
  /** Append the full receipt/report to the origin conversation. Always called. */
  appendHistory: (chatId: string, text: string) => void;
  /** Present only when a bot token is configured. */
  sendTelegram?: (chatId: string, text: string) => void;
  /** Present only when an APNs pusher is installed. Carries workId — no turnId exists here. */
  pushWork?: (input: { chatId: string; workId: string; status: string; body: string }) => void;
}

/** Concise lock-screen line — label + status only, never receipt content. */
export function workPushBody(work: AsyncWorkRecord): string {
  const label = work.label?.trim();
  if (work.status === 'completed') return label ? `Work finished: ${label}` : 'Work finished.';
  return label ? `Work ${work.status}: ${label}` : `Work ${work.status}.`;
}

export function deliverWorkReceipt(
  work: AsyncWorkRecord,
  fullText: string,
  sinks: ReceiptSinks,
): WorkDeliveryRoute {
  sinks.appendHistory(work.originChatId, fullText);

  if (/^-?\d+$/.test(work.originChatId)) {
    if (sinks.sendTelegram) {
      sinks.sendTelegram(work.originChatId, fullText.slice(0, 4096));
      return 'telegram';
    }
    return 'none';
  }

  if (work.originChatId.startsWith('ios_') || work.originChatId.startsWith('mac_')) {
    if (sinks.pushWork) {
      sinks.pushWork({ chatId: work.originChatId, workId: work.workId, status: work.status, body: workPushBody(work) });
      return 'ios';
    }
    return 'none';
  }

  return 'none';
}
