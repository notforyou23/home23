import type { EventEnvelope } from "../events/index.js";
import type { MessageProjection } from "../messages/index.js";

/** M02 Activity states. M18 projects them; it does not own a lifecycle. */
export type ActivityState =
  | "idle"
  | "accepted"
  | "working"
  | "background"
  | "stopping"
  | "attention"
  | "failed";

export type ActivityCategory =
  | "started"
  | "progress"
  | "waiting"
  | "retry"
  | "failure"
  | "completion"
  | "artifact";

export type ActivityFreshness = "current" | "stale" | "unknown" | "unavailable";
export type ActivityWorkObservationKind = ActivityCategory;

/** Narrow M11 work-state vocabulary already locked by M02. */
export type ActivityObservedState =
  | "queued"
  | "leased"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ActivityTerminalReason =
  | "completed"
  | "passed"
  | "cancelled"
  | "cancelled_by_owner"
  | "deadline_exceeded"
  | "max_turns_reached"
  | "execution_failed"
  | "source_unavailable"
  | "result_posted"
  | "attachment_failed";

export interface ActivityActor {
  principalId: string;
  displayName: string | null;
}

/** Exact locked work-observation fields; arbitrary diagnostic bags are omitted. */
export interface ActivityWorkObservation {
  id: string;
  authoritySystem: "resident_turn" | "bot_turn";
  authorityId: string;
  sourceVersion: string;
  observedState: ActivityObservedState;
  observedAt: string;
  sourceUpdatedAt: string;
  freshness: ActivityFreshness;
  terminal: boolean;
  /** Never copied verbatim; exact frozen tokens may map to controlled labels. */
  safeSummary: string | null;
}

/**
 * Dependency-safe M11/M16 adapter seam. `binding` must be derived at the trusted
 * canonical Work/Attempt boundary. M18 verifies it against the paired durable
 * `activity.updated` Event and never accepts actor/Channel attribution from the
 * observation itself.
 */
export interface ActivityWorkObservationInput {
  event: EventEnvelope;
  binding: {
    source: "canonical_work_attempt";
    workId: string;
    channelId: string;
    actorPrincipalId: string;
  };
  observation: ActivityWorkObservation;
}

/** Trusted M08 membership snapshot for one already-authenticated viewer. */
export interface ActivityAudience {
  principalId: string;
  channels: readonly {
    channelId: string;
    memberPrincipalIds: readonly string[];
  }[];
}

export interface ActivitySourceStamp {
  kind: "event" | "work_observation";
  id: string;
  eventType: string | null;
  authoritySystem: "resident_turn" | "bot_turn" | null;
  authorityId: string | null;
  sourceVersion: string | null;
  freshness: ActivityFreshness | null;
}

export interface ActivityInterval {
  firstEventSequence: number;
  lastEventSequence: number;
  startedAt: string;
  endedAt: string;
}

export interface ActivityEntry {
  /** Deterministic projection key, not a second canonical identifier. */
  key: string;
  eventSequence: number;
  category: ActivityCategory;
  state: ActivityState;
  label: string;
  /** Matches the locked Activity contract vocabulary. */
  updatedAt: string;
  channelId: string | null;
  actor: ActivityActor;
  workId: string | null;
  observationId: string | null;
  messageId: string | null;
  artifactId: string | null;
  source: ActivitySourceStamp;
  terminalReason: ActivityTerminalReason | null;
  terminalExplanation: string | null;
  collapsedCount: number;
  compacted: boolean;
  interval: ActivityInterval;
}

export type ActivityProjectionIntegrity =
  | { status: "complete" }
  | { status: "conflict"; conflictAtEventSequence: number };

export interface ActivityProjection {
  entries: readonly ActivityEntry[];
  throughEventSequence: number;
  integrity: ActivityProjectionIntegrity;
}

/**
 * Trusted Event-repository read boundary. This is a complete retained window,
 * not an incremental batch: every durable sequence in the open/closed range
 * must be supplied so rebuilding cannot depend on caller chunking.
 */
export interface ActivitySourceWindow {
  completeness: "complete_retained_window";
  retainedAfterEventSequence: number;
  throughEventSequence: number;
}

export interface ProjectActivityInput {
  sourceWindow: ActivitySourceWindow;
  events: readonly EventEnvelope[];
  messages: readonly MessageProjection[];
  workObservations: readonly ActivityWorkObservationInput[];
  audience: ActivityAudience;
}

export type ActivityScope =
  | { kind: "all" }
  | { kind: "channel"; channelId: string };

export interface ActivityBoundary {
  eventSequence: number;
  key: string;
}

export interface ActivityPage {
  entries: readonly ActivityEntry[];
  nextBoundary: ActivityBoundary | null;
}
