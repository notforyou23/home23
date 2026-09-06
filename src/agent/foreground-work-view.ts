/**
 * Compact current view of active Work and unfinished commitments.
 * Uses existing WorkRegistry / relationship-ledger projections only.
 */

import type { RelationshipLedger } from './relationship-ledger.js';

export interface CompactWorkProjection {
  workId: string;
  label: string;
  status: string;
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
  const work = (input.work ?? []).slice(0, MAX_WORK_LINES);
  const commitments = (input.commitments ?? [])
    .filter((entry) => entry.type === 'promise' || entry.type === 'thread')
    .filter((entry) => entry.status === undefined || entry.status === 'active')
    .slice(0, MAX_COMMITMENT_LINES);

  const workLines = work.length === 0
    ? ['- none']
    : work.map((item) => {
      const progress = item.progressSummary ? ` — ${oneLine(item.progressSummary, 80)}` : '';
      return `- ${item.workId} (${item.kind ?? 'work'} ${item.status}): ${oneLine(item.label)}${progress}`;
    });

  const commitmentLines = commitments.length === 0
    ? ['- none']
    : commitments.map((item) => `- ${item.type}: ${oneLine(item.title)} — ${oneLine(item.statement, 100)}`);

  return [
    '[FOREGROUND — ACTIVE WORK AND COMMITMENTS]',
    'You are the same resident in this conversation. Background Work does not replace you or this thread.',
    '',
    'Active Work:',
    ...workLines,
    '',
    'Unfinished commitments:',
    ...commitmentLines,
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
  return buildForegroundWorkView({ work, commitments });
}
