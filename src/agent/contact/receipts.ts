import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ContactReceipt } from './types.js';
import { contactReceiptPath } from './paths.js';

export function newReceiptId(): string {
  return `cr_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function writeContactReceipt(workspacePath: string, receipt: ContactReceipt): ContactReceipt {
  const filePath = contactReceiptPath(workspacePath);
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(receipt)}\n`, 'utf8');
  return receipt;
}

export function buildReceipt(
  partial: Omit<ContactReceipt, 'schema' | 'id' | 'ts'> & { id?: string; ts?: string },
): ContactReceipt {
  return {
    schema: 'home23.contact-receipt.v1',
    id: partial.id ?? newReceiptId(),
    ts: partial.ts ?? new Date().toISOString(),
    agent: partial.agent,
    chatId: partial.chatId,
    capability: partial.capability,
    sideEffect: partial.sideEffect,
    authority: partial.authority,
    dryRun: partial.dryRun,
    confirmed: partial.confirmed,
    ok: partial.ok,
    summary: partial.summary,
    before: partial.before,
    after: partial.after,
    verified: partial.verified,
    error: partial.error,
    metadata: partial.metadata,
  };
}
