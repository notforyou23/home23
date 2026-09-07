import type { MessagingActorContext } from "../channels/index.js";
import { assertCoordinationId } from "../ids/index.js";
import type { createLeaseService } from "../leases/index.js";
import { LeaseError } from "../leases/index.js";
import { canonicalTimestamp, sha256 } from "./canonical.js";
import { WorkError } from "./errors.js";
import type { M11Database, WorkRecord } from "./types.js";
import type { createWorkService } from "./service.js";
import { createResidentAssignments } from '../app/resident-assignments.js';

type WorkService = ReturnType<typeof createWorkService>;

export const PRODUCT_WORK_THREAD_KIND = "resident_work_thread" as const;

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
  conversationId: string;
  originMessageId: string | null;
  accountableResident: {
    principalId: string;
    residentBinding: string;
    displayName: string;
  };
  kind: string;
  title: string;
  summary: string;
  state: "queued" | "running" | "stopping" | "succeeded" | "failed" | "cancelled";
  assignmentState?: string;
  assignmentSummary?: string | null;
  cancelAvailable: boolean;
  retryAvailable: boolean;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
  retryOfWorkId: string | null;
  retriedByWorkIds: readonly string[];
  finalResultMessageId: string | null;
}

export interface ProductWorkListProjection {
  works: readonly ProductWorkProjection[];
  nextCursor: string | null;
}

export interface ProductWorkMutationResult {
  outcome: "cancelled" | "cancellation_requested" | "retried";
  replayed: boolean;
  work: ProductWorkProjection;
}

export interface ProductWorkControlPort {
  list(input: {
    context: MessagingActorContext;
    conversationId?: string;
    limit?: number;
    cursor?: string;
  }): ProductWorkListProjection;
  get(input: { context: MessagingActorContext; workId: string }): ProductWorkProjection;
  cancel(input: { context: MessagingActorContext; workId: string; idempotencyKey: string }): ProductWorkMutationResult;
  retry(input: { context: MessagingActorContext; workId: string; idempotencyKey: string }): ProductWorkMutationResult;
  recoverCancellations(input: { requestId: string; correlationId: string }): {
    discovered: number;
    completed: number;
  };
}

interface WorkPresentationRow {
  conversationId: string;
  originText: string | null;
  targetPrincipalId: string;
  residentBinding: string;
  displayName: string;
  finalResultMessageId: string | null;
  durableTitle: string | null;
  durableSummary: string | null;
}

