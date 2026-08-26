import { createHash } from "node:crypto";
import type { AgentResponse, CoordinationTurnOrigin } from "../../agent/types.js";
import type { ResidentCoordinationAdapter } from "../../coordination-adapter/index.js";
import { MessagingError, type MessagingActorContext } from "../channels/index.js";
import type { MessageProjection } from "../messages/index.js";
import type { ContextManifestInput, WorkRecord } from "../work/index.js";
import type { CoordinationLeasePort, CoordinationWorkPort } from "./types.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function responseMessageId(workId: string): string {
  if (!workId.startsWith("wrk_")) throw new Error("Work ID cannot derive a Message ID");
  return `msg_${workId.slice(4)}`;
}

export interface DirectMessageChannelContext {
  channelId: string;
  conversationId: string;
  targetBotId: string;
  targetPrincipalId: string;
  residentBinding: string;
  instruction: string;
  manifest: ContextManifestInput;
}

export interface DirectMessageContextPort {
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
    text: string; mentions: readonly string[]; clientMessageId: string | null;
    attachmentIds?: readonly string[];
    replyToMessageId: string | null; tombstonesMessageId: null;
    provenance: { roundId: string | null; workId: string | null };
  }): Promise<{ outcome: "committed" | "replayed"; message: MessageProjection; receipt: { eventSequence: number } }>;
  listMessages(input: {
    context: MessagingActorContext; channelId: string; limit: number;
  }): Promise<{ messages: readonly MessageProjection[] }>;
}

