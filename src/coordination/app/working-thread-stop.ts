import type { CoordinationTurnOrigin } from "../../agent/types.js";
import type { ResidentCoordinationAdapter, ResidentUdsAgentPort } from "../../coordination-adapter/index.js";
import type { M11Database } from "../work/types.js";
import type { createWorkService } from "../work/service.js";
import type { createLeaseService } from "../leases/index.js";

/** Shared live and recovery stop path. A revoked lease alone never proves stop. */
export function createWorkingThreadStop(options: {
  database: M11Database;
  work: ReturnType<typeof createWorkService>;
  leases: ReturnType<typeof createLeaseService>;
  residentAdapters: ReadonlyMap<string, Pick<ResidentCoordinationAdapter, "stopRevoked">>;
  residentAgents: ReadonlyMap<string, Pick<ResidentUdsAgentPort, "stopExact">>;
  awaitSettlement?(workId: string): Promise<void>;
}) {
  const { database, work, leases } = options;
  return async (workId: string, identity: { requestId: string; correlationId: string }): Promise<void> => {
      const current = leases.current(workId);
      const slug = database.readOne<{ binding: string }>(
        "SELECT resident_binding AS binding FROM bots WHERE principal_id = ?", current.work.targetPrincipalId,
      )?.binding;
      if (!slug || current.work.state !== "cancelling" || current.lease.state !== "revoked" || current.attempt.state !== "cancel_requested") return;
      const binding = { workId: workId, attemptId: current.attempt.id, leaseId: current.lease.id,
        holderPrincipalId: current.attempt.holderPrincipalId, holderInstanceId: current.attempt.holderInstanceId,
        authorityReference: current.attempt.authorityReference, fencingToken: current.attempt.fencingToken,
        requestId: identity.requestId, correlationId: identity.correlationId };
      if (work.getPlannedInvocation(workId) && work.getInvocationExecution(workId) === null) {
        // No execution permission was ever issued. Revocation fences any pending
        // start request, so there can be no selected-tool effect to stop.
        const { authorityReference, ...terminalBinding } = binding;
        leases.terminalize({ ...terminalBinding, receipt: { status: "cancelled",
          sourceReference: authorityReference, resultDigest: null, artifactIds: [],
          timestamp: current.lease.endedAt ?? new Date().toISOString() } });
        return;
      }
      let stopped = await options.residentAdapters.get(slug)?.stopRevoked(binding);
      if (!stopped) {
        const origin: CoordinationTurnOrigin = { kind: "coordination", ...binding,
          channelId: current.work.channelId, originMessageId: current.work.originMessageId,
          roundId: current.work.roundId };
        stopped = (await options.residentAgents.get(slug)?.stopExact(
          `coordination:${current.work.channelId}:${workId}`, origin, identity.correlationId,
        ))?.stopped;
        if (stopped && work.get(workId)?.state === "cancelling") {
          // stopExact acknowledges only an exact durable stopped terminal envelope.
          const { authorityReference, ...terminalBinding } = binding;
          leases.terminalize({ ...terminalBinding, receipt: { status: "cancelled",
            sourceReference: binding.authorityReference, resultDigest: null, artifactIds: [],
            timestamp: current.lease.endedAt ?? new Date().toISOString() } });
        }
      }
      if (stopped) {
        // The adapter records the resident's terminal receipt after actual execution
        // exits. Do not mistake an accepted abort request for completed cancellation.
        await Promise.race([options.awaitSettlement?.(workId), new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 5_000); timer.unref?.();
        })]);
      }
  };
}
