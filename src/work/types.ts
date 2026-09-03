/**
 * Async Work contract (Step 31).
 *
 * One durable record shape for delegated work — coding jobs, sub-agents, and
 * cron agent-turns. The record is the routing authority: originChatId is
 * always the ROOT human/channel conversation (never a `subagent:` chat), so
 * detached completion delivery can never strand a result in a hidden sub-chat.
 * Cron agent-turns use the isolated `cron-<jobId>` chat as origin.
 */
import { randomBytes } from 'node:crypto';
import type { MediaAttachment } from '../types.js';

export type AsyncWorkKind = 'coding' | 'subagent' | 'cron';

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
  | { type: 'subagent_chat'; chatId: string }
  | { type: 'cron_chat'; chatId: string };

export type ChatWorkHandle = Extract<WorkResultHandle, { chatId: string }>;

/**
 * Immutable canonical destination captured when a resident starts detached
 * work from a Connected Agents turn. The coordination process must re-check
 * every field against the parent Work before committing the child result.
 */
export interface CoordinationWorkDestination {
  kind: 'coordination';
  parentWorkId: string;
  channelId: string;
  conversationId: string;
  originMessageId: string;
  attemptId: string;
  leaseId: string;
  fencingToken: number;
  targetPrincipalId: string;
  residentBinding: string;
  residentInstanceId: string;
  authorityReference: string;
}

/** Lossless producer result; receiptText remains Inspector/history evidence. */
export interface AsyncWorkTerminalResult {
  receiptText: string;
  resultText: string | null;
  artifacts?: readonly MediaAttachment[];
}

export function isChatWorkHandle(handle: WorkResultHandle): handle is ChatWorkHandle {
  return handle.type === 'subagent_chat' || handle.type === 'cron_chat';
}

export interface AsyncWorkRecord {
  schema: 'home23.async-work.v1';
  workId: string;                 // aw_<base36 ts>_<4hex>
  kind: AsyncWorkKind;
  agent: string;                  // HOME23_AGENT owning this record
  originChatId: string;           // ROOT conversation (resolveRootChatId applied)
  originTurnId?: string;          // turn that launched the work, when known
  parentWorkId?: string;          // set when launched from inside another work item
  /** Present only for detached work returning to a canonical Connected Agents Message. */
  coordinationDestination?: CoordinationWorkDestination;
  /** Inline work returns through its parent tool call and must never be recovery-delivered. */
  deliveryMode?: 'detached' | 'inline';
  label: string;
  status: AsyncWorkStatus;
  startedAt: string;              // ISO
  updatedAt: string;              // ISO
  finishedAt?: string;            // ISO
  progressSummary?: string;
  resultHandle: WorkResultHandle;
  verification: VerificationStatus;
  /**
   * Exact terminal payload persisted before detached delivery is attempted.
   * Canonical coordination recovery must use this value; it must never
   * reconstruct visible chat text from a diagnostic receipt.
   */
  terminalResult?: AsyncWorkTerminalResult;
  /** Set once detached delivery lands, or atomically at inline terminal commit. */
  deliveredAt?: string;
  error?: string;
}

export function newWorkId(): string {
  return `aw_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`;
}

const SUBAGENT_CHAT_RE = /^subagent:(.*):(?:[0-9a-f]{4}|[0-9a-f]{32})$/;

/** Unwrap legacy detached and high-entropy joined subagent layers (bounded). */
export function resolveRootChatId(chatId: string): string {
  let current = chatId;
  for (let i = 0; i < 10; i++) {
    const m = SUBAGENT_CHAT_RE.exec(current);
    if (!m || m[1] === undefined) return current;
    current = m[1];
  }
  return current;
}

/** Origins a human actually reads: Telegram numeric chats and iOS/Mac app conversations. */
export function isHumanOrigin(chatId: string): boolean {
  return /^-?\d+$/.test(chatId) || chatId.startsWith('ios_') || chatId.startsWith('mac_');
}
