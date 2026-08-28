import type {
  CoordinationMutation,
  CoordinationMutationResult,
  CoordinationTransaction,
  SqliteValue,
} from "../db/index.js";
import type { ReasoningEffort } from "../../agent/reasoning-effort.js";

export interface M11Database {
  readOne<T>(sql: string, ...parameters: SqliteValue[]): T | undefined;
  readAll<T>(sql: string, ...parameters: SqliteValue[]): T[];
  mutateWithEvent<T>(
    mutate: (transaction: CoordinationTransaction) => CoordinationMutation<T>,
  ): CoordinationMutationResult<T>;
}

export interface ContextManifestInput {
  privacy: "channel_only";
  channelId: string;
  messageIds: readonly string[];
  artifactIds: readonly string[];
  counts: { messages: number; artifacts: number };
  watermarks: { channelSequence: number; eventSequence: number };
  digests: { context: string; source: string };
}

export interface ContextManifest {
  id: string;
  privacy: "channel_only";
  channelId: string;
  messageIds: readonly string[];
  artifactIds: readonly string[];
  messageCount: number;
  artifactCount: number;
  channelWatermark: number;
  eventWatermark: number;
  contextDigest: string;
  sourceDigest: string;
  createdAt: string;
}

export type WorkState =
  | "queued"
  | "leased"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface WorkRecord {
  id: string;
  principalId: string;
  targetPrincipalId: string;
  channelId: string;
  originMessageId: string | null;
  roundId: string | null;
  contextManifestId: string;
  kind: string;
  idempotencyKeyDigest: string;
  requestDigest: string;
  state: WorkState;
  currentAttemptId: string | null;
  nextFencingToken: number;
  automaticOfferCount: number;
  maxAutomaticOffers: number;
  terminalReason: string | null;
  terminalReceiptDigest: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

export interface WorkTurnSelection {
  modelAlias: string | null;
  reasoningEffort: ReasoningEffort | null;
}

export interface CreateWorkInput {
  principalId: string;
  targetPrincipalId: string;
  channelId: string;
  originMessageId: string | null;
  roundId: string | null;
  kind: string;
  idempotencyKey: string;
  manifest: ContextManifestInput;
  maxAutomaticOffers: number;
  requestId: string;
  correlationId: string;
  /** Omitted by pre-selection callers; omission is exactly the null/default pair. */
  turnSelection?: WorkTurnSelection;
}

export interface CreateWorkResult {
  work: WorkRecord;
  manifest: ContextManifest;
  wakeOutboxId: string;
  replayed: boolean;
}

export interface CancelQueuedWorkInput {
  workId: string;
  actorPrincipalId: string;
  reasonCode: string;
  sourceReference: string;
  timestamp: string;
  requestId: string;
  correlationId: string;
}

export interface QueuedCancellationReceipt {
  workId: string;
  attemptId: null;
  fencingToken: 0;
  status: "cancelled";
  sourceReference: string;
  resultDigest: null;
  artifactIds: readonly [];
  receiptDigest: string;
  createdAt: string;
}

export interface CancelQueuedWorkResult {
  work: WorkRecord;
  receipt: QueuedCancellationReceipt;
  terminalOutboxId: string;
  replayed: boolean;
}

export type WorkGeneratedIdKind =
  | "contextManifest"
  | "work"
  | "outbox"
  | "delivery";

export interface CreateWorkServiceOptions {
  database: M11Database;
  generateId: (kind: WorkGeneratedIdKind) => string;
  now?: () => Date;
}
