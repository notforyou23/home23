import { createHash } from 'node:crypto';
import type { TurnStore } from '../chat/turn-store.js';
import type { ResidentTerminalReceipt } from './types.js';

export type ResidentRecoveryTruth =
  | { kind: 'unknown'; workId: string; attemptId: string }
  | {
      kind: 'terminal';
      workId: string;
      attemptId: string;
      leaseId: string;
      holderPrincipalId: string;
      holderInstanceId: string;
      authorityReference: string;
      fencingToken: number;
      evidenceDigest: string;
      receipt: ResidentTerminalReceipt;
    };

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Reconstruct only evidence durable in the resident turn journal after restart. */
export function residentRecoveryTruth(
  store: Pick<TurnStore, 'startEnvelope' | 'finalEnvelope'>,
  chatId: string,
  turnId: string,
): ResidentRecoveryTruth | null {
  const start = store.startEnvelope(chatId, turnId);
  const origin = start?.coordination_origin;
  if (!origin) return null;
  const final = store.finalEnvelope(chatId, turnId);
  if (!final || final.status !== 'complete' || typeof final.assistant_content !== 'string') {
    return Object.freeze({ kind: 'unknown', workId: origin.workId, attemptId: origin.attemptId });
  }
  const receipt: ResidentTerminalReceipt = Object.freeze({
    status: 'succeeded',
    sourceReference: origin.authorityReference,
    resultDigest: digest(final.assistant_content),
    artifactIds: Object.freeze([]),
    timestamp: final.ended_at!,
  });
  return Object.freeze({
    kind: 'terminal',
    workId: origin.workId,
    attemptId: origin.attemptId,
    leaseId: origin.leaseId,
    holderPrincipalId: origin.holderPrincipalId,
    holderInstanceId: origin.holderInstanceId,
    authorityReference: origin.authorityReference,
    fencingToken: origin.fencingToken,
    evidenceDigest: digest(JSON.stringify({ turnId, receipt })),
    receipt,
  });
}
