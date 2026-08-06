/**
 * Async Work contract (Step 31).
 *
 * One durable record shape for detached work — coding jobs and sub-agents in
 * this first slice. The record is the routing authority: originChatId is
 * always the ROOT human/channel conversation (never a `subagent:` chat), so
 * completion delivery can never strand a result in a hidden sub-chat.
 */
import { randomBytes } from 'node:crypto';

export type AsyncWorkKind = 'coding' | 'subagent';

export type AsyncWorkStatus =
  | 'queued' | 'running' | 'blocked'
  | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export const TERMINAL_WORK_STATUSES: ReadonlySet<AsyncWorkStatus> =
  new Set(['completed', 'failed', 'cancelled', 'interrupted']);

/**
 * Honest values only (anti-theater): the harness can attest that a review
 * happened, not that the work is "correct". 'reviewed' means the review turn
 * ran and its report was delivered; 'skipped' means review was configured but
 * could not run (busy origin, review turn error); 'none' means review was not
 * applicable (failures, review disabled for the kind, non-human origin).
 */
export type VerificationStatus = 'none' | 'pending' | 'reviewed' | 'skipped';

export type WorkResultHandle =
  | { type: 'coding_job'; jobId: string }
  | { type: 'subagent_chat'; chatId: string };

export interface AsyncWorkRecord {
  schema: 'home23.async-work.v1';
  workId: string;                 // aw_<base36 ts>_<4hex>
  kind: AsyncWorkKind;
  agent: string;                  // HOME23_AGENT owning this record
  originChatId: string;           // ROOT conversation (resolveRootChatId applied)
  originTurnId?: string;          // turn that launched the work, when known
  parentWorkId?: string;          // set when launched from inside another work item
  label: string;
  status: AsyncWorkStatus;
  startedAt: string;              // ISO
  updatedAt: string;              // ISO
  finishedAt?: string;            // ISO
  progressSummary?: string;
  resultHandle: WorkResultHandle;
  verification: VerificationStatus;
  /** Set once the receipt/report reached the origin conversation. Recovery re-delivers when absent. */
  deliveredAt?: string;
  error?: string;
}

export function newWorkId(): string {
  return `aw_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`;
}

const SUBAGENT_CHAT_RE = /^subagent:(.*):[0-9a-f]{4}$/;

/** Unwrap `subagent:<parent>:<hex>` layers (bounded) to the root conversation id. */
export function resolveRootChatId(chatId: string): string {
  let current = chatId;
  for (let i = 0; i < 10; i++) {
    const m = SUBAGENT_CHAT_RE.exec(current);
    if (!m) return current;
    current = m[1];
  }
  return current;
}

/** Origins a human actually reads: Telegram numeric chats and iOS/Mac app conversations. */
export function isHumanOrigin(chatId: string): boolean {
  return /^-?\d+$/.test(chatId) || chatId.startsWith('ios_') || chatId.startsWith('mac_');
}
