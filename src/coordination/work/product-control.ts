import type { MessagingActorContext } from "../channels/index.js";
import type { createLeaseService } from "../leases/index.js";
import { LeaseError } from "../leases/index.js";
import { canonicalTimestamp, sha256 } from "./canonical.js";
import { WorkError } from "./errors.js";
import type { M11Database, WorkRecord } from "./types.js";
import type { createWorkService } from "./service.js";

type WorkService = ReturnType<typeof createWorkService>;

interface ExecutionRow {
  attemptId: string;
  leaseId: string;
  holderPrincipalId: string;
  holderInstanceId: string;
  authorityReference: string;
  fencingToken: number;
  attemptState: string;
  leaseState: string;
  leaseEndedAt: string | null;
}

export interface ProductWorkProjection {
  id: string;
  channelId: string;
  state: "queued" | "running" | "stopping" | "succeeded" | "failed" | "cancelled";
  cancelAvailable: boolean;
  retryAvailable: boolean;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
  retryOfWorkId: string | null;
}

export interface ProductWorkMutationResult {
  outcome: "cancelled" | "cancellation_requested" | "retried";
  replayed: boolean;
  work: ProductWorkProjection;
}

export interface ProductWorkControlPort {
  get(input: { context: MessagingActorContext; workId: string }): ProductWorkProjection;
  cancel(input: { context: MessagingActorContext; workId: string; idempotencyKey: string }): ProductWorkMutationResult;
  retry(input: { context: MessagingActorContext; workId: string; idempotencyKey: string }): ProductWorkMutationResult;
  recoverCancellations(input: { requestId: string; correlationId: string }): {
    discovered: number;
    completed: number;
  };
}

function execution(database: M11Database, workId: string): ExecutionRow | undefined {
  return database.readOne<ExecutionRow>(
    `SELECT a.id AS attemptId, l.id AS leaseId,
            a.holder_principal_id AS holderPrincipalId,
            a.holder_instance_id AS holderInstanceId,
            a.authority_reference AS authorityReference,
            a.fencing_token AS fencingToken, a.state AS attemptState,
            l.state AS leaseState, l.ended_at AS leaseEndedAt
       FROM works w JOIN attempts a ON a.id = w.current_attempt_id
       JOIN leases l ON l.attempt_id = a.id WHERE w.id = ?`,
    workId,
  );
}

function assertAccess(database: M11Database, work: WorkRecord, context: MessagingActorContext): void {
  if (work.principalId !== context.principalId) throw new WorkError("ineligible", "Work is outside the authenticated principal scope");
  const member = database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM channel_members WHERE channel_id = ? AND principal_id = ? AND active = 1",
    work.channelId, context.principalId,
  );
  if (member?.count !== 1) throw new WorkError("ineligible", "Work is outside the authenticated Channel scope");
}

function projection(database: M11Database, work: WorkRecord): ProductWorkProjection {
  const retry = database.readOne<{ sourceWorkId: string }>(
    "SELECT source_work_id AS sourceWorkId FROM work_retry_provenance WHERE retry_work_id = ?",
    work.id,
  );
  const state = work.state === "leased" || work.state === "running" ? "running"
    : work.state === "cancelling" ? "stopping" : work.state;
  const expired = work.state === "queued" && work.currentAttemptId === null && database.readOne<{ state: string }>(
    "SELECT state FROM attempts WHERE work_id = ? ORDER BY ordinal DESC LIMIT 1", work.id,
  )?.state === "expired";
  return Object.freeze({
    id: work.id, channelId: work.channelId, state,
    cancelAvailable: work.state === "queued" || work.state === "running",
    retryAvailable: work.state === "failed" || work.state === "cancelled" || expired,
    createdAt: work.createdAt, updatedAt: work.updatedAt, terminalAt: work.terminalAt,
    retryOfWorkId: retry?.sourceWorkId ?? null,
  });
}

