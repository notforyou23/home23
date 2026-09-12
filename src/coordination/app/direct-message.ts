import { residentOutcomeInstruction, type createResidentOutcomeStore } from './resident-outcomes.js';
import { boundHistoricalContext } from '../../agent/historical-context.js';
import { createHash } from "node:crypto";
import type { AgentResponse, CoordinationTurnOrigin } from "../../agent/types.js";
import type {
  ResidentAgentPort,
  ResidentCommunicationPort,
  ResidentCoordinationAdapter,
  ResidentInputAttachment,
  ResidentRun,
  ResidentTerminalReceipt,
  ResidentWorkRequest,
} from "../../coordination-adapter/index.js";
import { MessagingError, type MessagingActorContext } from "../channels/index.js";
import {
  isCommunicationJsonValue,
  stableCommunicationEventId,
} from "../communications/index.js";
import type { JsonValue } from "../db/index.js";
import type { MessageProjection, MessageTurnSelection } from "../messages/index.js";
import type { ContextManifestInput, WorkRecord } from "../work/index.js";
import { isCanonicalMessagesAuthority, type AuthorityEpoch } from "../epochs/index.js";
import { workResultIdempotencyKey } from "../contracts/resident-presence.js";
import type {
  CoordinationDeviceNotificationPort,
  CoordinationLeasePort,
  CoordinationWorkPort,
} from "./types.js";
import { catalogAcceptsTurnSelection } from "./model-selection.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function responseMessageId(workId: string): string {
  if (!workId.startsWith("wrk_")) throw new Error("Work ID cannot derive a Message ID");
  return `msg_${workId.slice(4)}`;
}

export interface DirectMessageChannelContext {
  channelId: string;
  conversationId: string;
  targetBotId: string;
  targetBotDisplayName: string;
  targetPrincipalId: string;
  residentBinding: string;
  instruction: string;
  instructionMessageIds?: readonly string[];
  /** Original canonical request, never a recursively wrapped runtime prompt. */
  originalOwnerRequest?: string;
  historyBackfill: readonly DirectMessageHistoryEntry[];
  attachments: readonly ResidentInputAttachment[];
  manifest: ContextManifestInput;
}

export type DirectMessageHistoryEntry = import("../../agent/historical-context.js").HistoricalContextEntry;

export interface DirectMessageContextPort {
  /** Read-only lookup; the Message service still validates the exact replay body. */
  findWorkIdByIdempotency?(principalId: string, keyDigest: string): string | null;
  resolveTarget(input: {
    context: MessagingActorContext;
    channelId: string;
  }): Promise<Pick<DirectMessageChannelContext,
    "channelId" | "conversationId" | "targetBotId" | "targetBotDisplayName" |
    "targetPrincipalId" | "residentBinding">>;
  prepare(input: {
    context: MessagingActorContext;
    channelId: string;
    originMessage: MessageProjection;
    attachmentIds: readonly string[];
    instructionMessageIds?: readonly string[];
  }): Promise<DirectMessageChannelContext>;
  recover(work: WorkRecord): Promise<{
    prepared: DirectMessageChannelContext;
    originMessageId: string;
  }>;
}

export interface DirectMessageMessagePort {
  getMessage?(input: { context: MessagingActorContext; messageId: string }): Promise<MessageProjection | null>;
  sendMessage(input: {
    context: MessagingActorContext; channelId: string; messageId: string;
    authorPrincipalId: string; idempotencyKey: string; kind: "text" | "result";
    text: string | null; mentions: readonly string[]; clientMessageId: string | null;
    attachmentIds?: readonly string[];
    replyToMessageId: string | null; tombstonesMessageId: null;
    provenance: { roundId: string | null; workId: string | null };
    turnSelection?: MessageTurnSelection;
  }): Promise<{ outcome: "committed" | "replayed"; message: MessageProjection; receipt: { eventSequence: number } }>;
  listMessages(input: {
    context: MessagingActorContext; channelId: string; limit: number;
  }): Promise<{ messages: readonly MessageProjection[] }>;
}

export interface DirectMessageResidentTarget {
  resident: Pick<ResidentCoordinationAdapter,
    "execute" | "continueAccepted" | "reattach" | "recoverCompleted">;
  holderInstanceId: string;
  models: Pick<ResidentAgentPort, "modelCatalog">;
  context(input: {
    principalId: string;
    requestId: string;
    correlationId: string;
  }): MessagingActorContext;
}

export type DirectMessageTargetDescriptor = Pick<DirectMessageChannelContext,
  "channelId" | "conversationId" | "targetBotId" | "targetBotDisplayName" |
  "targetPrincipalId" | "residentBinding">;

export type DirectMessageExecutionRequest = ResidentWorkRequest & Readonly<{
  historyBackfill: readonly DirectMessageHistoryEntry[];
}>;

export interface DirectMessageExecutionPort {
  stopRevoked?: ResidentCoordinationAdapter['stopRevoked'];
  execute(input: DirectMessageExecutionRequest): Promise<ResidentRun>;
  continueAccepted(input: DirectMessageExecutionRequest): Promise<ResidentRun>;
  reattach(input: DirectMessageExecutionRequest): Promise<ResidentRun>;
  recoverCompleted(input: DirectMessageExecutionRequest): Promise<ResidentRun>;
}

