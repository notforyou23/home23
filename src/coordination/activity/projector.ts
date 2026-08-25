import { validateEventEnvelope } from "../events/index.js";
import { assertCoordinationId } from "../ids/index.js";

import type {
  ActivityActor,
  ActivityAudience,
  ActivityCategory,
  ActivityEntry,
  ActivityFreshness,
  ActivityInterval,
  ActivityObservedState,
  ActivityProjection,
  ActivitySourceStamp,
  ActivityState,
  ActivityTerminalReason,
  ActivityWorkObservationInput,
  ProjectActivityInput,
} from "./types.js";

const CATEGORIES = new Set<ActivityCategory>([
  "started", "progress", "waiting", "retry", "failure", "completion", "artifact",
]);
const FRESHNESS = new Set<ActivityFreshness>([
  "current", "stale", "unknown", "unavailable",
]);
const OBSERVED_STATES = new Set<ActivityObservedState>([
  "queued", "leased", "running", "cancelling", "succeeded", "failed", "cancelled",
]);
const STATE_BY_CATEGORY: Readonly<Record<ActivityCategory, readonly ActivityObservedState[]>> = {
  started: ["leased", "running"],
  progress: ["running"],
  waiting: ["queued", "cancelling"],
  retry: ["queued"],
  failure: ["failed", "cancelled"],
  completion: ["succeeded"],
  artifact: ["running", "succeeded"],
};
const FAILURE_REASONS = new Set<ActivityTerminalReason>([
  "deadline_exceeded", "max_turns_reached", "execution_failed", "source_unavailable",
]);
const COMPLETION_REASONS = new Set<ActivityTerminalReason>(["completed", "passed"]);
const TERMINAL_EXPLANATIONS: Readonly<Record<ActivityTerminalReason, string>> = {
  completed: "Completed successfully.",
  passed: "Passed without posting a message.",
  cancelled: "Cancelled.",
  cancelled_by_owner: "Cancelled by the owner.",
  deadline_exceeded: "Stopped at the deadline.",
  max_turns_reached: "Stopped at the turn limit.",
  execution_failed: "Execution failed.",
  source_unavailable: "The authoritative source became unavailable.",
  result_posted: "A durable result message was posted.",
  attachment_failed: "Attachment processing failed.",
};
const SAFE_REFERENCE = /^[A-Za-z0-9._:-]{1,128}$/;
// Frozen M02 presentation mapping. Additions require a numbered contract delta.
const LOCKED_SAFE_SUMMARY_LABELS: ReadonlyMap<string, string> = new Map([
  ["Checking one source.", "Checking one source"],
]);

type ValidatedEvent = ReturnType<typeof validateEventEnvelope>;

interface NormalizedMessage {
  id: string;
  channelId: string;
  conversationId: string;
  sequence: number;
  actor: ActivityActor;
  kind: "text" | "system" | "result";
  visibility: "visible" | "tombstoned";
  mentions: readonly string[];
  replyToMessageId: string | null;
  tombstonesMessageId: string | null;
  workId: string | null;
  roundId: string | null;
  createdAt: string;
}

interface NormalizedWorkInput {
  event: ValidatedEvent;
  binding: ActivityWorkObservationInput["binding"];
  observation: ActivityWorkObservationInput["observation"];
  category: ActivityCategory;
  terminalReason: ActivityTerminalReason | null;
  artifactId: string | null;
}

type EventDecision =
  | { kind: "entry"; entry: ActivityEntry }
  | { kind: "ignore" }
  | { kind: "conflict" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function exactTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value ? value : null;
}

function validId(kind: Parameters<typeof assertCoordinationId>[0], value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    assertCoordinationId(kind, value);
    return true;
  } catch {
    return false;
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" ||
    typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function earlierConflict(current: number | null, candidate: number): number {
  return current === null ? candidate : Math.min(current, candidate);
}

function compareEntries(left: ActivityEntry, right: ActivityEntry): number {
  return left.eventSequence - right.eventSequence || asciiCompare(left.key, right.key);
}

function normalizeAudience(audience: ActivityAudience): ReadonlyMap<string, ReadonlySet<string>> {
  if (!isRecord(audience) || !validId("principal", audience.principalId) ||
    !Array.isArray(audience.channels)) throw new TypeError("activity audience is invalid");
  const channels = new Map<string, ReadonlySet<string>>();
  for (const candidate of audience.channels) {
    if (!isRecord(candidate) || !validId("channel", candidate.channelId) ||
      !Array.isArray(candidate.memberPrincipalIds) || channels.has(candidate.channelId)) {
      throw new TypeError("activity audience is invalid");
    }
    const members = new Set<string>();
    for (const principalId of candidate.memberPrincipalIds) {
      if (!validId("principal", principalId) || members.has(principalId)) {
        throw new TypeError("activity audience is invalid");
      }
      members.add(principalId);
    }
    channels.set(candidate.channelId, members);
  }
  return channels;
}

function visibleToAudience(
  channelId: string | null,
  actorPrincipalId: string,
  audience: ActivityAudience,
  channels: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (channelId === null) return actorPrincipalId === audience.principalId;
  const members = channels.get(channelId);
  return Boolean(members?.has(audience.principalId) && members.has(actorPrincipalId));
}

function safeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 80 &&
    !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : null;
}

