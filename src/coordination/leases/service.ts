import { assertCoordinationId } from "../ids/index.js";
import {
  assertDigest,
  assertExactKeys,
  assertId,
  assertSafeReference,
  canonicalJson,
  canonicalTimestamp,
  sha256,
} from "../work/canonical.js";
import { assertM11Transition } from "../work/state-machines.js";
import type { M11Database, WorkRecord } from "../work/types.js";

import { LeaseError, type LeaseErrorCode } from "./errors.js";
import type {
  AttemptRecord,
  CompletedLeaseMutationResult,
  CreateLeaseServiceOptions,
  HeartbeatLeaseInput,
  LeaseBindingInput,
  LeaseMutationResult,
  LeaseRecord,
  OfferLeaseInput,
  OfferLeaseResult,
  ReasonedLeaseBindingInput,
  TerminalReceiptInput,
  TerminalReceiptRecord,
  TerminalizeInput,
  TerminalizeResult,
} from "./types.js";

interface WorkRow extends WorkRecord {}
interface AttemptRow extends AttemptRecord {}
interface LeaseRow extends LeaseRecord {}
interface ReceiptRow {
  workId: string;
  attemptId: string;
  fencingToken: number;
  status: TerminalReceiptRecord["status"];
  sourceReference: string;
  resultDigest: string | null;
  artifactRefsJson: string;
  receiptDigest: string;
  createdAt: string;
}

const WORK_SELECT = `
SELECT id, principal_id AS principalId, target_principal_id AS targetPrincipalId,
       channel_id AS channelId, origin_message_id AS originMessageId,
       round_id AS roundId, context_manifest_id AS contextManifestId, kind,
       idempotency_key_digest AS idempotencyKeyDigest, request_digest AS requestDigest,
       state, current_attempt_id AS currentAttemptId,
       next_fencing_token AS nextFencingToken,
       automatic_offer_count AS automaticOfferCount,
       max_automatic_offers AS maxAutomaticOffers, terminal_reason AS terminalReason,
       terminal_receipt_digest AS terminalReceiptDigest, version,
       created_at AS createdAt, updated_at AS updatedAt, terminal_at AS terminalAt
FROM works`;

const ATTEMPT_SELECT = `
SELECT id, work_id AS workId, ordinal, holder_principal_id AS holderPrincipalId,
       holder_instance_id AS holderInstanceId, authority_reference AS authorityReference,
       state, fencing_token AS fencingToken,
       rejected_evidence_count AS rejectedEvidenceCount, version,
       offered_at AS offeredAt, accepted_at AS acceptedAt, started_at AS startedAt,
       ended_at AS endedAt, updated_at AS updatedAt
FROM attempts`;

const LEASE_SELECT = `
SELECT id, work_id AS workId, attempt_id AS attemptId,
       holder_principal_id AS holderPrincipalId,
       holder_instance_id AS holderInstanceId, fencing_token AS fencingToken,
       state, issued_at AS issuedAt, heartbeat_at AS heartbeatAt,
       expires_at AS expiresAt, ended_at AS endedAt, reason_code AS reasonCode,
       version
FROM leases`;

const RECEIPT_SELECT = `
SELECT work_id AS workId, attempt_id AS attemptId, fencing_token AS fencingToken,
       terminal_status AS status, source_reference AS sourceReference,
       result_digest AS resultDigest, artifact_refs_json AS artifactRefsJson,
       receipt_digest AS receiptDigest, created_at AS createdAt
FROM terminal_receipts`;

function freezeWork(row: WorkRow): WorkRecord {
  return Object.freeze({ ...row });
}

function freezeAttempt(row: AttemptRow): AttemptRecord {
  return Object.freeze({ ...row });
}

function freezeLease(row: LeaseRow): LeaseRecord {
  return Object.freeze({ ...row });
}

function freezeReceipt(row: ReceiptRow): TerminalReceiptRecord {
  return Object.freeze({
    workId: row.workId,
    attemptId: row.attemptId,
    fencingToken: row.fencingToken,
    status: row.status,
    sourceReference: row.sourceReference,
    resultDigest: row.resultDigest,
    artifactIds: Object.freeze(JSON.parse(row.artifactRefsJson) as string[]),
    receiptDigest: row.receiptDigest,
    createdAt: row.createdAt,
  });
}

function readWork(database: M11Database, workId: string): WorkRecord {
  const row = database.readOne<WorkRow>(`${WORK_SELECT} WHERE id = ?`, workId);
  if (!row) throw new LeaseError("not_found", "Work was not found");
  return freezeWork(row);
}

