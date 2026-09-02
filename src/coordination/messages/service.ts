import {
  createMessagingIdempotencyClaim,
  MessagingError,
  resolveMessagingActor,
  type MessagingActorContext,
} from "../channels/index.js";
import { assertCoordinationId } from "../ids/index.js";
import type { JsonValue } from "../policy/index.js";
import type {
  CreateMessageServiceOptions,
  MessageKind,
  MessageProvenance,
  MessageTurnSelection,
  PendingMessage,
} from "./types.js";
import { REASONING_EFFORTS } from "../../agent/reasoning-effort.js";

const MAX_MESSAGE_BYTES = 65_536;

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("messaging clock returned an invalid date");
  }
  return new Date(value.getTime()).toISOString();
}

function assertId(kind: Parameters<typeof assertCoordinationId>[0], value: string): void {
  try {
    assertCoordinationId(kind, value);
  } catch {
    throw new MessagingError("request_invalid");
  }
}

function canonicalNullableId(
  kind: "message" | "round" | "work",
  value: string | null,
): string | null {
  if (value === null) return null;
  assertId(kind, value);
  return value;
}

function canonicalClientMessageId(value: string | null): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.includes("\0")
  ) {
    throw new MessagingError("request_invalid");
  }
  return value;
}

function canonicalBody(
  kind: MessageKind,
  value: string | null,
  attachmentCount: number,
): string | null {
  if (value === null) {
    if (kind === "system" || ((kind === "text" || kind === "result") && attachmentCount > 0)) {
      return null;
    }
    throw new MessagingError("request_invalid");
  }
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_MESSAGE_BYTES
  ) {
    throw new MessagingError("request_invalid");
  }
  return value;
}

function canonicalProvenance(value: MessageProvenance): MessageProvenance {
  if (!value || typeof value !== "object") throw new MessagingError("request_invalid");
  return Object.freeze({
    roundId: canonicalNullableId("round", value.roundId),
    workId: canonicalNullableId("work", value.workId),
  });
}

function canonicalTurnSelection(
  value: MessageTurnSelection | undefined,
): MessageTurnSelection | null {
  if (value === undefined) return null;
  if (
    !value || typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "modelAlias,reasoningEffort"
  ) {
    throw new MessagingError("request_invalid");
  }
  if (
    value.modelAlias !== null &&
    (typeof value.modelAlias !== "string" || value.modelAlias.length < 1 ||
      value.modelAlias.length > 256 || /[\0\r\n]/u.test(value.modelAlias))
  ) {
    throw new MessagingError("request_invalid");
  }
  if (
    value.reasoningEffort !== null &&
    (typeof value.reasoningEffort !== "string" ||
      !REASONING_EFFORTS.includes(value.reasoningEffort))
  ) {
    throw new MessagingError("request_invalid");
  }
  if (value.modelAlias === null && value.reasoningEffort === null) return null;
  return Object.freeze({ ...value });
}

function sameResolvedActor(
  left: Awaited<ReturnType<typeof resolveMessagingActor>>,
  right: Awaited<ReturnType<typeof resolveMessagingActor>>,
): boolean {
  return left.principalId === right.principalId &&
    left.kind === right.kind &&
    left.displayName === right.displayName &&
    left.requestId === right.requestId &&
    left.correlationId === right.correlationId &&
    left.residentCredential?.residentBinding === right.residentCredential?.residentBinding &&
    left.residentCredential?.instanceId === right.residentCredential?.instanceId &&
    left.residentCredential?.keyVersion === right.residentCredential?.keyVersion;
}

