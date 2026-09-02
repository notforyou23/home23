import { LeaseError, type createLeaseService } from "../coordination/leases/index.js";
import type {
  ResidentCoordinationPort,
  ResidentLeaseBinding,
  ResidentTerminalReceipt,
} from "./types.js";

function leaseBinding(binding: ResidentLeaseBinding) {
  return {
    workId: binding.workId,
    attemptId: binding.attemptId,
    leaseId: binding.leaseId,
    holderPrincipalId: binding.holderPrincipalId,
    holderInstanceId: binding.holderInstanceId,
    fencingToken: binding.fencingToken,
    requestId: binding.requestId,
    correlationId: binding.correlationId,
  };
}

/** Exact shape adapter from M13 callbacks to M11's strict fenced API. */
export function createM11ResidentCoordinationPort(
  leases: ReturnType<typeof createLeaseService>,
): ResidentCoordinationPort {
  return Object.freeze({
    assertCurrent(binding: ResidentLeaseBinding) {
      const current = leases.assertCurrent(leaseBinding(binding));
      const executable =
        (current.work.state === "leased" && current.attempt.state === "offered" && current.lease.state === "offered") ||
        (current.work.state === "leased" && current.attempt.state === "accepted" && current.lease.state === "active") ||
        (current.work.state === "running" && current.attempt.state === "running" && current.lease.state === "active");
      if (!executable) throw new LeaseError("stale_fence", "resident Lease is no longer executable");
    },
    cancellationState(binding: ResidentLeaseBinding) {
      const current = leases.assertCurrent(leaseBinding(binding));
      const cancellationRequested =
        current.work.state === "cancelling" &&
        current.attempt.state === "cancel_requested" &&
        current.lease.state === "revoked";
      const cancellationCompleted =
        current.work.state === "cancelled" &&
        current.attempt.state === "cancelled" &&
        current.lease.state === "revoked";
      if ((!cancellationRequested && !cancellationCompleted) || current.lease.endedAt === null) return null;
      return Object.freeze({ timestamp: current.lease.endedAt });
    },
    assertCompleted(binding: ResidentLeaseBinding, resultDigest?: string) {
      const completed = leases.assertCompleted(leaseBinding(binding), resultDigest);
      return Object.freeze({
        status: completed.receipt.status,
        sourceReference: completed.receipt.sourceReference,
        resultDigest: completed.receipt.resultDigest,
        artifactIds: Object.freeze([...completed.receipt.artifactIds]),
        timestamp: completed.receipt.createdAt,
      });
    },
    accept(binding: ResidentLeaseBinding) { leases.accept(leaseBinding(binding)); },
    start(binding: ResidentLeaseBinding) { leases.start(leaseBinding(binding)); },
    reattach(binding: ResidentLeaseBinding) {
      const exact = leaseBinding(binding);
      const current = leases.assertCurrent(exact);
      if (current.work.state !== "running" || current.attempt.state !== "running" || current.lease.state !== "active") {
        throw new Error("only an exact running resident Lease may reattach");
      }
      leases.heartbeat({ ...exact, extendMs: 60_000 });
    },
    revoke(binding: ResidentLeaseBinding & { reasonCode: string }) {
      leases.revoke({ ...leaseBinding(binding), reasonCode: binding.reasonCode });
    },
    terminalize(input: ResidentLeaseBinding & { receipt: ResidentTerminalReceipt }) {
      const terminal = leases.terminalize({ ...leaseBinding(input), receipt: input.receipt });
      return Object.freeze({
        status: terminal.receipt.status,
        sourceReference: terminal.receipt.sourceReference,
        resultDigest: terminal.receipt.resultDigest,
        artifactIds: Object.freeze([...terminal.receipt.artifactIds]),
        timestamp: terminal.receipt.createdAt,
      });
    },
  });
}