function readAttempt(database: M11Database, attemptId: string): AttemptRecord {
  const row = database.readOne<AttemptRow>(`${ATTEMPT_SELECT} WHERE id = ?`, attemptId);
  if (!row) throw new LeaseError("not_found", "Attempt was not found");
  return freezeAttempt(row);
}

function readLease(database: M11Database, leaseId: string): LeaseRecord {
  const row = database.readOne<LeaseRow>(`${LEASE_SELECT} WHERE id = ?`, leaseId);
  if (!row) throw new LeaseError("not_found", "Lease was not found");
  return freezeLease(row);
}

function readMutationResult(database: M11Database, workId: string, attemptId: string, leaseId: string): LeaseMutationResult {
  return Object.freeze({
    work: readWork(database, workId),
    attempt: readAttempt(database, attemptId),
    lease: readLease(database, leaseId),
  });
}

function assertBoundedIdentifier(value: unknown, code: LeaseErrorCode, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(value)) {
    throw new LeaseError(code, `${label} must be a bounded identifier`);
  }
  return value;
}

function assertHolderInstance(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new LeaseError("invalid_request", "holder instance must be a bounded opaque identifier");
  }
  return value;
}

function assertBinding(input: LeaseBindingInput): LeaseBindingInput {
  assertExactKeys(
    input,
    ["workId", "attemptId", "leaseId", "holderPrincipalId", "holderInstanceId", "fencingToken", "requestId", "correlationId"],
    "invalid_request",
    "Lease binding",
  );
  assertId("work", input.workId, "invalid_request");
  assertId("attempt", input.attemptId, "invalid_request");
  assertId("lease", input.leaseId, "invalid_request");
  assertId("principal", input.holderPrincipalId, "invalid_request");
  assertHolderInstance(input.holderInstanceId);
  assertId("request", input.requestId, "invalid_request");
  assertId("correlation", input.correlationId, "invalid_request");
  if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 0) {
    throw new LeaseError("invalid_request", "fencing token must be a nonnegative safe integer");
  }
  return input;
}

function assertReasonedBinding(input: ReasonedLeaseBindingInput): ReasonedLeaseBindingInput {
  assertExactKeys(
    input,
    ["workId", "attemptId", "leaseId", "holderPrincipalId", "holderInstanceId", "fencingToken", "requestId", "correlationId", "reasonCode"],
    "invalid_request",
    "reasoned Lease binding",
  );
  const { reasonCode, ...binding } = input;
  assertBinding(binding);
  assertBoundedIdentifier(reasonCode, "invalid_request", "reason code");
  return input;
}

function exactBinding(
  work: WorkRecord,
  attempt: AttemptRecord,
  lease: LeaseRecord,
  input: LeaseBindingInput,
): boolean {
  return work.currentAttemptId === attempt.id &&
    attempt.workId === work.id && lease.workId === work.id &&
    lease.attemptId === attempt.id && input.attemptId === attempt.id &&
    input.leaseId === lease.id && input.holderPrincipalId === attempt.holderPrincipalId &&
    input.holderPrincipalId === lease.holderPrincipalId &&
    input.holderInstanceId === attempt.holderInstanceId &&
    input.holderInstanceId === lease.holderInstanceId &&
    input.fencingToken === attempt.fencingToken &&
    input.fencingToken === lease.fencingToken;
}

function lifecycleEvent(
  work: WorkRecord,
  input: Pick<LeaseBindingInput, "requestId" | "correlationId">,
  createdAt: string,
  payload: Record<string, string | number | null>,
) {
  return {
    type: "turn.updated",
    aggregateKind: "work",
    aggregateId: work.id,
    aggregateVersion: work.version + 1,
    channelId: work.channelId,
    actorPrincipalId: work.targetPrincipalId,
    requestId: input.requestId,
    correlationId: input.correlationId,
    payload,
    createdAt,
  } as const;
}