/** Join M08 -> M11 -> M13 -> M11 terminal -> M08 result without activating a process. */
export function createDirectMessageSubmissionService(options: {
  messages: DirectMessageMessagePort;
  context: DirectMessageContextPort;
  work: CoordinationWorkPort;
  leases: CoordinationLeasePort;
  resident: Pick<ResidentCoordinationAdapter,
    "execute" | "continueAccepted" | "reattach" | "recoverCompleted">;
  holderInstanceId: string;
  beginWork(): () => void;
  recoveryIdentity(): { requestId: string; correlationId: string };
  residentContext(input: { residentBinding: string; principalId: string; requestId: string; correlationId: string }): MessagingActorContext;
}) {
  const inFlight = new Map<string, Promise<MessageProjection>>();
  const once = (callback: () => void) => {
    let called = false;
    return () => {
      if (called) return;
      called = true;
      callback();
    };
  };

  function dispatch(input: {
    work: WorkRecord; prepared: DirectMessageChannelContext; originMessageId: string;
    requestId: string; correlationId: string; endWork: () => void; recovery: boolean;
  }): Promise<MessageProjection> {
    const existing = inFlight.get(input.work.id);
    if (existing) {
      input.endWork();
      return existing;
    }
    const execution = (async () => {
      let origin: CoordinationTurnOrigin;
      let recoveryPhase: "offered" | "accepted" | "running" | "completed" | null = null;
      if (input.recovery) {
        const recoveredWork = options.work.get(input.work.id);
        if (!recoveredWork) throw new Error("resident Work disappeared during recovery");
        const exactWork = recoveredWork.channelId === input.prepared.channelId &&
          recoveredWork.originMessageId === input.originMessageId &&
          recoveredWork.roundId === null &&
          recoveredWork.targetPrincipalId === input.prepared.targetPrincipalId;
        if (!exactWork) throw new Error("resident Work recovery binding is not exact");
        if (recoveredWork.state === "queued" && recoveredWork.currentAttemptId === null) {
          const offer = options.leases.offer({
            workId: recoveredWork.id,
            holderPrincipalId: input.prepared.targetPrincipalId,
            holderInstanceId: options.holderInstanceId,
            authorityReference: `resident:${input.prepared.residentBinding}`,
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
            holderInstanceId: options.holderInstanceId,
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
            current.attempt.holderInstanceId === options.holderInstanceId &&
            current.lease.holderPrincipalId === current.attempt.holderPrincipalId &&
            current.lease.holderInstanceId === current.attempt.holderInstanceId &&
            current.lease.fencingToken === current.attempt.fencingToken &&
            current.attempt.authorityReference === `resident:${input.prepared.residentBinding}`;
          if (!exactBinding) throw new Error("resident Work recovery binding is not exact");
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
          holderInstanceId: options.holderInstanceId,
          authorityReference: `resident:${input.prepared.residentBinding}`, automatic: true,
          requestId: input.requestId, correlationId: input.correlationId,
        });
        origin = Object.freeze({
          kind: "coordination", workId: input.work.id, attemptId: offer.attempt.id,
          leaseId: offer.lease.id, holderPrincipalId: input.prepared.targetPrincipalId,
          holderInstanceId: options.holderInstanceId, authorityReference: offer.attempt.authorityReference,
          fencingToken: offer.fencingToken, channelId: input.prepared.channelId,
          originMessageId: input.originMessageId, roundId: null,
        });
      }
      const residentRequest = {
        chatId: `coordination:${input.prepared.channelId}:${input.work.id}`,
        instruction: input.prepared.instruction, origin,
        requestId: input.requestId, correlationId: input.correlationId,
      };
      let agentResponse: AgentResponse;
      if (recoveryPhase === "completed") {
        const run = await options.resident.recoverCompleted(residentRequest);
        agentResponse = await run.response;
      } else {
        const run = recoveryPhase === "running"
          ? await options.resident.reattach(residentRequest)
          : recoveryPhase === "accepted"
            ? await options.resident.continueAccepted(residentRequest)
            : await options.resident.execute(residentRequest);
        [agentResponse] = await Promise.all([run.response, run.receipt]) as [AgentResponse, unknown];
      }
      const result = await options.messages.sendMessage({
        context: options.residentContext({
          residentBinding: input.prepared.residentBinding,
          principalId: input.prepared.targetPrincipalId,
          requestId: input.requestId, correlationId: input.correlationId,
        }),
        channelId: input.prepared.channelId, messageId: responseMessageId(input.work.id),
        authorPrincipalId: input.prepared.targetPrincipalId,
        idempotencyKey: `work-result:${input.work.id}`, kind: "result",
        text: agentResponse.text, mentions: [], clientMessageId: null,
        replyToMessageId: input.originMessageId, tombstonesMessageId: null,
        provenance: { roundId: null, workId: input.work.id },
      });
      return result.message;
    })().finally(input.endWork);
    inFlight.set(input.work.id, execution);
    void execution.finally(() => inFlight.delete(input.work.id)).catch(() => undefined);
    return execution;
  }

  return Object.freeze({
    async recoverResidentWork() {
      const recoverable = [
        ...options.work.listResidentRecoverable("resident_turn", 100),
        ...options.work.listSucceededMissingResult("resident_turn", 100),
      ];
      let scheduled = 0;
      let refused = 0;
      for (const work of recoverable) {
        try {
          const recovered = await options.context.recover(work);
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
        attachmentIds: readonly string[]; mentions: readonly string[]; replyToMessageId: string | null };
    }) {
      const endWork = once(options.beginWork());
      let workTransferred = false;
      try {
        if (input.context.identity.kind !== "owner" || input.body.text === null) {
          throw new MessagingError("request_invalid");
        }
        const appended = await options.messages.sendMessage({
          context: input.context, channelId: input.channelId, messageId: input.body.messageId,
          authorPrincipalId: input.context.principalId, idempotencyKey: input.idempotencyKey,
          kind: "text", text: input.body.text, mentions: input.body.mentions,
          attachmentIds: input.body.attachmentIds,
          clientMessageId: input.body.clientMessageId, replyToMessageId: input.body.replyToMessageId,
          tombstonesMessageId: null, provenance: { roundId: null, workId: null },
        });
        const prepared = await options.context.prepare({
          context: input.context, channelId: input.channelId,
          originMessage: appended.message, attachmentIds: input.body.attachmentIds,
        });
        const created = options.work.create({
          principalId: input.context.principalId, targetPrincipalId: prepared.targetPrincipalId,
          channelId: input.channelId, originMessageId: appended.message.id, roundId: null,
          kind: "resident_turn", idempotencyKey: input.idempotencyKey,
          manifest: prepared.manifest, maxAutomaticOffers: 1,
          requestId: input.context.requestId, correlationId: input.context.correlationId,
        });
        let response: Promise<MessageProjection>;
        if (created.work.state === "succeeded") {
          const residentContext = options.residentContext({
            residentBinding: prepared.residentBinding, principalId: prepared.targetPrincipalId,
            requestId: input.context.requestId, correlationId: input.context.correlationId,
          });
          workTransferred = true;
          response = (async () => {
            const page = await options.messages.listMessages({
              context: residentContext, channelId: input.channelId, limit: 100,
            });
            const result = page.messages.find((message) => message.provenance.workId === created.work.id);
            if (result) {
              endWork();
              return result;
            }
            return dispatch({
              work: created.work, prepared, originMessageId: appended.message.id,
              requestId: input.context.requestId, correlationId: input.context.correlationId,
              endWork, recovery: true,
            });
          })().catch((error) => {
            endWork();
            throw error;
          });
        } else if (["failed", "cancelled"].includes(created.work.state)) {
          response = Promise.reject(new Error("terminal resident Work has no successful result"));
        } else if (created.work.state === "queued") {
          workTransferred = true;
          response = dispatch({ work: created.work, prepared, originMessageId: appended.message.id,
            requestId: input.context.requestId, correlationId: input.context.correlationId,
            endWork, recovery: false });
        } else if (["leased", "running"].includes(created.work.state)) {
          workTransferred = true;
          response = dispatch({ work: created.work, prepared, originMessageId: appended.message.id,
            requestId: input.context.requestId, correlationId: input.context.correlationId,
            endWork, recovery: true });
        } else {
          response = Promise.reject(new Error("resident Work is not safely reattachable"));
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