function normalizeMessage(value: unknown): NormalizedMessage | null {
  if (!isRecord(value) || !validId("message", value.id) ||
    !validId("channel", value.channelId) || !validId("conversation", value.conversationId) ||
    !positiveInteger(value.sequence) || !isRecord(value.author) ||
    !validId("principal", value.author.principalId) ||
    (value.author.kind !== "owner" && value.author.kind !== "bot") ||
    (value.author.kind === "owner" && value.author.principalId !== "user_owner") ||
    (value.author.kind === "bot" && value.author.principalId === "user_owner") ||
    (value.kind !== "text" && value.kind !== "system" && value.kind !== "result") ||
    (value.visibility !== "visible" && value.visibility !== "tombstoned") ||
    !Array.isArray(value.mentions) || !isRecord(value.provenance)) return null;
  const createdAt = exactTimestamp(value.createdAt);
  if (!createdAt || !value.mentions.every((id) => validId("principal", id))) return null;
  const workId = value.provenance.workId;
  const roundId = value.provenance.roundId;
  const replyToMessageId = value.replyToMessageId;
  const tombstonesMessageId = value.tombstonesMessageId;
  if ((workId !== null && !validId("work", workId)) ||
    (roundId !== null && !validId("round", roundId)) ||
    (replyToMessageId !== null && !validId("message", replyToMessageId)) ||
    (tombstonesMessageId !== null && !validId("message", tombstonesMessageId))) return null;
  return {
    id: value.id,
    channelId: value.channelId,
    conversationId: value.conversationId,
    sequence: value.sequence,
    actor: { principalId: value.author.principalId, displayName: safeDisplayName(value.author.displayName) },
    kind: value.kind,
    visibility: value.visibility,
    mentions: Object.freeze([...value.mentions]) as readonly string[],
    replyToMessageId,
    tombstonesMessageId,
    workId,
    roundId,
    createdAt,
  };
}

function messageIndex(messages: readonly unknown[]): ReadonlyMap<string, NormalizedMessage> {
  const groups = new Map<string, NormalizedMessage[]>();
  for (const value of messages) {
    const message = normalizeMessage(value);
    if (!message) continue;
    const group = groups.get(message.id) ?? [];
    group.push(message);
    groups.set(message.id, group);
  }
  const output = new Map<string, NormalizedMessage>();
  for (const [id, group] of groups) {
    if (new Set(group.map(stableJson)).size === 1 && group[0]) output.set(id, group[0]);
  }
  return output;
}

function validateTerminal(
  category: ActivityCategory,
  observedState: ActivityObservedState,
  terminal: boolean,
  terminalReason: unknown,
): terminalReason is ActivityTerminalReason | null {
  if (category === "failure") {
    if (!terminal || typeof terminalReason !== "string") return false;
    if (observedState === "cancelled") {
      return terminalReason === "cancelled" || terminalReason === "cancelled_by_owner" ||
        FAILURE_REASONS.has(terminalReason as ActivityTerminalReason);
    }
    return observedState === "failed" && FAILURE_REASONS.has(terminalReason as ActivityTerminalReason);
  }
  if (category === "completion") {
    return terminal && observedState === "succeeded" && typeof terminalReason === "string" &&
      COMPLETION_REASONS.has(terminalReason as ActivityTerminalReason);
  }
  return !terminal && terminalReason === null;
}

