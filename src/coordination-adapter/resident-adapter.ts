import { createHash } from 'node:crypto';
import type { AgentEvent, CoordinationTurnOrigin } from '../agent/types.js';
import {
  isCommunicationJsonValue,
  stableCommunicationEventId,
  type CommunicationEventInput,
} from '../coordination/communications/index.js';
import type { JsonValue } from '../coordination/db/index.js';
import type {
  ResidentAgentPort,
  ResidentCommunicationContext,
  ResidentCommunicationPort,
  ResidentCoordinationPort,
  ResidentDurableEvent,
  ResidentDurableTerminal,
  ResidentLeaseBinding,
  ResidentObservation,
  ResidentRun,
  ResidentTerminalReceipt,
  ResidentTurnSelectionReceipt,
  ResidentWorkRequest,
} from './types.js';

const MAX_OBSERVATIONS = 32;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function bindingFor(request: ResidentWorkRequest): ResidentLeaseBinding {
  const { origin } = request;
  return Object.freeze({
    workId: origin.workId,
    attemptId: origin.attemptId,
    leaseId: origin.leaseId,
    holderPrincipalId: origin.holderPrincipalId,
    holderInstanceId: origin.holderInstanceId,
    authorityReference: origin.authorityReference,
    fencingToken: origin.fencingToken,
    requestId: request.requestId,
    correlationId: request.correlationId,
  });
}

function privacySafeOrigin(origin: CoordinationTurnOrigin): CoordinationTurnOrigin {
  return Object.freeze({
    kind: 'coordination',
    workId: origin.workId,
    attemptId: origin.attemptId,
    leaseId: origin.leaseId,
    holderPrincipalId: origin.holderPrincipalId,
    holderInstanceId: origin.holderInstanceId,
    authorityReference: origin.authorityReference,
    fencingToken: origin.fencingToken,
    channelId: origin.channelId,
    originMessageId: origin.originMessageId,
    roundId: origin.roundId,
  });
}

function boundedObservation(durable: ResidentDurableEvent, at: string): ResidentObservation {
  const event = durable.event;
  const outcomeCode = event.type === 'status' && typeof event.status === 'string'
    ? event.status.slice(0, 64)
    : event.type;
  return Object.freeze({
    kind: event.type,
    outcomeCode,
    evidenceDigest: digest(JSON.stringify({ kind: event.type, outcomeCode })),
    at,
  });
}

function exactJsonRecord(value: unknown): Record<string, JsonValue> {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { serialized = undefined; }
  if (serialized === undefined) throw new TypeError('resident event is not JSON serializable');
  const parsed = JSON.parse(serialized) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !isCommunicationJsonValue(parsed)) {
    throw new TypeError('resident event is not a lossless JSON object');
  }
  return parsed as Record<string, JsonValue>;
}

function communicationKind(event: AgentEvent): string {
  switch (event.type) {
    case 'thinking':
      return event.provenance ? 'reasoning' : 'legacy_thinking_unattributed';
    case 'tool_start': return 'tool_call_started';
    case 'tool_result': return 'tool_call_completed';
    case 'response_chunk': return 'assistant_response_delta';
    case 'media': return 'media';
    case 'subagent_start': return 'subagent_started';
    case 'subagent_result': return 'subagent_completed';
    case 'cache': return 'cache';
    case 'status': return 'status';
  }
}

function durableCommunicationEventId(durable: ResidentDurableEvent): string {
  return stableCommunicationEventId(
    `resident-turn:${durable.turnId}:event:${durable.sequence}`,
    durable.occurredAt,
  );
}

function communicationToolCallId(
  durable: ResidentDurableEvent,
  parentEventId: string | null,
): string {
  const event = durable.event;
  if (event.type !== 'tool_start' && event.type !== 'tool_result') {
    throw new TypeError('tool call identity requires a tool event');
  }
  if (typeof event.toolCallId === 'string' && event.toolCallId.length > 0) {
    return event.toolCallId;
  }
  if (event.type === 'tool_result' && parentEventId) return parentEventId;
  return durableCommunicationEventId(durable);
}

