import type {
  AgentEvent,
  AgentResponse,
  CoordinationTurnDeliveryContext,
  CoordinationTurnOrigin,
} from '../agent/types.js';
import type { ReasoningEffort } from '../agent/reasoning-effort.js';
import type { AppendCommunicationEventInput } from '../coordination/communications/index.js';
import type { HOUSE_RESIDENT_CAPABILITIES } from '../coordination/house-resident-capabilities.js';

export interface ResidentLeaseBinding extends Omit<CoordinationTurnOrigin, 'kind' | 'channelId' | 'originMessageId' | 'roundId'> {
  requestId: string;
  correlationId: string;
}

export interface ResidentWorkRequest {
  chatId: string;
  instruction: string;
  attachments?: readonly ResidentInputAttachment[];
  origin: CoordinationTurnOrigin;
  requestId: string;
  correlationId: string;
  communication?: ResidentCommunicationContext;
  turnSelection: ResidentTurnSelectionRequest;
}

/** Private coordinator-to-resident attachment reference. Never crosses HTTP. */
export interface ResidentInputAttachment {
  artifactId: string;
  name: string;
  contentType: string;
  byteCount: number;
  sha256: string;
  path: string;
}

export interface ResidentTurnSelectionRequest {
  modelAlias: string | null;
  reasoningEffort: ReasoningEffort | null;
}

export interface ResidentTurnSelectionReceipt {
  requestedProvider: string | null;
  requestedModelAlias: string | null;
  requestedModel: string | null;
  requestedEffort: ReasoningEffort | null;
  resolvedProvider: string | null;
  resolvedModel: string | null;
  resolvedEffort: ReasoningEffort | null;
  actualProvider: string | null;
  actualModel: string | null;
  actualEffort: ReasoningEffort | null;
}

export interface ResidentModelCatalog {
  capabilities: readonly (typeof HOUSE_RESIDENT_CAPABILITIES)[number][];
  models: readonly Readonly<{
    alias: string;
    provider: string;
    model: string;
    reasoningEffort: ReasoningEffort | null;
  }>[];
  defaultModel: string;
  defaultProvider: string;
  defaultReasoningEffort: ReasoningEffort;
  reasoningEfforts: readonly ReasoningEffort[];
}

export interface ResidentCommunicationContext {
  conversationId: string;
  responseMessageId: string;
  actor: {
    principalId: string;
    displayName: string;
    kind: string;
  };
}

export interface ResidentDurableEvent {
  turnId: string;
  sequence: number;
  occurredAt: string;
  provider: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  event: AgentEvent;
}

/** Exact resident-owned terminal metadata returned with durable event replay. */
export interface ResidentDurableTerminal {
  status: string;
  lastSequence: number;
  endedAt: string;
  errorCode: string | null;
  errorMessage: string | null;
  provider: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
}

export interface ResidentCommunicationPort {
  append(input: AppendCommunicationEventInput): unknown | Promise<unknown>;
}

/** Inspector/evidence vocabulary for one execution kind. */
export interface CoordinationExecutionEvidenceTaxonomy {
  eventIdPrefix: "resident-turn" | "bot-turn";
  runtimeSystem: "resident_runtime" | "bot_runtime";
  sequenceField: "residentSequence" | "botSequence";
  terminalStatusField: "residentStatus" | "botStatus";
  terminalPayloadField: "residentTerminal" | "botTerminal";
}

export type ResidentTerminalStatus = 'succeeded' | 'failed' | 'cancelled';

export interface ResidentTerminalReceipt {
  status: ResidentTerminalStatus;
  sourceReference: string;
  resultDigest: string | null;
  artifactIds: readonly string[];
  timestamp: string;
}

export interface ResidentArtifactPromotionPort {
  promote(input: Readonly<{
    binding: ResidentLeaseBinding;
    media: NonNullable<AgentResponse['media']>;
  }>): Promise<readonly string[]>;
}

export interface ResidentCoordinationPort {
  assertCurrent(binding: ResidentLeaseBinding): void | Promise<void>;
  cancellationState?(binding: ResidentLeaseBinding):
    { timestamp: string } | null | Promise<{ timestamp: string } | null>;
  assertCompleted(binding: ResidentLeaseBinding, resultDigest?: string):
    ResidentTerminalReceipt | void | Promise<ResidentTerminalReceipt | void>;
  accept(binding: ResidentLeaseBinding): void | Promise<void>;
  start(binding: ResidentLeaseBinding): void | Promise<void>;
  reattach(binding: ResidentLeaseBinding): void | Promise<void>;
  revoke(binding: ResidentLeaseBinding & { reasonCode: string }): void | Promise<void>;
  terminalize(input: ResidentLeaseBinding & { receipt: ResidentTerminalReceipt }): unknown | Promise<unknown>;
  observe?(binding: ResidentLeaseBinding, observation: ResidentObservation): void | Promise<void>;
}

export interface ResidentObservation {
  kind: AgentEvent['type'];
  outcomeCode: string;
  evidenceDigest: string;
  at: string;
}

export interface ResidentAgentPort {
  modelCatalog(input: {
    requestId: string;
    correlationId: string;
  }): Promise<ResidentModelCatalog>;
  runWithTurn(
    chatId: string,
    userText: string,
    options: {
      coordinationOrigin: CoordinationTurnOrigin;
      coordinationDelivery?: CoordinationTurnDeliveryContext;
      coordinationRequest?: { requestId: string; correlationId: string };
      turnSelection: ResidentTurnSelectionRequest;
      attachments?: readonly ResidentInputAttachment[];
      completedRecovery?: true;
      onDurableStart(start: {
        turnId: string;
        chatId: string;
        persistedAt: string;
        selection?: ResidentTurnSelectionReceipt;
      }): void | Promise<void>;
      onEvent(event: ResidentDurableEvent): void;
    },
  ): Promise<{
    turnId: string;
    response: Promise<AgentResponse>;
    /** Present for transports that can prove the resident's durable terminal envelope. */
    terminal?: Promise<ResidentDurableTerminal>;
    selection?: ResidentTurnSelectionReceipt;
  }>;
  stop(chatId: string, turnId: string): { stopped: boolean } | Promise<{ stopped: boolean }>;
}

export interface ResidentRun {
  turnId: string;
  response: Promise<AgentResponse>;
  receipt: Promise<ResidentTerminalReceipt>;
}
