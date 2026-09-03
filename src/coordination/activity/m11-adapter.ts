import type { EventEnvelope } from "../events/index.js";
import type { MessageProjection } from "../messages/index.js";

import { projectActivity } from "./projector.js";
import type {
  ActivityAudience,
  ActivityFreshness,
  ActivityObservedState,
  ActivityProjection,
  ActivitySourceWindow,
  ActivityTerminalReason,
  ActivityWorkObservationInput,
} from "./types.js";

export type M11ActivitySourceKind = "work_attempt" | "outbox" | "round" | "recovery";

/**
 * A content-free fact assembled at the trusted M11 read boundary. The adapter
 * checks its identity, fence, and state against the durable event before M18
 * is allowed to project it.
 */
export interface TrustedM11ActivityFact {
  event: EventEnvelope;
  sourceKind: M11ActivitySourceKind;
  workId: string;
  /** Immutable canonical Work.kind; execution vocabulary must not be inferred from an authority label. */
  workKind: string;
  /** Canonical target identity classification assembled at the trusted M11 read boundary. */
  executionAuthoritySystem: "resident_turn" | "bot_turn";
  channelId: string;
  actorPrincipalId: string;
  attemptId: string | null;
  /** Canonical Work.round_id; required when sourceKind is round. */
  linkedRoundId: string | null;
  fencingToken: number;
  authorityReference: string;
  observedState: ActivityObservedState;
  sourceUpdatedAt: string;
  freshness: ActivityFreshness;
  terminalReasonCode: string | null;
  artifactId: string | null;
}

export type M11MembershipCapability =
  | {
      status: "available";
      authentication: "authenticated";
      authority: "trusted_m08_membership_snapshot";
      snapshotVersion: number;
      audience: ActivityAudience;
    }
  | { status: "unavailable" };

export type M11FactAssemblyCapability =
  | {
      status: "complete";
      authority: "trusted_m11_fact_assembly";
      throughEventSequence: number;
    }
  | { status: "unavailable" };

export interface ProjectM11ActivityInput {
  sourceWindow: ActivitySourceWindow;
  events: readonly EventEnvelope[];
  messages: readonly MessageProjection[];
  facts: readonly TrustedM11ActivityFact[];
  membership: M11MembershipCapability;
  factAssembly: M11FactAssemblyCapability;
}

export type M11ActivityProjectionResult =
  | { kind: "projected"; projection: ActivityProjection }
  | {
      kind: "capability_off";
      reason: "membership_unavailable" | "fact_assembly_unavailable";
    };