function communicationPayload(
  durable: ResidentDurableEvent,
  parentEventId: string | null,
): Record<string, JsonValue> {
  const event = exactJsonRecord(durable.event);
  const common: Record<string, JsonValue> = {
    residentSequence: durable.sequence,
    rawEvent: event,
  };
  switch (durable.event.type) {
    case 'thinking':
      return { ...common, text: durable.event.content,
        ...(event.providerEvent === undefined ? {} : { providerEvent: event.providerEvent }) };
    case 'tool_start':
      return { ...common, toolCallId: communicationToolCallId(durable, parentEventId),
        tool: durable.event.tool,
        arguments: event.args ?? null };
    case 'tool_result':
      return { ...common, toolCallId: communicationToolCallId(durable, parentEventId),
        tool: durable.event.tool,
        result: durable.event.exactResult ?? durable.event.result,
        preview: durable.event.result, success: durable.event.success };
    case 'response_chunk':
      return { ...common, delta: durable.event.chunk };
    case 'media':
      return { ...common, mediaType: durable.event.mediaType, path: durable.event.path,
        caption: durable.event.caption ?? null, toolCallId: durable.event.toolCallId ?? null };
    case 'subagent_start':
      return { ...common, subagentId: durable.event.subagentId, task: durable.event.task,
        label: durable.event.label ?? null, parentToolCallId: durable.event.parentToolCallId ?? null };
    case 'subagent_result':
      return { ...common, subagentId: durable.event.subagentId, task: durable.event.task,
        result: durable.event.result, success: durable.event.success,
        parentToolCallId: durable.event.parentToolCallId ?? null };
    case 'cache':
      return { ...common, read: durable.event.read, write: durable.event.write,
        input: durable.event.input, output: durable.event.output };
    case 'status':
      return { ...common, status: durable.event.status, message: durable.event.message ?? null };
  }
}

function communicationEvent(input: {
  durable: ResidentDurableEvent;
  context: ResidentCommunicationContext;
  origin: CoordinationTurnOrigin;
  parentEventId: string | null;
}): CommunicationEventInput {
  const { durable, context, origin } = input;
  const event = durable.event;
  const providerOrigin = event.type === 'thinking' || event.type === 'response_chunk'
    || event.type === 'tool_start';
  return Object.freeze({
    eventId: durableCommunicationEventId(durable),
    conversationId: context.conversationId,
    channelId: origin.channelId,
    messageId: context.responseMessageId,
    workId: origin.workId,
    attemptId: origin.attemptId,
    turnId: durable.turnId,
    parentEventId: input.parentEventId,
    actor: context.actor,
    source: {
      system: providerOrigin ? 'provider' : 'resident_runtime',
      provider: durable.provider,
      model: durable.model,
      adapter: 'agent_loop',
      sourceEventType: event.sourceEventType ?? `agent.${event.type}`,
      additionalFields: {
        reasoningEffort: durable.reasoningEffort,
        residentSequence: durable.sequence,
      },
    },
    kind: communicationKind(event),
    provenance: event.type === 'thinking' ? event.provenance : null,
    occurredAt: durable.occurredAt,
    payload: communicationPayload(durable, input.parentEventId),
    terminal: event.type === 'tool_result' || event.type === 'subagent_result',
  });
}

function terminalCommunicationEvent(input: {
  turnId: string;
  durableTerminal: ResidentDurableTerminal | null;
  receipt: ResidentTerminalReceipt;
  context: ResidentCommunicationContext;
  origin: CoordinationTurnOrigin;
  parentEventId: string | null;
}): CommunicationEventInput {
  const { durableTerminal, receipt, context, origin } = input;
  return Object.freeze({
    eventId: stableCommunicationEventId(
      `resident-turn:${input.turnId}:terminal`,
      receipt.timestamp,
    ),
    conversationId: context.conversationId,
    channelId: origin.channelId,
    messageId: context.responseMessageId,
    workId: origin.workId,
    attemptId: origin.attemptId,
    turnId: input.turnId,
    parentEventId: input.parentEventId,
    actor: context.actor,
    source: {
      system: 'resident_runtime',
      provider: durableTerminal?.provider ?? null,
      model: durableTerminal?.model ?? null,
      adapter: 'agent_loop',
      sourceEventType: 'turn.terminal',
      additionalFields: {
        reasoningEffort: durableTerminal?.reasoningEffort ?? null,
        residentStatus: durableTerminal?.status ?? null,
      },
    },
    kind: receipt.status === 'failed' ? 'failure' : 'receipt',
    occurredAt: receipt.timestamp,
    payload: {
      status: receipt.status,
      sourceReference: receipt.sourceReference,
      resultDigest: receipt.resultDigest,
      artifactIds: [...receipt.artifactIds],
      residentTerminal: durableTerminal === null ? null : exactJsonRecord(durableTerminal),
    },
    terminal: true,
  });
}