function normalizeWorkInput(value: unknown): NormalizedWorkInput | null {
  if (!isRecord(value) || !isRecord(value.binding) || !isRecord(value.observation)) return null;
  let event: ValidatedEvent;
  try {
    event = validateEventEnvelope(value.event);
  } catch {
    return null;
  }
  const binding = value.binding;
  const observation = value.observation;
  if (event.type !== "activity.updated" || event.durability !== "durable" ||
    event.aggregate.kind !== "work" || !validId("work", event.aggregate.id) ||
    event.channelId === null || event.actorPrincipalId === null ||
    binding.source !== "canonical_work_attempt" || !validId("work", binding.workId) ||
    !validId("channel", binding.channelId) || !validId("principal", binding.actorPrincipalId) ||
    binding.workId !== event.aggregate.id || binding.channelId !== event.channelId ||
    binding.actorPrincipalId !== event.actorPrincipalId ||
    !validId("workObservation", observation.id) || observation.authoritySystem !== "resident_turn" ||
    typeof observation.authorityId !== "string" || !SAFE_REFERENCE.test(observation.authorityId) ||
    typeof observation.sourceVersion !== "string" || !SAFE_REFERENCE.test(observation.sourceVersion) ||
    typeof observation.observedState !== "string" ||
    !OBSERVED_STATES.has(observation.observedState as ActivityObservedState) ||
    typeof observation.freshness !== "string" ||
    !FRESHNESS.has(observation.freshness as ActivityFreshness) ||
    typeof observation.terminal !== "boolean" ||
    (observation.safeSummary !== null && (
      typeof observation.safeSummary !== "string" || observation.safeSummary.length > 512 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(observation.safeSummary)
    ))) return null;
  const observedAt = exactTimestamp(observation.observedAt);
  const sourceUpdatedAt = exactTimestamp(observation.sourceUpdatedAt);
  if (!observedAt || !sourceUpdatedAt || sourceUpdatedAt > observedAt || observedAt > event.createdAt) {
    return null;
  }
  const category = event.payload.category;
  const observedState = observation.observedState as ActivityObservedState;
  if (typeof category !== "string" || !CATEGORIES.has(category as ActivityCategory) ||
    !STATE_BY_CATEGORY[category as ActivityCategory].includes(observedState) ||
    event.payload.observationId !== observation.id || event.payload.workId !== binding.workId ||
    event.payload.observedState !== observedState ||
    event.payload.sourceVersion !== observation.sourceVersion ||
    event.payload.terminal !== observation.terminal ||
    !validateTerminal(
      category as ActivityCategory,
      observedState,
      observation.terminal,
      event.payload.terminalReason,
    )) return null;
  const artifactId = event.payload.artifactId;
  if ((category === "artifact" && !validId("artifact", artifactId)) ||
    (category !== "artifact" && artifactId !== null)) return null;
  return {
    event,
    binding: {
      source: "canonical_work_attempt",
      workId: binding.workId,
      channelId: binding.channelId,
      actorPrincipalId: binding.actorPrincipalId,
    },
    observation: {
      id: observation.id,
      authoritySystem: "resident_turn",
      authorityId: observation.authorityId,
      sourceVersion: observation.sourceVersion,
      observedState,
      observedAt,
      sourceUpdatedAt,
      freshness: observation.freshness as ActivityFreshness,
      terminal: observation.terminal,
      safeSummary: observation.safeSummary,
    },
    category: category as ActivityCategory,
    terminalReason: event.payload.terminalReason as ActivityTerminalReason | null,
    artifactId: artifactId as string | null,
  };
}

function fullWorkSignature(input: NormalizedWorkInput): string {
  return stableJson(input);
}

function sourceTuple(input: NormalizedWorkInput): string {
  return `${input.observation.authoritySystem}\0${input.observation.authorityId}\0${input.observation.sourceVersion}`;
}

function sourceSemanticSignature(input: NormalizedWorkInput): string {
  return stableJson({
    binding: input.binding,
    authoritySystem: input.observation.authoritySystem,
    authorityId: input.observation.authorityId,
    sourceVersion: input.observation.sourceVersion,
    observedState: input.observation.observedState,
    observedAt: input.observation.observedAt,
    sourceUpdatedAt: input.observation.sourceUpdatedAt,
    freshness: input.observation.freshness,
    terminal: input.observation.terminal,
    safeSummary: input.observation.safeSummary,
    category: input.category,
    terminalReason: input.terminalReason,
    artifactId: input.artifactId,
  });
}

