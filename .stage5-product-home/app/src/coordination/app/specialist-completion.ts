import { createHash } from "node:crypto";

import type { MediaAttachment } from "../../types.js";
import type {
  ResidentArtifactPromotionPort,
  ResidentCommunicationPort,
  ResidentLeaseBinding,
} from "../../coordination-adapter/index.js";
import {
  COORDINATION_TERMINAL_EVIDENCE_MAX_BYTES,
  type CoordinationCompletionCommit,
} from "../../work/receipt-delivery.js";
import { ArtifactError } from "../artifacts/index.js";
import { assertCoordinationId } from "../ids/index.js";
import { ResidentProtocolError, type JsonValue } from "../resident-protocol/index.js";
import type { ResidentUdsRequestContext } from "../transport/uds/index.js";
import { MessagingError, type MessagingActorContext } from "../channels/index.js";
import {
  CommunicationEventConflictError,
  stableCommunicationEventId,
} from "../communications/index.js";
import { LeaseError, type LeaseBindingInput } from "../leases/index.js";
import type { MessageProjection } from "../messages/index.js";
import type { WorkRecord } from "../work/index.js";
import type { DirectMessageContextPort, DirectMessageMessagePort } from "./direct-message.js";
import type { GroupChannelMessageContextPort } from "./channel-message.js";

export const COORDINATION_COMPLETION_PATH = "/internal/v1/coordination-completions";
export const COORDINATION_UDS_SERVER_INSTANCE_ID = "home23-coordination";

type CompletionStatus = CoordinationCompletionCommit["status"];

export interface SpecialistCompletionResidentTarget {
  serverInstanceId: string;
  clientInstanceId: string;
  keyVersion: number;
  context(input: {
    principalId: string;
    requestId: string;
    correlationId: string;
  }): MessagingActorContext;
  artifactPromotion?: ResidentArtifactPromotionPort;
}

export interface SpecialistCompletionConsumerOptions {
  work: { get(workId: string): WorkRecord | null };
  leases: {
    assertCompleted(binding: LeaseBindingInput): Readonly<{
      work: WorkRecord;
      attempt: Readonly<{
        id: string;
        holderPrincipalId: string;
        holderInstanceId: string;
        authorityReference: string;
        fencingToken: number;
      }>;
      lease: Readonly<{ id: string }>;
      receipt: unknown;
    }>;
  };
  messages: DirectMessageMessagePort & {
    getMessage(input: {
      context: MessagingActorContext;
      messageId: string;
    }): Promise<MessageProjection | null>;
  };
  communications: Pick<ResidentCommunicationPort, "append">;
  directContext: Pick<DirectMessageContextPort, "recover">;
  groupContext?: Pick<GroupChannelMessageContextPort, "recover">;
  resolveResident(residentBinding: string): SpecialistCompletionResidentTarget | undefined;
  assertAuthority(): void;
  recordMessage(input: {
    message: MessageProjection;
    kind: "assistant_message_committed";
    requestId: string;
    correlationId: string;
  }): Promise<void>;
  beginWork(): () => void;
}

function invalid(message: string): never {
  throw new ResidentProtocolError("request_invalid", message);
}

