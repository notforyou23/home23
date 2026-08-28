import type { JsonValue } from "../db/index.js";
import type { RoundRecord } from "../rounds/index.js";
import type {
  ContextManifestInput,
  CreateWorkResult,
  M11Database,
  WorkRecord,
  WorkTurnSelection,
} from "../work/index.js";

export const MAX_CHANNEL_TURNS_PER_BOT = 4;
export const MAX_CHANNEL_TURNS_PER_ROUND = 12;

export interface CoordinatorAuthority {
  capability: "messages";
  mode: "canonical";
  epoch: number;
  writer: string;
}

/** Facts constructed by a trusted policy boundary, never from message/model text. */
export interface CoordinatorStandingScope {
  source: "trusted_policy_boundary";
  reference: string;
  channelId: string;
  allowedParticipantIds: readonly string[];
  broadcastAllowed: boolean;
}

export interface CoordinatorAdmissionTarget {
  targetBotId: string;
  targetBotDisplayName: string;
  targetPrincipalId: string;
  residentBinding: string;
}

/** Immutable caller state committed with the Round before any Work exists. */
export interface CoordinatorAdmissionPlan {
  version: 1;
  channelId: string;
  conversationId: string;
  originMessageId: string;
  originEventId: string;
  actorPrincipalId: string;
  visibleParticipantIds: readonly string[];
  selectedTargets: readonly CoordinatorAdmissionTarget[];
  responseOrder: "parallel" | "sequential";
  standingReference: string;
  manifest: ContextManifestInput;
  turnSelection: WorkTurnSelection;
}

export interface ChannelTurnTrigger {
  eventId: string;
  messageId: string;
  channelId: string;
  actorPrincipalId: string;
  selection: "mentions" | "broadcast";
  mentionedBotIds: readonly string[];
  /** Entire trusted recipient plan; sequential dispatch may admit one Work at a time. */
  plannedBotIds: readonly string[];
  admissionPlan: CoordinatorAdmissionPlan;
  visibleParticipantIds: readonly string[];
  standing: CoordinatorStandingScope;
  authority: CoordinatorAuthority;
  deadlineAt: string;
  manifest: ContextManifestInput;
  /** Server-validated owner selection copied to every Work in this pass. */
  turnSelection?: WorkTurnSelection;
  requestId: string;
  correlationId: string;
}

export interface CoordinatorDispatch {
  round: RoundRecord;
  recipients: readonly string[];
  works: readonly CreateWorkResult[];
  replayed: boolean;
  provenance: CoordinatorDispatchProvenance;
  activityFacts: readonly CoordinatorActivityFact[];
}

export interface CoordinatorAdmissionReplay {
  round: RoundRecord;
  recipients: readonly string[];
  works: readonly WorkRecord[];
  replayed: true;
}

export interface CoordinatorDispatchProvenance {
  sourceEventId: string;
  sourceMessageId: string;
  standingReference: string;
  authority: CoordinatorAuthority;
}

/** Content-free facts suitable for trusted M11 Activity fact assembly. */
export interface CoordinatorActivityFact {
  sourceKind: "work_attempt";
  workId: string;
  roundId: string;
  channelId: string;
  actorPrincipalId: string;
  targetPrincipalId: string;
  observedState: "queued";
  authorityReference: string;
  sourceEventId: string;
}

export type CoordinatorTurnDisposition = "completed" | "passed" | "retryable_failure" | "permanent_failure";

export interface ReconcileRoundInput {
  roundId: string;
  dispositions?: Readonly<Record<string, CoordinatorTurnDisposition>>;
  requestId: string;
  correlationId: string;
}

export interface CoordinatorRoundStatus {
  round: RoundRecord;
  works: readonly WorkRecord[];
  outcome: "waiting" | "completed" | "failed" | "cancelled";
  reasonCode: string | null;
}

export interface CoordinatorRoundPort {
  create(input: {
    channelId: string;
    coordinatorBotId: string;
    maxBotTurns: number;
    deadlineAt: string;
    requestId: string;
    correlationId: string;
    admissionPlan?: { readonly [key: string]: JsonValue };
  }): RoundRecord;
  beginPass(input: { roundId: string; requestId: string; correlationId: string }): RoundRecord;
  wait(input: { roundId: string; requestId: string; correlationId: string }): RoundRecord;
  reconcileDeadline(input: { roundId: string; requestId: string; correlationId: string }): RoundRecord;
  terminalize(input: {
    roundId: string;
    status: "completed" | "failed" | "cancelled";
    reasonCode: string;
    requestId: string;
    correlationId: string;
  }): RoundRecord;
  get(roundId: string): RoundRecord | null;
}

export interface CoordinatorWorkPort {
  create(input: {
    principalId: string;
    targetPrincipalId: string;
    channelId: string;
    originMessageId: string | null;
    roundId: string | null;
    kind: string;
    idempotencyKey: string;
    manifest: ContextManifestInput;
    maxAutomaticOffers: number;
    requestId: string;
    correlationId: string;
    turnSelection?: WorkTurnSelection;
  }): CreateWorkResult;
  cancelQueued(input: {
    workId: string;
    actorPrincipalId: string;
    reasonCode: string;
    sourceReference: string;
    timestamp: string;
    requestId: string;
    correlationId: string;
  }): unknown;
  get(workId: string): WorkRecord | null;
}

export interface CreateChannelCoordinatorOptions {
  database: M11Database;
  rounds: CoordinatorRoundPort;
  work: CoordinatorWorkPort;
  enabled?: boolean;
  expectedAuthorityWriter: string;
  now?: () => Date;
  durabilityFailpoint?: (
    point: "after_round_created" | "after_work_created",
    detail: Readonly<{ roundId: string; workCount: number }>,
  ) => void;
}
