import {
  createMessagingIdempotencyClaim,
  MessagingError,
  resolveMessagingActor,
  type MessagingActorContext,
} from "../channels/index.js";
import { assertCoordinationId } from "../ids/index.js";
import type { CreateUnreadServiceOptions } from "./types.js";

function assertChannelId(value: string): void {
  try {
    assertCoordinationId("channel", value);
  } catch {
    throw new MessagingError("request_invalid");
  }
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("messaging clock returned an invalid date");
  }
  return new Date(value.getTime()).toISOString();
}

export function createUnreadService(options: CreateUnreadServiceOptions) {
  const { repository, participantDirectory } = options;
  const now = options.now ?? (() => new Date());

  async function actor(context: MessagingActorContext) {
    return resolveMessagingActor(
      context,
      participantDirectory,
      "product:read",
    );
  }

  async function getUnread(input: {
    context: MessagingActorContext;
    channelId: string;
  }) {
    assertChannelId(input.channelId);
    const resolved = await actor(input.context);
    return repository.getUnread(input.channelId, resolved);
  }

  async function markRead(input: {
    context: MessagingActorContext;
    channelId: string;
    readThroughSequence: number;
    idempotencyKey: string;
  }) {
    assertChannelId(input.channelId);
    if (
      !Number.isSafeInteger(input.readThroughSequence) ||
      input.readThroughSequence < 0
    ) {
      throw new MessagingError("request_invalid");
    }
    const resolved = await actor(input.context);
    return repository.advanceReadCursor({
      actor: resolved,
      channelId: input.channelId,
      readThroughSequence: input.readThroughSequence,
      updatedAt: canonicalNow(now),
      idempotency: createMessagingIdempotencyClaim(
        "read_cursor.update",
        resolved.principalId,
        input.idempotencyKey,
        {
          channelId: input.channelId,
          readThroughSequence: input.readThroughSequence,
        },
      ),
    });
  }

  async function listInbox(input: { context: MessagingActorContext }) {
    const resolved = await actor(input.context);
    return repository.listInbox(resolved);
  }

  return Object.freeze({ getUnread, markRead, listInbox });
}
