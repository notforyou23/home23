import { assertCoordinationId } from "../ids/index.js";
import { createLeaseService } from "../leases/index.js";
import { createOutboxService } from "../outbox/index.js";

import {
  assertDigest,
  assertExactKeys,
  assertId,
  assertSafeReference,
  canonicalTimestamp,
} from "./canonical.js";
import type {
  CreateRecoveryServiceOptions,
  PositiveSourceTruth,
  RecoverStartupInput,
  RecoveryIdentity,
  RecoveryReceipt,
  SourceTruth,
  TerminalSourceTruth,
} from "./recovery-types.js";

interface ContinuityRow {
  workId: string;
  workState: string;
  channelId: string;
  currentAttemptId: string | null;
  attemptId: string;
  attemptState: string;
  authorityReference: string;
  attemptHolderPrincipalId: string;
  attemptHolderInstanceId: string;
  attemptFencingToken: number;
  leaseId: string;
  leaseState: string;
  leaseHolderPrincipalId: string;
  leaseHolderInstanceId: string;
  leaseFencingToken: number;
}

const CONTINUITY_SELECT = `
SELECT w.id AS workId, w.state AS workState, w.channel_id AS channelId,
       w.current_attempt_id AS currentAttemptId,
       a.id AS attemptId, a.state AS attemptState,
       a.authority_reference AS authorityReference,
       a.holder_principal_id AS attemptHolderPrincipalId,
       a.holder_instance_id AS attemptHolderInstanceId,
       a.fencing_token AS attemptFencingToken,
       l.id AS leaseId, l.state AS leaseState,
       l.holder_principal_id AS leaseHolderPrincipalId,
       l.holder_instance_id AS leaseHolderInstanceId,
       l.fencing_token AS leaseFencingToken
FROM works w
JOIN attempts a ON a.work_id = w.id
JOIN leases l ON l.attempt_id = a.id`;

function assertIdentity(input: RecoveryIdentity): void {
  assertId("request", input.requestId, "invalid_request");
  assertId("correlation", input.correlationId, "invalid_request");
}

function assertHolderInstance(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new TypeError("recovery holder instance must be a bounded opaque identifier");
  }
  return value;
}

function validateTruth(truth: SourceTruth): void {
  if (truth.kind === "unknown" || truth.kind === "unverifiable") {
    assertExactKeys(truth, ["kind", "workId", "attemptId"], "invalid_request", "unknown source truth");
    assertId("work", truth.workId, "invalid_request");
    assertId("attempt", truth.attemptId, "invalid_request");
    return;
  }
  const keys = [
    "kind", "workId", "attemptId", "leaseId", "holderPrincipalId",
    "holderInstanceId", "authorityReference", "fencingToken", "evidenceDigest",
  ];
  if (truth.kind === "terminal") keys.push("receipt");
  assertExactKeys(truth, keys, "invalid_request", "positive source truth");
  assertId("work", truth.workId, "invalid_request");
  assertId("attempt", truth.attemptId, "invalid_request");
  assertId("lease", truth.leaseId, "invalid_request");
  assertId("principal", truth.holderPrincipalId, "invalid_request");
  assertHolderInstance(truth.holderInstanceId);
  assertSafeReference(truth.authorityReference, "invalid_request", "truth authority reference");
  assertDigest(truth.evidenceDigest, "invalid_request", "truth evidence digest");
  if (
    typeof truth.fencingToken !== "number" ||
    !Number.isSafeInteger(truth.fencingToken) ||
    truth.fencingToken < 1
  ) {
    throw new TypeError("recovery fencing token must be a positive safe integer");
  }
}

function exactContinuity(row: ContinuityRow, truth: PositiveSourceTruth | TerminalSourceTruth): boolean {
  return row.workId === truth.workId && row.currentAttemptId === truth.attemptId &&
    row.attemptId === truth.attemptId && row.leaseId === truth.leaseId &&
    row.authorityReference === truth.authorityReference &&
    row.attemptHolderPrincipalId === truth.holderPrincipalId &&
    row.leaseHolderPrincipalId === truth.holderPrincipalId &&
    row.attemptHolderInstanceId === truth.holderInstanceId &&
    row.leaseHolderInstanceId === truth.holderInstanceId &&
    row.attemptFencingToken === truth.fencingToken &&
    row.leaseFencingToken === truth.fencingToken;
}