/** Exact execution authority for either a permanent resident or an on-demand Bot. */
export interface DirectMessageExecutionTarget {
  execution: DirectMessageExecutionPort;
  holderInstanceId: string;
  models: Pick<ResidentAgentPort, "modelCatalog">;
  context(input: {
    principalId: string;
    requestId: string;
    correlationId: string;
  }): MessagingActorContext;
  workKind: "resident_turn" | "bot_turn";
  authorityReference: string;
  actorKind: "resident_bot" | "specialist_bot";
  acceptsAttachments?(attachments: readonly ResidentInputAttachment[]): boolean;
}

/** Idempotent, lossless communication evidence for canonical Message commits. */
export function createCanonicalMessageRecorder(
  communications?: ResidentCommunicationPort,
  notifications?: Pick<CoordinationDeviceNotificationPort, "notifyMessageCommitted">,
) {
  const exactMessage = (message: MessageProjection): Record<string, JsonValue> => {
    let serialized: string | undefined;
    try { serialized = JSON.stringify(message); } catch { serialized = undefined; }
    if (serialized === undefined) throw new TypeError("canonical Message is not JSON serializable");
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        !isCommunicationJsonValue(parsed)) {
      throw new TypeError("canonical Message is not lossless JSON evidence");
    }
    return parsed as Record<string, JsonValue>;
  };
  return async (input: {
    message: MessageProjection;
    kind: "user_message_committed" | "assistant_message_committed";
    requestId: string;
    correlationId: string;
    turnSelection?: MessageTurnSelection;
  }): Promise<void> => {
    const message = input.message;
    const notify = () => {
      if (input.kind !== "assistant_message_committed" || !notifications) return;
      void notifications.notifyMessageCommitted({
        conversationId: message.conversationId,
        channelId: message.channelId,
        messageId: message.id,
        createdAt: message.createdAt,
        ...(message.provenance.workId === null
          ? {}
          : { workId: message.provenance.workId }),
        displayName: message.author.displayName,
        preview: message.text,
        hasAttachments: message.attachments.length > 0,
      }).catch((error: unknown) => {
        console.warn(
          "[home23-coordination] Connected Agents notification failed:",
          error instanceof Error ? error.message : error,
        );
      });
    };
    if (!communications) {
      notify();
      return;
    }
    const rawMessage = exactMessage(message);
    await communications.append({
      event: {
        eventId: stableCommunicationEventId(
          `canonical-message:${message.id}:${input.kind}`,
          message.createdAt,
        ),
        conversationId: message.conversationId,
        channelId: message.channelId,
        messageId: message.id,
        workId: message.provenance.workId,
        actor: {
          principalId: message.author.principalId,
          displayName: message.author.displayName,
          kind: message.author.kind,
        },
        source: {
          system: "core_messaging",
          adapter: "canonical_messages",
          sourceEventType: "message.appended",
        },
        kind: input.kind,
        occurredAt: message.createdAt,
        payload: {
          text: message.text,
          clientMessageId: message.clientMessageId,
          replyToMessageId: message.replyToMessageId,
          attachments: rawMessage.attachments ?? [],
          rawMessage,
          ...(input.turnSelection === undefined ? {} : {
            requestedModelAlias: input.turnSelection.modelAlias,
            requestedEffort: input.turnSelection.reasoningEffort,
          }),
        },
        terminal: true,
      },
      requestId: input.requestId,
      correlationId: input.correlationId,
    });
    // A duplicate communication event can be recovery after the canonical
    // Message became durable but before its notification delivery was recorded.
    // The delivery store owns per-device dedupe, so always reconcile delivery.
    notify();
  };
}

