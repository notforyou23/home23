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
  ResidentArtifactPromotionPort,
  ResidentCommunicationContext,
  ResidentCommunicationPort,
  CoordinationExecutionEvidenceTaxonomy,
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
const RESIDENT_TURN_EVIDENCE_TAXONOMY: CoordinationExecutionEvidenceTaxonomy = Object.freeze({
  eventIdPrefix: 'resident-turn',
  runtimeSystem: 'resident_runtime',
  sequenceField: 'residentSequence',
  terminalStatusField: 'residentStatus',
  terminalPayloadField: 'residentTerminal',
});
export const BOT_TURN_EVIDENCE_TAXONOMY: CoordinationExecutionEvidenceTaxonomy = Object.freeze({
  eventIdPrefix: 'bot-turn',
  runtimeSystem: 'bot_runtime',
  sequenceField: 'botSequence',
  terminalStatusField: 'botStatus',
  terminalPayloadField: 'botTerminal',
});

function immutableTerminalReceipt(
  value: unknown,
  fallback: ResidentTerminalReceipt,
): ResidentTerminalReceipt {
  if (value === undefined) return Object.freeze({ ...fallback, artifactIds: Object.freeze([...fallback.artifactIds]) });
  const raw = value && typeof value === 'object' && 'receipt' in value
    ? (value as { receipt: unknown }).receipt
    : value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('coordination terminal receipt is malformed');
  }
  const receipt = raw as Record<string, unknown>;
  if (
    !['succeeded', 'failed', 'cancelled'].includes(String(receipt.status)) ||
    typeof receipt.sourceReference !== 'string' ||
    (receipt.resultDigest !== null &&
      (typeof receipt.resultDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.resultDigest))) ||
    !Array.isArray(receipt.artifactIds) ||
    !receipt.artifactIds.every((id) => typeof id === 'string') ||
    typeof receipt.timestamp !== 'string' ||
    Number.isNaN(new Date(receipt.timestamp).valueOf())
  ) {
    throw new TypeError('coordination terminal receipt is malformed');
  }
  return Object.freeze({
    status: receipt.status as ResidentTerminalReceipt['status'],
    sourceReference: receipt.sourceReference,
    resultDigest: receipt.resultDigest as string | null,
    artifactIds: Object.freeze([...(receipt.artifactIds as string[])]),
    timestamp: receipt.timestamp,
  });
}

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

function durableCommunicationEventId(
  durable: ResidentDurableEvent,
  taxonomy: CoordinationExecutionEvidenceTaxonomy,
): string {
  return stableCommunicationEventId(
    `${taxonomy.eventIdPrefix}:${durable.turnId}:event:${durable.sequence}`,
    durable.occurredAt,
  );
}

function communicationToolCallId(
  durable: ResidentDurableEvent,
  parentEventId: string | null,
  taxonomy: CoordinationExecutionEvidenceTaxonomy,
): string {
  const event = durable.event;
  if (event.type !== 'tool_start' && event.type !== 'tool_result') {
    throw new TypeError('tool call identity requires a tool event');
  }
  if (typeof event.toolCallId === 'string' && event.toolCallId.length > 0) {
    return event.toolCallId;
  }
  if (event.type === 'tool_result' && parentEventId) return parentEventId;
  return durableCommunicationEventId(durable, taxonomy);
}

