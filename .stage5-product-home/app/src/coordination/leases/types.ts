import type { M11Database, WorkRecord } from "../work/types.js";

export type AttemptState =
  | "created"
  | "offered"
  | "accepted"
  | "running"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "rejected"
  | "abandoned";

export type LeaseState = "offered" | "active" | "released" | "expired" | "revoked";

export interface AttemptRecord {
  id: string;
  workId: string;
  ordinal: number;
  holderPrincipalId: string;
  holderInstanceId: string;
  authorityReference: string;
  state: AttemptState;
  fencingToken: number;
  rejectedEvidenceCount: number;
  version: number;
  offeredAt: string;
  acceptedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
}

export interface LeaseRecord {
  id: string;
  workId: string;
  attemptId: string;
  holderPrincipalId: string;
  holderInstanceId: string;
  fencingToken: number;
  state: LeaseState;
  issuedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  endedAt: string | null;
  reasonCode: string | null;
  version: number;
}

export interface LeaseBindingInput {
  workId: string;
  attemptId: string;
  leaseId: string;
  holderPrincipalId: string;
  holderInstanceId: string;
  fencingToken: number;
  requestId: string;
  correlationId: string;
}

export interface OfferLeaseInput {
  workId: string;
  holderPrincipalId: string;
  holderInstanceId: string;
  authorityReference: string;
  automatic: boolean;
  requestId: string;
  correlationId: string;
}

export interface ReasonedLeaseBindingInput extends LeaseBindingInput {
  reasonCode: string;
}

export interface HeartbeatLeaseInput extends LeaseBindingInput {
  extendMs: number;
}

export interface TerminalReceiptInput {
  status: "succeeded" | "failed" | "cancelled";
  sourceReference: string;
  resultDigest: string | null;
  artifactIds: readonly string[];
  timestamp: string;
}

export interface TerminalizeInput extends LeaseBindingInput {
  receipt: TerminalReceiptInput;
}

export interface TerminalReceiptRecord {
  workId: string;
  attemptId: string;
  fencingToken: number;
  status: "succeeded" | "failed" | "cancelled";
  sourceReference: string;
  resultDigest: string | null;
  artifactIds: readonly string[];
  receiptDigest: string;
  createdAt: string;
}

export interface LeaseMutationResult {
  work: WorkRecord;
  attempt: AttemptRecord;
  lease: LeaseRecord;
}

export interface CompletedLeaseMutationResult extends LeaseMutationResult {
  receipt: TerminalReceiptRecord;
}

export interface OfferLeaseResult extends LeaseMutationResult {
  fencingToken: number;
}

export interface TerminalizeResult extends LeaseMutationResult {
  receipt: TerminalReceiptRecord;
  terminalOutboxId: string;
  replayed: boolean;
}

export type LeaseGeneratedIdKind =
  | "attempt"
  | "lease"
  | "workObservation"
  | "outbox"
  | "delivery";

export interface CreateLeaseServiceOptions {
  database: M11Database;
  generateId: (kind: LeaseGeneratedIdKind) => string;
  now?: () => Date;
  leaseTtlMs: number;
}
