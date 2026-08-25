import type { M11Database } from "../work/types.js";

export type OutboxState = "pending" | "claimed" | "retry" | "delivered" | "dead_letter";
export type DeliveryState = "pending" | "sending" | "delivered" | "retry_wait" | "permanent_failure" | "cancelled";
export type DeliveryDisposition =
  | "accepted"
  | "duplicate_accepted"
  | "retryable_failure"
  | "permanent_failure";
export type OutboxClaimKind = "ordinary" | "duplicate_probe";

export interface OutboxRecord {
  id: string;
  kind: "work.wake" | "work.terminal";
  aggregateKind: "work";
  aggregateId: string;
  destinationReference: string;
  payloadJson: string;
  payloadDigest: string;
  endpointIdempotencyKey: string;
  state: OutboxState;
  attemptCount: number;
  maxAttempts: number;
  notBefore: string;
  claimedBy: string | null;
  claimExpiresAt: string | null;
  claimEpoch: number;
  activeClaimKind: OutboxClaimKind | null;
  recoveryProbeCount: number;
  lastErrorCode: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

export interface DeliveryRecord {
  id: string;
  outboxId: string;
  state: DeliveryState;
  endpointIdempotencyKey: string;
  attemptCount: number;
  activeClaimEpoch: number | null;
  finalDisposition: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

export interface OutboxIdentity {
  requestId: string;
  correlationId: string;
}

export interface ClaimOutboxInput extends OutboxIdentity {
  claimant: string;
  claimTtlMs: number;
}

export interface SettleOutboxInput extends OutboxIdentity {
  outboxId: string;
  deliveryId: string;
  claimant: string;
  claimEpoch: number;
  endpointIdempotencyKey: string;
  disposition: DeliveryDisposition;
  errorCode: string | null;
}

export interface OutboxMutationResult {
  outbox: OutboxRecord;
  delivery: DeliveryRecord;
}

export interface ClaimedOutboxResult extends OutboxMutationResult {
  claimEpoch: number;
  claimKind: OutboxClaimKind;
  endpointIdempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface CreateOutboxServiceOptions {
  database: M11Database;
  now?: () => Date;
  retryBaseMs: number;
}
