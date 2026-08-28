import {
  adaptTrustedM11ActivityFact,
  pageActivity,
  projectTrustedM11Activity,
  type ActivityAudience,
  type ActivityObservedState,
  type ActivityProjection,
  type ActivitySourceWindow,
  type TrustedM11ActivityFact,
} from "../activity/index.js";
import { ActivityReadError } from "../activity/index.js";
import { MessagingError, type MessagingActorContext } from "../channels/index.js";
import type { EventEnvelope, SqliteEventRepository } from "../events/index.js";
import type { MessageProjection } from "../messages/index.js";
import type { M11Database } from "../work/index.js";
import type { CoordinationActivityReadPort } from "./types.js";

interface EventBounds {
  currentSequence: number;
  retainedFloor: number;
  retainedCount: number;
}

interface WorkFactRow {
  id: string;
  targetPrincipalId: string;
  channelId: string;
  roundId: string | null;
  state: ActivityObservedState;
  updatedAt: string;
}

interface AttemptFactRow {
  id: string;
  workId: string;
  authorityReference: string;
  fencingToken: number;
}

interface RoundFactRow {
  id: string;
  channelId: string;
  coordinatorBotId: string;
  state: "open" | "coordinating" | "waiting" | "completed" | "failed" | "cancelled";
  updatedAt: string;
}

interface OutboxFactRow {
  id: string;
  workId: string;
  kind: "work.wake" | "work.terminal";
  updatedAt: string;
}

interface ObservationFactRow {
  id: string;
  workId: string;
  attemptId: string | null;
  authorityReference: string;
  fencingToken: number;
  observationKind: "terminal" | "not_started" | "running" | "rejected_fence";
  outcomeCode: string;
  createdAt: string;
}

const OBSERVED_STATES = new Set<ActivityObservedState>([
  "queued", "leased", "running", "cancelling", "succeeded", "failed", "cancelled",
]);
const TERMINAL_STATES = new Set<ActivityObservedState>([
  "succeeded", "failed", "cancelled",
]);

function stringPayload(event: EventEnvelope, key: string): string {
  const value = event.payload[key];
  if (typeof value !== "string") {
    throw new Error(`Activity fact ${event.id} has no ${key}`);
  }
  return value;
}

function observedPayload(event: EventEnvelope): ActivityObservedState {
  const state = event.payload.state;
  if (typeof state !== "string" || !OBSERVED_STATES.has(state as ActivityObservedState)) {
    throw new Error(`Activity fact ${event.id} has an invalid Work state`);
  }
  return state as ActivityObservedState;
}

function terminalReason(
  event: EventEnvelope,
  state: ActivityObservedState,
): string | null {
  if (!TERMINAL_STATES.has(state)) return null;
  return stringPayload(event, "reasonCode");
}

function safeCurrentState(value: string, label: string): ActivityObservedState {
  if (!OBSERVED_STATES.has(value as ActivityObservedState)) {
    throw new Error(`${label} has an invalid retained Work state`);
  }
  return value as ActivityObservedState;
}

/**
 * Complete trusted M08/M11 Activity read adapter. It rebuilds only from the
 * retained canonical event window and immutable Message/Work facts, then lets
 * M18 enforce attribution, privacy, ordering, and conflict detection.
 */