export function createMessageService(options: CreateMessageServiceOptions) {
  const { repository, participantDirectory } = options;
  const now = options.now ?? (() => new Date());

  async function sendMessage(input: {
    context: MessagingActorContext;
    channelId: string;
    messageId: string;
    authorPrincipalId: string;
    idempotencyKey: string;
    kind: MessageKind;
    text: string | null;
    mentions: readonly string[];
    attachmentIds?: readonly string[];
    clientMessageId: string | null;
    replyToMessageId: string | null;
    tombstonesMessageId: string | null;
    provenance: MessageProvenance;
    turnSelection?: MessageTurnSelection;
  }) {
    assertId("channel", input.channelId);
    assertId("message", input.messageId);
    assertId("principal", input.authorPrincipalId);
    const actor = await resolveMessagingActor(
      input.context,
      participantDirectory,
      "message:send",
    );
    if (actor.principalId !== input.authorPrincipalId) {
      throw new MessagingError("identity_context_mismatch");
    }
    if (input.kind !== "text" && input.kind !== "system" && input.kind !== "result") {
      throw new MessagingError("request_invalid");
    }
    if (!Array.isArray(input.mentions) || input.mentions.length > 64) {
      throw new MessagingError("invalid_mention");
    }
    const mentions = [...input.mentions];
    if (new Set(mentions).size !== mentions.length) {
      throw new MessagingError("invalid_mention");
    }
    for (const mention of mentions) {
      try {
        assertCoordinationId("bot", mention);
      } catch {
        throw new MessagingError("invalid_mention");
      }
    }
    mentions.sort();
    const attachmentIds = input.attachmentIds === undefined ? [] : [...input.attachmentIds];
    if (attachmentIds.length > 10 || new Set(attachmentIds).size !== attachmentIds.length) {
      throw new MessagingError("request_invalid");
    }
    for (const attachmentId of attachmentIds) assertId("artifact", attachmentId);
    const artifactActor = attachmentIds.length > 0 && options.resolveAttachmentActor
      ? await options.resolveAttachmentActor(input.context)
      : undefined;
    if (artifactActor && !sameResolvedActor(actor, artifactActor)) {
      throw new MessagingError("identity_context_mismatch");
    }
    const replyToMessageId = canonicalNullableId("message", input.replyToMessageId);
    const tombstonesMessageId = canonicalNullableId("message", input.tombstonesMessageId);
    if (replyToMessageId && tombstonesMessageId) {
      throw new MessagingError("invalid_relation");
    }
    const text = canonicalBody(input.kind, input.text, attachmentIds.length);
    if (
      tombstonesMessageId &&
      (input.kind !== "system" || text !== null || mentions.length > 0)
    ) {
      throw new MessagingError("invalid_relation");
    }
    const clientMessageId = canonicalClientMessageId(input.clientMessageId);
    const provenance = canonicalProvenance(input.provenance);
    const turnSelection = canonicalTurnSelection(input.turnSelection);
    const message: PendingMessage = Object.freeze({
      id: input.messageId,
      channelId: input.channelId,
      author: Object.freeze({
        principalId: actor.principalId,
        kind: actor.kind,
        displayName: actor.displayName,
      }),
      kind: input.kind,
      text,
      mentions: Object.freeze(mentions),
      clientMessageId,
      replyToMessageId,
      tombstonesMessageId,
      provenance,
      createdAt: canonicalNow(now),
    });
    const digestInput: Record<string, JsonValue> = {
      channelId: message.channelId,
      messageId: message.id,
      authorPrincipalId: message.author.principalId,
      kind: message.kind,
      text: message.text,
      mentions: [...message.mentions],
      attachmentIds: [...attachmentIds],
      clientMessageId: message.clientMessageId,
      replyToMessageId: message.replyToMessageId,
      tombstonesMessageId: message.tombstonesMessageId,
      provenance: {
        roundId: message.provenance.roundId,
        workId: message.provenance.workId,
      },
    };
    // An omitted/null selection must retain the exact pre-extension digest.
    // A real override joins the Message commit so a process crash before Work
    // creation cannot permit a different choice on retry.
    if (turnSelection) digestInput.turnSelection = { ...turnSelection };
    const idempotency = createMessagingIdempotencyClaim(
      "message.append",
      actor.principalId,
      input.idempotencyKey,
      digestInput,
    );
    return repository.appendMessage({
      message,
      attachmentIds: Object.freeze(attachmentIds),
      actor,
      ...(artifactActor === undefined ? {} : { artifactActor }),
      idempotency,
      ...(turnSelection ? { turnSelection } : {}),
    });
  }

  async function listMessages(input: {
    context: MessagingActorContext;
    channelId: string;
    beforeSequence?: number;
    limit: number;
  }) {
    assertId("channel", input.channelId);
    const actor = await resolveMessagingActor(
      input.context,
      participantDirectory,
      "product:read",
    );
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      (input.beforeSequence !== undefined &&
        (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence < 1))
    ) {
      throw new MessagingError("request_invalid");
    }
    return repository.listMessages({
      channelId: input.channelId,
      actor,
      beforeSequence: input.beforeSequence,
      limit: input.limit,
    });
  }

  return Object.freeze({ sendMessage, listMessages });
}