/** Join M08 -> M11 -> M13 -> M11 terminal -> M08 result without activating a process. */
export function createDirectMessageSubmissionService(options: {
  messages: DirectMessageMessagePort;
  context: DirectMessageContextPort;
  work: CoordinationWorkPort;
  leases: CoordinationLeasePort;
  outcomes?: ReturnType<typeof createResidentOutcomeStore>;
  recoverWorkingContext?(work: WorkRecord): ReturnType<DirectMessageContextPort["recover"]>;
  resolveResident(residentBinding: string): DirectMessageResidentTarget | undefined;
  resolveExecutionTarget?(target: DirectMessageTargetDescriptor):
    DirectMessageExecutionTarget | undefined |
    Promise<DirectMessageExecutionTarget | undefined>;
  authority: { current(): AuthorityEpoch | null };
  communications?: ResidentCommunicationPort;
  notifications?: Pick<
    CoordinationDeviceNotificationPort,
    "notifyMessageCommitted" | "notifyWorkStarted"
  >;
  beginWork(): () => void;
  recoveryIdentity(): { requestId: string; correlationId: string };
}) {
  const inFlight = new Map<string, Promise<MessageProjection>>();
  let outcomeTickRunning = false;
  const recordMessage = createCanonicalMessageRecorder(
    options.communications,
    options.notifications,
  );
  const once = (callback: () => void) => {
    let called = false;
    return () => {
      if (called) return;
      called = true;
      callback();
    };
  };
  const assertAuthority = () => {
    if (!isCanonicalMessagesAuthority(options.authority.current())) {
      throw new MessagingError("authority_unavailable");
    }
  };
  const executionTargetFor = async (
    descriptor: DirectMessageTargetDescriptor,
  ): Promise<DirectMessageExecutionTarget> => {
    const explicit = await options.resolveExecutionTarget?.(descriptor);
    if (explicit) return explicit;
    const resident = options.resolveResident(descriptor.residentBinding);
    if (!resident) throw new Error("direct-message target is not enabled");
    return Object.freeze({
      execution: resident.resident,
      holderInstanceId: resident.holderInstanceId,
      models: resident.models,
      context: resident.context,
      workKind: "resident_turn" as const,
      authorityReference: `resident:${descriptor.residentBinding}`,
      actorKind: "resident_bot" as const,
    });
  };

  function dispatch(input: {
    work: WorkRecord; prepared: DirectMessageChannelContext; originMessageId: string;
    requestId: string; correlationId: string; endWork: () => void; recovery: boolean;
    target: DirectMessageExecutionTarget;
  }): Promise<MessageProjection> {
    const existing = inFlight.get(input.work.id);
    if (existing) {
      input.endWork();
      return existing;
    }
    const execution = (async () => {
      const target = input.target;
      const planned = options.work.getPlannedInvocation?.(input.work.id);
      const workingThread = input.work.kind === "resident_work_thread";
      if (workingThread && !planned) throw new Error("Working Thread has no durable planned invocation");
      if (workingThread) {
        void options.notifications?.notifyWorkStarted({
          workId: input.work.id,
          conversationId: input.prepared.conversationId,
          channelId: input.prepared.channelId,
          status: "running",
          displayName: input.prepared.targetBotDisplayName,
        }).catch(() => undefined);
      }
      let origin: CoordinationTurnOrigin;
      let recoveryPhase: "offered" | "accepted" | "running" | "completed" | null = null;
      if (input.recovery) {
        const recoveredWork = options.work.get(input.work.id);
        if (!recoveredWork) throw new Error("direct-message Work disappeared during recovery");
        const exactWork = recoveredWork.channelId === input.prepared.channelId &&
          recoveredWork.originMessageId === input.originMessageId &&
          recoveredWork.roundId === input.work.roundId &&
          recoveredWork.targetPrincipalId === input.prepared.targetPrincipalId &&
          (recoveredWork.kind === target.workKind || workingThread);
        if (!exactWork) throw new Error("direct-message Work recovery binding is not exact");
        if (recoveredWork.state === "queued" && recoveredWork.currentAttemptId === null) {
          const offer = options.leases.offer({
            workId: recoveredWork.id,
            holderPrincipalId: input.prepared.targetPrincipalId,
            holderInstanceId: target.holderInstanceId,
            authorityReference: target.authorityReference,
            automatic: true,
            requestId: input.requestId,
            correlationId: input.correlationId,
          });
          origin = Object.freeze({
            kind: "coordination",
            workId: recoveredWork.id,
            attemptId: offer.attempt.id,
            leaseId: offer.lease.id,
            holderPrincipalId: input.prepared.targetPrincipalId,
            holderInstanceId: target.holderInstanceId,
            authorityReference: offer.attempt.authorityReference,
            fencingToken: offer.fencingToken,
            channelId: input.prepared.channelId,
            originMessageId: input.originMessageId,
            roundId: input.work.roundId,
          });
        } else {
          const current = options.leases.current(recoveredWork.id);
          const exactBinding = current.work.channelId === input.prepared.channelId &&
            current.work.originMessageId === input.originMessageId &&
            current.work.roundId === input.work.roundId &&
            current.work.targetPrincipalId === input.prepared.targetPrincipalId &&
            current.attempt.holderPrincipalId === input.prepared.targetPrincipalId &&
            current.attempt.holderInstanceId === target.holderInstanceId &&
            current.lease.holderPrincipalId === current.attempt.holderPrincipalId &&
            current.lease.holderInstanceId === current.attempt.holderInstanceId &&
            current.lease.fencingToken === current.attempt.fencingToken &&
            current.attempt.authorityReference === target.authorityReference;
          if (!exactBinding) throw new Error("direct-message Work recovery binding is not exact");
          if (
            current.work.state === "leased" && current.attempt.state === "offered" &&
            current.lease.state === "offered"
          ) recoveryPhase = "offered";
          else if (
            current.work.state === "leased" && current.attempt.state === "accepted" &&
            current.lease.state === "active"
          ) recoveryPhase = "accepted";
          else if (
            current.work.state === "running" && current.attempt.state === "running" &&
            current.lease.state === "active"
          ) recoveryPhase = "running";
          else if (
            current.work.state === "succeeded" && current.attempt.state === "succeeded" &&
            current.lease.state === "released"
          ) recoveryPhase = "completed";
          else throw new Error("resident Work recovery lifecycle is ambiguous");
          origin = Object.freeze({
            kind: "coordination", workId: current.work.id, attemptId: current.attempt.id,
            leaseId: current.lease.id, holderPrincipalId: current.attempt.holderPrincipalId,
            holderInstanceId: current.attempt.holderInstanceId,
            authorityReference: current.attempt.authorityReference,
            fencingToken: current.attempt.fencingToken, channelId: current.work.channelId,
            originMessageId: current.work.originMessageId, roundId: current.work.roundId,
          });
        }
      } else {
        const offer = options.leases.offer({
          workId: input.work.id, holderPrincipalId: input.prepared.targetPrincipalId,
          holderInstanceId: target.holderInstanceId,
          authorityReference: target.authorityReference, automatic: true,
          requestId: input.requestId, correlationId: input.correlationId,
        });
        origin = Object.freeze({
          kind: "coordination", workId: input.work.id, attemptId: offer.attempt.id,
          leaseId: offer.lease.id, holderPrincipalId: input.prepared.targetPrincipalId,
          holderInstanceId: target.holderInstanceId, authorityReference: offer.attempt.authorityReference,
          fencingToken: offer.fencingToken, channelId: input.prepared.channelId,
          originMessageId: input.originMessageId, roundId: input.work.roundId,
        });
      }
      const executionRequest: DirectMessageExecutionRequest = {
        ...(planned ? {
          ...((options.work.getInvocationExecution?.(input.work.id) === null || planned.recoveryPolicy !== "safe_before_start") ? { plannedRecoveryBeforeStart: true as const } : {}),
          plannedExecution: { kind: "planned_tool" as const, invocationId: planned.invocationId, toolName: planned.toolName, canonicalArgs: planned.canonicalArgs, executionInstruction: planned.executionInstruction, title: planned.title, recoveryPolicy: planned.recoveryPolicy },
          coordinationWorkDestination: { kind: "coordination" as const, parentWorkId: input.work.id, channelId: input.work.channelId, conversationId: input.prepared.conversationId, originMessageId: input.originMessageId, attemptId: origin.attemptId, leaseId: origin.leaseId, fencingToken: origin.fencingToken, targetPrincipalId: origin.holderPrincipalId, residentBinding: input.prepared.residentBinding, residentInstanceId: origin.holderInstanceId, authorityReference: origin.authorityReference },
        } : {}),
        chatId: `coordination:${input.prepared.channelId}:${input.work.id}`,
        instruction: input.prepared.instruction, origin,
        historyBackfill: boundHistoricalContext(input.prepared.historyBackfill
          .filter(entry => entry.messageId !== input.originMessageId)),
        attachments: input.prepared.attachments,
        requestId: input.requestId, correlationId: input.correlationId,
        turnSelection: options.work.getTurnSelection(input.work.id),
        communication: {
          conversationId: input.prepared.conversationId,
          responseMessageId: responseMessageId(input.work.id),
          actor: {
            principalId: input.prepared.targetPrincipalId,
            displayName: input.prepared.targetBotDisplayName,
            kind: target.actorKind,
          },
        },
      };
      const settleRun = async (run: ResidentRun): Promise<[AgentResponse, ResidentTerminalReceipt]> => {
        // A response rejection may precede durable terminal evidence. Let the
        // adapter finish its fenced receipt before deciding recovery failed.
        const [response, receipt] = await Promise.allSettled([run.response, run.receipt]);
        if (receipt.status === "rejected") throw receipt.reason;
        if (response.status === "rejected") throw response.reason;
        return [response.value, receipt.value];
      };
      let agentResponse: AgentResponse;
      let terminalReceipt: ResidentTerminalReceipt;
      if (recoveryPhase === "completed") {
        const run = await target.execution.recoverCompleted(executionRequest);
        [agentResponse, terminalReceipt] = await settleRun(run);
      } else {
        const run = recoveryPhase === "running"
          ? await target.execution.reattach(executionRequest)
          : recoveryPhase === "accepted"
            ? await target.execution.continueAccepted(executionRequest)
            : await target.execution.execute(executionRequest);
        [agentResponse, terminalReceipt] = await settleRun(run);
      }
      if (terminalReceipt.status !== "succeeded") {
        throw new Error(`direct-message Work ended ${terminalReceipt.status}`);
      }
      const resultText = agentResponse.text.trim() ? agentResponse.text : null;
      if (resultText === null && terminalReceipt.artifactIds.length === 0) {
        throw new Error("successful direct-message Work produced no answer");
      }
      const result = await options.messages.sendMessage({
        context: target.context({
          principalId: input.prepared.targetPrincipalId,
          requestId: input.requestId, correlationId: input.correlationId,
        }),
        channelId: input.prepared.channelId, messageId: responseMessageId(input.work.id),
        authorPrincipalId: input.prepared.targetPrincipalId,
        idempotencyKey: workResultIdempotencyKey(input.work.id), kind: "result",
        text: resultText, mentions: [], clientMessageId: null,
        attachmentIds: terminalReceipt.artifactIds,
        replyToMessageId: input.originMessageId, tombstonesMessageId: null,
        provenance: { roundId: input.work.roundId, workId: input.work.id },
      });
      await recordMessage({
        message: result.message,
        kind: "assistant_message_committed",
        requestId: input.requestId,
        correlationId: input.correlationId,
      });
      return result.message;
    })().catch(async (error) => {
      // A planned invocation is never replanned after a lost execution. Preserve
      // the exact fence and record a truthful terminal failure, without Chat noise.
      if (input.work.kind === "resident_work_thread") {
        const work = options.work.get(input.work.id);
        if (work?.state === "running" && options.work.getInvocationExecution?.(work.id) && options.work.getPlannedInvocation?.(work.id)?.recoveryPolicy === "safe_before_start") {
          const current = options.leases.current(work.id);
          const interruptedAt = new Date().toISOString();
          await options.communications?.append({ event: {
            eventId: stableCommunicationEventId(`planned-interruption:${work.id}`, work.createdAt),
            conversationId: input.prepared.conversationId, channelId: work.channelId,
            messageId: work.originMessageId, workId: work.id,
            actor: { principalId: input.prepared.targetPrincipalId, displayName: input.prepared.targetBotDisplayName, kind: "resident_bot" },
            source: { system: "resident_runtime", adapter: "canonical_work", sourceEventType: "planned_execution.interrupted" },
            kind: "failure", occurredAt: interruptedAt,
            payload: { text: "This assignment was interrupted after execution began. Its outcome could not be verified, so the tool was not run again.", executionState: "interrupted", recoveryPolicy: "interrupt_after_start" },
            terminal: true,
          }, requestId: input.requestId, correlationId: input.correlationId });
          options.leases.terminalize({
            workId: work.id, attemptId: current.attempt.id, leaseId: current.lease.id,
            holderPrincipalId: current.attempt.holderPrincipalId,
            holderInstanceId: current.attempt.holderInstanceId, fencingToken: current.attempt.fencingToken,
            requestId: input.requestId, correlationId: input.correlationId,
            receipt: { status: "failed", sourceReference: current.attempt.authorityReference,
              resultDigest: sha256(`planned execution interrupted: ${error instanceof Error ? error.message : String(error)}`),
              artifactIds: [], timestamp: new Date().toISOString() },
          });
        }
      }
      throw error;
    }).finally(input.endWork);
    inFlight.set(input.work.id, execution);
    void execution.finally(() => inFlight.delete(input.work.id)).catch(() => undefined);
    return execution;
  }

  const recoverContext = async (work: WorkRecord) => {
    const outcome = options.outcomes?.forReview(work.id);
    if (outcome?.prepared) return { prepared: JSON.parse(outcome.prepared) as DirectMessageChannelContext,
      originMessageId: work.originMessageId! };
    return (work.kind === "resident_work_thread" || work.kind === "channel.bot_turn") && options.recoverWorkingContext
      ? options.recoverWorkingContext(work) : options.context.recover(work);
  };
  return Object.freeze({
    async processResidentOutcomes(): Promise<void> {
      const store = options.outcomes;
      if (!store || outcomeTickRunning) return;
      outcomeTickRunning = true;
      try {
        assertAuthority();
        store.discover();
        for (const row of store.pending()) {
          try {
            const source = options.work.get(row.sourceWorkId);
            if (!source || !source.originMessageId) continue;
            let review = row.reviewWorkId ? options.work.get(row.reviewWorkId) : null;
            // Older versions could enqueue a review of a scheduled review. Retire
            // only work that never started; preserve running execution for recovery.
            if (row.key.startsWith('scheduled:') && source.kind !== 'channel.bot_turn') {
              const identity = options.recoveryIdentity();
              if (review?.state === 'leased') {
                const current = options.leases.current(review.id);
                if (current.attempt.state === 'offered' && current.lease.state === 'offered') {
                  options.leases.reject({workId:review.id,attemptId:current.attempt.id,leaseId:current.lease.id,
                    holderPrincipalId:current.attempt.holderPrincipalId,holderInstanceId:current.attempt.holderInstanceId,
                    fencingToken:current.attempt.fencingToken,reasonCode:'superseded_scheduled_review',...identity});
                  review = options.work.get(review.id);
                }
              }
              if (review?.state === 'queued') review = options.work.cancelQueued({workId:review.id,
                actorPrincipalId:review.principalId,reasonCode:'superseded_scheduled_review',
                sourceReference:`outcome:${row.key}`,timestamp:new Date().toISOString(),...identity}).work;
              if (!review || ['succeeded','failed','cancelled'].includes(review.state)) {
                store.update(row,'settled_at',new Date().toISOString());
                continue;
              }
            }
            if (store.busy(source.channelId, review?.id ?? null)) continue;
            const identity = options.recoveryIdentity();
            let prepared: DirectMessageChannelContext;
            if (row.prepared) prepared = JSON.parse(row.prepared);
            else {
              // Context recovery validates channel membership, identity and original manifest.
              // Its success-state restriction concerns execution recovery, not terminal evidence reading.
              const recovered = await recoverContext({ ...source, state: 'succeeded' });
              const target = await executionTargetFor(recovered.prepared);
              const page = await options.messages.listMessages({ context: target.context({
                principalId: source.targetPrincipalId, ...identity }), channelId: source.channelId, limit: 100 });
              const instructionMessageIds = recovered.prepared.instructionMessageIds;
              const history = page.messages.filter(m => m.text !== null &&
                !(instructionMessageIds ?? [source.originMessageId]).includes(m.id)).map(m => ({
                messageId: m.id, sequence: m.sequence, role: m.author.principalId === source.targetPrincipalId ? 'assistant' as const : 'user' as const,
                text: m.text!, createdAt: m.createdAt,
              }));
              const originalMessage = page.messages.find(message => message.id === source.originMessageId)
                ?? await options.messages.getMessage?.({ context: target.context({ principalId: source.targetPrincipalId, ...identity }), messageId: source.originMessageId });
              const original = recovered.prepared.originalOwnerRequest
                ?? (instructionMessageIds && !recovered.prepared.instruction.startsWith('INTERNAL WORK OUTCOME')
                  ? recovered.prepared.instruction : originalMessage?.text)
                ?? (recovered.prepared.instruction.startsWith('INTERNAL WORK OUTCOME') ? null : recovered.prepared.instruction);
              if (original === null) throw new Error('Canonical original request unavailable; refusing to wrap an internal outcome as owner intent');
              prepared = { ...recovered.prepared,
                originalOwnerRequest: original,
                instruction: residentOutcomeInstruction(original, row.evidence, source.id),
                historyBackfill: boundHistoricalContext(history),
                manifest: directMessageManifest({ channelId: source.channelId,
                  messageIds: [...new Set([...(instructionMessageIds ?? [source.originMessageId]), ...page.messages.map(m => m.id)])],
                  attachmentIds: recovered.prepared.manifest.artifactIds,
                  channelSequence: Math.max(0, ...page.messages.map(m => m.sequence)), eventSequence: store.eventWatermark(),
                  ...(instructionMessageIds === undefined ? {} : { instructionMessageIds }) }),
              };
              store.update(row, 'prepared_json', JSON.stringify(prepared));
            }
            const target = await executionTargetFor(prepared);
            if (!review) {
              review = options.work.create({ principalId: source.principalId, targetPrincipalId: source.targetPrincipalId,
                channelId: source.channelId, originMessageId: source.originMessageId, roundId: source.roundId,
                kind: target.workKind, idempotencyKey: `resident-outcome:${row.key}`, manifest: prepared.manifest,
                maxAutomaticOffers: 1, turnSelection: options.work.getTurnSelection(source.id), ...identity }).work;
              store.update(row, 'review_work_id', review.id);
            }
            if (['failed','cancelled'].includes(review.state)) {
              const message = await options.messages.sendMessage({ context: target.context({ principalId: source.targetPrincipalId, ...identity }),
                channelId: source.channelId, messageId: responseMessageId(review.id), authorPrincipalId: source.targetPrincipalId,
                idempotencyKey: workResultIdempotencyKey(review.id), kind: 'result',
                text: `My follow-through for this work ${review.state === 'cancelled' ? 'was stopped' : 'was interrupted before I could verify the outcome'}. I have not restarted the assignment. The saved work remains available for inspection.`,
                mentions: [], clientMessageId: null, replyToMessageId: source.originMessageId, tombstonesMessageId: null,
                provenance: { roundId: source.roundId, workId: review.id } });
              await recordMessage({ message: message.message, kind: 'assistant_message_committed', ...identity });
              store.update(row, 'settled_at', new Date().toISOString());
              continue;
            }
            if (review.state === 'succeeded') {
              const existing = await options.messages.getMessage?.({context: target.context({principalId: source.targetPrincipalId,...identity}),messageId:responseMessageId(review.id)});
              if (existing) { store.update(row, 'settled_at', new Date().toISOString()); continue; }
            }
            if (review.state === 'cancelling' || inFlight.has(review.id)) continue;
            // Reuse the canonical Work/Attempt/Lease transport and its restart reattachment.
            void dispatch({ work: review, prepared, originMessageId: source.originMessageId, ...identity,
              endWork: once(options.beginWork()), recovery: true, target }).catch(error => {
                console.warn('[resident-outcomes] review dispatch failed:', review!.id, error instanceof Error ? error.message : String(error));
              });
          } catch (error) {
            console.warn('[resident-outcomes] pending follow-through:', row.key, error instanceof Error ? error.message : String(error));
          }
        }
      } finally { outcomeTickRunning = false; }
    },
    async dispatchWorkingThread(workId: string): Promise<void> {
      assertAuthority();
      if (inFlight.has(workId)) return;
      const work = options.work.get(workId);
      if (!work || work.kind !== "resident_work_thread") throw new Error("Working Thread not found");
      if (["cancelled", "failed", "cancelling"].includes(work.state)) return;
      const recovered = await recoverContext(work);
      const target = await executionTargetFor(recovered.prepared);
      const identity = options.recoveryIdentity();
      void dispatch({ work, prepared: recovered.prepared, originMessageId: recovered.originMessageId,
        requestId: identity.requestId, correlationId: identity.correlationId,
        endWork: once(options.beginWork()), recovery: true, target }).catch(error => {
          console.error("[home23-coordination] Working Thread execution failed", workId, error);
        });
    },
    async awaitSettlement(workId: string): Promise<void> {
      await inFlight.get(workId)?.catch(() => undefined);
    },
    async selectionOptions(input: {
      context: MessagingActorContext;
      channelId: string;
    }) {
      assertAuthority();
      const prepared = await options.context.resolveTarget(input);
      const target = await executionTargetFor(prepared);
      const catalog = await target.models.modelCatalog({
        requestId: input.context.requestId,
        correlationId: input.context.correlationId,
      });
      return Object.freeze({
        channelId: prepared.channelId,
        conversationId: prepared.conversationId,
        targetBotId: prepared.targetBotId,
        ...catalog,
      });
    },

    async recoverResidentWork() {
      assertAuthority();
      const recoverable = [
        ...options.work.listResidentRecoverable("resident_turn", 100),
        ...options.work.listSucceededMissingResult("resident_turn", 100),
        ...options.work.listResidentRecoverable("bot_turn", 100),
        ...options.work.listSucceededMissingResult("bot_turn", 100),
        ...options.work.listResidentRecoverable("resident_work_thread", 100),
        ...options.work.listSucceededMissingResult("resident_work_thread", 100),
      ];
      let scheduled = 0;
      let refused = 0;
      for (const work of recoverable) {
        if (options.outcomes?.forReview(work.id)) continue; // Queue serializes follow-through with foreground work.
        try {
          const recovered = await recoverContext(work);
          const target = await executionTargetFor(recovered.prepared);
          if (target.workKind !== work.kind && work.kind !== "resident_work_thread") {
            throw new Error("direct-message Work target kind changed");
          }
          if (target.acceptsAttachments?.(recovered.prepared.attachments) === false) {
            throw new Error("direct-message Work contains unsupported attachments");
          }
          const identity = options.recoveryIdentity();
          const endWork = once(options.beginWork());
          dispatch({
            work,
            prepared: recovered.prepared,
            originMessageId: recovered.originMessageId,
            requestId: identity.requestId,
            correlationId: identity.correlationId,
            endWork,
            recovery: true,
            target,
          });
          scheduled += 1;
        } catch {
          refused += 1;
        }
      }
      return Object.freeze({ discovered: recoverable.length, scheduled, refused });
    },

    async submitMessage(input: {
      context: MessagingActorContext; channelId: string; idempotencyKey: string;
      instructionMessageIds?: readonly string[];
      body: { messageId: string; clientMessageId: string; text: string | null;
        attachmentIds: readonly string[]; mentions: readonly string[]; replyToMessageId: string | null;
        modelAlias: string | null; reasoningEffort: import("../../agent/reasoning-effort.js").ReasoningEffort | null };
    }) {
      assertAuthority();
      if ("botSelections" in input.body) throw new MessagingError("request_invalid");
      const turnSelection = Object.freeze({
        modelAlias: input.body.modelAlias ?? null,
        reasoningEffort: input.body.reasoningEffort ?? null,
      });
      const endWork = once(options.beginWork());
      let workTransferred = false;
      try {
        if (
          (input.context.identity.kind !== "owner" && input.context.identity.kind !== "on_demand_bot") ||
          (input.body.text === null && input.body.attachmentIds.length === 0)
        ) {
          throw new MessagingError("request_invalid");
        }
        const priorWorkId = options.context.findWorkIdByIdempotency?.(
          input.context.principalId, sha256(input.idempotencyKey),
        );
        const priorWork = priorWorkId ? options.work.get(priorWorkId) : null;
        if (priorWork) {
          if (input.instructionMessageIds !== undefined && !options.work.getInstructionMessageIds) {
            throw new MessagingError("authority_unavailable");
          }
          const recordedInstructionIds = options.work.getInstructionMessageIds?.(priorWork.id);
          if (JSON.stringify(recordedInstructionIds) !== JSON.stringify(input.instructionMessageIds)) {
            throw new MessagingError("idempotency_conflict");
          }
        }
        if (!priorWork && (turnSelection.modelAlias !== null || turnSelection.reasoningEffort !== null)) {
          const resolved = await options.context.resolveTarget({
            context: input.context,
            channelId: input.channelId,
          });
          const selectionTarget = await executionTargetFor(resolved);
          const catalog = await selectionTarget.models.modelCatalog({
            requestId: input.context.requestId,
            correlationId: input.context.correlationId,
          });
          if (!catalogAcceptsTurnSelection(catalog, turnSelection)) {
            throw new MessagingError("request_invalid");
          }
        }
        const appended = await options.messages.sendMessage({
          context: input.context, channelId: input.channelId, messageId: input.body.messageId,
          authorPrincipalId: input.context.principalId, idempotencyKey: input.idempotencyKey,
          kind: "text", text: input.body.text, mentions: input.body.mentions,
          attachmentIds: input.body.attachmentIds,
          clientMessageId: input.body.clientMessageId, replyToMessageId: input.body.replyToMessageId,
          tombstonesMessageId: null, provenance: { roundId: null, workId: null },
          turnSelection,
        });
        // Accepted Work owns its original snapshot. An exact retry must not
        // revalidate mutable model catalogs or rebuild the last-100 context.
        // sendMessage above remains the authority for body/key conflicts.
        if (priorWork) {
          if (appended.outcome !== "replayed" || priorWork.principalId !== input.context.principalId ||
              priorWork.channelId !== input.channelId || priorWork.originMessageId !== appended.message.id ||
              priorWork.roundId !== null || !["resident_turn", "bot_turn"].includes(priorWork.kind)) {
            throw new MessagingError("idempotency_conflict");
          }
          const response = (async () => {
            if (["failed", "cancelled", "cancelling"].includes(priorWork.state)) {
              throw new Error("terminal or cancelling direct-message Work has no successful result");
            }
            if (priorWork.state === "succeeded") {
              const result = options.messages.getMessage
                ? await options.messages.getMessage({ context: input.context, messageId: responseMessageId(priorWork.id) })
                : (await options.messages.listMessages({ context: input.context, channelId: input.channelId, limit: 100 }))
                  .messages.find((message) => message.provenance.workId === priorWork.id);
              if (!result || result.channelId !== priorWork.channelId || result.provenance.workId !== priorWork.id) {
                throw new Error("successful direct-message Work has no canonical result");
              }
              return result;
            }
            if (!["queued", "leased", "running"].includes(priorWork.state)) {
              throw new Error("direct-message Work is not safely reattachable");
            }
            const recovered = await recoverContext(priorWork);
            const target = await executionTargetFor(recovered.prepared);
            if (target.workKind !== priorWork.kind || target.acceptsAttachments?.(recovered.prepared.attachments) === false) {
              throw new Error("direct-message replay target no longer accepts the original Work");
            }
            return dispatch({
              work: priorWork, prepared: recovered.prepared, originMessageId: appended.message.id,
              requestId: input.context.requestId, correlationId: input.context.correlationId,
              endWork, recovery: priorWork.state !== "queued", target,
            });
          })().finally(endWork);
          workTransferred = true;
          void response.catch(() => undefined);
          return Object.freeze({
            requestId: input.context.requestId, correlationId: input.context.correlationId,
            channelId: input.channelId, conversationId: appended.message.conversationId,
            message: appended.message, work: priorWork, replayed: true,
            throughEventSequence: appended.receipt.eventSequence, response,
          });
        }
        await recordMessage({
          message: appended.message,
          kind: "user_message_committed",
          requestId: input.context.requestId,
          correlationId: input.context.correlationId,
          turnSelection,
        });
        const prepared = await options.context.prepare({
          context: input.context, channelId: input.channelId,
          originMessage: appended.message, attachmentIds: input.body.attachmentIds,
          ...(input.instructionMessageIds === undefined ? {} : { instructionMessageIds: input.instructionMessageIds }),
        });
        // Refuse a disabled target before creating durable Work or returning
        // an accepted response. The owner Message remains the canonical record
        // of what was submitted, but no unroutable Work may be advertised.
        const target = await executionTargetFor(prepared);
        if (target.acceptsAttachments?.(prepared.attachments) === false) {
          throw new MessagingError("request_invalid");
        }
        const created = options.work.create({
          principalId: input.context.principalId, targetPrincipalId: prepared.targetPrincipalId,
          channelId: input.channelId, originMessageId: appended.message.id, roundId: null,
          kind: target.workKind, idempotencyKey: input.idempotencyKey,
          manifest: prepared.manifest, maxAutomaticOffers: 1,
          requestId: input.context.requestId, correlationId: input.context.correlationId,
          turnSelection,
          ...(prepared.instructionMessageIds === undefined ? {} : { instructionMessageIds: prepared.instructionMessageIds }),
        });
        let response: Promise<MessageProjection>;
        if (created.work.state === "succeeded") {
          const targetContext = target.context({
            principalId: prepared.targetPrincipalId,
            requestId: input.context.requestId, correlationId: input.context.correlationId,
          });
          workTransferred = true;
          response = (async () => {
            const page = await options.messages.listMessages({
              context: targetContext, channelId: input.channelId, limit: 100,
            });
            const result = page.messages.find((message) => message.provenance.workId === created.work.id);
            if (result) {
              await recordMessage({
                message: result,
                kind: "assistant_message_committed",
                requestId: input.context.requestId,
                correlationId: input.context.correlationId,
              });
              endWork();
              return result;
            }
            return dispatch({
              work: created.work, prepared, originMessageId: appended.message.id,
              requestId: input.context.requestId, correlationId: input.context.correlationId,
              endWork, recovery: true, target,
            });
          })().catch((error) => {
            endWork();
            throw error;
          });
        } else if (["failed", "cancelled"].includes(created.work.state)) {
          response = Promise.reject(new Error("terminal direct-message Work has no successful result"));
        } else if (created.work.state === "queued") {
          workTransferred = true;
          response = dispatch({ work: created.work, prepared, originMessageId: appended.message.id,
            requestId: input.context.requestId, correlationId: input.context.correlationId,
            endWork, recovery: false, target });
        } else if (["leased", "running"].includes(created.work.state)) {
          workTransferred = true;
          response = dispatch({ work: created.work, prepared, originMessageId: appended.message.id,
            requestId: input.context.requestId, correlationId: input.context.correlationId,
            endWork, recovery: true, target });
        } else {
          response = Promise.reject(new Error("direct-message Work is not safely reattachable"));
        }
        // The HTTP adapter returns 202 and intentionally omits this background
        // promise. Retain an internal rejection observer while allowing tests and
        // in-process callers to await the original response.
        void response.catch(() => undefined);
        return Object.freeze({
          requestId: input.context.requestId, correlationId: input.context.correlationId,
          channelId: input.channelId, conversationId: prepared.conversationId,
          message: appended.message, work: created.work,
          replayed: appended.outcome === "replayed" || created.replayed,
          throughEventSequence: appended.receipt.eventSequence,
          response,
        });
      } finally {
        if (!workTransferred) endWork();
      }
    },
  });
}

export function directMessageManifest(input: {
  channelId: string; messageIds: readonly string[]; attachmentIds: readonly string[];
  channelSequence: number; eventSequence: number;
  instructionMessageIds?: readonly string[];
}): ContextManifestInput {
  const messageIds = [...input.messageIds];
  const attachmentIds = [...input.attachmentIds].sort();
  const source = JSON.stringify({
    channelId: input.channelId,
    messageIds,
    attachmentIds,
    channelSequence: input.channelSequence,
    eventSequence: input.eventSequence,
    ...(input.instructionMessageIds === undefined ? {} : { instructionMessageIds: [...input.instructionMessageIds] }),
  });
  return Object.freeze({
    privacy: "channel_only", channelId: input.channelId,
    messageIds: Object.freeze(messageIds), artifactIds: Object.freeze(attachmentIds),
    counts: Object.freeze({ messages: messageIds.length, artifacts: attachmentIds.length }),
    watermarks: Object.freeze({ channelSequence: input.channelSequence, eventSequence: input.eventSequence }),
    digests: Object.freeze({ context: sha256(source), source: sha256(`coordination.messages:${source}`) }),
  });
}
