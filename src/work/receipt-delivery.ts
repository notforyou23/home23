/**
 * Receipt routing for terminal async work (supersedes src/acp/result-delivery.ts).
 *
 * Canonical Connected Agents work is deliberately different from legacy app
 * chats: no receipt is injected into its synthetic resident history. A narrow
 * callback receives an immutable, exact destination/result claim; the
 * coordination consumer re-authenticates the resident and validates it against
 * the parent canonical Work before it can append a Message.
 */
import type { MediaAttachment } from '../types.js';
import {
  TERMINAL_WORK_STATUSES,
  type AsyncWorkRecord,
  type AsyncWorkTerminalResult,
  type CoordinationWorkDestination,
} from './types.js';

export type WorkDeliveryRoute = 'none' | 'telegram' | 'ios' | 'coordination';

export interface CoordinationCompletionCommit {
  parentWorkId: string;
  childWorkId: string;
  childKind: 'subagent';
  childResultHandle: Extract<AsyncWorkRecord['resultHandle'], { type: 'subagent_chat' }>;
  status: AsyncWorkRecord['status'];
  finishedAt: string;
  channelId: string;
  conversationId: string;
  originMessageId: string;
  targetPrincipalId: string;
  residentBinding: string;
  residentInstanceId: string;
  authorityReference: string;
  terminalText: string | null;
  artifacts: readonly MediaAttachment[];
}

export interface ReceiptSinks {
  /** Append the full receipt/report to a legacy origin conversation. */
  appendHistory: (chatId: string, text: string) => void;
  /** Present only when a bot token is configured. */
  sendTelegram?: (chatId: string, text: string) => void;
  /** Present only when an APNs pusher is installed. Carries workId — no turnId exists here. */
  pushWork?: (input: { chatId: string; workId: string; status: string; body: string }) => void;
  /**
   * Installed by the resident coordination bridge. This callback is transport
   * only; the coordination consumer remains the sole canonical Message writer.
   */
  commitCoordinationCompletion?: (
    input: CoordinationCompletionCommit,
  ) => void | Promise<void>;
}

/** Concise lock-screen line — label + status only, never receipt content. */
export function workPushBody(work: AsyncWorkRecord): string {
  const label = work.label?.trim();
  if (work.status === 'completed') return label ? `Work finished: ${label}` : 'Work finished.';
  return label ? `Work ${work.status}: ${label}` : `Work ${work.status}.`;
}

function isNonempty(value: string): boolean {
  return value.length > 0 && !value.includes('\0');
}

function exactCoordinationDestination(
  work: AsyncWorkRecord,
): CoordinationWorkDestination | null {
  const destination = work.coordinationDestination;
  if (!destination || destination.kind !== 'coordination') return null;
  if (
    work.kind !== 'subagent' ||
    work.deliveryMode === 'inline' ||
    work.resultHandle.type !== 'subagent_chat' ||
    !TERMINAL_WORK_STATUSES.has(work.status) ||
    !work.finishedAt ||
    work.parentWorkId !== destination.parentWorkId ||
    work.originChatId !==
      `coordination:${destination.channelId}:${destination.parentWorkId}` ||
    work.agent !== destination.residentBinding ||
    destination.authorityReference !== `resident:${destination.residentBinding}` ||
    ![
      destination.parentWorkId,
      destination.channelId,
      destination.conversationId,
      destination.originMessageId,
      destination.targetPrincipalId,
      destination.residentBinding,
      destination.residentInstanceId,
    ].every(isNonempty)
  ) return null;
  return destination;
}

function terminalResult(
  result: string | AsyncWorkTerminalResult,
): AsyncWorkTerminalResult {
  return typeof result === 'string'
    ? { receiptText: result, resultText: result, artifacts: Object.freeze([]) }
    : result;
}

export function coordinationCompletionCommit(
  work: AsyncWorkRecord,
  result: string | AsyncWorkTerminalResult,
): CoordinationCompletionCommit | null {
  const destination = exactCoordinationDestination(work);
  if (!destination || work.resultHandle.type !== 'subagent_chat' || !work.finishedAt) {
    return null;
  }
  const terminal = terminalResult(result);
  const artifacts = Object.freeze((terminal.artifacts ?? []).map((artifact) =>
    Object.freeze({ ...artifact })));
  return Object.freeze({
    parentWorkId: destination.parentWorkId,
    childWorkId: work.workId,
    childKind: 'subagent',
    childResultHandle: Object.freeze({ ...work.resultHandle }),
    status: work.status,
    finishedAt: work.finishedAt,
    channelId: destination.channelId,
    conversationId: destination.conversationId,
    originMessageId: destination.originMessageId,
    targetPrincipalId: destination.targetPrincipalId,
    residentBinding: destination.residentBinding,
    residentInstanceId: destination.residentInstanceId,
    authorityReference: destination.authorityReference,
    terminalText: terminal.resultText,
    artifacts,
  });
}

export async function deliverWorkReceipt(
  work: AsyncWorkRecord,
  result: string | AsyncWorkTerminalResult,
  sinks: ReceiptSinks,
): Promise<WorkDeliveryRoute> {
  if (work.originChatId.startsWith('coordination:')) {
    const commit = coordinationCompletionCommit(work, result);
    if (!commit || !sinks.commitCoordinationCompletion) return 'none';
    await sinks.commitCoordinationCompletion(commit);
    return 'coordination';
  }

  const fullText = terminalResult(result).receiptText;
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