export function createLeaseService(options: CreateLeaseServiceOptions) {
  const now = options.now ?? (() => new Date());
  if (!Number.isSafeInteger(options.leaseTtlMs) || options.leaseTtlMs < 1_000 || options.leaseTtlMs > 86_400_000) {
    throw new LeaseError("invalid_request", "Lease TTL must be between one second and one day");
  }

  function recordRejectedFence(input: LeaseBindingInput, work: WorkRecord): void {
    const existing = options.database.readOne<{ count: number }>(
      "SELECT count(*) AS count FROM work_observations WHERE work_id = ? AND observation_kind = 'rejected_fence'",
      work.id,
    )?.count ?? 0;
    if (existing >= 32) return;
    const observationId = options.generateId("workObservation");
    assertCoordinationId("workObservation", observationId);
    const createdAt = canonicalTimestamp(now());
    const evidenceDigest = sha256(canonicalJson({
      workId: work.id,
      attemptId: input.attemptId,
      leaseId: input.leaseId,
      holderPrincipalId: input.holderPrincipalId,
      holderInstanceId: input.holderInstanceId,
      fencingToken: input.fencingToken,
      outcomeCode: "stale_fence",
    }));
    options.database.mutateWithEvent((transaction) => {
      transaction.run(
        `INSERT INTO work_observations (
          id, work_id, attempt_id, authority_reference, holder_instance_id,
          fencing_token, observation_kind, outcome_code, evidence_digest, created_at
        ) VALUES (?, ?, NULL, 'coordination:rejected-fence', ?, ?, 'rejected_fence',
                  'stale_fence', ?, ?)`,
        observationId,
        work.id,
        input.holderInstanceId,
        input.fencingToken,
        evidenceDigest,
        createdAt,
      );
      return {
        value: undefined,
        event: {
          type: "activity.updated",
          aggregateKind: "workObservation",
          aggregateId: observationId,
          aggregateVersion: 1,
          channelId: work.channelId,
          actorPrincipalId: input.holderPrincipalId,
          requestId: input.requestId,
          correlationId: input.correlationId,
          payload: {
            observationId,
            workId: work.id,
            outcomeCode: "stale_fence",
            rejectedFence: input.fencingToken,
            evidenceDigest,
          },
          createdAt,
        },
      };
    });
  }

  function boundRows(input: LeaseBindingInput): LeaseMutationResult {
    assertBinding(input);
    const work = readWork(options.database, input.workId);
    let attempt: AttemptRecord;
    let lease: LeaseRecord;
    try {
      attempt = readAttempt(options.database, input.attemptId);
      lease = readLease(options.database, input.leaseId);
    } catch (error) {
      recordRejectedFence(input, work);
      throw new LeaseError("stale_fence", "Lease binding is not current");
    }
    if (!exactBinding(work, attempt, lease, input)) {
      recordRejectedFence(input, work);
      throw new LeaseError("stale_fence", "Lease binding is not current");
    }
    return Object.freeze({ work, attempt, lease });
  }

  return Object.freeze({
    assertCurrent(input: LeaseBindingInput): LeaseMutationResult {
      return boundRows(input);
    },

    assertCompleted(input: LeaseBindingInput, resultDigest?: string): CompletedLeaseMutationResult {
      const current = boundRows(input);
      const receipt = options.database.readOne<ReceiptRow>(
        `${RECEIPT_SELECT} WHERE work_id = ?`,
        current.work.id,
      );
      const exact = current.work.state === "succeeded" &&
        current.attempt.state === "succeeded" && current.lease.state === "released" &&
        receipt?.status === "succeeded" &&
        receipt.attemptId === current.attempt.id &&
        receipt.fencingToken === current.attempt.fencingToken &&
        receipt.sourceReference === current.attempt.authorityReference &&
        (resultDigest === undefined || receipt.resultDigest === resultDigest);
      if (!exact) throw new LeaseError("terminal_conflict", "completed resident result does not match terminal truth");
      return Object.freeze({ ...current, receipt: freezeReceipt(receipt!) });
    },

    current(workIdInput: string): LeaseMutationResult {
      const workId = assertId("work", workIdInput, "invalid_request");
      const work = readWork(options.database, workId);
      if (!work.currentAttemptId) {
        throw new LeaseError("illegal_state", "Work does not have a current Attempt");
      }
      const attempt = readAttempt(options.database, work.currentAttemptId);
      const lease = options.database.readOne<LeaseRow>(
        `${LEASE_SELECT} WHERE work_id = ? AND attempt_id = ?`,
        work.id,
        attempt.id,
      );
      if (!lease) throw new LeaseError("not_found", "current Attempt Lease was not found");
      return Object.freeze({ work, attempt, lease: freezeLease(lease) });
    },

    offer(input: OfferLeaseInput): OfferLeaseResult {
      assertExactKeys(
        input,
        ["workId", "holderPrincipalId", "holderInstanceId", "authorityReference", "automatic", "requestId", "correlationId"],
        "invalid_request",
        "Lease offer",
      );
      const workId = assertId("work", input.workId, "invalid_request");
      const holderPrincipalId = assertId("principal", input.holderPrincipalId, "invalid_request");
      const holderInstanceId = assertHolderInstance(input.holderInstanceId);
      const authorityReference = assertSafeReference(input.authorityReference, "invalid_request", "authority reference");
      const requestId = assertId("request", input.requestId, "invalid_request");
      const correlationId = assertId("correlation", input.correlationId, "invalid_request");
      if (typeof input.automatic !== "boolean") throw new LeaseError("invalid_request", "automatic must be boolean");
      const work = readWork(options.database, workId);
      if (work.state !== "queued" || work.currentAttemptId !== null) {
        throw new LeaseError("illegal_state", "only queued Work without a live Attempt may be offered");
      }
      if (holderPrincipalId !== work.targetPrincipalId) {
        throw new LeaseError("invalid_request", "Lease holder must be the Work target Bot");
      }
      if (input.automatic && work.automaticOfferCount >= work.maxAutomaticOffers) {
        throw new LeaseError("retry_budget_exhausted", "automatic offer budget is exhausted");
      }
      assertM11Transition("work", "queued", "leased");
      assertM11Transition("attempt", "created", "offered");
      const attemptId = options.generateId("attempt");
      const leaseId = options.generateId("lease");
      assertCoordinationId("attempt", attemptId);
      assertCoordinationId("lease", leaseId);
      const createdAt = canonicalTimestamp(now());
      const expiry = canonicalTimestamp(new Date(now().valueOf() + options.leaseTtlMs));
      const fencingToken = work.nextFencingToken;
      const ordinal = (options.database.readOne<{ ordinal: number }>(
        "SELECT coalesce(max(ordinal), 0) + 1 AS ordinal FROM attempts WHERE work_id = ?",
        work.id,
      )?.ordinal ?? 1);
      const committed = options.database.mutateWithEvent((transaction) => {
        transaction.run(
          `INSERT INTO attempts (
            id, work_id, ordinal, holder_principal_id, holder_instance_id,
            authority_reference, state, fencing_token, rejected_evidence_count,
            version, offered_at, accepted_at, started_at, ended_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'created', ?, 0, 1, ?, NULL, NULL, NULL, ?)`,
          attemptId, work.id, ordinal, holderPrincipalId, holderInstanceId,
          authorityReference, fencingToken, createdAt, createdAt,
        );
        transaction.run(
          "UPDATE attempts SET state = 'offered', version = 2, updated_at = ? WHERE id = ?",
          createdAt,
          attemptId,
        );
        transaction.run(
          `INSERT INTO leases (
            id, work_id, attempt_id, holder_principal_id, holder_instance_id,
            fencing_token, state, issued_at, heartbeat_at, expires_at, ended_at,
            reason_code, version
          ) VALUES (?, ?, ?, ?, ?, ?, 'offered', ?, ?, ?, NULL, NULL, 1)`,
          leaseId, work.id, attemptId, holderPrincipalId, holderInstanceId,
          fencingToken, createdAt, createdAt, expiry,
        );
        transaction.run(
          `UPDATE works SET state = 'leased', current_attempt_id = ?,
             next_fencing_token = next_fencing_token + 1,
             automatic_offer_count = automatic_offer_count + ?,
             version = version + 1, updated_at = ? WHERE id = ?`,
          attemptId, input.automatic ? 1 : 0, createdAt, work.id,
        );
        return {
          value: undefined,
          event: lifecycleEvent(work, { requestId, correlationId }, createdAt, {
            workId: work.id,
            state: "leased",
            attemptId,
            attemptState: "offered",
            leaseId,
            leaseState: "offered",
            fencingToken,
            automaticOfferCount: work.automaticOfferCount + (input.automatic ? 1 : 0),
          }),
        };
      });
      void committed;
      return Object.freeze({
        ...readMutationResult(options.database, work.id, attemptId, leaseId),
        fencingToken,
      });
    },

    accept(input: LeaseBindingInput): LeaseMutationResult {
      const current = boundRows(input);
      if (current.work.state !== "leased" || current.attempt.state !== "offered" || current.lease.state !== "offered") {
        throw new LeaseError("illegal_state", "only the current offered Attempt and Lease may be accepted");
      }
      assertM11Transition("attempt", "offered", "accepted");
      assertM11Transition("lease", "offered", "active");
      const createdAt = canonicalTimestamp(now());
      options.database.mutateWithEvent((transaction) => {
        transaction.run(
          "UPDATE attempts SET state = 'accepted', accepted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?",
          createdAt, createdAt, current.attempt.id,
        );
        transaction.run(
          "UPDATE leases SET state = 'active', heartbeat_at = ?, version = version + 1 WHERE id = ?",
          createdAt, current.lease.id,
        );
        transaction.run("UPDATE works SET version = version + 1, updated_at = ? WHERE id = ?", createdAt, current.work.id);
        return {
          value: undefined,
          event: lifecycleEvent(current.work, input, createdAt, {
            workId: current.work.id,
            state: "leased",
            attemptId: current.attempt.id,
            attemptState: "accepted",
            leaseId: current.lease.id,
            leaseState: "active",
            fencingToken: current.lease.fencingToken,
          }),
        };
      });
      return readMutationResult(options.database, current.work.id, current.attempt.id, current.lease.id);
    },

    start(input: LeaseBindingInput): LeaseMutationResult {
      const current = boundRows(input);
      if (current.work.state !== "leased" || current.attempt.state !== "accepted" || current.lease.state !== "active") {
        throw new LeaseError("illegal_state", "only an accepted active exact Lease may start");
      }
      assertM11Transition("work", "leased", "running");
      assertM11Transition("attempt", "accepted", "running");
      const createdAt = canonicalTimestamp(now());
      options.database.mutateWithEvent((transaction) => {
        transaction.run(
          "UPDATE attempts SET state = 'running', started_at = ?, updated_at = ?, version = version + 1 WHERE id = ?",
          createdAt, createdAt, current.attempt.id,
        );
        transaction.run(
          "UPDATE works SET state = 'running', updated_at = ?, version = version + 1 WHERE id = ?",
          createdAt, current.work.id,
        );
        return {
          value: undefined,
          event: lifecycleEvent(current.work, input, createdAt, {
            workId: current.work.id,
            state: "running",
            attemptId: current.attempt.id,
            attemptState: "running",
            leaseId: current.lease.id,
            leaseState: "active",
            fencingToken: current.lease.fencingToken,
          }),
        };
      });
      return readMutationResult(options.database, current.work.id, current.attempt.id, current.lease.id);
    },

    heartbeat(input: HeartbeatLeaseInput): LeaseMutationResult {
      assertExactKeys(
        input,
        ["workId", "attemptId", "leaseId", "holderPrincipalId", "holderInstanceId", "fencingToken", "requestId", "correlationId", "extendMs"],
        "invalid_request",
        "Lease heartbeat",
      );
      const { extendMs, ...binding } = input;
      if (!Number.isSafeInteger(extendMs) || extendMs < 1_000 || extendMs > 86_400_000) {
        throw new LeaseError("invalid_request", "heartbeat extension must be between one second and one day");
      }
      const current = boundRows(binding);
      if (current.lease.state !== "active" || !["accepted", "running"].includes(current.attempt.state)) {
        throw new LeaseError("illegal_state", "only an active accepted or running Lease may heartbeat");
      }
      const heartbeatAt = canonicalTimestamp(now());
      const expiresAt = canonicalTimestamp(new Date(now().valueOf() + extendMs));
      options.database.mutateWithEvent((transaction) => {
        transaction.run(
          "UPDATE leases SET heartbeat_at = ?, expires_at = ?, version = version + 1 WHERE id = ?",
          heartbeatAt, expiresAt, current.lease.id,
        );
        transaction.run("UPDATE works SET version = version + 1, updated_at = ? WHERE id = ?", heartbeatAt, current.work.id);
        return {
          value: undefined,
          event: lifecycleEvent(current.work, binding, heartbeatAt, {
            workId: current.work.id,
            state: current.work.state,
            attemptId: current.attempt.id,
            attemptState: current.attempt.state,
            leaseId: current.lease.id,
            leaseState: "active",
            fencingToken: current.lease.fencingToken,
          }),
        };
      });
      return readMutationResult(options.database, current.work.id, current.attempt.id, current.lease.id);
    },

    reject(input: ReasonedLeaseBindingInput): LeaseMutationResult {
      assertReasonedBinding(input);
      const { reasonCode, ...binding } = input;
      const current = boundRows(binding);
      if (current.work.state !== "leased" || current.attempt.state !== "offered" || current.lease.state !== "offered") {
        throw new LeaseError("illegal_state", "only an offered Attempt may be rejected");
      }
      assertM11Transition("attempt", "offered", "rejected");
      assertM11Transition("lease", "offered", "active");
      assertM11Transition("lease", "active", "released");
      assertM11Transition("work", "leased", "queued");
      const createdAt = canonicalTimestamp(now());
      options.database.mutateWithEvent((transaction) => {
        transaction.run(
          "UPDATE attempts SET state = 'rejected', ended_at = ?, updated_at = ?, version = version + 1 WHERE id = ?",
          createdAt, createdAt, current.attempt.id,
        );
        transaction.run("UPDATE leases SET state = 'active', version = version + 1 WHERE id = ?", current.lease.id);
        transaction.run(
          "UPDATE leases SET state = 'released', ended_at = ?, reason_code = ?, version = version + 1 WHERE id = ?",
          createdAt, reasonCode, current.lease.id,
        );
        transaction.run(
          "UPDATE works SET state = 'queued', current_attempt_id = NULL, updated_at = ?, version = version + 1 WHERE id = ?",
          createdAt, current.work.id,
        );
        return {
          value: undefined,
          event: lifecycleEvent(current.work, binding, createdAt, {
            workId: current.work.id,
            state: "queued",
            attemptId: current.attempt.id,
            attemptState: "rejected",
            leaseId: current.lease.id,
            leaseState: "released",
            fencingToken: current.lease.fencingToken,
            reasonCode,
          }),
        };
      });
      return readMutationResult(options.database, current.work.id, current.attempt.id, current.lease.id);
    },

    expire(input: ReasonedLeaseBindingInput): LeaseMutationResult {
      assertReasonedBinding(input);
      const { reasonCode, ...binding } = input;
      const current = boundRows(binding);
      if (current.work.state !== "leased" || current.attempt.state !== "accepted" || current.lease.state !== "active") {
        throw new LeaseError("illegal_state", "only an accepted not-started Attempt may expire");
      }
      assertM11Transition("attempt", "accepted", "expired");
      assertM11Transition("lease", "active", "expired");
      assertM11Transition("work", "leased", "queued");
      const createdAt = canonicalTimestamp(now());
      options.database.mutateWithEvent((transaction) => {
        transaction.run(
          "UPDATE attempts SET state = 'expired', ended_at = ?, updated_at = ?, version = version + 1 WHERE id = ?",
          createdAt, createdAt, current.attempt.id,
        );
        transaction.run(
          "UPDATE leases SET state = 'expired', ended_at = ?, reason_code = ?, version = version + 1 WHERE id = ?",
          createdAt, reasonCode, current.lease.id,
        );
        transaction.run(
          "UPDATE works SET state = 'queued', current_attempt_id = NULL, updated_at = ?, version = version + 1 WHERE id = ?",
          createdAt, current.work.id,
        );
        return {
          value: undefined,
          event: lifecycleEvent(current.work, binding, createdAt, {
            workId: current.work.id,
            state: "queued",
            attemptId: current.attempt.id,
            attemptState: "expired",
            leaseId: current.lease.id,
            leaseState: "expired",
            fencingToken: current.lease.fencingToken,
            reasonCode,
          }),
        };
      });
      return readMutationResult(options.database, current.work.id, current.attempt.id, current.lease.id);
    },

    revoke(input: ReasonedLeaseBindingInput): LeaseMutationResult {
      assertReasonedBinding(input);
      const { reasonCode, ...binding } = input;
      const current = boundRows(binding);
      if (current.work.state !== "running" || current.attempt.state !== "running" || current.lease.state !== "active") {
        throw new LeaseError("illegal_state", "only a running exact Lease may be revoked");
      }
      assertM11Transition("work", "running", "cancelling");
      assertM11Transition("attempt", "running", "cancel_requested");
      assertM11Transition("lease", "active", "revoked");
      const createdAt = canonicalTimestamp(now());
      options.database.mutateWithEvent((transaction) => {
        transaction.run(
          "UPDATE attempts SET state = 'cancel_requested', updated_at = ?, version = version + 1 WHERE id = ?",
          createdAt, current.attempt.id,
        );
        transaction.run(
          "UPDATE leases SET state = 'revoked', ended_at = ?, reason_code = ?, version = version + 1 WHERE id = ?",
          createdAt, reasonCode, current.lease.id,
        );
        transaction.run(
          "UPDATE works SET state = 'cancelling', updated_at = ?, version = version + 1 WHERE id = ?",
          createdAt, current.work.id,
        );
        return {
          value: undefined,
          event: lifecycleEvent(current.work, binding, createdAt, {
            workId: current.work.id,
            state: "cancelling",
            attemptId: current.attempt.id,
            attemptState: "cancel_requested",
            leaseId: current.lease.id,
            leaseState: "revoked",
            fencingToken: current.lease.fencingToken,
            reasonCode,
          }),
        };
      });
      return readMutationResult(options.database, current.work.id, current.attempt.id, current.lease.id);
    },

    terminalize(input: TerminalizeInput): TerminalizeResult {
      assertExactKeys(
        input,
        ["workId", "attemptId", "leaseId", "holderPrincipalId", "holderInstanceId", "fencingToken", "requestId", "correlationId", "receipt"],
        "invalid_request",
        "terminal request",
      );
      const { receipt: receiptInput, ...binding } = input;
      assertBinding(binding);
      const normalized = normalizeReceipt(receiptInput);
      const receiptDigest = sha256(canonicalJson({
        workId: binding.workId,
        attemptId: binding.attemptId,
        fencingToken: binding.fencingToken,
        ...normalized,
      }));
      const current = boundRows(binding);
      const existing = options.database.readOne<ReceiptRow>(`${RECEIPT_SELECT} WHERE work_id = ?`, binding.workId);
      if (existing) {
        if (existing.receiptDigest !== receiptDigest) {
          throw new LeaseError("terminal_conflict", "terminal receipt conflicts with immutable history");
        }
        const outbox = options.database.readOne<{ id: string }>(
          "SELECT id FROM outbox WHERE kind = 'work.terminal' AND aggregate_id = ?",
          binding.workId,
        );
        if (!outbox) throw new Error("terminal receipt is missing its durable outbox intent");
        return Object.freeze({
          ...readMutationResult(options.database, binding.workId, binding.attemptId, binding.leaseId),
          receipt: freezeReceipt(existing),
          terminalOutboxId: outbox.id,
          replayed: true,
        });
      }
      const expectedAttemptState = normalized.status === "cancelled" ? "cancel_requested" : "running";
      const expectedWorkState = normalized.status === "cancelled" ? "cancelling" : "running";
      if (current.attempt.state !== expectedAttemptState || current.work.state !== expectedWorkState) {
        throw new LeaseError("illegal_state", "terminal status is not legal from the current lifecycle state");
      }
      if (normalized.sourceReference !== current.attempt.authorityReference) {
        throw new LeaseError("invalid_request", "terminal source does not match Attempt authority");
      }
      assertM11Transition("attempt", current.attempt.state, normalized.status);
      assertM11Transition("work", current.work.state, normalized.status);
      if (current.lease.state === "active") assertM11Transition("lease", "active", "released");
      else if (!(normalized.status === "cancelled" && current.lease.state === "revoked")) {
        throw new LeaseError("stale_fence", "terminal receipt does not bind the current executable Lease");
      }
      const outboxId = options.generateId("outbox");
      const deliveryId = options.generateId("delivery");
      assertCoordinationId("outbox", outboxId);
      assertCoordinationId("delivery", deliveryId);
      const destinationReference = `channel:${current.work.channelId}`;
      const payload = {
        workId: current.work.id,
        attemptId: current.attempt.id,
        state: normalized.status,
        sourceReference: normalized.sourceReference,
        resultDigest: normalized.resultDigest,
        artifactIds: normalized.artifactIds,
        receiptDigest,
        fencingToken: current.lease.fencingToken,
      };
      const payloadJson = canonicalJson(payload);
      const payloadDigest = sha256(payloadJson);
      const endpointIdempotencyKey = sha256(canonicalJson({
        destinationReference,
        kind: "work.terminal",
        receiptDigest,
        workId: current.work.id,
      }));
      options.database.mutateWithEvent((transaction) => {
        transaction.run(
          `INSERT INTO terminal_receipts (
            work_id, attempt_id, fencing_token, terminal_status, source_reference,
            result_digest, artifact_refs_json, receipt_digest, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          current.work.id, current.attempt.id, current.lease.fencingToken,
          normalized.status, normalized.sourceReference, normalized.resultDigest,
          canonicalJson(normalized.artifactIds), receiptDigest, normalized.createdAt,
        );
        transaction.run(
          "UPDATE attempts SET state = ?, ended_at = ?, updated_at = ?, version = version + 1 WHERE id = ?",
          normalized.status, normalized.createdAt, normalized.createdAt, current.attempt.id,
        );
        if (current.lease.state === "active") {
          transaction.run(
            "UPDATE leases SET state = 'released', ended_at = ?, reason_code = 'terminal_receipt', version = version + 1 WHERE id = ?",
            normalized.createdAt, current.lease.id,
          );
        }
        transaction.run(
          `UPDATE works SET state = ?, terminal_reason = ?, terminal_receipt_digest = ?,
             terminal_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
          normalized.status, `receipt_${normalized.status}`, receiptDigest,
          normalized.createdAt, normalized.createdAt, current.work.id,
        );
        transaction.run(
          `INSERT INTO outbox (
            id, kind, aggregate_kind, aggregate_id, destination_reference,
            payload_json, payload_digest, endpoint_idempotency_key, state,
            attempt_count, max_attempts, not_before, claimed_by, claim_expires_at,
            last_error_code, version, created_at, updated_at, delivered_at
          ) VALUES (?, 'work.terminal', 'work', ?, ?, ?, ?, ?, 'pending', 0, 4,
                    ?, NULL, NULL, NULL, 1, ?, ?, NULL)`,
          outboxId, current.work.id, destinationReference, payloadJson, payloadDigest,
          endpointIdempotencyKey, normalized.createdAt, normalized.createdAt,
          normalized.createdAt,
        );
        transaction.run(
          `INSERT INTO deliveries (
            id, outbox_id, state, endpoint_idempotency_key, attempt_count,
            final_disposition, version, created_at, updated_at, terminal_at
          ) VALUES (?, ?, 'pending', ?, 0, NULL, 1, ?, ?, NULL)`,
          deliveryId, outboxId, endpointIdempotencyKey, normalized.createdAt,
          normalized.createdAt,
        );
        return {
          value: undefined,
          events: [
            lifecycleEvent(current.work, binding, normalized.createdAt, {
              workId: current.work.id,
              state: normalized.status,
              attemptId: current.attempt.id,
              attemptState: normalized.status,
              leaseId: current.lease.id,
              leaseState: current.lease.state === "active" ? "released" : "revoked",
              fencingToken: current.lease.fencingToken,
              receiptDigest,
              reasonCode: `receipt_${normalized.status}`,
            }),
            {
              type: "activity.updated",
              aggregateKind: "outbox",
              aggregateId: outboxId,
              aggregateVersion: 1,
              channelId: current.work.channelId,
              actorPrincipalId: current.work.targetPrincipalId,
              requestId: binding.requestId,
              correlationId: binding.correlationId,
              payload: {
                outboxId,
                deliveryId,
                workId: current.work.id,
                state: "pending",
                payloadDigest,
                endpointIdempotencyKey,
                receiptDigest,
              },
              createdAt: normalized.createdAt,
            },
          ],
        };
      });
      const receipt = options.database.readOne<ReceiptRow>(`${RECEIPT_SELECT} WHERE work_id = ?`, current.work.id);
      if (!receipt) throw new Error("terminal transaction did not retain its receipt");
      return Object.freeze({
        ...readMutationResult(options.database, current.work.id, current.attempt.id, current.lease.id),
        receipt: freezeReceipt(receipt),
        terminalOutboxId: outboxId,
        replayed: false,
      });
    },
  });
}