function exactObject(value: JsonValue | undefined, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} is invalid`);
  return value as Record<string, JsonValue>;
}

function exactKeys(
  value: Record<string, JsonValue>,
  keys: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    invalid(`${label} fields are invalid`);
  }
}

function exactString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function nullableText(value: JsonValue | undefined): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    invalid("terminalText is invalid");
  }
  return value;
}

function exactTerminalEvidence(value: JsonValue | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid("terminalEvidence is invalid");
  }
  return value;
}

function exactTimestamp(value: JsonValue | undefined): string {
  const timestamp = exactString(value, "finishedAt");
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== timestamp) {
    invalid("finishedAt is invalid");
  }
  return timestamp;
}

function exactId(
  kind: Parameters<typeof assertCoordinationId>[0],
  value: JsonValue | undefined,
): string {
  const id = exactString(value, kind);
  try { assertCoordinationId(kind, id); } catch { invalid(`${kind} is invalid`); }
  return id;
}

function exactArtifact(value: JsonValue): MediaAttachment {
  const artifact = exactObject(value, "artifact");
  const allowed = ["type", "generatedBy", "path", "mimeType", "fileName", "byteCount", "sha256"];
  const allowedWithCaption = [...allowed, "caption"];
  const actual = Object.keys(artifact).sort().join("\0");
  if (actual !== allowed.sort().join("\0") && actual !== allowedWithCaption.sort().join("\0")) {
    invalid("artifact fields are invalid");
  }
  const type = exactString(artifact.type, "artifact type");
  if (type !== "image" && type !== "voice" && type !== "document") invalid("artifact type is invalid");
  const byteCount = artifact.byteCount;
  if (typeof byteCount !== "number" || !Number.isSafeInteger(byteCount) || byteCount < 1) {
    invalid("artifact byteCount is invalid");
  }
  const caption = artifact.caption;
  if (caption !== undefined && (typeof caption !== "string" || caption.includes("\0"))) {
    invalid("artifact caption is invalid");
  }
  return Object.freeze({
    type,
    generatedBy: exactString(artifact.generatedBy, "artifact generator") as NonNullable<MediaAttachment["generatedBy"]>,
    path: exactString(artifact.path, "artifact path"),
    mimeType: exactString(artifact.mimeType, "artifact mimeType"),
    fileName: exactString(artifact.fileName, "artifact fileName"),
    byteCount,
    sha256: exactString(artifact.sha256, "artifact sha256"),
    ...(caption === undefined ? {} : { caption }),
  });
}

export function parseCoordinationCompletionCommit(
  payload: JsonValue,
): CoordinationCompletionCommit {
  const value = exactObject(payload, "coordination completion");
  exactKeys(value, [
    "parentWorkId", "childWorkId", "childKind", "childResultHandle", "status",
    "finishedAt", "channelId", "conversationId", "originMessageId",
    "attemptId", "leaseId", "fencingToken", "targetPrincipalId",
    "residentBinding", "residentInstanceId",
    "authorityReference", "terminalEvidence", "terminalText", "artifacts",
  ], "coordination completion");
  const parentWorkId = exactId("work", value.parentWorkId);
  const channelId = exactId("channel", value.channelId);
  const childWorkId = exactString(value.childWorkId, "childWorkId");
  if (childWorkId.length > 64 || !/^aw_[a-z0-9]+_[a-f0-9]{4}$/u.test(childWorkId)) {
    invalid("childWorkId is invalid");
  }
  if (value.childKind !== "subagent") invalid("childKind is invalid");
  const handle = exactObject(value.childResultHandle, "childResultHandle");
  exactKeys(handle, ["type", "chatId"], "childResultHandle");
  if (handle.type !== "subagent_chat") invalid("childResultHandle type is invalid");
  const chatId = exactString(handle.chatId, "childResultHandle chatId");
  if (chatId.length > 512 || !chatId.startsWith(`subagent:coordination:${channelId}:${parentWorkId}:`)) {
    invalid("childResultHandle chatId is outside the parent Work");
  }
  const status = value.status;
  if (!["completed", "failed", "cancelled", "interrupted"].includes(String(status))) {
    invalid("status is invalid");
  }
  const terminalText = nullableText(value.terminalText);
  const terminalEvidence = exactTerminalEvidence(value.terminalEvidence);
  if (Buffer.byteLength(terminalEvidence, "utf8") > COORDINATION_TERMINAL_EVIDENCE_MAX_BYTES) {
    invalid("terminalEvidence is too large");
  }
  const fencingToken = value.fencingToken;
  if (typeof fencingToken !== "number" || !Number.isSafeInteger(fencingToken) || fencingToken < 1) {
    invalid("fencingToken is invalid");
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length > 10) invalid("artifacts are invalid");
  const artifacts = Object.freeze(value.artifacts.map(exactArtifact));
  if (status !== "completed" && (terminalText !== null || artifacts.length > 0)) {
    invalid("non-successful specialist completion cannot contain a visible result");
  }
  if (status === "completed" && terminalText === null && artifacts.length === 0) {
    invalid("successful specialist completion has no result");
  }
  return Object.freeze({
    parentWorkId,
    childWorkId,
    childKind: "subagent",
    childResultHandle: Object.freeze({ type: "subagent_chat", chatId }),
    status: status as CompletionStatus,
    finishedAt: exactTimestamp(value.finishedAt),
    channelId,
    conversationId: exactId("conversation", value.conversationId),
    originMessageId: exactId("message", value.originMessageId),
    attemptId: exactId("attempt", value.attemptId),
    leaseId: exactId("lease", value.leaseId),
    fencingToken,
    targetPrincipalId: exactId("principal", value.targetPrincipalId),
    residentBinding: exactString(value.residentBinding, "residentBinding"),
    residentInstanceId: exactString(value.residentInstanceId, "residentInstanceId"),
    authorityReference: exactString(value.authorityReference, "authorityReference"),
    terminalEvidence,
    terminalText,
    artifacts,
  });
}

function stableMessageId(parent: WorkRecord, childWorkId: string): string {
  const timestamp = BigInt(new Date(parent.createdAt).valueOf());
  if (timestamp < 0n || timestamp >= (1n << 48n)) invalid("parent Work timestamp is invalid");
  const bytes = Buffer.alloc(16);
  let remaining = timestamp;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  createHash("sha256")
    .update("home23-specialist-result-message-v1\0", "utf8")
    .update(parent.id, "utf8")
    .update("\0", "utf8")
    .update(childWorkId, "utf8")
    .digest()
    .copy(bytes, 6, 0, 10);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString("hex");
  return `msg_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sameTarget(input: CoordinationCompletionCommit, target: {
  channelId: string;
  conversationId: string;
  originMessageId: string;
  targetPrincipalId: string;
  residentBinding: string;
}): boolean {
  return input.channelId === target.channelId &&
    input.conversationId === target.conversationId &&
    input.originMessageId === target.originMessageId &&
    input.targetPrincipalId === target.targetPrincipalId &&
    input.residentBinding === target.residentBinding;
}