export function createRecoveryService(options: CreateRecoveryServiceOptions) {
  const now = options.now ?? (() => new Date());
  const leases = createLeaseService({
    database: options.database,
    generateId: options.generateId,
    now,
    leaseTtlMs: options.leaseTtlMs,
  });
  const outbox = createOutboxService({
    database: options.database,
    now,
    retryBaseMs: options.retryBaseMs,
  });

  function continuity(truth: SourceTruth): ContinuityRow | undefined {
    return options.database.readOne<ContinuityRow>(
      `${CONTINUITY_SELECT} WHERE w.id = ? AND a.id = ?`,
      truth.workId,
      truth.attemptId,
    );
  }

  function recordPositiveTruth(
    truth: PositiveSourceTruth | TerminalSourceTruth,
    row: ContinuityRow,
    identity: RecoveryIdentity,
  ): void {
    const existing = options.database.readOne<{ count: number }>(
      `SELECT count(*) AS count FROM work_observations
       WHERE work_id = ? AND attempt_id = ? AND observation_kind = ?
         AND evidence_digest = ?`,
      truth.workId,
      truth.attemptId,
      truth.kind,
      truth.evidenceDigest,
    );
    if ((existing?.count ?? 0) > 0) return;
    const observationId = options.generateId("workObservation");
    assertCoordinationId("workObservation", observationId);
    const at = canonicalTimestamp(now());
    const outcomeCode = truth.kind === "terminal"
      ? `positive_${truth.receipt.status}`
      : truth.kind === "not_started"
        ? "positive_not_started"
        : "positive_running";
    options.database.mutateWithEvent((transaction) => {
      transaction.run(
        `INSERT INTO work_observations (
          id, work_id, attempt_id, authority_reference, holder_instance_id,
          fencing_token, observation_kind, outcome_code, evidence_digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        observationId,
        truth.workId,
        truth.attemptId,
        truth.authorityReference,
        truth.holderInstanceId,
        truth.fencingToken,
        truth.kind,
        outcomeCode,
        truth.evidenceDigest,
        at,
      );
      return {
        value: undefined,
        event: {
          type: "activity.updated",
          aggregateKind: "workObservation",
          aggregateId: observationId,
          aggregateVersion: 1,
          channelId: row.channelId,
          actorPrincipalId: truth.holderPrincipalId,
          requestId: identity.requestId,
          correlationId: identity.correlationId,
          payload: {
            observationId,
            workId: truth.workId,
            attemptId: truth.attemptId,
            observationKind: truth.kind,
            outcomeCode,
            fencingToken: truth.fencingToken,
            evidenceDigest: truth.evidenceDigest,
          },
          createdAt: at,
        },
      };
    });
  }

  return Object.freeze({
    recoverStartup(input: RecoverStartupInput): RecoveryReceipt {
      assertExactKeys(input, ["truths", "requestId", "correlationId"], "invalid_request", "startup recovery");
      assertIdentity(input);
      if (!Array.isArray(input.truths)) throw new TypeError("startup truths must be an array");
      for (const truth of input.truths) validateTruth(truth);
      const result = {
        staleOutboxClaimsReclaimed: outbox.reclaimStaleClaims({
          requestId: input.requestId,
          correlationId: input.correlationId,
        }),
        terminalized: 0,
        terminalReplays: 0,
        requeued: 0,
        reattached: 0,
        rejectedTruth: 0,
        ambiguous: 0,
      };
      const addressed = new Set<string>();

      for (const truth of input.truths) {
        if (truth.kind === "unknown" || truth.kind === "unverifiable") {
          const row = continuity(truth);
          if (!row || row.currentAttemptId !== truth.attemptId) {
            result.rejectedTruth += 1;
            continue;
          }
          addressed.add(truth.attemptId);
          if (["offered", "accepted", "running", "cancel_requested"].includes(row.attemptState)) {
            result.ambiguous += 1;
          }
          continue;
        }
        const row = continuity(truth);
        if (!row || !exactContinuity(row, truth)) {
          result.rejectedTruth += 1;
          continue;
        }
        addressed.add(truth.attemptId);
        if (truth.kind === "not_started") {
          if (row.workState !== "leased" || row.attemptState !== "accepted" || row.leaseState !== "active") {
            result.rejectedTruth += 1;
            continue;
          }
          recordPositiveTruth(truth, row, input);
          leases.expire({
            workId: truth.workId,
            attemptId: truth.attemptId,
            leaseId: truth.leaseId,
            holderPrincipalId: truth.holderPrincipalId,
            holderInstanceId: truth.holderInstanceId,
            fencingToken: truth.fencingToken,
            reasonCode: "positive_not_started",
            requestId: input.requestId,
            correlationId: input.correlationId,
          });
          result.requeued += 1;
          continue;
        }
        if (truth.kind === "running") {
          if (row.workState !== "running" || row.attemptState !== "running" || row.leaseState !== "active") {
            result.rejectedTruth += 1;
            continue;
          }
          recordPositiveTruth(truth, row, input);
          leases.heartbeat({
            workId: truth.workId,
            attemptId: truth.attemptId,
            leaseId: truth.leaseId,
            holderPrincipalId: truth.holderPrincipalId,
            holderInstanceId: truth.holderInstanceId,
            fencingToken: truth.fencingToken,
            extendMs: options.leaseTtlMs,
            requestId: input.requestId,
            correlationId: input.correlationId,
          });
          result.reattached += 1;
          continue;
        }
        const terminalStateMatches =
          (["running", "cancelling", "succeeded", "failed", "cancelled"].includes(row.workState)) &&
          (["running", "cancel_requested", "succeeded", "failed", "cancelled"].includes(row.attemptState));
        if (!terminalStateMatches || truth.receipt.sourceReference !== truth.authorityReference) {
          result.rejectedTruth += 1;
          continue;
        }
        recordPositiveTruth(truth, row, input);
        const terminal = leases.terminalize({
          workId: truth.workId,
          attemptId: truth.attemptId,
          leaseId: truth.leaseId,
          holderPrincipalId: truth.holderPrincipalId,
          holderInstanceId: truth.holderInstanceId,
          fencingToken: truth.fencingToken,
          receipt: truth.receipt,
          requestId: input.requestId,
          correlationId: input.correlationId,
        });
        if (terminal.replayed) result.terminalReplays += 1;
        else result.terminalized += 1;
      }

      const active = options.database.readAll<{ attemptId: string }>(
        `SELECT a.id AS attemptId
         FROM works w JOIN attempts a ON a.id = w.current_attempt_id
         WHERE w.state NOT IN ('succeeded', 'failed', 'cancelled')
           AND a.state IN ('offered', 'accepted', 'running', 'cancel_requested')`,
      );
      for (const row of active) {
        if (!addressed.has(row.attemptId)) result.ambiguous += 1;
      }
      return Object.freeze(result);
    },
  });
}
