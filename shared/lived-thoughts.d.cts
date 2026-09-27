import type { FeedbackClaim } from './prediction-feedback.cjs';
export interface ReceiptedThought {
  cellId: string;
  kind: 'prediction' | 'estimate' | 'reflection' | 'observation';
  text: string;
  candidate: FeedbackClaim;
  seq?: number;
  asOf?: string;
}
export function thoughtsFromReceipt(record: { category: string; payload: Record<string, unknown>; seq?: number; issuedAt?: string }): ReceiptedThought[];
