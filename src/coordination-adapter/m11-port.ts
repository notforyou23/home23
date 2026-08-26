import type { createLeaseService } from "../coordination/leases/index.js";
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
    assertCurrent(binding: ResidentLeaseBinding) { leases.assertCurrent(leaseBinding(binding)); },
    assertCompleted(binding: ResidentLeaseBinding, resultDigest?: string) {
      leases.assertCompleted(leaseBinding(binding), resultDigest);
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
      return leases.terminalize({ ...leaseBinding(input), receipt: input.receipt });
    },
  });
}