export function createProductWorkControl(options: {
  database: M11Database;
  work: WorkService;
  leases: ReturnType<typeof createLeaseService>;
  now?: () => Date;
}): ProductWorkControlPort {
  const now = options.now ?? (() => new Date());
  const load = (workId: string, context: MessagingActorContext) => {
    const work = options.work.get(workId);
    if (!work) throw new WorkError("not_found", "Work was not found");
    assertAccess(options.database, work, context);
    return work;
  };
  const completeCancellation = (
    work: WorkRecord,
    identity: Pick<MessagingActorContext, "requestId" | "correlationId">,
  ): WorkRecord => {
    const current = execution(options.database, work.id);
    if (
      !current || current.attemptState !== "cancel_requested" ||
      current.leaseState !== "revoked" || current.leaseEndedAt === null
    ) {
      throw new LeaseError("stale_fence", "cancelled execution fence is unavailable");
    }
    return options.leases.terminalize({
      workId: work.id,
      attemptId: current.attemptId,
      leaseId: current.leaseId,
      holderPrincipalId: current.holderPrincipalId,
      holderInstanceId: current.holderInstanceId,
      fencingToken: current.fencingToken,
      requestId: identity.requestId,
      correlationId: identity.correlationId,
      receipt: {
        status: "cancelled",
        sourceReference: current.authorityReference,
        resultDigest: null,
        artifactIds: [],
        timestamp: current.leaseEndedAt,
      },
    }).work;
  };
  const service: ProductWorkControlPort = {
    recoverCancellations(identity) {
      let discovered = 0;
      let completed = 0;
      for (;;) {
        const pending = options.database.readAll<{ id: string }>(
          "SELECT id FROM works WHERE state = 'cancelling' ORDER BY created_at, id LIMIT 100",
        );
        if (pending.length === 0) break;
        discovered += pending.length;
        for (const row of pending) {
          const work = options.work.get(row.id);
          if (!work || work.state !== "cancelling") continue;
          completeCancellation(work, identity);
          completed += 1;
        }
      }
      return Object.freeze({ discovered, completed });
    },
    get({ context, workId }) { return projection(options.database, load(workId, context)); },
    cancel({ context, workId, idempotencyKey }) {
      const work = load(workId, context);
      if (work.state === "cancelled") return { outcome: "cancelled", replayed: true, work: projection(options.database, work) };
      if (work.state === "cancelling") {
        const cancelled = completeCancellation(work, context);
        return { outcome: "cancelled", replayed: true, work: projection(options.database, cancelled) };
      }
      if (work.state === "queued" && work.currentAttemptId === null) {
        const result = options.work.cancelQueued({ workId, actorPrincipalId: context.principalId,
          reasonCode: "product_cancelled", sourceReference: "product:conversation",
          timestamp: canonicalTimestamp(now()), requestId: context.requestId, correlationId: context.correlationId });
        return { outcome: "cancelled", replayed: result.replayed, work: projection(options.database, result.work) };
      }
      if (work.state !== "running") throw new WorkError("illegal_state", "Work cannot be cancelled from its current state");
      const current = execution(options.database, workId);
      if (!current || current.attemptState !== "running" || current.leaseState !== "active") throw new LeaseError("stale_fence", "current execution fence is unavailable");
      const result = options.leases.revoke({ workId, attemptId: current.attemptId, leaseId: current.leaseId,
        holderPrincipalId: current.holderPrincipalId, holderInstanceId: current.holderInstanceId,
        fencingToken: current.fencingToken, reasonCode: "product_cancelled",
        requestId: context.requestId, correlationId: context.correlationId });
      const cancelled = completeCancellation(result.work, context);
      return { outcome: "cancelled", replayed: false, work: projection(options.database, cancelled) };
    },
    retry({ context, workId, idempotencyKey }) {
      let source = load(workId, context);
      if (source.state === "cancelling") source = completeCancellation(source, context);
      const expired = source.state === "queued" && source.currentAttemptId === null && options.database.readOne<{ state: string }>(
        "SELECT state FROM attempts WHERE work_id = ? ORDER BY ordinal DESC LIMIT 1", source.id,
      )?.state === "expired";
      if (expired) source = options.work.cancelQueued({ workId: source.id, actorPrincipalId: context.principalId,
        reasonCode: "retry_expired_attempt", sourceReference: "product:conversation",
        timestamp: canonicalTimestamp(now()), requestId: context.requestId, correlationId: context.correlationId }).work;
      if (source.state !== "failed" && source.state !== "cancelled") throw new WorkError("illegal_state", "only failed, cancelled, or expired Work may be retried");
      const manifest = options.database.readOne<any>(
        `SELECT privacy, channel_id AS channelId, message_refs_json AS messageIds,
                artifact_refs_json AS artifactIds, message_count AS messageCount,
                artifact_count AS artifactCount, channel_watermark AS channelWatermark,
                event_watermark AS eventWatermark, context_digest AS contextDigest,
                source_digest AS sourceDigest FROM context_manifests WHERE id = ?`,
        source.contextManifestId,
      );
      if (!manifest) throw new Error("Work context manifest is unavailable");
      const created = options.work.create({ principalId: context.principalId, targetPrincipalId: source.targetPrincipalId,
        channelId: source.channelId, originMessageId: source.originMessageId, roundId: source.roundId,
        kind: source.kind, idempotencyKey: `retry:${sha256(idempotencyKey)}`, maxAutomaticOffers: source.maxAutomaticOffers,
        manifest: { privacy: "channel_only", channelId: manifest.channelId,
          messageIds: JSON.parse(manifest.messageIds), artifactIds: JSON.parse(manifest.artifactIds),
          counts: { messages: manifest.messageCount, artifacts: manifest.artifactCount },
          watermarks: { channelSequence: manifest.channelWatermark, eventSequence: manifest.eventWatermark },
          digests: { context: manifest.contextDigest, source: manifest.sourceDigest } },
        requestId: context.requestId, correlationId: context.correlationId,
        turnSelection: options.work.getTurnSelection(source.id) });
      const existing = options.database.readOne<{ sourceWorkId: string }>("SELECT source_work_id AS sourceWorkId FROM work_retry_provenance WHERE retry_work_id = ?", created.work.id);
      if (existing && existing.sourceWorkId !== source.id) throw new WorkError("idempotency_conflict", "retry key is bound to different Work");
      if (!existing) options.database.mutateWithEvent((transaction) => {
        transaction.run("INSERT INTO work_retry_provenance (source_work_id, retry_work_id, created_at) VALUES (?, ?, ?)", source.id, created.work.id, created.work.createdAt);
        return { value: undefined, event: { type: "turn.updated", aggregateKind: "workRetry", aggregateId: created.work.id,
          aggregateVersion: 1, channelId: created.work.channelId, actorPrincipalId: context.principalId,
          requestId: context.requestId, correlationId: context.correlationId,
          payload: { workId: created.work.id, state: "queued", retryOfWorkId: source.id }, createdAt: created.work.createdAt } };
      });
      return { outcome: "retried", replayed: created.replayed, work: projection(options.database, created.work) };
    },
  };
  return Object.freeze(service);
}