function exactTurnSelection(
  request: ResidentWorkRequest,
  receipt: ResidentTurnSelectionReceipt | undefined,
): ResidentTurnSelectionReceipt {
  const requested = request.turnSelection ?? Object.freeze({
    modelAlias: null,
    reasoningEffort: null,
  });
  return receipt ?? Object.freeze({
    requestedProvider: null,
    requestedModelAlias: requested.modelAlias,
    requestedModel: null,
    requestedEffort: requested.reasoningEffort,
    resolvedProvider: null,
    resolvedModel: null,
    resolvedEffort: null,
    actualProvider: null,
    actualModel: null,
    actualEffort: null,
  });
}

function selectionCommunicationEvent(input: {
  turnId: string;
  persistedAt: string;
  selection: ResidentTurnSelectionReceipt;
  context: ResidentCommunicationContext;
  origin: CoordinationTurnOrigin;
}): CommunicationEventInput & { eventId: string } {
  const { selection, context, origin } = input;
  return Object.freeze({
    eventId: stableCommunicationEventId(
      `resident-turn:${input.turnId}:selection`,
      input.persistedAt,
    ),
    conversationId: context.conversationId,
    channelId: origin.channelId,
    messageId: context.responseMessageId,
    workId: origin.workId,
    attemptId: origin.attemptId,
    turnId: input.turnId,
    parentEventId: null,
    actor: context.actor,
    source: {
      system: 'resident_runtime',
      provider: selection.actualProvider,
      model: selection.actualModel,
      adapter: 'agent_loop',
      sourceEventType: 'turn.selection',
      additionalFields: {
        reasoningEffort: selection.actualEffort,
      },
    },
    kind: 'receipt',
    occurredAt: input.persistedAt,
    payload: exactJsonRecord(selection),
    terminal: false,
  });
}

function parentCommunicationEventId(
  durable: ResidentDurableEvent,
  parentEvents: Map<string, string>,
): string | null {
  const eventId = durableCommunicationEventId(durable);
  const event = durable.event;
  const toolKey = event.type === 'tool_start' || event.type === 'tool_result'
    ? `tool:${typeof event.toolCallId === 'string' && event.toolCallId.length > 0
      ? event.toolCallId
      : `legacy:${event.tool}`}`
    : null;
  const parentKey = event.type === 'tool_result'
    ? toolKey
    : event.type === 'media' && event.toolCallId
      ? `tool:${event.toolCallId}`
      : event.type === 'subagent_start' && event.parentToolCallId
        ? `tool:${event.parentToolCallId}`
        : event.type === 'subagent_result'
          ? `subagent:${event.subagentId}`
          : event.type === 'tool_start' && event.parentActivityId
            ? `activity:${event.parentActivityId}`
            : null;
  const parentEventId = parentKey ? parentEvents.get(parentKey) ?? null : null;
  if (event.type === 'tool_start') {
    parentEvents.set(toolKey!, eventId);
    parentEvents.set(
      `activity:${typeof event.toolCallId === 'string' && event.toolCallId.length > 0
        ? event.toolCallId
        : `legacy:${event.tool}`}`,
      eventId,
    );
  }
  if (event.type === 'subagent_start') {
    parentEvents.set(`subagent:${event.subagentId}`, eventId);
    parentEvents.set(`activity:${event.subagentId}`, eventId);
  }
  return parentEventId;
}

export class ResidentCoordinationAdapter {
  private readonly active = new Map<string, {
    chatId: string;
    turnId: string;
    binding: ResidentLeaseBinding;
    cancelling: boolean;
  }>();

  constructor(
    private readonly agent: ResidentAgentPort,
    private readonly coordination: ResidentCoordinationPort,
    private readonly now: () => Date = () => new Date(),
    private readonly communications?: ResidentCommunicationPort,
  ) {}

  async execute(request: ResidentWorkRequest): Promise<ResidentRun> {
    return this.run(request, 'start');
  }

  async reattach(request: ResidentWorkRequest): Promise<ResidentRun> {
    return this.run(request, 'reattach');
  }

  async continueAccepted(request: ResidentWorkRequest): Promise<ResidentRun> {
    return this.run(request, 'continueAccepted');
  }

