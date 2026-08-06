/**
 * Coding-job result delivery routing (Step 29 follow-up).
 *
 * A finished coding job is detached from any live agent turn, so the
 * job_finished listener is the ONLY place its result reaches the human. This
 * module is the pure routing decision, split out from the home.ts wiring so it
 * is deterministically testable.
 *
 * Routing is on the job's real origin conversation id (job.requestedBy — the
 * chatId captured at coding_start), never on the agent's injected identity:
 *   - numeric chatId  → Telegram (existing behavior, preserved verbatim)
 *   - ios_* chatId    → iOS app via APNs (concise lock-screen line + routing
 *                       metadata so the app can open the conversation)
 *   - anything else   → history only
 *
 * The branches are mutually exclusive, so a job produces at most one push (no
 * duplicate notification). Every path still appends the full result to history.
 * The lock-screen body is a concise status line — the full result tail stays in
 * history / coding_result and is never placed on the lock screen.
 */

import type { CodingJobRecord, CodingJobReceipt } from './types.js';

export type CodingDeliveryRoute = 'none' | 'telegram' | 'ios';

export interface CodingResultSinks {
  /** Append the full result to the origin conversation's history. Always called (when there is an origin). */
  appendHistory: (chatId: string, text: string) => void;
  /** Send a Telegram message. Present only when a bot token is configured. */
  sendTelegram?: (chatId: string, text: string) => void;
  /** Fire an iOS push. Present only when an APNs pusher is installed. */
  pushIos?: (input: { chatId: string; turnId: string; body: string }) => void;
}

/** The full history/Telegram body — full result tail, for the in-app transcript. */
export function codingHistoryText(job: CodingJobRecord, receipt: CodingJobReceipt): string {
  const headline = job.label || job.prompt.slice(0, 100);
  return `[Coding job ${job.status}] ${headline}\n\n${receipt.resultTail.slice(0, 1500)}\n(job ${job.id}; coding_result for full output)`;
}

/** The concise lock-screen body — status + label only, never the result tail. */
export function codingPushBody(job: CodingJobRecord): string {
  const label = job.label?.trim();
  if (job.status === 'completed') {
    return label ? `Coding job finished: ${label}` : 'Coding job finished.';
  }
  return label ? `Coding job ${job.status}: ${label}` : `Coding job ${job.status}.`;
}

/**
 * Route a finished coding job's result to the correct channel(s) and report
 * which push channel (if any) fired. Never throws for a missing sink — an
 * unconfigured/absent channel degrades to history-only.
 */
export function deliverCodingJobResult(
  job: CodingJobRecord,
  receipt: CodingJobReceipt,
  sinks: CodingResultSinks,
): CodingDeliveryRoute {
  const requestedBy = job.requestedBy ?? '';
  if (!requestedBy) return 'none';

  sinks.appendHistory(requestedBy, codingHistoryText(job, receipt));

  if (/^-?\d+$/.test(requestedBy)) {
    if (sinks.sendTelegram) {
      sinks.sendTelegram(requestedBy, codingHistoryText(job, receipt).slice(0, 4096));
      return 'telegram';
    }
    return 'none';
  }

  if (requestedBy.startsWith('ios_')) {
    if (sinks.pushIos) {
      sinks.pushIos({ chatId: requestedBy, turnId: job.id, body: codingPushBody(job) });
      return 'ios';
    }
    return 'none';
  }

  return 'none';
}