const SAFE_REFERENCE = /^[A-Za-z0-9._:-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" ||
    typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function paired(event: EventEnvelope, fact: TrustedM11ActivityFact): boolean {
  const payload = event.payload;
  if (fact.sourceKind !== "round" && payload.workId !== fact.workId) return false;
  if (fact.sourceKind === "work_attempt") {
    const attemptMatches = fact.attemptId === null
      ? payload.attemptId === null || payload.attemptId === undefined
      : payload.attemptId === fact.attemptId;
    const fenceMatches = fact.attemptId === null
      ? fact.fencingToken === 0 &&
        (payload.fencingToken === 0 || payload.fencingToken === undefined)
      : payload.fencingToken === fact.fencingToken;
    const terminal = fact.observedState === "succeeded" || fact.observedState === "failed" ||
      fact.observedState === "cancelled";
    const reasonMatches = terminal
      ? typeof payload.reasonCode === "string" &&
        payload.reasonCode === fact.terminalReasonCode
      : fact.terminalReasonCode === null;
    return event.type === "turn.updated" && event.aggregate.kind === "work" &&
      event.aggregate.id === fact.workId && payload.state === fact.observedState &&
      attemptMatches && fenceMatches && reasonMatches;
  }
  if (fact.sourceKind === "outbox") {
    const state = payload.state;
    const compatible =
      ((state === "pending" || state === "claimed") &&
        (fact.observedState === "queued" || fact.observedState === "running")) ||
      (state === "retry" && fact.observedState === "queued") ||
      (state === "delivered" &&
        (fact.observedState === "succeeded" || fact.observedState === "failed" ||
          fact.observedState === "cancelled")) ||
      (state === "dead_letter" && fact.observedState === "failed");
    return event.type === "activity.updated" && event.aggregate.kind === "outbox" &&
      payload.outboxId === event.aggregate.id && fact.attemptId === null &&
      fact.fencingToken === 0 && compatible;
  }
  if (fact.sourceKind === "round") {
    const states: Readonly<Record<string, ActivityObservedState>> = {
      open: "queued", coordinating: "running", waiting: "queued",
      completed: "succeeded", failed: "failed", cancelled: "cancelled",
    };
    const terminal = fact.observedState === "succeeded" || fact.observedState === "failed" ||
      fact.observedState === "cancelled";
    const reasonMatches = terminal
      ? typeof payload.reasonCode === "string" &&
        payload.reasonCode === fact.terminalReasonCode
      : fact.terminalReasonCode === null;
    return event.type === "turn.updated" && event.aggregate.kind === "round" &&
      payload.roundId === event.aggregate.id && typeof payload.state === "string" &&
      fact.linkedRoundId === event.aggregate.id && fact.attemptId === null &&
      fact.fencingToken === 0 && states[payload.state] === fact.observedState && reasonMatches;
  }
  const kind = payload.observationKind;
  const outcome = payload.outcomeCode;
  const recoveryCompatible =
    (kind === "running" && fact.observedState === "running") ||
    (kind === "not_started" &&
      (fact.observedState === "leased" || fact.observedState === "queued")) ||
    (kind === "terminal" && typeof outcome === "string" &&
      outcome === `positive_${fact.observedState}`) ||
    ((kind === "rejected_fence" || outcome === "stale_fence") &&
      fact.freshness !== "current" && payload.rejectedFence === fact.fencingToken);
  return event.type === "activity.updated" && event.aggregate.kind === "workObservation" &&
    payload.observationId === event.aggregate.id &&
    (fact.attemptId === null || payload.attemptId === fact.attemptId) &&
    ((outcome === "stale_fence" && payload.rejectedFence === fact.fencingToken) ||
      payload.fencingToken === fact.fencingToken) &&
    recoveryCompatible;
}

function terminalReason(fact: TrustedM11ActivityFact): ActivityTerminalReason | null {
  if (fact.observedState === "succeeded") {
    return fact.terminalReasonCode === "passed" ? "passed" : "completed";
  }
  if (fact.observedState === "cancelled") {
    if (fact.terminalReasonCode === "deadline_exceeded") return "deadline_exceeded";
    if (fact.terminalReasonCode === "max_bot_turns_exhausted" ||
      fact.terminalReasonCode === "max_turns_reached") return "max_turns_reached";
    if (fact.terminalReasonCode === "cancelled_by_owner" ||
      fact.terminalReasonCode === "owner_cancelled") return "cancelled_by_owner";
    return "cancelled";
  }
  if (fact.observedState !== "failed") return null;
  if (fact.terminalReasonCode === "deadline_exceeded") return "deadline_exceeded";
  if (fact.terminalReasonCode === "max_bot_turns_exhausted" ||
    fact.terminalReasonCode === "max_turns_reached") return "max_turns_reached";
  if (fact.terminalReasonCode === "source_unavailable") return "source_unavailable";
  return "execution_failed";
}

function category(fact: TrustedM11ActivityFact):
  ActivityWorkObservationInput["event"]["payload"]["category"] {
  if (fact.observedState === "succeeded") return "completion";
  if (fact.observedState === "failed" || fact.observedState === "cancelled") return "failure";
  if (fact.artifactId !== null) return "artifact";
  if (fact.observedState === "cancelling") return "waiting";
  if (fact.observedState === "queued") {
    return fact.attemptId === null ? "waiting" : "retry";
  }
  if (fact.observedState === "leased") return "started";
  return fact.sourceKind === "outbox" ? "progress" :
    fact.event.payload.attemptState === "running" ? "progress" : "started";
}

function observationId(event: EventEnvelope): string {
  return `obs_${event.id.slice("evt_".length)}`;
}

function sourceVersion(fact: TrustedM11ActivityFact): string {
  // Aggregate versions and fencing tokens are scoped to one Work/Attempt. Bind
  // the version stamp to the canonical durable Event so two turns handled by
  // the same resident cannot masquerade as one authoritative source version.
  return `m11:${fact.sourceKind}:${fact.event.id}:v${fact.event.aggregate.version}:f${fact.fencingToken}`;
}

function exactAuthoritySystem(
  workKind: string,
  executionAuthoritySystem: TrustedM11ActivityFact["executionAuthoritySystem"],
): ActivityWorkObservationInput["observation"]["authoritySystem"] | null {
  if (workKind === "bot_turn" && executionAuthoritySystem === "bot_turn") return "bot_turn";
  if (workKind === "resident_turn" && executionAuthoritySystem === "resident_turn") return "resident_turn";
  // A Channel Work kind describes orchestration. Its immutable target Bot
  // binding determines whether Core or a permanent resident executes it.
  if (workKind === "channel.bot_turn") return executionAuthoritySystem;
  return null;
}

export function adaptTrustedM11ActivityFact(
  fact: TrustedM11ActivityFact,
): ActivityWorkObservationInput | null {
  if (!isRecord(fact) || !isRecord(fact.event) || !paired(fact.event, fact) ||
    fact.event.durability !== "durable" ||
    (fact.sourceKind !== "outbox" && fact.event.channelId !== fact.channelId) ||
    typeof fact.workKind !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(fact.workKind) ||
    (fact.executionAuthoritySystem !== "resident_turn" &&
      fact.executionAuthoritySystem !== "bot_turn") ||
    !SAFE_REFERENCE.test(fact.authorityReference) ||
    !Number.isSafeInteger(fact.fencingToken) || fact.fencingToken < 0) return null;
  if (fact.artifactId !== null &&
    !["succeeded", "failed", "cancelled"].includes(fact.observedState) &&
    fact.event.payload.artifactId !== fact.artifactId) return null;
  const id = observationId(fact.event);
  const reason = terminalReason(fact);
  const terminal = reason !== null;
  if (["succeeded", "failed", "cancelled"].includes(fact.observedState) && !terminal) return null;
  const kind = category(fact);
  const version = sourceVersion(fact);
  const authoritySystem = exactAuthoritySystem(
    fact.workKind,
    fact.executionAuthoritySystem,
  );
  if (authoritySystem === null) return null;
  const event: EventEnvelope = Object.freeze({
    ...fact.event,
    type: "activity.updated",
    aggregate: Object.freeze({ kind: "work", id: fact.workId, version: fact.event.aggregate.version }),
    channelId: fact.channelId,
    actorPrincipalId: fact.actorPrincipalId,
    payload: Object.freeze({
      observationId: id,
      workId: fact.workId,
      category: kind,
      observedState: fact.observedState,
      sourceVersion: version,
      terminal,
      terminalReason: reason,
      artifactId: kind === "artifact" ? fact.artifactId : null,
    }),
  });
  return Object.freeze({
    event,
    binding: Object.freeze({
      source: "canonical_work_attempt" as const,
      workId: fact.workId,
      channelId: fact.channelId,
      actorPrincipalId: fact.actorPrincipalId,
    }),
    observation: Object.freeze({
      id,
      authoritySystem,
      authorityId: fact.authorityReference,
      sourceVersion: version,
      observedState: fact.observedState,
      observedAt: fact.event.createdAt,
      sourceUpdatedAt: fact.sourceUpdatedAt,
      freshness: fact.freshness,
      terminal,
      safeSummary: null,
    }),
  });
}

export function projectTrustedM11Activity(
  input: ProjectM11ActivityInput,
): M11ActivityProjectionResult {
  if (input.membership.status !== "available" ||
    input.membership.authentication !== "authenticated" ||
    input.membership.authority !== "trusted_m08_membership_snapshot" ||
    !Number.isSafeInteger(input.membership.snapshotVersion) ||
    input.membership.snapshotVersion < 1) {
    return Object.freeze({ kind: "capability_off", reason: "membership_unavailable" });
  }
  if (input.factAssembly.status !== "complete" ||
    input.factAssembly.authority !== "trusted_m11_fact_assembly" ||
    input.factAssembly.throughEventSequence !== input.sourceWindow.throughEventSequence) {
    return Object.freeze({ kind: "capability_off", reason: "fact_assembly_unavailable" });
  }
  const factGroups = new Map<string, TrustedM11ActivityFact[]>();
  for (const fact of input.facts) {
    const group = factGroups.get(fact.event.id) ?? [];
    group.push(fact);
    factGroups.set(fact.event.id, group);
  }
  const adapted: ActivityWorkObservationInput[] = [];
  const events = input.events.map((event) => {
    const group = factGroups.get(event.id);
    if (!group) return event;
    if (new Set(group.map(stableJson)).size !== 1) {
      return Object.freeze({ ...event, type: "activity.updated" });
    }
    const fact = group[0]!;
    const observation = adaptTrustedM11ActivityFact(fact);
    if (observation && stableJson(event) === stableJson(fact.event)) {
      adapted.push(observation);
      return observation.event;
    }
    return Object.freeze({ ...event, type: "activity.updated" });
  });
  return Object.freeze({
    kind: "projected",
    projection: projectActivity({
      sourceWindow: input.sourceWindow,
      events,
      messages: input.messages,
      workObservations: adapted,
      audience: input.membership.audience,
    }),
  });
}
