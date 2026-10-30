/**
 * Compact current view of active Work and unfinished commitments.
 * Uses existing WorkRegistry / relationship-ledger projections only.
 */

import type { RelationshipLedger } from './relationship-ledger.js';

export interface CompactWorkProjection {
  workId: string;
  label: string;
  status: string;
  executionState?: string;
  kind?: string;
  progressSummary?: string;
}

export interface CompactCommitmentProjection {
  id: string;
  type: string;
  title: string;
  statement: string;
  status?: string;
}

const MAX_WORK_LINES = 8;
const MAX_COMMITMENT_LINES = 8;
const LINE_BUDGET = 160;

function oneLine(value: string, budget = LINE_BUDGET): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, budget);
}

export function buildForegroundWorkView(input: {
  work?: readonly CompactWorkProjection[] | null;
  commitments?: readonly CompactCommitmentProjection[] | null;
}): string {
  const work = input.work ?? [];
  const commitments = (input.commitments ?? [])
    .filter((entry) => entry.type === 'promise' || entry.type === 'thread')
    .filter((entry) => entry.status === undefined || entry.status === 'active');

  const activeExecutions = work.filter(item => ['queued','leased','running','cancelling'].includes(item.executionState ?? item.status));
  const unresolved = work.filter(item => !activeExecutions.includes(item));
  const workLines = (items: CompactWorkProjection[]) => [
    `Showing ${Math.min(items.length, MAX_WORK_LINES)} of ${items.length} supplied records.`,
    ...(items.length === 0 ? ['- none in the supplied view'] : items.slice(0, MAX_WORK_LINES).map((item) => {
      const progress = item.progressSummary ? ` — ${oneLine(item.progressSummary, 80)}` : '';
      return `- ${item.workId} (${item.kind ?? 'work'} ${item.status}): ${oneLine(item.label)}${progress}`;
    })),
    ...(items.length > MAX_WORK_LINES
      ? [`- ${items.length - MAX_WORK_LINES} supplied records omitted from this preview; inspect work_list and work_status.`] : []),
  ];

  const commitmentLines = commitments.length === 0
    ? ['- none in the supplied view']
    : commitments.slice(0, MAX_COMMITMENT_LINES).map((item) => `- ${item.type}: ${oneLine(item.title)} — ${oneLine(item.statement, 100)}`);

  return [
    '[FOREGROUND — ACTIVE WORK AND COMMITMENTS]',
    'You are the same resident in this conversation. Background Work does not replace you or this thread.',
    `Bounded preview of ${work.length} supplied Work records; this is not a complete inventory. Use work_list with limit 100 and exact work_status for omitted or older Work.`,
    '',
    'Active executions:',
    ...workLines(activeExecutions),
    '',
    'Unresolved assignments:',
    ...workLines(unresolved),
    '',
    'Unfinished commitments:',
    `Showing ${Math.min(commitments.length, MAX_COMMITMENT_LINES)} of ${commitments.length} supplied commitments.`,
    ...commitmentLines,
    ...(commitments.length > MAX_COMMITMENT_LINES
      ? [`- ${commitments.length - MAX_COMMITMENT_LINES} supplied commitments omitted from this preview.`] : []),
    '[/FOREGROUND — ACTIVE WORK AND COMMITMENTS]',
  ].join('\n');
}

export function collectForegroundTurnContext(input: {
  chatId: string;
  workRegistry?: {
    list(filter: { originChatId?: string; active?: boolean; limit?: number }): CompactWorkProjection[];
  } | null;
  relationshipLedger?: Pick<RelationshipLedger, 'listEntries'> | null;
}): string {
  const work = input.workRegistry?.list({
    originChatId: input.chatId,
    active: true,
    limit: MAX_WORK_LINES,
  }) ?? [];
  const ledger = input.relationshipLedger;
  const commitments = ledger
    ? [
        ...ledger.listEntries({ type: 'promise', status: 'active' }),
        ...ledger.listEntries({ type: 'thread', status: 'active' }),
      ].filter((entry) => entry.privacy_class !== 'sensitive')
    : [];
  return `${buildForegroundWorkView({ work, commitments })}\nSource: bounded local async registry view, at most ${MAX_WORK_LINES} active Work records from this chat.`;
}

/** Current canonical assignments are available to app conversation and work
 * returns alike. A read failure is an omission, never a claim of no work. */
export interface CanonicalOwnerContact {
  messageId: string;
  text: string;
  channelId?: string;
  channelKind?: 'direct' | 'group';
  channelSequence?: number;
  sourceSequence?: number;
  previousAssistantMessageId?: string | null;
  createdAt?: string;
}

export async function collectCanonicalWorkContext(read: () => Promise<unknown>, onOwnerContact?: (contact: CanonicalOwnerContact) => void,
  relationshipLedger?: Pick<RelationshipLedger, 'listEntries'>): Promise<string> {
  try {
    const result = await read() as { registry?: string; work?: Array<Record<string, unknown>>; unseenOwnerMessages?: unknown[]; ownerMessageSequence?: number; ownerContact?: CanonicalOwnerContact | null };
    if (result?.registry !== 'canonical' || !Array.isArray(result.work)) throw new Error('Invalid canonical work view');
    if (result.ownerContact && typeof result.ownerContact.messageId === 'string' && typeof result.ownerContact.text === 'string') onOwnerContact?.(result.ownerContact);
    const rows = result.work.map(row => ({ workId: String(row.id), label: String(row.title ?? row.id),
      executionState: String(row.state),
      status: row.assignmentState ? `${row.assignmentState}; execution ${row.state}` : String(row.state), kind: typeof row.toolName === 'string' ? row.toolName : 'assignment',
      progressSummary: typeof (row.conclusion as { summary?: string } | null)?.summary === 'string' ? (row.conclusion as { summary: string }).summary : typeof row.summary === 'string' ? row.summary : undefined }));
    const correction = result.unseenOwnerMessages?.length
      ? `\n[OWNER DIRECTION CHANGED]\nThese canonical owner messages arrived after this turn's prepared context. Read them before deciding what to do. Before another launch, record work_report_outcome with owner_message_sequence=${result.ownerMessageSequence}: active only when continuation fits the new direction, blocked without a revisit for a pause, cancelled when stopped.\n${JSON.stringify(result.unseenOwnerMessages)}\n[/OWNER DIRECTION CHANGED]` : '';
    const commitments = relationshipLedger ? [...relationshipLedger.listEntries({ type: 'promise', status: 'active' }),
      ...relationshipLedger.listEntries({ type: 'thread', status: 'active' })].filter(entry => entry.privacy_class !== 'sensitive') : [];
    return `${buildForegroundWorkView({ work: rows, commitments })}\nSource: bounded current canonical assignment preview, selected from at most 1000 recent resident Work records and then limited by the request. Older records may be outside that lookback even when this view is empty. Descriptions state intent; execution state and heartbeats do not establish meaningful progress or completion.${correction}`;
  } catch {
    return '[CURRENT WORK UNAVAILABLE] The canonical assignment view could not be read. Do not infer that no work is active; inspect work_list before starting recovery.';
  }
}