function exactResultMessage(
  message: MessageProjection,
  input: CoordinationCompletionCommit,
  parent: WorkRecord,
  includeResult: boolean,
): boolean {
  if (
    message.channelId !== input.channelId ||
    message.conversationId !== input.conversationId ||
    message.author.principalId !== input.targetPrincipalId ||
    message.kind !== "result" || message.visibility !== "visible" ||
    message.replyToMessageId !== input.originMessageId ||
    message.provenance.roundId !== parent.roundId ||
    message.provenance.workId !== parent.id
  ) return false;
  if (!includeResult) return true;
  return message.text === input.terminalText &&
    message.attachments.length === input.artifacts.length &&
    message.attachments.every((attachment, index) => {
      const artifact = input.artifacts[index];
      return artifact !== undefined && attachment.name === artifact.fileName &&
        attachment.contentType === artifact.mimeType &&
        attachment.byteCount === artifact.byteCount && attachment.sha256 === artifact.sha256;
    });
}

function terminalArtifacts(input: CoordinationCompletionCommit): JsonValue[] {
  return input.artifacts.map((artifact) => ({
    type: artifact.type,
    generatedBy: artifact.generatedBy ?? null,
    path: artifact.path,
    mimeType: artifact.mimeType ?? null,
    fileName: artifact.fileName ?? null,
    byteCount: artifact.byteCount ?? null,
    sha256: artifact.sha256 ?? null,
    ...(artifact.caption === undefined ? {} : { caption: artifact.caption }),
  }));
}