function eventCatalog(
  rawEvents: readonly unknown[],
  retainedAfterEventSequence: number,
  throughEventSequence: number,
): {
  events: readonly ValidatedEvent[];
  byId: ReadonlyMap<string, ValidatedEvent>;
  maximumSequence: number;
  firstConflict: number | null;
} {
  const groups = new Map<string, ValidatedEvent[]>();
  for (const value of rawEvents) {
    let event: ValidatedEvent;
    try {
      event = validateEventEnvelope(value);
    } catch {
      // Invalid input has no trusted cursor position and is omitted.
      continue;
    }
    if (event.durability !== "durable") continue;
    if (event.sequence <= retainedAfterEventSequence || event.sequence > throughEventSequence) {
      throw new TypeError("durable Event lies outside the complete Activity source window");
    }
    const group = groups.get(event.id) ?? [];
    group.push(event);
    groups.set(event.id, group);
  }
  let firstConflict: number | null = null;
  const unique: ValidatedEvent[] = [];
  for (const group of groups.values()) {
    if (new Set(group.map(stableJson)).size > 1) {
      const sequence = Math.min(...group.map((event) => event.sequence));
      firstConflict = firstConflict === null ? sequence : Math.min(firstConflict, sequence);
    } else if (group[0]) unique.push(group[0]);
  }
  const bySequence = new Map<number, ValidatedEvent[]>();
  for (const event of unique) {
    const group = bySequence.get(event.sequence) ?? [];
    group.push(event);
    bySequence.set(event.sequence, group);
  }
  const accepted: ValidatedEvent[] = [];
  for (const [sequence, group] of bySequence) {
    if (group.length > 1) {
      firstConflict = firstConflict === null ? sequence : Math.min(firstConflict, sequence);
    } else if (group[0]) accepted.push(group[0]);
  }
  accepted.sort((left, right) => left.sequence - right.sequence || asciiCompare(left.id, right.id));
  let expectedSequence = retainedAfterEventSequence + 1;
  for (const event of accepted) {
    if (event.sequence > expectedSequence) {
      firstConflict = earlierConflict(firstConflict, expectedSequence);
      break;
    }
    expectedSequence = event.sequence + 1;
  }
  if (expectedSequence <= throughEventSequence) {
    firstConflict = earlierConflict(firstConflict, expectedSequence);
  }
  return {
    events: Object.freeze(accepted),
    byId: new Map(accepted.map((event) => [event.id, event])),
    maximumSequence: throughEventSequence,
    firstConflict,
  };
}

function workCatalog(
  values: readonly unknown[],
  events: ReadonlyMap<string, ValidatedEvent>,
): {
  byEventId: ReadonlyMap<string, NormalizedWorkInput>;
  recognizedEventIds: ReadonlySet<string>;
  firstConflict: number | null;
} {
  let firstConflict: number | null = null;
  const normalized: NormalizedWorkInput[] = [];
  const recognizedEventIds = new Set<string>();
  for (const value of values) {
    let claimedEvent: ValidatedEvent;
    try {
      claimedEvent = validateEventEnvelope(isRecord(value) ? value.event : undefined);
    } catch {
      // An invalid embedded envelope has no trustworthy global sequence.
      continue;
    }
    const canonicalEvent = events.get(claimedEvent.id);
    if (!canonicalEvent) continue;
    const input = normalizeWorkInput(value);
    if (!input || stableJson(canonicalEvent) !== stableJson(claimedEvent)) {
      firstConflict = earlierConflict(firstConflict, claimedEvent.sequence);
      continue;
    }
    normalized.push(input);
    recognizedEventIds.add(input.event.id);
  }
  const byWork = new Map<string, NormalizedWorkInput[]>();
  for (const input of normalized) {
    const group = byWork.get(input.binding.workId) ?? [];
    group.push(input);
    byWork.set(input.binding.workId, group);
  }
  for (const group of byWork.values()) {
    const ordered = [...group].sort((left, right) => left.event.sequence - right.event.sequence);
    const canonical = ordered[0]?.binding;
    if (!canonical) continue;
    const mismatch = ordered.find((input) =>
      input.binding.channelId !== canonical.channelId ||
      input.binding.actorPrincipalId !== canonical.actorPrincipalId
    );
    if (mismatch) firstConflict = earlierConflict(firstConflict, mismatch.event.sequence);
  }
  const byEvent = new Map<string, NormalizedWorkInput[]>();
  for (const input of normalized) {
    const group = byEvent.get(input.event.id) ?? [];
    group.push(input);
    byEvent.set(input.event.id, group);
  }
  const uniqueByEvent: NormalizedWorkInput[] = [];
  for (const group of byEvent.values()) {
    if (new Set(group.map(fullWorkSignature)).size > 1) {
      const sequence = group[0]!.event.sequence;
      firstConflict = earlierConflict(firstConflict, sequence);
    } else if (group[0]) uniqueByEvent.push(group[0]);
  }

  const byObservation = new Map<string, NormalizedWorkInput[]>();
  for (const input of uniqueByEvent) {
    const group = byObservation.get(input.observation.id) ?? [];
    group.push(input);
    byObservation.set(input.observation.id, group);
  }
  const uniqueByObservation: NormalizedWorkInput[] = [];
  for (const group of byObservation.values()) {
    if (group.length > 1) {
      const sequence = Math.min(...group.map((input) => input.event.sequence));
      firstConflict = earlierConflict(firstConflict, sequence);
    } else if (group[0]) uniqueByObservation.push(group[0]);
  }

  const bySource = new Map<string, NormalizedWorkInput[]>();
  for (const input of uniqueByObservation) {
    const group = bySource.get(sourceTuple(input)) ?? [];
    group.push(input);
    bySource.set(sourceTuple(input), group);
  }
  const accepted = new Map<string, NormalizedWorkInput>();
  for (const group of bySource.values()) {
    if (new Set(group.map(sourceSemanticSignature)).size > 1) {
      const sequence = Math.min(...group.map((input) => input.event.sequence));
      firstConflict = earlierConflict(firstConflict, sequence);
      continue;
    }
    const earliest = [...group].sort((left, right) => left.event.sequence - right.event.sequence)[0];
    if (earliest) accepted.set(earliest.event.id, earliest);
  }
  return { byEventId: accepted, recognizedEventIds, firstConflict };
}