  async recoverCompleted(request: ResidentWorkRequest): Promise<{
    turnId: string;
    response: Promise<import('../agent/types.js').AgentResponse>;
  }> {
    if (!request.instruction.trim()) throw new TypeError('resident Work instruction is required');
    if (request.origin.kind !== 'coordination') throw new TypeError('coordination origin is required');
    if (this.communications && !request.communication) {
      throw new TypeError('resident communication context is required');
    }
    const origin = privacySafeOrigin(request.origin);
    const binding = bindingFor(request);
    await this.coordination.assertCompleted(binding);
    const parentEvents = new Map<string, string>();
    let lastEventId: string | null = null;
    let replayChain = Promise.resolve();
    const started = await this.agent.runWithTurn(request.chatId, request.instruction, {
      coordinationOrigin: origin,
      coordinationRequest: { requestId: request.requestId, correlationId: request.correlationId },
      turnSelection: request.turnSelection,
      onDurableStart: async ({ turnId, persistedAt, selection }) => {
        await this.coordination.assertCompleted(binding);
        if (this.communications && request.communication) {
          const event = selectionCommunicationEvent({
            turnId,
            persistedAt,
            selection: exactTurnSelection(request, selection),
            context: request.communication,
            origin,
          });
          await this.communications.append({
            event,
            requestId: request.requestId,
            correlationId: request.correlationId,
          });
          lastEventId = event.eventId;
        }
      },
      onEvent: (durable) => {
        const parentEventId = parentCommunicationEventId(durable, parentEvents);
        lastEventId = stableCommunicationEventId(
          `resident-turn:${durable.turnId}:event:${durable.sequence}`,
          durable.occurredAt,
        );
        if (!this.communications || !request.communication) return;
        replayChain = replayChain.then(async () => {
          await this.coordination.assertCompleted(binding);
          await this.communications!.append({
            event: communicationEvent({
              durable, context: request.communication!, origin, parentEventId,
            }),
            requestId: request.requestId,
            correlationId: request.correlationId,
          });
        });
        void replayChain.catch(() => undefined);
      },
    });
    const response = (async () => {
      const result = await started.response;
      await replayChain;
      await this.coordination.assertCompleted(binding, digest(result.text));
      if (this.communications && request.communication) {
        const durableTerminal = started.terminal ? await started.terminal : null;
        const receipt: ResidentTerminalReceipt = Object.freeze({
          status: 'succeeded',
          sourceReference: origin.authorityReference,
          resultDigest: digest(result.text),
          artifactIds: Object.freeze([]),
          timestamp: durableTerminal?.endedAt ?? this.now().toISOString(),
        });
        await this.communications.append({
          event: terminalCommunicationEvent({
            turnId: started.turnId,
            durableTerminal,
            receipt,
            context: request.communication,
            origin,
            parentEventId: lastEventId,
          }),
          requestId: request.requestId,
          correlationId: request.correlationId,
        });
        await this.coordination.assertCompleted(binding, digest(result.text));
      }
      return result;
    })();
    return Object.freeze({ turnId: started.turnId, response });
  }

