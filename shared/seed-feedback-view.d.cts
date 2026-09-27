export function projectFeedbackState<T extends { cells: Array<{ id: string }>; ledgerSeq: number }>(
  checkpoint: T,
  tail: Array<{ seq: number; category: string; issuedAt?: string; payload: Record<string, unknown> }>,
): T & { feedbackView: { complete: boolean; checkpointSeq: number; throughSeq: number } };