function freezeEntry(entry: ActivityEntry): ActivityEntry {
  return Object.freeze({
    ...entry,
    actor: Object.freeze({ ...entry.actor }),
    source: Object.freeze({ ...entry.source }),
    interval: Object.freeze({ ...entry.interval }),
  });
}

function initialInterval(sequence: number, updatedAt: string): ActivityInterval {
  return {
    firstEventSequence: sequence,
    lastEventSequence: sequence,
    startedAt: updatedAt,
    endedAt: updatedAt,
  };
}

function chronologicalBounds(...timestamps: readonly string[]): {
  startedAt: string;
  endedAt: string;
} {
  const ordered = [...timestamps].sort(asciiCompare);
  return { startedAt: ordered[0]!, endedAt: ordered.at(-1)! };
}

function workPresentation(input: NormalizedWorkInput): {
  category: ActivityCategory;
  state: ActivityState;
  label: string;
  terminalReason: ActivityTerminalReason | null;
  terminalExplanation: string | null;
} {
  const state = input.observation.observedState;
  if (input.observation.terminal) {
    const reason = input.terminalReason!;
    if (state === "cancelled") {
      return {
        category: "completion",
        state: "idle",
        label: "Cancelled",
        terminalReason: reason,
        terminalExplanation: TERMINAL_EXPLANATIONS[reason],
      };
    }
    const failure = input.category === "failure";
    return {
      category: input.category,
      state: failure ? "failed" : "idle",
      label: failure ? "Failed" : reason === "passed" ? "Passed" : "Completed",
      terminalReason: reason,
      terminalExplanation: TERMINAL_EXPLANATIONS[reason],
    };
  }
  if (input.observation.freshness !== "current") {
    const labels: Record<Exclude<ActivityFreshness, "current">, string> = {
      stale: "Status may be stale",
      unknown: "Status unavailable",
      unavailable: "Source unavailable",
    };
    return {
      category: "waiting",
      state: "attention",
      label: labels[input.observation.freshness],
      terminalReason: null,
      terminalExplanation: null,
    };
  }
  if (input.category === "waiting" && state === "cancelling") {
    return { category: "waiting", state: "stopping", label: "Stopping", terminalReason: null, terminalExplanation: null };
  }
  const presentations: Record<Exclude<ActivityCategory, "failure" | "completion">, [ActivityState, string]> = {
    started: ["accepted", "Started"],
    progress: ["working", "Working"],
    waiting: ["attention", "Waiting"],
    retry: ["attention", "Retry scheduled"],
    artifact: ["working", "Artifact ready"],
  };
  const [activityState, label] = presentations[input.category as keyof typeof presentations];
  const lockedLabel = input.category === "progress" && input.observation.safeSummary !== null
    ? LOCKED_SAFE_SUMMARY_LABELS.get(input.observation.safeSummary)
    : undefined;
  return {
    category: input.category,
    state: activityState,
    label: lockedLabel ?? label,
    terminalReason: null,
    terminalExplanation: null,
  };
}