  private async run(
    request: ResidentWorkRequest,
    mode: 'start' | 'continueAccepted' | 'reattach',
  ): Promise<ResidentRun> {
    if (!request.instruction.trim()) throw new TypeError('resident Work instruction is required');
    if (request.origin.kind !== 'coordination') throw new TypeError('coordination origin is required');
    if (this.communications && !request.communication) {
      throw new TypeError('resident communication context is required');
    }
    if (this.active.has(request.origin.workId)) {
      throw new Error('resident Work already has an active turn');
    }
    const origin = privacySafeOrigin(request.origin);
    const binding = bindingFor(request);
    let observations = 0;
    const parentEvents = new Map<string, string>();
    let lastEventId: string | null = null;
    let callbackChain = Promise.resolve();
    const fenceCallback = (callback: () => void | Promise<void>): void => {
      callbackChain = callbackChain.then(async () => {
        await this.coordination.assertCurrent(binding);
        await callback();
      });
      callbackChain.catch(() => {
        const active = this.active.get(origin.workId);
        if (active) this.agent.stop(active.chatId, active.turnId);
      });
    };

    const started = await this.agent.runWithTurn(request.chatId, request.instruction, {
      coordinationOrigin: origin,
      coordinationRequest: { requestId: request.requestId, correlationId: request.correlationId },
      turnSelection: request.turnSelection,
      onDurableStart: async ({ turnId, persistedAt, selection }) => {
        await this.coordination.assertCurrent(binding);
        if (mode === 'start') {
          await this.coordination.accept(binding);
          await this.coordination.assertCurrent(binding);
          await this.coordination.start(binding);
        } else if (mode === 'continueAccepted') {
          await this.coordination.start(binding);
        } else {
          await this.coordination.reattach(binding);
        }
        if (this.communications && request.communication) {
          await this.coordination.assertCurrent(binding);
        }
        this.active.set(origin.workId, { chatId: request.chatId, turnId, binding, cancelling: false });
        if (this.communications && request.communication) {
          const event = selectionCommunicationEvent({
            turnId,
            persistedAt,
            selection: exactTurnSelection(request, selection),
            context: request.communication,
            origin,
          });
          await this.communications.append({
            event,
            requestId: request.requestId,
            correlationId: request.correlationId,
          });
          lastEventId = event.eventId;
        }
      },
      onEvent: (durable) => {
        const parentEventId = parentCommunicationEventId(durable, parentEvents);
        lastEventId = stableCommunicationEventId(
          `resident-turn:${durable.turnId}:event:${durable.sequence}`,
          durable.occurredAt,
        );
        const shouldObserve = Boolean(this.coordination.observe) && observations < MAX_OBSERVATIONS;
        if (shouldObserve) observations += 1;
        if (!this.communications && !shouldObserve) return;
        fenceCallback(async () => {
          if (this.communications && request.communication) {
            await this.communications.append({
              event: communicationEvent({
                durable, context: request.communication, origin, parentEventId,
              }),
              requestId: request.requestId,
              correlationId: request.correlationId,
            });
          }
          if (shouldObserve) {
            await this.coordination.observe!(binding, boundedObservation(durable, this.now().toISOString()));
          }
        });
      },
    });

    const receipt = (async (): Promise<unknown> => {
      try {
        let terminal: ResidentTerminalReceipt;
        let durableTerminal: ResidentDurableTerminal | null = null;
        try {
          const response = await started.response;
          durableTerminal = started.terminal ? await started.terminal : null;
          await callbackChain;
          const cancelled = this.active.get(origin.workId)?.cancelling === true;
          terminal = Object.freeze({
            status: cancelled ? 'cancelled' : 'succeeded',
            sourceReference: origin.authorityReference,
            resultDigest: cancelled ? null : digest(response.text),
            artifactIds: Object.freeze([]),
            timestamp: durableTerminal?.endedAt ?? this.now().toISOString(),
          });
        } catch (error) {
          if (started.terminal) {
            try { durableTerminal = await started.terminal; } catch { durableTerminal = null; }
          }
          await callbackChain;
          const cancelled = this.active.get(origin.workId)?.cancelling === true;
          terminal = Object.freeze({
            status: cancelled ? 'cancelled' : 'failed',
            sourceReference: origin.authorityReference,
            resultDigest: cancelled ? null : digest(
              durableTerminal?.errorMessage ?? durableTerminal?.errorCode ??
              (error instanceof Error ? error.message : String(error)),
            ),
            artifactIds: Object.freeze([]),
            timestamp: durableTerminal?.endedAt ?? this.now().toISOString(),
          });
        }
        await this.coordination.assertCurrent(binding);
        if (this.communications && request.communication) {
          await this.communications.append({
            event: terminalCommunicationEvent({
              turnId: started.turnId,
              durableTerminal,
              receipt: terminal,
              context: request.communication,
              origin,
              parentEventId: lastEventId,
            }),
            requestId: request.requestId,
            correlationId: request.correlationId,
          });
          await this.coordination.assertCurrent(binding);
        }
        return await this.coordination.terminalize({ ...binding, receipt: terminal });
      } finally {
        this.active.delete(origin.workId);
      }
    })();

    return Object.freeze({ turnId: started.turnId, response: started.response, receipt });
  }

  async cancel(workId: string, reasonCode = 'coordination_cancel'): Promise<boolean> {
    const active = this.active.get(workId);
    if (!active) return false;
    if (active.cancelling) return false;
    await this.coordination.assertCurrent(active.binding);
    await this.coordination.revoke({ ...active.binding, reasonCode });
    active.cancelling = true;
    return (await this.agent.stop(active.chatId, active.turnId)).stopped;
  }
}
