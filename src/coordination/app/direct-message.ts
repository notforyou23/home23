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
import type {
  CoordinationDeviceNotificationPort,
  CoordinationLeasePort,
  CoordinationWorkPort,
} from "./types.js";

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
  historyBackfill: readonly DirectMessageHistoryEntry[];
  attachments: readonly ResidentInputAttachment[];
  manifest: ContextManifestInput;
}

export interface DirectMessageHistoryEntry {
  messageId: string;
  sequence: number;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface DirectMessageContextPort {
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
  }): Promise<DirectMessageChannelContext>;
  recover(work: WorkRecord): Promise<{
    prepared: DirectMessageChannelContext;
    originMessageId: string;
  }>;
}

export interface DirectMessageMessagePort {
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
        ...(message.provenance.workId === null
          ? {}
          : { workId: message.provenance.workId }),
        displayName: message.author.displayName,
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
    notify();
  };
}

/** Join M08 -> M11 -> M13 -> M11 terminal -> M08 result without activating a process. */
export function createDirectMessageSubmissionService(options: {
  messages: DirectMessageMessagePort;
  context: DirectMessageContextPort;
  work: CoordinationWorkPort;
  leases: CoordinationLeasePort;
  resolveResident(residentBinding: string): DirectMessageResidentTarget | undefined;
  resolveExecutionTarget?(target: DirectMessageTargetDescriptor):
    DirectMessageExecutionTarget | undefined |
    Promise<DirectMessageExecutionTarget | undefined>;
  authority: { current(): AuthorityEpoch | null };
  communications?: ResidentCommunicationPort;
  notifications?: Pick<CoordinationDeviceNotificationPort, "notifyMessageCommitted">;
  beginWork(): () => void;
  recoveryIdentity(): { requestId: string; correlationId: string };
}) {
  const inFlight = new Map<string, Promise<MessageProjection>>();
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
      let origin: CoordinationTurnOrigin;
      let recoveryPhase: "offered" | "accepted" | "running" | "completed" | null = null;
      if (input.recovery) {
        const recoveredWork = options.work.get(input.work.id);
        if (!recoveredWork) throw new Error("direct-message Work disappeared during recovery");
        const exactWork = recoveredWork.channelId === input.prepared.channelId &&
          recoveredWork.originMessageId === input.originMessageId &&
          recoveredWork.roundId === null &&
          recoveredWork.targetPrincipalId === input.prepared.targetPrincipalId &&
          recoveredWork.kind === target.workKind;
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
            roundId: null,
          });
        } else {
          const current = options.leases.current(recoveredWork.id);
          const exactBinding = current.work.channelId === input.prepared.channelId &&
            current.work.originMessageId === input.originMessageId &&
            current.work.roundId === null &&
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
          originMessageId: input.originMessageId, roundId: null,
        });
      }
      const executionRequest = {
        chatId: `coordination:${input.prepared.channelId}:${input.work.id}`,
        instruction: input.prepared.instruction, origin,
        historyBackfill: input.prepared.historyBackfill,
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
      let agentResponse: AgentResponse;
      let terminalReceipt: ResidentTerminalReceipt;
      if (recoveryPhase === "completed") {
        const run = await target.execution.recoverCompleted(executionRequest);
        [agentResponse, terminalReceipt] = await Promise.all([run.response, run.receipt]);
      } else {
        const run = recoveryPhase === "running"
          ? await target.execution.reattach(executionRequest)
          : recoveryPhase === "accepted"
            ? await target.execution.continueAccepted(executionRequest)
            : await target.execution.execute(executionRequest);
        [agentResponse, terminalReceipt] = await Promise.all([run.response, run.receipt]);
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
        idempotencyKey: `work-result:${input.work.id}`, kind: "result",
        text: resultText, mentions: [], clientMessageId: null,
        attachmentIds: terminalReceipt.artifactIds,
        replyToMessageId: input.originMessageId, tombstonesMessageId: null,
        provenance: { roundId: null, workId: input.work.id },
      });
      await recordMessage({
        message: result.message,
        kind: "assistant_message_committed",
        requestId: input.requestId,
        correlationId: input.correlationId,
      });
      return result.message;
    })().finally(input.endWork);
    inFlight.set(input.work.id, execution);
    void execution.finally(() => inFlight.delete(input.work.id)).catch(() => undefined);
    return execution;
  }

  return Object.freeze({
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
      ];
      let scheduled = 0;
      let refused = 0;
      for (const work of recoverable) {
        try {
          const recovered = await options.context.recover(work);
          const target = await executionTargetFor(recovered.prepared);
          if (target.workKind !== work.kind) {
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
      body: { messageId: string; clientMessageId: string; text: string | null;
        attachmentIds: readonly string[]; mentions: readonly string[]; replyToMessageId: string | null;
        modelAlias: string | null; reasoningEffort: import("../../agent/reasoning-effort.js").ReasoningEffort | null };
    }) {
      assertAuthority();
      const turnSelection = Object.freeze({
        modelAlias: input.body.modelAlias ?? null,
        reasoningEffort: input.body.reasoningEffort ?? null,
      });
      const endWork = once(options.beginWork());
      let workTransferred = false;
      try {
        if (
          input.context.identity.kind !== "owner" ||
          (input.body.text === null && input.body.attachmentIds.length === 0)
        ) {
          throw new MessagingError("request_invalid");
        }
        if (turnSelection.modelAlias !== null || turnSelection.reasoningEffort !== null) {
          const resolved = await options.context.resolveTarget({
            context: input.context,
            channelId: input.channelId,
          });
          const selectionTarget = await executionTargetFor(resolved);
          const catalog = await selectionTarget.models.modelCatalog({
            requestId: input.context.requestId,
            correlationId: input.context.correlationId,
          });
          if (
            (turnSelection.modelAlias !== null &&
              !catalog.models.some((model) => model.alias === turnSelection.modelAlias)) ||
            (turnSelection.reasoningEffort !== null &&
              !catalog.reasoningEfforts.includes(turnSelection.reasoningEffort))
          ) {
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
}): ContextManifestInput {
  const messageIds = [...input.messageIds];
  const attachmentIds = [...input.attachmentIds].sort();
  const source = JSON.stringify({
    channelId: input.channelId,
    messageIds,
    attachmentIds,
    channelSequence: input.channelSequence,
    eventSequence: input.eventSequence,
  });
  return Object.freeze({
    privacy: "channel_only", channelId: input.channelId,
    messageIds: Object.freeze(messageIds), artifactIds: Object.freeze(attachmentIds),
    counts: Object.freeze({ messages: messageIds.length, artifacts: attachmentIds.length }),
    watermarks: Object.freeze({ channelSequence: input.channelSequence, eventSequence: input.eventSequence }),
    digests: Object.freeze({ context: sha256(source), source: sha256(`coordination.messages:${source}`) }),
  });
}
