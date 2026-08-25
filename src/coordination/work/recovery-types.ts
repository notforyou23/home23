import type { TerminalReceiptInput } from "../leases/index.js";

import type { M11Database } from "./types.js";

export interface RecoveryIdentity {
  requestId: string;
  correlationId: string;
}

export interface UnknownSourceTruth {
  kind: "unknown" | "unverifiable";
  workId: string;
  attemptId: string;
}

export interface PositiveSourceTruth {
  kind: "not_started" | "running";
  workId: string;
  attemptId: string;
  leaseId: string;
  holderPrincipalId: string;
  holderInstanceId: string;
  authorityReference: string;
  fencingToken: number;
  evidenceDigest: string;
}

export interface TerminalSourceTruth extends Omit<PositiveSourceTruth, "kind"> {
  kind: "terminal";
  receipt: TerminalReceiptInput;
}

export type SourceTruth = UnknownSourceTruth | PositiveSourceTruth | TerminalSourceTruth;

export interface RecoverStartupInput extends RecoveryIdentity {
  truths: readonly SourceTruth[];
}

export interface RecoveryReceipt {
  staleOutboxClaimsReclaimed: number;
  terminalized: number;
  terminalReplays: number;
  requeued: number;
  reattached: number;
  rejectedTruth: number;
  ambiguous: number;
}

export interface CreateRecoveryServiceOptions {
  database: M11Database;
  generateId: (
    kind: "attempt" | "lease" | "workObservation" | "outbox" | "delivery"
  ) => string;
  now?: () => Date;
  leaseTtlMs: number;
  retryBaseMs: number;
}
