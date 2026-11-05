import { assertDigest, assertExactKeys, assertId, canonicalTimestamp } from "../work/canonical.js";
import { assertM11Transition } from "../work/state-machines.js";

import { OutboxError } from "./errors.js";
import type {
  ClaimOutboxInput,
  ClaimedOutboxResult,
  CreateOutboxServiceOptions,
  DeliveryRecord,
  OutboxIdentity,
  OutboxMutationResult,
  OutboxRecord,
  SettleOutboxInput,
} from "./types.js";

interface OutboxRow extends OutboxRecord {}
interface DeliveryRow extends DeliveryRecord {}

const OUTBOX_SELECT = `
SELECT id, kind, aggregate_kind AS aggregateKind, aggregate_id AS aggregateId,
       destination_reference AS destinationReference, payload_json AS payloadJson,
       payload_digest AS payloadDigest,
       endpoint_idempotency_key AS endpointIdempotencyKey, state,
       attempt_count AS attemptCount, max_attempts AS maxAttempts,
       not_before AS notBefore, claimed_by AS claimedBy,
       claim_expires_at AS claimExpiresAt, claim_epoch AS claimEpoch,
       active_claim_kind AS activeClaimKind,
       recovery_probe_count AS recoveryProbeCount,
       last_error_code AS lastErrorCode,
       version, created_at AS createdAt, updated_at AS updatedAt,
       delivered_at AS deliveredAt
FROM outbox`;

const DELIVERY_SELECT = `
SELECT id, outbox_id AS outboxId, state,
       endpoint_idempotency_key AS endpointIdempotencyKey,
       attempt_count AS attemptCount, active_claim_epoch AS activeClaimEpoch,
       final_disposition AS finalDisposition,
       version, created_at AS createdAt, updated_at AS updatedAt,
       terminal_at AS terminalAt
FROM deliveries`;

function freezeOutbox(row: OutboxRow): OutboxRecord {
  return Object.freeze({ ...row });
}

function freezeDelivery(row: DeliveryRow): DeliveryRecord {
  return Object.freeze({ ...row });
}

function assertIdentity(input: OutboxIdentity): void {
  assertId("request", input.requestId, "invalid_request");
  assertId("correlation", input.correlationId, "invalid_request");
}

function assertClaimant(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new OutboxError("invalid_request", "claimant must be a bounded opaque identifier");
  }
  return value;
}

function assertErrorCode(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(value)) {
    throw new OutboxError("invalid_request", "delivery error code must be a bounded identifier");
  }
  return value;
}

function assertClaimEpoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new OutboxError("invalid_request", "claim epoch must be a positive safe integer");
  }
  return value as number;
}