function safeWorkText(value: string | null, maximum: number): string {
  if (!value) return "";
  const collapsed = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (collapsed.length <= maximum) return collapsed;
  return `${collapsed.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

function presentation(database: M11Database, work: WorkRecord): WorkPresentationRow {
  const row = database.readOne<WorkPresentationRow>(
    `SELECT h.id AS conversationId,
            CASE WHEN origin.author_principal_id = w.principal_id
                       AND origin.author_kind = 'owner'
                       AND origin.stored_visibility = 'visible'
                       AND NOT EXISTS (
                         SELECT 1 FROM messages origin_tombstone
                          WHERE origin_tombstone.tombstones_message_id = origin.id
                       )
                 THEN origin.body_text ELSE NULL END AS originText,
            bot.principal_id AS targetPrincipalId,
            bot.resident_binding AS residentBinding,
            bot.name AS displayName,
            product.title AS durableTitle,
            product.summary AS durableSummary,
            (SELECT result.id FROM messages result
              WHERE result.work_id = w.id AND result.kind = 'result'
                AND result.stored_visibility = 'visible'
                AND NOT EXISTS (
                  SELECT 1 FROM messages tombstone
                   WHERE tombstone.tombstones_message_id = result.id
                )
              ORDER BY result.channel_sequence ASC, result.id ASC LIMIT 1
            ) AS finalResultMessageId
       FROM works w
       JOIN conversation_handles h ON h.channel_id = w.channel_id
       JOIN bots bot ON bot.principal_id = w.target_principal_id
       LEFT JOIN work_thread_presentations product ON product.work_id = w.id
       LEFT JOIN messages origin ON origin.id = w.origin_message_id
      WHERE w.id = ?`,
    work.id,
  );
  if (!row) throw new Error("durable Work is missing its conversation or accountable resident");
  return row;
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

function isWorkingThread(database: M11Database, work: WorkRecord): boolean {
  return work.kind === PRODUCT_WORK_THREAD_KIND || !!database.readOne('SELECT work_id FROM work_thread_presentations WHERE work_id = ?',work.id);
}
function assertAccess(database: M11Database, work: WorkRecord, context: MessagingActorContext): void {
  const assignedResident = (context.identity.kind === 'resident' || context.identity.kind === 'on_demand_bot') && work.targetPrincipalId === context.principalId;
  if (work.principalId !== context.principalId && !assignedResident && !(context.identity.kind === 'owner' && database.readOne('SELECT id FROM channels WHERE id = ? AND owner_principal_id = ?',work.channelId,context.principalId))) throw new WorkError("ineligible", "Work is outside the authenticated principal scope");
  const member = database.readOne<{ count: number }>(
    "SELECT count(*) AS count FROM channel_members WHERE channel_id = ? AND principal_id = ? AND active = 1",
    work.channelId, context.principalId,
  );
  if (member?.count !== 1) throw new WorkError("ineligible", "Work is outside the authenticated Channel scope");
}

function projection(database: M11Database, work: WorkRecord): ProductWorkProjection {
  const shown = presentation(database, work);
  const retry = database.readOne<{ sourceWorkId: string }>(
    "SELECT source_work_id AS sourceWorkId FROM work_retry_provenance WHERE retry_work_id = ?",
    work.id,
  );
  const retriedByWorkIds = database.readAll<{ retryWorkId: string }>(
    "SELECT retry_work_id AS retryWorkId FROM work_retry_provenance WHERE source_work_id = ? ORDER BY created_at, retry_work_id",
    work.id,
  ).map((row) => row.retryWorkId);
  const state = work.state === "leased" ? "queued" : work.state === "running" ? "running"
    : work.state === "cancelling" ? "stopping" : work.state;
  const expired = work.state === "queued" && work.currentAttemptId === null && database.readOne<{ state: string }>(
    "SELECT state FROM attempts WHERE work_id = ? ORDER BY ordinal DESC LIMIT 1", work.id,
  )?.state === "expired";
  const summary = safeWorkText(shown.durableSummary ?? shown.originText, 280);
  const title = safeWorkText(shown.durableTitle ?? shown.originText, 88) || `${shown.displayName} work`;
  const workingThread = isWorkingThread(database,work);
  const assessment = workingThread ? createResidentAssignments(database).latest(work.id) : null;
  return Object.freeze({
    id: work.id,
    channelId: work.channelId,
    conversationId: shown.conversationId,
    originMessageId: work.originMessageId,
    accountableResident: Object.freeze({
      principalId: shown.targetPrincipalId,
      residentBinding: shown.residentBinding,
      displayName: shown.displayName,
    }),
    // Product clients identify visible thread rows by this stable presentation kind.
    // The canonical Work retains channel.bot_turn for Round recovery.
    kind: workingThread ? PRODUCT_WORK_THREAD_KIND : work.kind,
    title,
    summary: summary || title,
    state,
    ...(workingThread ? {
      assignmentState: createResidentAssignments(database).presentationState(work.id, work.state, assessment),
      assignmentSummary: assessment?.summary ?? null,
    } : {}),
    cancelAvailable: work.state === "queued" || work.state === "running" || (workingThread && work.state === "leased"),
    retryAvailable: !workingThread && (work.state === "failed" || work.state === "cancelled" || expired),
    createdAt: work.createdAt, updatedAt: work.updatedAt, terminalAt: work.terminalAt,
    retryOfWorkId: retry?.sourceWorkId ?? null,
    retriedByWorkIds: Object.freeze(retriedByWorkIds),
    finalResultMessageId: shown.finalResultMessageId,
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
    list({ context, conversationId, limit = 50, cursor }) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new WorkError("invalid_request", "Work list limit must be between 1 and 100");
      }
      if (cursor !== undefined && !/^work-offset:[0-9]{1,7}$/.test(cursor)) throw new WorkError("invalid_request", "Invalid Work cursor");
      const offset = cursor ? Number(cursor.slice("work-offset:".length)) : 0;
      if (conversationId !== undefined) assertCoordinationId("conversation", conversationId);
      const rows = options.database.readAll<{ id: string }>(
        `SELECT w.id
           FROM works w
           JOIN conversation_handles h ON h.channel_id = w.channel_id
          WHERE (w.principal_id = ? OR EXISTS(SELECT 1 FROM channels c WHERE c.id=w.channel_id AND c.owner_principal_id=?))
            AND (w.kind = '${PRODUCT_WORK_THREAD_KIND}' OR EXISTS(SELECT 1 FROM work_thread_presentations p WHERE p.work_id=w.id))
            AND EXISTS (
              SELECT 1 FROM channel_members member
               WHERE member.channel_id = w.channel_id
                 AND member.principal_id = ? AND member.active = 1
            )
            AND (? IS NULL OR h.id = ?)
          ORDER BY CASE WHEN w.state IN ('queued', 'leased', 'running', 'cancelling') THEN 0 ELSE 1 END,
                   w.updated_at DESC, w.id DESC
          LIMIT ? OFFSET ?`,
        context.principalId,
        context.identity.kind === 'owner' ? context.principalId : '',
        context.principalId,
        conversationId ?? null,
        conversationId ?? null,
        limit + 1,
        offset,
      );
      const works = rows.slice(0, limit).map(({ id }) => {
        const work = options.work.get(id);
        if (!work) throw new Error("listed Work disappeared during projection");
        return projection(options.database, work);
      });
      return Object.freeze({ works: Object.freeze(works), nextCursor: rows.length > limit ? `work-offset:${offset + limit}` : null });
    },
    recoverCancellations(identity) {
      let discovered = 0;
      let completed = 0;
      for (;;) {
        const pending = options.database.readAll<{ id: string }>(
          `SELECT id FROM works WHERE state = 'cancelling'
             AND kind <> '${PRODUCT_WORK_THREAD_KIND}' AND NOT EXISTS(SELECT 1 FROM work_thread_presentations p WHERE p.work_id=works.id) ORDER BY created_at, id LIMIT 100`,
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
      if (isWorkingThread(options.database,work)) {
        if (work.state === "cancelled") {
          return { outcome: "cancelled", replayed: true, work: projection(options.database, work) };
        }
        if (work.state === "cancelling") {
          return { outcome: "cancellation_requested", replayed: true, work: projection(options.database, work) };
        }
        if (work.state === "queued" && work.currentAttemptId === null) {
          const result = options.work.cancelQueued({ workId, actorPrincipalId: context.principalId,
            reasonCode: "product_cancelled", sourceReference: "product:conversation",
            timestamp: canonicalTimestamp(now()), requestId: context.requestId, correlationId: context.correlationId });
          return { outcome: "cancelled", replayed: result.replayed, work: projection(options.database, result.work) };
        }
        if (work.state === "leased") {
          const exact = options.leases.current(workId);
          const binding = { workId, attemptId: exact.attempt.id, leaseId: exact.lease.id,
            holderPrincipalId: exact.attempt.holderPrincipalId, holderInstanceId: exact.attempt.holderInstanceId,
            fencingToken: exact.attempt.fencingToken, reasonCode: "product_cancelled_before_start",
            requestId: context.requestId, correlationId: context.correlationId };
          if (exact.attempt.state === "offered") options.leases.reject(binding);
          else options.leases.expire(binding);
          const cancelled = options.work.cancelQueued({ workId, actorPrincipalId: context.principalId,
            reasonCode: "product_cancelled", sourceReference: "product:conversation",
            timestamp: canonicalTimestamp(now()), requestId: context.requestId, correlationId: context.correlationId });
          return { outcome: "cancelled", replayed: cancelled.replayed, work: projection(options.database, cancelled.work) };
        }
        if (work.state !== "running") {
          throw new WorkError("illegal_state", "Working Thread cannot be stopped from its current state");
        }
        const current = execution(options.database, workId);
        if (!current || current.attemptState !== "running" || current.leaseState !== "active") {
          throw new LeaseError("stale_fence", "current execution fence is unavailable");
        }
        const result = options.leases.revoke({ workId, attemptId: current.attemptId, leaseId: current.leaseId,
          holderPrincipalId: current.holderPrincipalId, holderInstanceId: current.holderInstanceId,
          fencingToken: current.fencingToken, reasonCode: "product_cancelled",
          requestId: context.requestId, correlationId: context.correlationId });
        return {
          outcome: "cancellation_requested",
          replayed: false,
          work: projection(options.database, result.work),
        };
      }
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
      if (isWorkingThread(options.database,source)) {
        throw new WorkError("illegal_state", "Working Thread retry is unavailable until execution dispatch is joined");
      }
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