export function createSqliteActivityReadService(options: {
  database: M11Database;
  events: SqliteEventRepository;
  messages: {
    listMessages(input: {
      context: MessagingActorContext;
      channelId: string;
      beforeSequence?: number;
      limit: number;
    }): Promise<{
      messages: readonly MessageProjection[];
      nextBeforeSequence: number | null;
    }>;
  };
}): CoordinationActivityReadPort {
  let cache: {
    key: string;
    audienceKey: string;
    projection: ActivityProjection;
  } | null = null;

  function bounds(): EventBounds {
    const row = options.database.readOne<{
      currentSequence: number;
      retainedFloor: number | null;
      retainedCount: number;
    }>(
      `SELECT
         COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0)
           AS currentSequence,
         MIN(sequence) AS retainedFloor,
         COUNT(*) AS retainedCount
       FROM events`,
    );
    if (!row || !Number.isSafeInteger(row.currentSequence) || row.currentSequence < 0 ||
        !Number.isSafeInteger(row.retainedCount) || row.retainedCount < 0) {
      throw new Error("Activity event bounds are invalid");
    }
    const retainedFloor = row.retainedCount === 0
      ? row.currentSequence + 1
      : row.retainedFloor;
    if (!Number.isSafeInteger(retainedFloor) || retainedFloor! < 1 ||
        (row.retainedCount > 0 &&
          row.retainedCount !== row.currentSequence - retainedFloor! + 1)) {
      throw new Error("Activity retained event window is not contiguous");
    }
    return Object.freeze({
      currentSequence: row.currentSequence,
      retainedFloor: retainedFloor!,
      retainedCount: row.retainedCount,
    });
  }

  function sourceWindow(boundary: EventBounds): ActivitySourceWindow {
    return Object.freeze({
      completeness: "complete_retained_window",
      retainedAfterEventSequence: boundary.retainedFloor - 1,
      throughEventSequence: boundary.currentSequence,
    });
  }

  function boundsKey(boundary: EventBounds): string {
    return `${boundary.retainedFloor}:${boundary.currentSequence}:${boundary.retainedCount}`;
  }

  function stableAudienceKey(value: ActivityAudience): string {
    return [
      value.principalId,
      ...value.channels.flatMap((channel) => [
        channel.channelId,
        ...channel.memberPrincipalIds,
      ]),
    ].join("\0");
  }

  function loadEvents(
    boundary: EventBounds,
    requestId: string,
  ): readonly EventEnvelope[] {
    if (boundary.retainedCount === 0) return Object.freeze([]);
    const retainedAfter = boundary.retainedFloor - 1;
    let after = retainedAfter;
    const events: EventEnvelope[] = [];
    while (after < boundary.currentSequence) {
      const result = options.events.resumeAfter(after, 1_000, requestId);
      if (result.kind === "reset") {
        throw new Error(
          `Activity event window reset: ${result.error.details.reason}`,
        );
      }
      const page = result.events.filter(
        (event) => event.sequence <= boundary.currentSequence,
      );
      if (page.length === 0) {
        throw new Error("Activity event window stopped before its boundary");
      }
      events.push(...page);
      after = page.at(-1)!.sequence;
    }
    if (
      events.length !== boundary.retainedCount ||
      events[0]?.sequence !== boundary.retainedFloor ||
      events.at(-1)?.sequence !== boundary.currentSequence
    ) {
      throw new Error("Activity event assembly is incomplete");
    }
    return Object.freeze(events);
  }

  function audience(context: MessagingActorContext): ActivityAudience {
    if (
      context.identity.kind !== "owner" ||
      context.principalId !== context.identity.auth.principalId
    ) {
      throw new MessagingError("identity_context_mismatch");
    }
    if (!context.identity.auth.scopes.includes("product:read")) {
      throw new MessagingError("scope_denied");
    }
    const rows = options.database.readAll<{
      channelId: string;
      memberPrincipalId: string;
    }>(
      `SELECT viewer.channel_id AS channelId,
              member.principal_id AS memberPrincipalId
       FROM channel_members viewer
       JOIN channel_members member ON member.channel_id = viewer.channel_id
       WHERE viewer.principal_id = ? AND viewer.active = 1 AND member.active = 1
       ORDER BY viewer.channel_id, member.principal_id`,
      context.principalId,
    );
    const channels = new Map<string, string[]>();
    for (const row of rows) {
      const members = channels.get(row.channelId) ?? [];
      members.push(row.memberPrincipalId);
      channels.set(row.channelId, members);
    }
    return Object.freeze({
      principalId: context.principalId,
      channels: Object.freeze([...channels].map(([channelId, memberPrincipalIds]) =>
        Object.freeze({
          channelId,
          memberPrincipalIds: Object.freeze(memberPrincipalIds),
        })
      )),
    });
  }

  async function messagesForEvents(
    context: MessagingActorContext,
    events: readonly EventEnvelope[],
  ): Promise<readonly MessageProjection[]> {
    const byChannel = new Map<string, Set<string>>();
    for (const event of events) {
      if (event.type !== "message.appended") continue;
      if (event.channelId === null) {
        throw new Error(`Message event ${event.id} has no Channel`);
      }
      const ids = byChannel.get(event.channelId) ?? new Set<string>();
      ids.add(event.aggregate.id);
      byChannel.set(event.channelId, ids);
    }
    const output: MessageProjection[] = [];
    for (const [channelId, required] of byChannel) {
      let beforeSequence: number | undefined;
      while (required.size > 0) {
        const page = await options.messages.listMessages({
          context,
          channelId,
          ...(beforeSequence === undefined ? {} : { beforeSequence }),
          limit: 100,
        });
        for (const message of page.messages) {
          if (required.delete(message.id)) output.push(message);
        }
        if (required.size === 0) break;
        if (page.nextBeforeSequence === null) {
          throw new Error(`Activity Message facts are incomplete for ${channelId}`);
        }
        beforeSequence = page.nextBeforeSequence;
      }
    }
    return Object.freeze(output);
  }

  function work(workId: string): WorkFactRow {
    const row = options.database.readOne<WorkFactRow>(
      `SELECT id, target_principal_id AS targetPrincipalId,
              channel_id AS channelId, round_id AS roundId, state,
              updated_at AS updatedAt
       FROM works WHERE id = ?`,
      workId,
    );
    if (!row) throw new Error(`Activity Work fact ${workId} is unavailable`);
    return Object.freeze({
      ...row,
      state: safeCurrentState(row.state, `Activity Work ${workId}`),
    });
  }

  function attempt(attemptId: string, workId: string): AttemptFactRow {
    const row = options.database.readOne<AttemptFactRow>(
      `SELECT id, work_id AS workId, authority_reference AS authorityReference,
              fencing_token AS fencingToken
       FROM attempts WHERE id = ? AND work_id = ?`,
      attemptId,
      workId,
    );
    if (!row) throw new Error(`Activity Attempt fact ${attemptId} is unavailable`);
    return row;
  }

  function workFact(event: EventEnvelope): TrustedM11ActivityFact {
    const retainedWork = work(event.aggregate.id);
    const state = observedPayload(event);
    const rawAttemptId = event.payload.attemptId;
    const attemptId = rawAttemptId === undefined || rawAttemptId === null
      ? null
      : typeof rawAttemptId === "string"
        ? rawAttemptId
        : (() => { throw new Error(`Activity Work event ${event.id} has an invalid Attempt`); })();
    const retainedAttempt = attemptId === null
      ? null
      : attempt(attemptId, retainedWork.id);
    const rawFence = event.payload.fencingToken;
    const fencingToken = attemptId === null
      ? rawFence === undefined || rawFence === 0 ? 0
        : (() => { throw new Error(`Activity Work event ${event.id} has an invalid zero fence`); })()
      : Number.isSafeInteger(rawFence) && (rawFence as number) >= 1
        ? rawFence as number
        : (() => { throw new Error(`Activity Work event ${event.id} has an invalid fence`); })();
    if (retainedAttempt && retainedAttempt.fencingToken !== fencingToken) {
      throw new Error(`Activity Work event ${event.id} has a mismatched retained fence`);
    }
    return Object.freeze({
      event,
      sourceKind: "work_attempt",
      workId: retainedWork.id,
      channelId: retainedWork.channelId,
      actorPrincipalId: retainedWork.targetPrincipalId,
      attemptId,
      linkedRoundId: retainedWork.roundId,
      fencingToken,
      authorityReference: retainedAttempt?.authorityReference ?? `work:${retainedWork.id}`,
      observedState: state,
      sourceUpdatedAt: event.createdAt,
      freshness: "current",
      terminalReasonCode: terminalReason(event, state),
      artifactId: null,
    });
  }

  function roundFact(event: EventEnvelope): TrustedM11ActivityFact | null {
    const round = options.database.readOne<RoundFactRow>(
      `SELECT id, channel_id AS channelId, coordinator_bot_id AS coordinatorBotId,
              state, updated_at AS updatedAt
       FROM rounds WHERE id = ?`,
      event.aggregate.id,
    );
    const retainedWork = round === undefined
      ? undefined
      : options.database.readOne<{ id: string }>(
      `SELECT id FROM works
       WHERE round_id = ? AND target_principal_id = ?
       ORDER BY created_at, id LIMIT 1`,
      event.aggregate.id,
      round.coordinatorBotId,
    );
    // A Round coordinator may not be one of the selected responders. M18's
    // Work-observation identity cannot truthfully bind that Round-only event
    // to another Bot's Work, so leave it as a non-Activity turn event.
    if (!round || !retainedWork) return null;
    const states: Readonly<Record<RoundFactRow["state"], ActivityObservedState>> = {
      open: "queued",
      coordinating: "running",
      waiting: "queued",
      completed: "succeeded",
      failed: "failed",
      cancelled: "cancelled",
    };
    const payloadState = event.payload.state;
    if (typeof payloadState !== "string" || !(payloadState in states)) {
      throw new Error(`Activity Round event ${event.id} has an invalid state`);
    }
    const observedState = states[payloadState as RoundFactRow["state"]];
    return Object.freeze({
      event,
      sourceKind: "round",
      workId: retainedWork.id,
      channelId: round.channelId,
      actorPrincipalId: round.coordinatorBotId,
      attemptId: null,
      linkedRoundId: round.id,
      fencingToken: 0,
      authorityReference: `round:${round.id}`,
      observedState,
      sourceUpdatedAt: event.createdAt,
      freshness: "current",
      terminalReasonCode: terminalReason(event, observedState),
      artifactId: null,
    });
  }

  function outboxFact(event: EventEnvelope): TrustedM11ActivityFact {
    const outbox = options.database.readOne<OutboxFactRow>(
      `SELECT id, aggregate_id AS workId, kind, updated_at AS updatedAt
       FROM outbox WHERE id = ? AND aggregate_kind = 'work'`,
      event.aggregate.id,
    );
    if (!outbox) throw new Error(`Activity Outbox fact ${event.aggregate.id} is unavailable`);
    const retainedWork = work(outbox.workId);
    const state = event.payload.state;
    const states: Readonly<Record<string, ActivityObservedState>> = {
      pending: "queued",
      claimed: "running",
      retry: "queued",
      delivered: "succeeded",
      dead_letter: "failed",
    };
    if (typeof state !== "string" || states[state] === undefined ||
        event.payload.workId !== outbox.workId) {
      throw new Error(`Activity Outbox event ${event.id} does not bind its Work`);
    }
    const observedState = states[state]!;
    return Object.freeze({
      event,
      sourceKind: "outbox",
      workId: retainedWork.id,
      channelId: retainedWork.channelId,
      actorPrincipalId: retainedWork.targetPrincipalId,
      attemptId: null,
      linkedRoundId: retainedWork.roundId,
      fencingToken: 0,
      authorityReference: `outbox:${outbox.id}`,
      observedState,
      sourceUpdatedAt: event.createdAt,
      freshness: "current",
      terminalReasonCode: observedState === "failed"
        ? "source_unavailable"
        : observedState === "succeeded" ? "completed" : null,
      artifactId: null,
    });
  }

  function recoveryFact(event: EventEnvelope): TrustedM11ActivityFact {
    const observation = options.database.readOne<ObservationFactRow>(
      `SELECT id, work_id AS workId, attempt_id AS attemptId,
              authority_reference AS authorityReference,
              fencing_token AS fencingToken,
              observation_kind AS observationKind, outcome_code AS outcomeCode,
              created_at AS createdAt
       FROM work_observations WHERE id = ?`,
      event.aggregate.id,
    );
    if (!observation) {
      throw new Error(`Activity recovery fact ${event.aggregate.id} is unavailable`);
    }
    const retainedWork = work(observation.workId);
    let observedState: ActivityObservedState;
    if (observation.observationKind === "running") observedState = "running";
    else if (observation.observationKind === "not_started") {
      observedState = observation.attemptId === null ? "queued" : "leased";
    } else if (observation.observationKind === "terminal") {
      const terminal = observation.outcomeCode.replace(/^positive_/, "");
      observedState = safeCurrentState(terminal, `Activity observation ${observation.id}`);
      if (!TERMINAL_STATES.has(observedState)) {
        throw new Error(`Activity observation ${observation.id} is not terminal`);
      }
    } else {
      // A rejected fence proves only that the supplied execution authority was
      // stale. It is not a snapshot of the Work state. Keep the reconstructed
      // fact non-terminal and stable across later Work transitions so an old
      // rejection can never masquerade as a later completion or failure.
      observedState = "queued";
    }
    return Object.freeze({
      event,
      sourceKind: "recovery",
      workId: retainedWork.id,
      channelId: retainedWork.channelId,
      actorPrincipalId: retainedWork.targetPrincipalId,
      attemptId: observation.attemptId,
      linkedRoundId: retainedWork.roundId,
      fencingToken: observation.fencingToken,
      authorityReference: observation.authorityReference,
      observedState,
      sourceUpdatedAt: observation.createdAt,
      freshness: observation.observationKind === "rejected_fence" ? "stale" : "current",
      terminalReasonCode: TERMINAL_STATES.has(observedState)
        ? `receipt_${observedState}`
        : null,
      artifactId: null,
    });
  }

  function facts(events: readonly EventEnvelope[]): readonly TrustedM11ActivityFact[] {
    const output: TrustedM11ActivityFact[] = [];
    for (const event of events) {
      if (event.type === "turn.updated" && event.aggregate.kind === "work") {
        output.push(workFact(event));
      } else if (event.type === "turn.updated" && event.aggregate.kind === "round") {
        const fact = roundFact(event);
        if (fact) output.push(fact);
      } else if (event.type === "activity.updated" && event.aggregate.kind === "outbox") {
        output.push(outboxFact(event));
      } else if (
        event.type === "activity.updated" &&
        event.aggregate.kind === "workObservation"
      ) {
        output.push(recoveryFact(event));
      } else if (event.type === "activity.updated") {
        throw new Error(
          `Activity event ${event.id} has no trusted M11 fact assembler`,
        );
      }
    }
    return Object.freeze(output);
  }

  async function assemble(
    context: MessagingActorContext,
    boundary: EventBounds,
    membership: ActivityAudience,
  ): Promise<ActivityProjection> {
    const window = sourceWindow(boundary);
    const events = loadEvents(boundary, context.requestId);
    const messageFacts = await messagesForEvents(context, events);
    const trustedFacts = facts(events);
    const rejectedFact = trustedFacts.find((fact) =>
      adaptTrustedM11ActivityFact(fact) === null
    );
    if (rejectedFact) {
      throw new Error(
        `fact_rejected:${rejectedFact.event.sequence}:${rejectedFact.sourceKind}:` +
        `${rejectedFact.event.aggregate.kind}`,
      );
    }
    const result = projectTrustedM11Activity({
      sourceWindow: window,
      events,
      messages: messageFacts,
      facts: trustedFacts,
      membership: {
        status: "available",
        authentication: "authenticated",
        authority: "trusted_m08_membership_snapshot",
        snapshotVersion: Math.max(1, boundary.currentSequence),
        audience: membership,
      },
      factAssembly: {
        status: "complete",
        authority: "trusted_m11_fact_assembly",
        throughEventSequence: boundary.currentSequence,
      },
    });
    if (result.kind !== "projected") {
      throw new Error(`Activity capability is off: ${result.reason}`);
    }
    if (result.projection.integrity.status !== "complete") {
      const conflictSequence = result.projection.integrity.conflictAtEventSequence;
      const conflict = events.find((event) => event.sequence === conflictSequence);
      const conflictFact = trustedFacts.find(
        (fact) => fact.event.sequence === conflictSequence,
      );
      const relatedFacts = conflictFact === undefined
        ? []
        : trustedFacts
          .filter((fact) => fact.workId === conflictFact.workId)
          .map((fact) => [
            fact.event.sequence,
            fact.sourceKind,
            fact.actorPrincipalId,
            fact.authorityReference,
            fact.event.aggregate.version,
            fact.fencingToken,
            fact.observedState,
          ].join("/"));
      throw new ActivityReadError(
        "activity_projection_conflict",
        `conflict_at_event:${conflictSequence}:` +
        `${conflict?.type ?? "missing"}:${conflict?.aggregate.kind ?? "missing"}:` +
        `${conflict?.aggregate.id ?? "missing"}:` +
        `related=${relatedFacts.join(",")}`,
      );
    }
    return result.projection;
  }

  return Object.freeze({
    async list(input: Parameters<CoordinationActivityReadPort["list"]>[0]) {
      try {
        // Validate the current authenticated context before consulting a cache.
        // A prior request by the same principal must never authorize a later
        // request whose scope or identity binding is missing.
        const membership = audience(input.context);
        const membershipKey = stableAudienceKey(membership);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const before = bounds();
          const key = boundsKey(before);
          let projection = cache?.key === key &&
            cache.audienceKey === membershipKey
            ? cache.projection
            : null;
          if (projection === null) {
            projection = await assemble(input.context, before, membership);
          }
          const after = bounds();
          if (boundsKey(after) !== key) continue;
          cache = { key, audienceKey: membershipKey, projection };
          const page = pageActivity(projection.entries, {
            after: input.after,
            limit: input.limit,
            scope: input.scope,
          });
          return Object.freeze({
            entries: page.entries,
            nextBoundary: page.nextBoundary,
            throughEventSequence: projection.throughEventSequence,
          });
        }
        throw new ActivityReadError(
          "activity_source_unstable",
          "source_changed_during_three_complete_assemblies",
          true,
        );
      } catch (error) {
        if (error instanceof MessagingError || error instanceof ActivityReadError) throw error;
        throw new ActivityReadError(
          "activity_source_incomplete",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });
}
