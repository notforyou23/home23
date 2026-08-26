import type { AgentEvent, AgentResponse, CoordinationTurnOrigin } from '../agent/types.js';

export interface ResidentLeaseBinding extends Omit<CoordinationTurnOrigin, 'kind' | 'channelId' | 'originMessageId' | 'roundId'> {
  requestId: string;
  correlationId: string;
}

export interface ResidentWorkRequest {
  chatId: string;
  instruction: string;
  origin: CoordinationTurnOrigin;
  requestId: string;
  correlationId: string;
}

export type ResidentTerminalStatus = 'succeeded' | 'failed' | 'cancelled';

export interface ResidentTerminalReceipt {
  status: ResidentTerminalStatus;
  sourceReference: string;
  resultDigest: string | null;
  artifactIds: readonly string[];
  timestamp: string;
}

export interface ResidentCoordinationPort {
  assertCurrent(binding: ResidentLeaseBinding): void | Promise<void>;
  accept(binding: ResidentLeaseBinding): void | Promise<void>;
  start(binding: ResidentLeaseBinding): void | Promise<void>;
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
  runWithTurn(
    chatId: string,
    userText: string,
    options: {
      coordinationOrigin: CoordinationTurnOrigin;
      coordinationRequest?: { requestId: string; correlationId: string };
      onDurableStart(start: { turnId: string; chatId: string; persistedAt: string }): void | Promise<void>;
      onEvent(event: AgentEvent): void;
    },
  ): Promise<{ turnId: string; response: Promise<AgentResponse> }>;
  stop(chatId: string, turnId: string): { stopped: boolean } | Promise<{ stopped: boolean }>;
}

export interface ResidentRun {
  turnId: string;
  response: Promise<AgentResponse>;
  receipt: Promise<unknown>;
}