export function createOutboxService(options: CreateOutboxServiceOptions) {
  const now = options.now ?? (() => new Date());
  if (!Number.isSafeInteger(options.retryBaseMs) || options.retryBaseMs < 100 || options.retryBaseMs > 3_600_000) {
    throw new OutboxError("invalid_request", "retry base must be between 100ms and one hour");
  }

  function read(outboxId: string, deliveryId?: string): OutboxMutationResult {
    const outbox = options.database.readOne<OutboxRow>(`${OUTBOX_SELECT} WHERE id = ?`, outboxId);
    const delivery = deliveryId === undefined
      ? options.database.readOne<DeliveryRow>(`${DELIVERY_SELECT} WHERE outbox_id = ?`, outboxId)
      : options.database.readOne<DeliveryRow>(`${DELIVERY_SELECT} WHERE id = ? AND outbox_id = ?`, deliveryId, outboxId);
    if (!outbox || !delivery) throw new OutboxError("illegal_state", "Outbox delivery binding is unavailable");
    return Object.freeze({ outbox: freezeOutbox(outbox), delivery: freezeDelivery(delivery) });
  }

  function event(
    outbox: OutboxRecord,
    delivery: DeliveryRecord,
    identity: OutboxIdentity,
    at: string,
    state: OutboxRecord["state"],
    deliveryState: DeliveryRecord["state"],
    disposition: string | null,
  ) {
    return {
      type: "activity.updated",
      aggregateKind: "outbox",
      aggregateId: outbox.id,
      aggregateVersion: outbox.version + 1,
      channelId: null,
      actorPrincipalId: null,
      requestId: identity.requestId,
      correlationId: identity.correlationId,
      payload: {
        outboxId: outbox.id,
        deliveryId: delivery.id,
        workId: outbox.aggregateId,
        state,
        deliveryState,
        attemptCount: outbox.attemptCount,
        endpointIdempotencyKey: outbox.endpointIdempotencyKey,
        disposition,
      },
      createdAt: at,
    } as const;
  }

  return Object.freeze({
    claimNext(input: ClaimOutboxInput): ClaimedOutboxResult | null {
      assertExactKeys(
        input,
        ["claimant", "claimTtlMs", "requestId", "correlationId"],
        "invalid_request",
        "Outbox claim",
      );
      const claimant = assertClaimant(input.claimant);
      assertIdentity(input);
      if (!Number.isSafeInteger(input.claimTtlMs) || input.claimTtlMs < 1_000 || input.claimTtlMs > 86_400_000) {
        throw new OutboxError("invalid_request", "claim TTL must be between one second and one day");
      }
      const at = canonicalTimestamp(now());
      const outbox = options.database.readOne<OutboxRow>(
        `${OUTBOX_SELECT}
         WHERE state IN ('pending', 'retry') AND not_before <= ?
           AND (attempt_count < max_attempts OR recovery_probe_count < 1)
         ORDER BY not_before, id LIMIT 1`,
        at,
      );
      if (!outbox) return null;
      const frozenOutbox = freezeOutbox(outbox);
      const delivery = options.database.readOne<DeliveryRow>(`${DELIVERY_SELECT} WHERE outbox_id = ?`, outbox.id);
      if (!delivery) throw new Error("Outbox is missing its Delivery row");
      const frozenDelivery = freezeDelivery(delivery);
      const expectedDelivery = outbox.state === "pending" ? "pending" : "retry_wait";
      if (delivery.state !== expectedDelivery) {
        throw new OutboxError("illegal_state", "Outbox and Delivery states are inconsistent");
      }
      assertM11Transition("outbox", outbox.state, "claimed");
      assertM11Transition("delivery", delivery.state, "sending");
      const expiresAt = canonicalTimestamp(new Date(now().valueOf() + input.claimTtlMs));
      const claimKind = outbox.attemptCount >= outbox.maxAttempts ? "duplicate_probe" : "ordinary";
      const claimEpoch = outbox.claimEpoch + 1;
      const outboxAttemptCount = outbox.attemptCount + (claimKind === "ordinary" ? 1 : 0);
      const recoveryProbeCount = outbox.recoveryProbeCount + (claimKind === "duplicate_probe" ? 1 : 0);
      const ordinal = delivery.attemptCount + 1;
      options.database.mutateWithEvent((transaction) => {
        transaction.run(
          `UPDATE outbox SET state = 'claimed', attempt_count = ?,
             claimed_by = ?, claim_expires_at = ?, claim_epoch = ?,
             active_claim_kind = ?, recovery_probe_count = ?, updated_at = ?,
             version = version + 1 WHERE id = ?`,
          outboxAttemptCount, claimant, expiresAt, claimEpoch, claimKind,
          recoveryProbeCount, at, outbox.id,
        );
        transaction.run(
          `UPDATE deliveries SET state = 'sending', attempt_count = attempt_count + 1,
             active_claim_epoch = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
          claimEpoch, at, delivery.id,
        );
        transaction.run(
          `INSERT INTO delivery_attempts (
            delivery_id, ordinal, claim_epoch, claim_kind,
            endpoint_idempotency_key, claimant, started_at,
            settled_at, disposition, error_code
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
          delivery.id, ordinal, claimEpoch, claimKind,
          outbox.endpointIdempotencyKey, claimant, at,
        );
        return {
          value: undefined,
          event: event(
            freezeOutbox({
              ...frozenOutbox,
              attemptCount: outboxAttemptCount,
              claimEpoch,
              activeClaimKind: claimKind,
              recoveryProbeCount,
            }),
            freezeDelivery({ ...frozenDelivery, attemptCount: ordinal }),
            input,
            at,
            "claimed",
            "sending",
            null,
          ),
        };
      });
      const current = read(outbox.id, delivery.id);
      let payload: unknown;
      try {
        payload = JSON.parse(current.outbox.payloadJson);
      } catch {
        throw new Error("claimed Outbox payload is malformed");
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("claimed Outbox payload is not an object");
      }
      return Object.freeze({
        ...current,
        claimEpoch: current.outbox.claimEpoch,
        claimKind: current.outbox.activeClaimKind!,
        endpointIdempotencyKey: current.outbox.endpointIdempotencyKey,
        payload: Object.freeze(payload as Record<string, unknown>),
      });
    },

    settle(input: SettleOutboxInput): OutboxMutationResult {
      assertExactKeys(
        input,
        ["outboxId", "deliveryId", "claimant", "claimEpoch", "endpointIdempotencyKey", "disposition", "errorCode", "requestId", "correlationId"],
        "invalid_request",
        "Outbox settlement",
      );
      const outboxId = assertId("outbox", input.outboxId, "invalid_request");
      const deliveryId = assertId("delivery", input.deliveryId, "invalid_request");
      const claimant = assertClaimant(input.claimant);
      const claimEpoch = assertClaimEpoch(input.claimEpoch);
      const endpointIdempotencyKey = assertDigest(
        input.endpointIdempotencyKey,
        "invalid_request",
        "endpoint idempotency key",
      );
      assertIdentity(input);
      if (!["accepted", "duplicate_accepted", "retryable_failure", "permanent_failure"].includes(input.disposition)) {
        throw new OutboxError("invalid_request", "unknown delivery disposition");
      }
      const errorCode = input.disposition === "accepted" || input.disposition === "duplicate_accepted"
        ? input.errorCode === null ? null : (() => { throw new OutboxError("invalid_request", "accepted delivery cannot carry an error"); })()
        : assertErrorCode(input.errorCode);
      const at = canonicalTimestamp(now());
      const current = read(outboxId, deliveryId);
      if (
        current.outbox.state !== "claimed" || current.delivery.state !== "sending" ||
        current.outbox.claimedBy !== claimant ||
        current.outbox.claimEpoch !== claimEpoch ||
        current.delivery.activeClaimEpoch !== claimEpoch ||
        current.outbox.endpointIdempotencyKey !== endpointIdempotencyKey ||
        current.delivery.endpointIdempotencyKey !== endpointIdempotencyKey
      ) {
        throw new OutboxError("illegal_state", "settlement does not bind the current claim");
      }
      if (current.outbox.claimExpiresAt === null || at >= current.outbox.claimExpiresAt) {
        throw new OutboxError("illegal_state", "settlement claim has expired");
      }
      const accepted = input.disposition === "accepted" || input.disposition === "duplicate_accepted";
      const exhausted = input.disposition === "retryable_failure" &&
        current.outbox.attemptCount >= current.outbox.maxAttempts;
      const permanent = input.disposition === "permanent_failure" || exhausted;
      const outboxState = accepted ? "delivered" : permanent ? "dead_letter" : "retry";
      const deliveryState = accepted ? "delivered" : permanent ? "permanent_failure" : "retry_wait";
      assertM11Transition("outbox", "claimed", outboxState);
      assertM11Transition("delivery", "sending", deliveryState);
      const delay = options.retryBaseMs * (2 ** Math.max(0, current.outbox.attemptCount - 1));
      const notBefore = accepted || permanent
        ? current.outbox.notBefore
        : canonicalTimestamp(new Date(now().valueOf() + Math.min(delay, 3_600_000)));
      const finalDisposition = accepted
        ? input.disposition
        : permanent
          ? exhausted ? "retry_budget_exhausted" : "permanent_failure"
          : null;
      options.database.mutateWithEvent((transaction) => {
        transaction.run(
          `UPDATE delivery_attempts SET settled_at = ?, disposition = ?, error_code = ?
           WHERE delivery_id = ? AND claim_epoch = ? AND disposition IS NULL`,
          at, input.disposition, errorCode, current.delivery.id, claimEpoch,
        );
        transaction.run(
          `UPDATE outbox SET state = ?, not_before = ?, claimed_by = NULL,
             claim_expires_at = NULL, active_claim_kind = NULL,
             last_error_code = ?, updated_at = ?,
             delivered_at = ?, version = version + 1 WHERE id = ?`,
          outboxState, notBefore, errorCode, at, accepted ? at : null, current.outbox.id,
        );
        transaction.run(
          `UPDATE deliveries SET state = ?, active_claim_epoch = NULL,
             final_disposition = ?, updated_at = ?,
             terminal_at = ?, version = version + 1 WHERE id = ?`,
          deliveryState, finalDisposition, at, accepted || permanent ? at : null,
          current.delivery.id,
        );
        return {
          value: undefined,
          event: event(
            current.outbox,
            current.delivery,
            input,
            at,
            outboxState,
            deliveryState,
            input.disposition,
          ),
        };
      });
      return read(current.outbox.id, current.delivery.id);
    },

    reclaimStaleClaims(identity: OutboxIdentity): number {
      assertExactKeys(identity, ["requestId", "correlationId"], "invalid_request", "Outbox reclaim");
      assertIdentity(identity);
      const at = canonicalTimestamp(now());
      const stale = options.database.readAll<OutboxRow>(
        `${OUTBOX_SELECT}
         WHERE state = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?
         ORDER BY claim_expires_at, id`,
        at,
      );
      for (const row of stale) {
        const outbox = freezeOutbox(row);
        const deliveryRow = options.database.readOne<DeliveryRow>(`${DELIVERY_SELECT} WHERE outbox_id = ?`, outbox.id);
        if (!deliveryRow || deliveryRow.state !== "sending") {
          throw new OutboxError("illegal_state", "stale Outbox claim has inconsistent Delivery state");
        }
        const delivery = freezeDelivery(deliveryRow);
        const exhaustedUnknown = outbox.activeClaimKind === "duplicate_probe" ||
          (outbox.attemptCount >= outbox.maxAttempts && outbox.recoveryProbeCount >= 1);
        const outboxState = exhaustedUnknown ? "dead_letter" : "retry";
        const deliveryState = exhaustedUnknown ? "permanent_failure" : "retry_wait";
        assertM11Transition("outbox", "claimed", outboxState);
        assertM11Transition("delivery", "sending", deliveryState);
        options.database.mutateWithEvent((transaction) => {
          transaction.run(
            `UPDATE delivery_attempts SET settled_at = ?, disposition = 'claim_expired',
               error_code = 'claim_expired'
             WHERE delivery_id = ? AND claim_epoch = ? AND disposition IS NULL`,
            at, delivery.id, outbox.claimEpoch,
          );
          transaction.run(
            `UPDATE outbox SET state = ?, not_before = ?, claimed_by = NULL,
               claim_expires_at = NULL, active_claim_kind = NULL,
               last_error_code = 'claim_expired',
               updated_at = ?, version = version + 1 WHERE id = ?`,
            outboxState, at, at, outbox.id,
          );
          transaction.run(
            `UPDATE deliveries SET state = ?, active_claim_epoch = NULL,
               final_disposition = ?, updated_at = ?,
               terminal_at = ?, version = version + 1 WHERE id = ?`,
            deliveryState,
            exhaustedUnknown ? "recovery_probe_exhausted" : null,
            at,
            exhaustedUnknown ? at : null,
            delivery.id,
          );
          return {
            value: undefined,
            event: event(outbox, delivery, identity, at, outboxState, deliveryState, "claim_expired"),
          };
        });
      }
      return stale.length;
    },
  });
}