function communicationPayload(
  durable: ResidentDurableEvent,
  parentEventId: string | null,
  taxonomy: CoordinationExecutionEvidenceTaxonomy,
): Record<string, JsonValue> {
  const event = exactJsonRecord(durable.event);
  const common: Record<string, JsonValue> = {
    [taxonomy.sequenceField]: durable.sequence,
    rawEvent: event,
  };
  switch (durable.event.type) {
    case 'thinking':
      return { ...common, text: durable.event.content,
        ...(event.providerEvent === undefined ? {} : { providerEvent: event.providerEvent }) };
    case 'tool_start':
      return { ...common, toolCallId: communicationToolCallId(durable, parentEventId, taxonomy),
        tool: durable.event.tool,
        arguments: event.args ?? null };
    case 'tool_result':
      return { ...common, toolCallId: communicationToolCallId(durable, parentEventId, taxonomy),
        tool: durable.event.tool,
        result: durable.event.exactResult ?? durable.event.result,
        preview: durable.event.result, success: durable.event.success };
    case 'response_chunk':
      return { ...common, delta: durable.event.chunk };
    case 'media':
      return { ...common, mediaType: durable.event.mediaType, path: durable.event.path,
        caption: durable.event.caption ?? null, toolCallId: durable.event.toolCallId ?? null,
        generatedBy: durable.event.generatedBy ?? null,
        mimeType: durable.event.mimeType ?? null, fileName: durable.event.fileName ?? null,
        byteCount: durable.event.byteCount ?? null, sha256: durable.event.sha256 ?? null };
    case 'subagent_start':
      return { ...common, subagentId: durable.event.subagentId, task: durable.event.task,
        label: durable.event.label ?? null, parentToolCallId: durable.event.parentToolCallId ?? null };
    case 'subagent_result':
      return { ...common,
        ...(typeof durable.event.subagentId === 'string' && durable.event.subagentId.length > 0
          ? { subagentId: durable.event.subagentId }
          : {}),
        task: durable.event.task, result: durable.event.result,
        ...(typeof durable.event.success === 'boolean'
          ? { success: durable.event.success }
          : {}),
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
  taxonomy: CoordinationExecutionEvidenceTaxonomy;
}): CommunicationEventInput {
  const { durable, context, origin, taxonomy } = input;
  const event = durable.event;
  const providerOrigin = event.type === 'thinking' || event.type === 'response_chunk'
    || event.type === 'tool_start';
  return Object.freeze({
    eventId: durableCommunicationEventId(durable, taxonomy),
    conversationId: context.conversationId,
    channelId: origin.channelId,
    messageId: context.responseMessageId,
    workId: origin.workId,
    attemptId: origin.attemptId,
    turnId: durable.turnId,
    parentEventId: input.parentEventId,
    actor: context.actor,
    source: {
      system: providerOrigin ? 'provider' : taxonomy.runtimeSystem,
      provider: durable.provider,
      model: durable.model,
      adapter: 'agent_loop',
      sourceEventType: event.sourceEventType ?? `agent.${event.type}`,
      additionalFields: {
        reasoningEffort: durable.reasoningEffort,
        [taxonomy.sequenceField]: durable.sequence,
      },
    },
    kind: communicationKind(event),
    provenance: event.type === 'thinking' ? event.provenance : null,
    occurredAt: durable.occurredAt,
    payload: communicationPayload(durable, input.parentEventId, taxonomy),
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
  taxonomy: CoordinationExecutionEvidenceTaxonomy;
}): CommunicationEventInput {
  const { durableTerminal, receipt, context, origin, taxonomy } = input;
  return Object.freeze({
    eventId: stableCommunicationEventId(
      `${taxonomy.eventIdPrefix}:${input.turnId}:terminal`,
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
      system: taxonomy.runtimeSystem,
      provider: durableTerminal?.provider ?? null,
      model: durableTerminal?.model ?? null,
      adapter: 'agent_loop',
      sourceEventType: 'turn.terminal',
      additionalFields: {
        reasoningEffort: durableTerminal?.reasoningEffort ?? null,
        [taxonomy.terminalStatusField]: durableTerminal?.status ?? null,
      },
    },
    kind: receipt.status === 'failed' ? 'failure' : 'receipt',
    occurredAt: receipt.timestamp,
    payload: {
      status: receipt.status,
      sourceReference: receipt.sourceReference,
      resultDigest: receipt.resultDigest,
      artifactIds: [...receipt.artifactIds],
      [taxonomy.terminalPayloadField]: durableTerminal === null ? null : exactJsonRecord(durableTerminal),
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
  taxonomy: CoordinationExecutionEvidenceTaxonomy;
}): CommunicationEventInput & { eventId: string } {
  const { selection, context, origin, taxonomy } = input;
  return Object.freeze({
    eventId: stableCommunicationEventId(
      `${taxonomy.eventIdPrefix}:${input.turnId}:selection`,
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
      system: taxonomy.runtimeSystem,
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
  taxonomy: CoordinationExecutionEvidenceTaxonomy,
): string | null {
  const eventId = durableCommunicationEventId(durable, taxonomy);
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
            && typeof event.subagentId === 'string' && event.subagentId.length > 0
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
  if (event.type === 'subagent_start'
      && typeof event.subagentId === 'string' && event.subagentId.length > 0) {
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
    private readonly artifactPromotion?: ResidentArtifactPromotionPort,
    private readonly evidenceTaxonomy: CoordinationExecutionEvidenceTaxonomy =
      RESIDENT_TURN_EVIDENCE_TAXONOMY,
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

  async recoverCompleted(request: ResidentWorkRequest): Promise<ResidentRun> {
    if (!request.instruction.trim() && (request.attachments?.length ?? 0) === 0) {
      throw new TypeError('resident Work instruction or attachment is required');
    }
    if (request.origin.kind !== 'coordination') throw new TypeError('coordination origin is required');
    if (this.communications && !request.communication) {
      throw new TypeError('resident communication context is required');
    }
    const origin = privacySafeOrigin(request.origin);
    const binding = bindingFor(request);
    const assertedReceipt = await this.coordination.assertCompleted(binding);
    const parentEvents = new Map<string, string>();
    let lastEventId: string | null = null;
    let replayChain = Promise.resolve();
    const started = await this.agent.runWithTurn(request.chatId, request.instruction, {
      coordinationOrigin: origin,
      coordinationRequest: { requestId: request.requestId, correlationId: request.correlationId },
      turnSelection: request.turnSelection,
      attachments: request.attachments,
      completedRecovery: true,
      onDurableStart: async ({ turnId, persistedAt, selection }) => {
        await this.coordination.assertCompleted(binding);
        if (this.communications && request.communication) {
          const event = selectionCommunicationEvent({
            turnId,
            persistedAt,
            selection: exactTurnSelection(request, selection),
            context: request.communication,
            origin,
            taxonomy: this.evidenceTaxonomy,
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
        const parentEventId = parentCommunicationEventId(
          durable,
          parentEvents,
          this.evidenceTaxonomy,
        );
        lastEventId = durableCommunicationEventId(durable, this.evidenceTaxonomy);
        if (!this.communications || !request.communication) return;
        replayChain = replayChain.then(async () => {
          await this.coordination.assertCompleted(binding);
          await this.communications!.append({
            event: communicationEvent({
              durable, context: request.communication!, origin, parentEventId,
              taxonomy: this.evidenceTaxonomy,
            }),
            requestId: request.requestId,
            correlationId: request.correlationId,
          });
        });
        void replayChain.catch(() => undefined);
      },
    });
    const completion = (async () => {
      const result = await started.response;
      await replayChain;
      const verifiedReceipt = await this.coordination.assertCompleted(binding, digest(result.text));
      const receipt = immutableTerminalReceipt(verifiedReceipt ?? assertedReceipt, {
        status: 'succeeded',
        sourceReference: origin.authorityReference,
        resultDigest: digest(result.text),
        artifactIds: Object.freeze([]),
        timestamp: this.now().toISOString(),
      });
      if (this.communications && request.communication) {
        const durableTerminal = started.terminal ? await started.terminal : null;
        await this.communications.append({
          event: terminalCommunicationEvent({
            turnId: started.turnId,
            durableTerminal,
            receipt,
            context: request.communication,
            origin,
            parentEventId: lastEventId,
            taxonomy: this.evidenceTaxonomy,
          }),
          requestId: request.requestId,
          correlationId: request.correlationId,
        });
        await this.coordination.assertCompleted(binding, digest(result.text));
      }
      return Object.freeze({ result, receipt });
    })();
    return Object.freeze({
      turnId: started.turnId,
      response: completion.then(({ result }) => result),
      receipt: completion.then(({ receipt }) => receipt),
    });
  }

  private async run(
    request: ResidentWorkRequest,
    mode: 'start' | 'continueAccepted' | 'reattach',
  ): Promise<ResidentRun> {
    if (!request.instruction.trim() && (request.attachments?.length ?? 0) === 0) {
      throw new TypeError('resident Work instruction or attachment is required');
    }
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
    const cancellationState = async (): Promise<{ timestamp: string } | null> => {
      const durable = await this.coordination.cancellationState?.(binding) ?? null;
      if (durable) return durable;
      return this.active.get(origin.workId)?.cancelling === true
        ? { timestamp: this.now().toISOString() }
        : null;
    };
    const settleCallbacks = async (): Promise<void> => {
      try {
        await callbackChain;
      } catch (error) {
        if (!(await cancellationState())) throw error;
      }
    };
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
      attachments: request.attachments,
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
            taxonomy: this.evidenceTaxonomy,
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
        const parentEventId = parentCommunicationEventId(
          durable,
          parentEvents,
          this.evidenceTaxonomy,
        );
        lastEventId = durableCommunicationEventId(durable, this.evidenceTaxonomy);
        const shouldObserve = Boolean(this.coordination.observe) && observations < MAX_OBSERVATIONS;
        if (shouldObserve) observations += 1;
        if (!this.communications && !shouldObserve) return;
        fenceCallback(async () => {
          if (this.communications && request.communication) {
            await this.communications.append({
              event: communicationEvent({
                durable, context: request.communication, origin, parentEventId,
                taxonomy: this.evidenceTaxonomy,
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

    const receipt = (async (): Promise<ResidentTerminalReceipt> => {
      try {
        let terminal: ResidentTerminalReceipt;
        let durableTerminal: ResidentDurableTerminal | null = null;
        try {
          const response = await started.response;
          durableTerminal = started.terminal ? await started.terminal : null;
          await settleCallbacks();
          let cancellation = await cancellationState();
          let artifactIds: readonly string[] = Object.freeze([]);
          if (cancellation === null) {
            await this.coordination.assertCurrent(binding);
            const media = (response.media ?? []).filter(
              (candidate) => candidate.generatedBy === 'generate_image',
            );
            if (media.length > 0) {
              if (!this.artifactPromotion) {
                throw new Error('resident generated media requires canonical attachments');
              }
              artifactIds = Object.freeze([...(await this.artifactPromotion.promote({
                binding,
                media,
              }))]);
              await this.coordination.assertCurrent(binding);
              cancellation = await cancellationState();
              if (cancellation !== null) artifactIds = Object.freeze([]);
            }
          }
          const cancelled = cancellation !== null;
          terminal = Object.freeze({
            status: cancelled ? 'cancelled' : 'succeeded',
            sourceReference: origin.authorityReference,
            resultDigest: cancelled ? null : digest(response.text),
            artifactIds: cancelled ? Object.freeze([]) : artifactIds,
            timestamp: cancellation?.timestamp ?? durableTerminal?.endedAt ?? this.now().toISOString(),
          });
        } catch (error) {
          if (started.terminal) {
            try { durableTerminal = await started.terminal; } catch { durableTerminal = null; }
          }
          await settleCallbacks();
          const cancellation = await cancellationState();
          const cancelled = cancellation !== null;
          terminal = Object.freeze({
            status: cancelled ? 'cancelled' : 'failed',
            sourceReference: origin.authorityReference,
            resultDigest: cancelled ? null : digest(
              durableTerminal?.errorMessage ?? durableTerminal?.errorCode ??
              (error instanceof Error ? error.message : String(error)),
            ),
            artifactIds: Object.freeze([]),
            timestamp: cancellation?.timestamp ?? durableTerminal?.endedAt ?? this.now().toISOString(),
          });
        }
        if (terminal.status === 'cancelled') {
          if (!(await cancellationState())) throw new Error('resident cancellation is not current');
        } else {
          await this.coordination.assertCurrent(binding);
        }
        if (this.communications && request.communication) {
          await this.communications.append({
            event: terminalCommunicationEvent({
              turnId: started.turnId,
              durableTerminal,
              receipt: terminal,
              context: request.communication,
              origin,
              parentEventId: lastEventId,
              taxonomy: this.evidenceTaxonomy,
            }),
            requestId: request.requestId,
            correlationId: request.correlationId,
          });
          if (terminal.status === 'cancelled') {
            if (!(await cancellationState())) throw new Error('resident cancellation is not current');
          } else {
            await this.coordination.assertCurrent(binding);
          }
        }
        const stored = await this.coordination.terminalize({ ...binding, receipt: terminal });
        return immutableTerminalReceipt(stored, terminal);
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
