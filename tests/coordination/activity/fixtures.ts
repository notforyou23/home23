import type { EventEnvelope } from "../../../src/coordination/events/index.js";
import type { MessageProjection } from "../../../src/coordination/messages/index.js";
import type {
  ActivityAudience,
  ActivityObservedState,
  ActivitySourceWindow,
  ActivityTerminalReason,
  ActivityWorkObservationInput,
  ActivityWorkObservationKind,
} from "../../../src/coordination/activity/index.js";

export function fixtureId(
  kind:
    | "event"
    | "channel"
    | "conversation"
    | "message"
    | "bot"
    | "principal"
    | "request"
    | "correlation"
    | "round"
    | "work"
    | "workObservation"
    | "artifact",
  suffix: number,
): string {
  const uuid = `0198d95f-6c00-7000-8000-${suffix.toString().padStart(12, "0")}`;
  const prefixes = {
    event: "evt_",
    channel: "chn_",
    conversation: "cnv_",
    message: "msg_",
    bot: "bot_",
    principal: "bot_",
    request: "req_",
    correlation: "cor_",
    round: "rnd_",
    work: "wrk_",
    workObservation: "obs_",
    artifact: "art_",
  } as const;
  return `${prefixes[kind]}${uuid}`;
}

export const OWNER = "user_owner";
export const JERRY = fixtureId("principal", 11);
export const FORREST = fixtureId("principal", 12);
export const OUTSIDER = fixtureId("principal", 13);
export const DIRECT_CHANNEL = fixtureId("channel", 21);
export const GROUP_CHANNEL = fixtureId("channel", 22);
export const PRIVATE_CHANNEL = fixtureId("channel", 23);

export function sourceWindow(
  retainedAfterEventSequence: number,
  throughEventSequence: number,
): ActivitySourceWindow {
  return {
    completeness: "complete_retained_window",
    retainedAfterEventSequence,
    throughEventSequence,
  };
}

export function audience(
  principalId = OWNER,
  channels: ActivityAudience["channels"] = [
    { channelId: DIRECT_CHANNEL, memberPrincipalIds: [OWNER, JERRY] },
    { channelId: GROUP_CHANNEL, memberPrincipalIds: [OWNER, JERRY, FORREST] },
  ],
): ActivityAudience {
  return { principalId, channels };
}

export function event(
  sequence: number,
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  const id = fixtureId("event", sequence);
  return {
    id,
    sequence,
    schemaVersion: 1,
    type: "message.appended",
    durability: "durable",
    aggregate: {
      kind: "message",
      id: fixtureId("message", sequence),
      version: 1,
    },
    channelId: DIRECT_CHANNEL,
    actorPrincipalId: JERRY,
    requestId: fixtureId("request", sequence),
    correlationId: fixtureId("correlation", sequence),
    createdAt: `2026-08-25T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    payload: {
      messageId: fixtureId("message", sequence),
      channelId: DIRECT_CHANNEL,
      conversationId: fixtureId("conversation", 31),
      channelSequence: sequence,
      channelVersion: 1,
      messageVersion: 1,
      authorPrincipalId: JERRY,
      mentions: [],
      replyToMessageId: null,
      tombstonesMessageId: null,
      roundId: fixtureId("round", 81),
      workId: fixtureId("work", 82),
    },
    ...overrides,
  };
}

export function resultMessage(
  sequence: number,
  overrides: Partial<MessageProjection> = {},
): MessageProjection {
  return {
    id: fixtureId("message", sequence),
    channelId: DIRECT_CHANNEL,
    conversationId: fixtureId("conversation", 31),
    sequence,
    author: { principalId: JERRY, kind: "bot", displayName: "Jerry" },
    kind: "result",
    text: "Private resident transcript must never enter Activity.",
    mentions: [],
    clientMessageId: null,
    replyToMessageId: null,
    tombstonesMessageId: null,
    provenance: {
      roundId: fixtureId("round", 81),
      workId: fixtureId("work", 82),
    },
    createdAt: `2026-08-25T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    attachments: [],
    visibility: "visible",
    ...overrides,
  };
}

interface ObservationOptions {
  channelId?: string;
  actorPrincipalId?: string;
  bindingActorPrincipalId?: string;
  bindingChannelId?: string;
  workId?: string;
  authorityId?: string;
  sourceVersion?: string;
  observedState?: ActivityObservedState;
  observedAt?: string;
  sourceUpdatedAt?: string;
  freshness?: "current" | "stale" | "unknown" | "unavailable";
  safeSummary?: string | null;
  terminalReason?: ActivityTerminalReason | null;
  artifactId?: string | null;
  eventPayload?: Record<string, unknown>;
}

export function observation(
  eventSequence: number,
  kind: ActivityWorkObservationKind,
  options: ObservationOptions = {},
): ActivityWorkObservationInput {
  const defaults: Record<ActivityWorkObservationKind, {
    observedState: ActivityObservedState;
    terminal: boolean;
    terminalReason: ActivityTerminalReason | null;
  }> = {
    started: { observedState: "running", terminal: false, terminalReason: null },
    progress: { observedState: "running", terminal: false, terminalReason: null },
    waiting: { observedState: "queued", terminal: false, terminalReason: null },
    retry: { observedState: "queued", terminal: false, terminalReason: null },
    failure: { observedState: "failed", terminal: true, terminalReason: "execution_failed" },
    completion: { observedState: "succeeded", terminal: true, terminalReason: "completed" },
    artifact: { observedState: "running", terminal: false, terminalReason: null },
  };
  const workId = options.workId ?? fixtureId("work", 82);
  const channelId = options.channelId ?? GROUP_CHANNEL;
  const actorPrincipalId = options.actorPrincipalId ?? JERRY;
  const observationId = fixtureId("workObservation", 1000 + eventSequence);
  const observedState = options.observedState ?? defaults[kind].observedState;
  const terminal = defaults[kind].terminal;
  const terminalReason = options.terminalReason === undefined
    ? defaults[kind].terminalReason
    : options.terminalReason;
  const artifactId = options.artifactId === undefined
    ? (kind === "artifact" ? fixtureId("artifact", 51) : null)
    : options.artifactId;
  const timestamp = options.observedAt ??
    `2026-08-25T12:01:${String(eventSequence).padStart(2, "0")}.000Z`;
  const sourceVersion = options.sourceVersion ?? String(eventSequence);
  const activityEvent = event(eventSequence, {
    type: "activity.updated",
    aggregate: { kind: "work", id: workId, version: 1 },
    channelId,
    actorPrincipalId,
    createdAt: timestamp,
    payload: {
      observationId,
      workId,
      category: kind,
      observedState,
      sourceVersion,
      terminal,
      terminalReason,
      artifactId,
      ...options.eventPayload,
    } as EventEnvelope["payload"],
  });
  return {
    event: activityEvent,
    binding: {
      source: "canonical_work_attempt",
      workId,
      channelId: options.bindingChannelId ?? channelId,
      actorPrincipalId: options.bindingActorPrincipalId ?? actorPrincipalId,
    },
    observation: {
      id: observationId,
      authoritySystem: "resident_turn",
      authorityId: options.authorityId ?? "resident-turn-reference-1",
      sourceVersion,
      observedState,
      observedAt: timestamp,
      sourceUpdatedAt: options.sourceUpdatedAt ?? timestamp,
      freshness: options.freshness ?? "current",
      terminal,
      safeSummary: options.safeSummary === undefined
        ? (kind === "progress" ? "Checking one source." : null)
        : options.safeSummary,
    },
  };
}