export function createSpecialistCompletionConsumer(
  options: SpecialistCompletionConsumerOptions,
) {
  return async (
    payload: JsonValue,
    request: ResidentUdsRequestContext,
  ): Promise<JsonValue> => {
    const endWork = options.beginWork();
    try {
      options.assertAuthority();
      const input = parseCoordinationCompletionCommit(payload);
      const resident = options.resolveResident(input.residentBinding);
      if (
        request.credential.role !== "resident" || !resident ||
        request.credential.residentSlug !== input.residentBinding ||
        request.credential.instanceId !== resident.clientInstanceId ||
        request.credential.keyVersion !== resident.keyVersion ||
        input.residentInstanceId !== resident.serverInstanceId ||
        input.authorityReference !== `resident:${input.residentBinding}`
      ) {
        throw new ResidentProtocolError("fence_invalid", "specialist completion resident identity differs");
      }
      const parent = options.work.get(input.parentWorkId);
      if (
        !parent ||
        (parent.kind !== "resident_turn" && parent.kind !== "channel.bot_turn") ||
        parent.channelId !== input.channelId ||
        parent.originMessageId !== input.originMessageId ||
        parent.targetPrincipalId !== input.targetPrincipalId
      ) {
        throw new ResidentProtocolError("fence_invalid", "specialist completion parent Work differs");
      }
      if (parent.state !== "succeeded") {
        if (["queued", "leased", "running", "cancelling"].includes(parent.state)) {
          throw new ResidentProtocolError(
            "server_busy",
            "specialist completion is waiting for its parent Work",
            { retryable: true },
          );
        }
        throw new ResidentProtocolError("fence_invalid", "specialist completion parent Work did not succeed");
      }
      const leaseBinding: LeaseBindingInput = Object.freeze({
        workId: parent.id,
        attemptId: input.attemptId,
        leaseId: input.leaseId,
        holderPrincipalId: input.targetPrincipalId,
        holderInstanceId: input.residentInstanceId,
        fencingToken: input.fencingToken,
        requestId: request.requestId,
        correlationId: request.correlationId,
      });
      const completed = options.leases.assertCompleted(leaseBinding);
      if (
        completed.work.id !== parent.id || completed.work.currentAttemptId !== input.attemptId ||
        completed.attempt.id !== input.attemptId || completed.lease.id !== input.leaseId ||
        completed.attempt.holderPrincipalId !== input.targetPrincipalId ||
        completed.attempt.holderInstanceId !== input.residentInstanceId ||
        completed.attempt.authorityReference !== input.authorityReference ||
        completed.attempt.fencingToken !== input.fencingToken
      ) {
        throw new ResidentProtocolError("fence_invalid", "specialist completion lease differs");
      }
      const binding: ResidentLeaseBinding = Object.freeze({
        ...leaseBinding,
        authorityReference: input.authorityReference,
      });

      let targetDisplayName: string;
      if (parent.kind === "resident_turn") {
        const recovered = await options.directContext.recover(parent);
        if (!sameTarget(input, {
          channelId: recovered.prepared.channelId,
          conversationId: recovered.prepared.conversationId,
          originMessageId: recovered.originMessageId,
          targetPrincipalId: recovered.prepared.targetPrincipalId,
          residentBinding: recovered.prepared.residentBinding,
        })) {
          throw new ResidentProtocolError("fence_invalid", "specialist completion direct context differs");
        }
        targetDisplayName = recovered.prepared.targetBotDisplayName;
      } else {
        if (!options.groupContext) invalid("group completion context is unavailable");
        const recovered = await options.groupContext.recover(parent);
        const target = recovered.selectedTargets.find((candidate) =>
          candidate.targetPrincipalId === parent.targetPrincipalId);
        if (!target || !sameTarget(input, {
          channelId: recovered.channelId,
          conversationId: recovered.conversationId,
          originMessageId: recovered.originMessageId,
          targetPrincipalId: target.targetPrincipalId,
          residentBinding: target.residentBinding,
        })) {
          throw new ResidentProtocolError("fence_invalid", "specialist completion group context differs");
        }
        targetDisplayName = target.targetBotDisplayName;
      }

      await options.communications.append({
        event: {
          eventId: stableCommunicationEventId(
            `specialist-terminal:${input.parentWorkId}:${input.childWorkId}`,
            input.finishedAt,
          ),
          conversationId: input.conversationId,
          channelId: input.channelId,
          messageId: null,
          workId: input.parentWorkId,
          attemptId: input.attemptId,
          turnId: null,
          actor: {
            principalId: input.targetPrincipalId,
            displayName: targetDisplayName,
            kind: "resident_bot",
          },
          source: {
            system: "resident_runtime",
            adapter: "resident_uds",
            sourceEventType: `specialist.${input.status}`,
          },
          kind: input.status === "failed" || input.status === "interrupted"
            ? "failure"
            : "subagent_completed",
          provenance: "resident_authenticated_specialist_terminal",
          occurredAt: input.finishedAt,
          payload: {
            parentWorkId: input.parentWorkId,
            childWorkId: input.childWorkId,
            childKind: input.childKind,
            childResultHandle: { ...input.childResultHandle },
            status: input.status,
            terminalEvidence: input.terminalEvidence,
            terminalText: input.terminalText,
            artifacts: terminalArtifacts(input),
          },
          terminal: true,
        },
        requestId: request.requestId,
        correlationId: request.correlationId,
      });
      if (input.status !== "completed") {
        return { accepted: true, childWorkId: input.childWorkId, messageId: null, replayed: false };
      }
      const messagingContext = resident.context({
        principalId: input.targetPrincipalId,
        requestId: request.requestId,
        correlationId: request.correlationId,
      });
      const specialistMessageId = stableMessageId(parent, input.childWorkId);
      const existing = await options.messages.getMessage({
        context: messagingContext,
        messageId: specialistMessageId,
      });
      if (existing) {
        if (existing.id !== specialistMessageId || !exactResultMessage(existing, input, parent, true)) {
          throw new ResidentProtocolError("fence_invalid", "specialist completion Message differs");
        }
        await options.recordMessage({
          message: existing,
          kind: "assistant_message_committed",
          requestId: request.requestId,
          correlationId: request.correlationId,
        });
        return {
          accepted: true,
          childWorkId: input.childWorkId,
          messageId: existing.id,
          replayed: true,
        };
      }
      const primaryMessageId = `msg_${parent.id.slice(4)}`;
      const primary = await options.messages.getMessage({
        context: messagingContext,
        messageId: primaryMessageId,
      });
      if (!primary) {
        throw new ResidentProtocolError(
          "server_busy",
          "specialist completion is waiting for the parent answer",
          { retryable: true },
        );
      }
      if (primary.id !== primaryMessageId || !exactResultMessage(primary, input, parent, false)) {
        throw new ResidentProtocolError("fence_invalid", "specialist completion parent answer differs");
      }
      const attachmentIds = input.artifacts.length === 0
        ? Object.freeze([])
        : await resident.artifactPromotion?.promote({
            binding,
            media: [...input.artifacts],
            resultIdentity: input.childWorkId,
          }) ?? invalid("specialist artifact storage is unavailable");
      const result = await options.messages.sendMessage({
        context: messagingContext,
        channelId: input.channelId,
        messageId: specialistMessageId,
        authorPrincipalId: input.targetPrincipalId,
        idempotencyKey: `specialist-result:${input.parentWorkId}:${input.childWorkId}`,
        kind: "result",
        text: input.terminalText,
        attachmentIds,
        mentions: [],
        clientMessageId: null,
        replyToMessageId: input.originMessageId,
        tombstonesMessageId: null,
        provenance: { roundId: parent.roundId, workId: parent.id },
      });
      await options.recordMessage({
        message: result.message,
        kind: "assistant_message_committed",
        requestId: request.requestId,
        correlationId: request.correlationId,
      });
      return {
        accepted: true,
        childWorkId: input.childWorkId,
        messageId: result.message.id,
        replayed: result.outcome === "replayed",
      };
    } catch (error) {
      if (error instanceof ResidentProtocolError) throw error;
      if (
        error instanceof MessagingError || error instanceof ArtifactError ||
        error instanceof CommunicationEventConflictError
      ) {
        const retryable = error instanceof CommunicationEventConflictError ? false : error.retryable;
        throw new ResidentProtocolError(
          retryable ? "internal_error" : "request_invalid",
          "specialist completion could not be committed",
          { retryable },
        );
      }
      if (error instanceof LeaseError) {
        throw new ResidentProtocolError(
          "fence_invalid",
          "specialist completion parent Lease differs",
        );
      }
      throw error;
    } finally {
      endWork();
    }
  };
}
