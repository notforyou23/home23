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
  resident: Pick<ResidentCoordinationAdapter, "execute">;
  holderInstanceId: string;
  residentContext(input: { residentBinding: string; principalId: string; requestId: string; correlationId: string }): MessagingActorContext;
}) {
  const inFlight = new Map<string, Promise<MessageProjection>>();

  function dispatch(input: {
    work: WorkRecord; prepared: DirectMessageChannelContext; originMessage: MessageProjection;
    requestId: string; correlationId: string;
  }): Promise<MessageProjection> {
    const existing = inFlight.get(input.work.id);
    if (existing) return existing;
    const execution = (async () => {
      const offer = options.leases.offer({
        workId: input.work.id, holderPrincipalId: input.prepared.targetPrincipalId,
        holderInstanceId: options.holderInstanceId,
        authorityReference: `resident:${input.prepared.residentBinding}`, automatic: true,
        requestId: input.requestId, correlationId: input.correlationId,
      });
      const origin: CoordinationTurnOrigin = Object.freeze({
        kind: "coordination", workId: input.work.id, attemptId: offer.attempt.id,
        leaseId: offer.lease.id, holderPrincipalId: input.prepared.targetPrincipalId,
        holderInstanceId: options.holderInstanceId, authorityReference: offer.attempt.authorityReference,
        fencingToken: offer.fencingToken, channelId: input.prepared.channelId,
        originMessageId: input.originMessage.id, roundId: null,
      });
      const run = await options.resident.execute({
        chatId: `coordination:${input.prepared.channelId}:${input.work.id}`,
        instruction: input.prepared.instruction, origin,
        requestId: input.requestId, correlationId: input.correlationId,
      });
      const [agentResponse] = await Promise.all([run.response, run.receipt]) as [AgentResponse, unknown];
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
        replyToMessageId: input.originMessage.id, tombstonesMessageId: null,
        provenance: { roundId: null, workId: input.work.id },
      });
      return result.message;
    })();
    inFlight.set(input.work.id, execution);
    void execution.finally(() => inFlight.delete(input.work.id)).catch(() => undefined);
    return execution;
  }

  return Object.freeze({
    async submitMessage(input: {
      context: MessagingActorContext; channelId: string; idempotencyKey: string;
      body: { messageId: string; clientMessageId: string; text: string | null;
        attachmentIds: readonly string[]; mentions: readonly string[]; replyToMessageId: string | null };
    }) {
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
      if (["succeeded", "failed", "cancelled"].includes(created.work.state)) {
        const residentContext = options.residentContext({
          residentBinding: prepared.residentBinding, principalId: prepared.targetPrincipalId,
          requestId: input.context.requestId, correlationId: input.context.correlationId,
        });
        response = options.messages.listMessages({
          context: residentContext, channelId: input.channelId, limit: 100,
        }).then((page) => {
          const result = page.messages.find((message) => message.provenance.workId === created.work.id);
          if (!result) throw new Error("terminal Work is missing its canonical result Message");
          return result;
        });
      } else if (created.work.state === "queued") {
        response = dispatch({ work: created.work, prepared, originMessage: appended.message,
          requestId: input.context.requestId, correlationId: input.context.correlationId });
      } else {
        response = Promise.reject(new Error("resident Work requires restart recovery before dispatch"));
        void response.catch(() => undefined);
      }
      return Object.freeze({
        requestId: input.context.requestId, correlationId: input.context.correlationId,
        channelId: input.channelId, conversationId: prepared.conversationId,
        message: appended.message, work: created.work,
        replayed: appended.outcome === "replayed" || created.replayed,
        throughEventSequence: appended.receipt.eventSequence,
        response,
      });
    },
  });
}

export function directMessageManifest(input: {
  channelId: string; messageIds: readonly string[]; attachmentIds: readonly string[];
  channelSequence: number; eventSequence: number;
}): ContextManifestInput {
  const source = JSON.stringify(input);
  return Object.freeze({
    privacy: "channel_only", channelId: input.channelId,
    messageIds: Object.freeze([...input.messageIds]), artifactIds: Object.freeze([...input.attachmentIds]),
    counts: Object.freeze({ messages: input.messageIds.length, artifacts: input.attachmentIds.length }),
    watermarks: Object.freeze({ channelSequence: input.channelSequence, eventSequence: input.eventSequence }),
    digests: Object.freeze({ context: sha256(source), source: sha256(`coordination.messages:${source}`) }),
  });
}