function entryFromWork(input: NormalizedWorkInput): ActivityEntry {
  const presentation = workPresentation(input);
  return freezeEntry({
    key: `work:${input.observation.id}:${presentation.category}`,
    eventSequence: input.event.sequence,
    category: presentation.category,
    state: presentation.state,
    label: presentation.label,
    updatedAt: input.observation.observedAt,
    channelId: input.binding.channelId,
    actor: { principalId: input.binding.actorPrincipalId, displayName: null },
    workId: input.binding.workId,
    observationId: input.observation.id,
    messageId: null,
    artifactId: input.category === "artifact" ? input.artifactId : null,
    source: {
      kind: "work_observation",
      id: input.observation.id,
      eventType: input.event.type,
      authoritySystem: input.observation.authoritySystem,
      authorityId: input.observation.authorityId,
      sourceVersion: input.observation.sourceVersion,
      freshness: input.observation.freshness,
    },
    terminalReason: presentation.terminalReason,
    terminalExplanation: presentation.terminalExplanation,
    collapsedCount: 1,
    compacted: false,
    interval: initialInterval(input.event.sequence, input.observation.observedAt),
  });
}

function eventSource(id: string, eventType: string): ActivitySourceStamp {
  return {
    kind: "event",
    id,
    eventType,
    authoritySystem: null,
    authorityId: null,
    sourceVersion: null,
    freshness: null,
  };
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function messagePayloadMatches(event: ValidatedEvent, message: NormalizedMessage): boolean {
  const payload = event.payload;
  return payload.messageId === message.id && payload.channelId === message.channelId &&
    payload.conversationId === message.conversationId && payload.channelSequence === message.sequence &&
    positiveInteger(payload.channelVersion) && payload.messageVersion === event.aggregate.version &&
    payload.authorPrincipalId === message.actor.principalId &&
    sameStrings(payload.mentions, message.mentions) &&
    payload.replyToMessageId === message.replyToMessageId &&
    payload.tombstonesMessageId === message.tombstonesMessageId &&
    payload.roundId === message.roundId && payload.workId === message.workId;
}

function decideEvent(
  event: ValidatedEvent,
  messages: ReadonlyMap<string, NormalizedMessage>,
  audience: ActivityAudience,
  channels: ReadonlyMap<string, ReadonlySet<string>>,
): EventDecision {
  if (event.type === "message.appended") {
    if (event.durability !== "durable") return { kind: "conflict" };
    const id = event.payload.messageId;
    const message = typeof id === "string" ? messages.get(id) : undefined;
    if (!message || event.aggregate.kind !== "message" || event.aggregate.id !== message.id ||
      event.channelId !== message.channelId || event.actorPrincipalId !== message.actor.principalId ||
      event.createdAt !== message.createdAt || !messagePayloadMatches(event, message)) {
      return { kind: "conflict" };
    }
    if (message.visibility !== "visible" || message.kind !== "result" || message.workId === null ||
      !visibleToAudience(message.channelId, message.actor.principalId, audience, channels)) {
      return { kind: "ignore" };
    }
    return { kind: "entry", entry: freezeEntry({
      key: `event:${event.id}:completion`,
      eventSequence: event.sequence,
      category: "completion",
      state: "idle",
      label: "Result posted",
      updatedAt: event.createdAt,
      channelId: message.channelId,
      actor: message.actor,
      workId: message.workId,
      observationId: null,
      messageId: message.id,
      artifactId: null,
      source: eventSource(event.id, event.type),
      terminalReason: "result_posted",
      terminalExplanation: TERMINAL_EXPLANATIONS.result_posted,
      collapsedCount: 1,
      compacted: false,
      interval: initialInterval(event.sequence, event.createdAt),
    }) };
  }
  if (event.type === "attachment.updated") {
    if (event.durability !== "durable") return { kind: "conflict" };
    const artifactId = event.payload.artifactId;
    const state = event.payload.state;
    if (event.aggregate.kind !== "artifact" || !validId("artifact", artifactId) ||
      event.aggregate.id !== artifactId || event.channelId !== null ||
      event.actorPrincipalId === null) return { kind: "conflict" };
    if (event.payload.ownerPrincipalId !== undefined &&
      !validId("principal", event.payload.ownerPrincipalId)) return { kind: "conflict" };
    if (state !== "staging" && state !== "ready" && state !== "failed" &&
      state !== "expired" && state !== "deleted") return { kind: "ignore" };
    if ((state !== "ready" && state !== "failed") ||
      !visibleToAudience(null, event.actorPrincipalId, audience, channels)) return { kind: "ignore" };
    const failed = state === "failed";
    return { kind: "entry", entry: freezeEntry({
      key: `event:${event.id}:${failed ? "failure" : "artifact"}`,
      eventSequence: event.sequence,
      category: failed ? "failure" : "artifact",
      state: failed ? "failed" : "working",
      label: failed ? "Attachment failed" : "Artifact ready",
      updatedAt: event.createdAt,
      channelId: null,
      actor: { principalId: event.actorPrincipalId, displayName: null },
      workId: null,
      observationId: null,
      messageId: null,
      artifactId,
      source: eventSource(event.id, event.type),
      terminalReason: failed ? "attachment_failed" : null,
      terminalExplanation: failed ? TERMINAL_EXPLANATIONS.attachment_failed : null,
      collapsedCount: 1,
      compacted: false,
      interval: initialInterval(event.sequence, event.createdAt),
    }) };
  }
  return { kind: "ignore" };
}

function progressKey(entry: ActivityEntry): string {
  return `${entry.workId}\0${entry.channelId}\0${entry.actor.principalId}\0` +
    `${entry.source.authoritySystem}\0${entry.source.authorityId}`;
}

function mergeProgress(first: ActivityEntry, latest: ActivityEntry): ActivityEntry {
  const bounds = chronologicalBounds(
    first.interval.startedAt,
    first.interval.endedAt,
    latest.interval.startedAt,
    latest.interval.endedAt,
  );
  return freezeEntry({
    ...latest,
    collapsedCount: first.collapsedCount + latest.collapsedCount,
    interval: {
      firstEventSequence: first.interval.firstEventSequence,
      lastEventSequence: latest.interval.lastEventSequence,
      ...bounds,
    },
  });
}

function collapseProgress(entries: readonly ActivityEntry[]): readonly ActivityEntry[] {
  const output: ActivityEntry[] = [];
  const active = new Map<string, { index: number; workId: string | null }>();
  for (const entry of [...entries].sort(compareEntries)) {
    if (entry.category === "progress" && entry.workId !== null) {
      const key = progressKey(entry);
      const existing = active.get(key);
      if (existing) output[existing.index] = mergeProgress(output[existing.index]!, entry);
      else {
        active.set(key, { index: output.length, workId: entry.workId });
        output.push(entry);
      }
      continue;
    }
    if (entry.workId !== null) {
      for (const [key, value] of active) if (value.workId === entry.workId) active.delete(key);
    }
    output.push(entry);
  }
  return Object.freeze(output.sort(compareEntries));
}

function reconcileTerminalResults(
  decisions: Map<string, EventDecision>,
  stopBeforeEventSequence: number | null,
): number | null {
  const byWork = new Map<string, { eventId: string; entry: ActivityEntry }[]>();
  for (const [eventId, decision] of decisions) {
    if (decision.kind !== "entry" || decision.entry.workId === null ||
      (stopBeforeEventSequence !== null &&
        decision.entry.eventSequence >= stopBeforeEventSequence)) continue;
    const group = byWork.get(decision.entry.workId) ?? [];
    group.push({ eventId, entry: decision.entry });
    byWork.set(decision.entry.workId, group);
  }
  let firstConflict: number | null = null;
  for (const facts of byWork.values()) {
    const results = facts.filter(({ entry }) =>
      entry.source.kind === "event" && entry.source.eventType === "message.appended"
    ).sort((left, right) => compareEntries(left.entry, right.entry));
    const terminals = facts.filter(({ entry }) =>
      entry.source.kind === "work_observation" && entry.terminalReason !== null
    ).sort((left, right) => compareEntries(left.entry, right.entry));
    if (results.length > 1 && results[1]) {
      firstConflict = earlierConflict(firstConflict, results[1].entry.eventSequence);
      continue;
    }
    const result = results[0];
    if (!result || terminals.length === 0) continue;
    const incompatible = terminals.find(({ entry }) =>
      entry.terminalReason !== "completed" ||
      entry.channelId !== result.entry.channelId ||
      entry.actor.principalId !== result.entry.actor.principalId ||
      entry.eventSequence <= result.entry.eventSequence
    );
    if (incompatible) {
      firstConflict = earlierConflict(
        firstConflict,
        Math.max(incompatible.entry.eventSequence, result.entry.eventSequence),
      );
      continue;
    }
    const terminal = terminals.at(-1)!;
    const bounds = chronologicalBounds(
      result.entry.interval.startedAt,
      result.entry.interval.endedAt,
      terminal.entry.interval.startedAt,
      terminal.entry.interval.endedAt,
    );
    decisions.set(result.eventId, { kind: "ignore" });
    for (const earlier of terminals.slice(0, -1)) {
      decisions.set(earlier.eventId, { kind: "ignore" });
    }
    decisions.set(terminal.eventId, {
      kind: "entry",
      entry: freezeEntry({
        ...terminal.entry,
        actor: {
          principalId: terminal.entry.actor.principalId,
          displayName: result.entry.actor.displayName,
        },
        messageId: result.entry.messageId,
        interval: {
          firstEventSequence: result.entry.eventSequence,
          lastEventSequence: terminal.entry.eventSequence,
          ...bounds,
        },
      }),
    });
  }
  return firstConflict;
}

export function projectActivity(input: ProjectActivityInput): ActivityProjection {
  if (!isRecord(input) || !Array.isArray(input.events) || !Array.isArray(input.messages) ||
    !Array.isArray(input.workObservations) || !isRecord(input.sourceWindow) ||
    input.sourceWindow.completeness !== "complete_retained_window" ||
    !Number.isSafeInteger(input.sourceWindow.retainedAfterEventSequence) ||
    input.sourceWindow.retainedAfterEventSequence < 0 ||
    !Number.isSafeInteger(input.sourceWindow.throughEventSequence) ||
    input.sourceWindow.throughEventSequence < input.sourceWindow.retainedAfterEventSequence) {
    throw new TypeError("activity projection input is invalid");
  }
  const channels = normalizeAudience(input.audience);
  const rawWorkEvents = input.workObservations.map((value) =>
    isRecord(value) ? value.event : undefined
  );
  const events = eventCatalog(
    [...input.events, ...rawWorkEvents],
    input.sourceWindow.retainedAfterEventSequence,
    input.sourceWindow.throughEventSequence,
  );
  const work = workCatalog(input.workObservations, events.byId);
  const messages = messageIndex(input.messages);
  const decisions = new Map<string, EventDecision>();
  let reconciliationConflict: number | null = null;
  for (const event of events.events) {
    const workInput = work.byEventId.get(event.id);
    if (event.type === "activity.updated") {
      if (!workInput) {
        if (!work.recognizedEventIds.has(event.id)) {
          reconciliationConflict = earlierConflict(reconciliationConflict, event.sequence);
        } else {
          decisions.set(event.id, { kind: "ignore" });
        }
      } else if (visibleToAudience(
        workInput.binding.channelId,
        workInput.binding.actorPrincipalId,
        input.audience,
        channels,
      )) {
        decisions.set(event.id, { kind: "entry", entry: entryFromWork(workInput) });
      } else {
        decisions.set(event.id, { kind: "ignore" });
      }
      continue;
    }
    const decision = decideEvent(event, messages, input.audience, channels);
    decisions.set(event.id, decision);
    if (decision.kind === "conflict") {
      reconciliationConflict = earlierConflict(reconciliationConflict, event.sequence);
    }
  }
  const baseConflicts = [
    events.firstConflict,
    work.firstConflict,
    reconciliationConflict,
  ].filter(
    (value): value is number => value !== null,
  );
  const baseFirstConflict = baseConflicts.length > 0 ? Math.min(...baseConflicts) : null;
  const terminalConflict = reconcileTerminalResults(decisions, baseFirstConflict);
  const conflicts = terminalConflict === null
    ? baseConflicts
    : [...baseConflicts, terminalConflict];
  const firstConflict = conflicts.length > 0 ? Math.min(...conflicts) : null;
  const throughEventSequence = firstConflict === null
    ? events.maximumSequence
    : Math.max(0, firstConflict - 1);
  const entries: ActivityEntry[] = [];
  for (const event of events.events) {
    if (event.sequence > throughEventSequence) continue;
    const decision = decisions.get(event.id);
    if (decision?.kind === "entry") entries.push(decision.entry);
  }

  const compactEntries = collapseProgress(entries);
  return Object.freeze({
    entries: compactEntries,
    throughEventSequence,
    integrity: firstConflict === null
      ? Object.freeze({ status: "complete" as const })
      : Object.freeze({ status: "conflict" as const, conflictAtEventSequence: firstConflict }),
  });
}
