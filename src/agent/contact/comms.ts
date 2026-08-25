import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectResidentWrite } from '../tools/tracked-source-guard.js';
import { commsDraftDir } from './paths.js';

export type CommsChannel = 'telegram' | 'email' | 'imessage' | 'discord' | 'x';

export interface CommsDraft {
  id: string;
  createdAt: string;
  channel: CommsChannel;
  to: string;
  subject?: string;
  body: string;
  attachments?: string[];
  sensitiveFlags: string[];
}

const SENDABLE = new Set<CommsChannel>(['telegram']);

function flagsFor(body: string, to: string): string[] {
  const flags: string[] = [];
  if (/\b(ssn|password|wire|routing number|medical)\b/i.test(body)) flags.push('sensitive_claim');
  if (/\bhttps?:\/\//i.test(body) === false && /\b(see attached|attachment|link)\b/i.test(body)) {
    flags.push('possible_missing_attachment_or_link');
  }
  if (!to.trim()) flags.push('missing_recipient');
  return flags;
}

export function createDraft(input: {
  workspacePath: string;
  projectRoot: string;
  channel: CommsChannel;
  to: string;
  body: string;
  subject?: string;
  attachments?: string[];
}): CommsDraft {
  const draft: CommsDraft = {
    id: `draft_${randomUUID().slice(0, 10)}`,
    createdAt: new Date().toISOString(),
    channel: input.channel,
    to: input.to.trim(),
    subject: input.subject,
    body: input.body,
    attachments: input.attachments,
    sensitiveFlags: flagsFor(input.body, input.to),
  };
  const dir = commsDraftDir(input.workspacePath);
  const filePath = join(dir, `${draft.id}.json`);
  const decision = inspectResidentWrite(filePath, input.projectRoot);
  if (!decision.allow) throw new Error(decision.reason);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(draft, null, 2), 'utf8');
  return draft;
}

export function loadDraft(workspacePath: string, draftId: string): CommsDraft {
  const filePath = join(commsDraftDir(workspacePath), `${draftId}.json`);
  if (!existsSync(filePath)) throw new Error(`draft not found: ${draftId}`);
  return JSON.parse(readFileSync(filePath, 'utf8')) as CommsDraft;
}

export function previewDraft(draft: CommsDraft): string {
  return [
    `channel: ${draft.channel}`,
    `to: ${draft.to}`,
    draft.subject ? `subject: ${draft.subject}` : null,
    draft.attachments?.length ? `attachments: ${draft.attachments.join(', ')}` : null,
    draft.sensitiveFlags.length ? `flags: ${draft.sensitiveFlags.join(', ')}` : 'flags: none',
    '---',
    draft.body,
  ].filter(Boolean).join('\n');
}

export function assertSendable(draft: CommsDraft, confirm: boolean): void {
  if (!confirm) throw new Error('comms_send requires confirm=true after preview');
  if (!SENDABLE.has(draft.channel)) {
    throw new Error(`channel ${draft.channel} is preview-only; telegram is the only sendable channel right now`);
  }
  if (!draft.to) throw new Error('draft has no recipient');
}