function normalizeReceipt(input: TerminalReceiptInput) {
  assertExactKeys(
    input,
    ["status", "sourceReference", "resultDigest", "artifactIds", "timestamp"],
    "invalid_request",
    "terminal receipt",
  );
  if (!["succeeded", "failed", "cancelled"].includes(input.status)) {
    throw new LeaseError("invalid_request", "invalid terminal status");
  }
  const sourceReference = assertSafeReference(input.sourceReference, "invalid_request", "terminal source reference");
  const resultDigest = input.resultDigest === null
    ? null
    : assertDigest(input.resultDigest, "invalid_request", "result digest");
  if (!Array.isArray(input.artifactIds) || input.artifactIds.length > 32) {
    throw new LeaseError("invalid_request", "terminal artifact references must be a bounded array");
  }
  const artifactIds = input.artifactIds.map((id) => assertId("artifact", id, "invalid_request"));
  if (new Set(artifactIds).size !== artifactIds.length) {
    throw new LeaseError("invalid_request", "terminal artifact references must be unique");
  }
  const parsed = new Date(input.timestamp);
  if (Number.isNaN(parsed.valueOf()) || canonicalTimestamp(parsed) !== input.timestamp) {
    throw new LeaseError("invalid_request", "terminal timestamp must be canonical UTC milliseconds");
  }
  return Object.freeze({
    status: input.status,
    sourceReference,
    resultDigest,
    artifactIds: Object.freeze([...artifactIds].sort()),
    createdAt: input.timestamp,
  });
}
