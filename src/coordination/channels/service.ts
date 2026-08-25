import { generateCoordinationId, assertCoordinationId } from "../ids/index.js";
import type { JsonValue } from "../policy/index.js";
import { resolveMessagingActor, resolveVisibleBots } from "./access.js";
import { ChannelCursorCodec } from "./cursor.js";
import { MessagingError } from "./errors.js";
import { createMessagingIdempotencyClaim } from "./idempotency.js";
import type {
  ChannelMember,
  ChannelProjection,
  ChannelRecord,
  ChannelRepository,
  GeneratedChannelIdKind,
  MessagingActorContext,
  MessagingParticipantDirectory,
  ResponderPolicy,
} from "./types.js";

const MAX_CHANNEL_TITLE_LENGTH = 120;
const MAX_CHANNEL_PURPOSE_LENGTH = 4_000;

export interface CreateChannelServiceOptions {
  repository: ChannelRepository;
  participantDirectory: MessagingParticipantDirectory;
  /** M12 supplies installation-scoped key material; at least 256 bits are required. */
  cursorSigningKey: Uint8Array;
  now?: () => Date;
  idGenerator?: (kind: GeneratedChannelIdKind) => string;
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("messaging clock returned an invalid date");
  }
  return new Date(value.getTime()).toISOString();
}

function canonicalText(
  value: string,
  maximumLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string") throw new MessagingError("request_invalid");
  const text = value.trim();
  if (
    (!allowEmpty && !text) ||
    text.length > maximumLength ||
    text.includes("\0")
  ) {
    throw new MessagingError("request_invalid");
  }
  return text;
}

function projectChannel(channel: ChannelRecord): ChannelProjection {
  const { nextMessageSequence: _nextMessageSequence, ...projection } = channel;
  return Object.freeze({
    ...projection,
    members: Object.freeze(channel.members.map((member) => Object.freeze({ ...member }))),
    responderPolicy: Object.freeze({ ...channel.responderPolicy }),
  });
}

function canonicalMemberBotIds(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > 63) {
    throw new MessagingError("invalid_membership");
  }
  for (const value of values) {
    try {
      assertCoordinationId("bot", value);
    } catch {
      throw new MessagingError("request_invalid");
    }
  }
  if (new Set(values).size !== values.length) {
    throw new MessagingError("invalid_membership");
  }
  return Object.freeze([...values].sort());
}

function membersFor(
  memberBotIds: readonly string[],
  visibleBots: ReadonlyMap<string, {
    id: string;
    principalId: string;
    name: string;
    residentBinding: string;
    version: number;
  }>,
): readonly ChannelMember[] {
  const members: ChannelMember[] = [{
    principalId: "user_owner",
    kind: "owner",
    role: "owner",
  }];
  for (const botId of memberBotIds) {
    const bot = visibleBots.get(botId);
    if (!bot || bot.id !== botId || bot.principalId !== botId) {
      throw new MessagingError("unknown_principal", { principalId: botId });
    }
    members.push({ principalId: bot.principalId, kind: "bot", role: "member" });
  }
  return Object.freeze(members.map((member) => Object.freeze(member)));
}

function validateResponderPolicy(
  policy: ResponderPolicy,
  memberBotIds: ReadonlySet<string>,
): ResponderPolicy {
  if (
    !policy ||
    (policy.mode !== "mentions_only" && policy.mode !== "mention_or_coordinator") ||
    (policy.responseOrder !== "parallel" && policy.responseOrder !== "sequential") ||
    !Number.isSafeInteger(policy.maxBotTurns) ||
    policy.maxBotTurns < 1 ||
    policy.maxBotTurns > 8
  ) {
    throw new MessagingError("request_invalid");
  }
  if (policy.mode === "mentions_only" && policy.coordinatorBotId !== null) {
    throw new MessagingError("invalid_membership");
  }
  if (
    policy.mode === "mention_or_coordinator" &&
    (policy.coordinatorBotId === null || !memberBotIds.has(policy.coordinatorBotId))
  ) {
    throw new MessagingError("invalid_membership");
  }
  return Object.freeze({ ...policy });
}

export function createChannelService(options: CreateChannelServiceOptions) {
  const { repository, participantDirectory } = options;
  const cursorCodec = new ChannelCursorCodec(options.cursorSigningKey);
  const now = options.now ?? (() => new Date());
  const idGenerator = options.idGenerator ?? ((kind: GeneratedChannelIdKind) =>
    generateCoordinationId(kind));

  function makeId(kind: GeneratedChannelIdKind): string {
    const value = idGenerator(kind);
    try {
      assertCoordinationId(kind, value);
    } catch {
      throw new MessagingError("request_invalid");
    }
    return value;
  }

  async function resolveActor(
    context: MessagingActorContext,
    scope: "product:read" | "message:send",
  ) {
    return resolveMessagingActor(
      context,
      participantDirectory,
      scope,
    );
  }

  async function ownerActor(context: MessagingActorContext) {
    const actor = await resolveActor(context, "message:send");
    if (actor.kind !== "owner" || actor.principalId !== "user_owner") {
      throw new MessagingError("identity_context_mismatch");
    }
    return actor;
  }

  async function createDirectConversation(input: {
    context: MessagingActorContext;
    memberBotIds: readonly string[];
    title?: string;
    purpose?: string;
    responderPolicy?: ResponderPolicy;
    pinned: boolean;
    idempotencyKey: string;
  }) {
    const actor = await ownerActor(input.context);
    const memberBotIds = canonicalMemberBotIds(input.memberBotIds);
    if (memberBotIds.length !== 1) throw new MessagingError("invalid_membership");
    if (typeof input.pinned !== "boolean") throw new MessagingError("request_invalid");
    const title = input.title === undefined
      ? null
      : canonicalText(input.title, MAX_CHANNEL_TITLE_LENGTH);
    const purpose = input.purpose === undefined
      ? null
      : canonicalText(input.purpose, MAX_CHANNEL_PURPOSE_LENGTH, true);
    const responderPolicy = input.responderPolicy === undefined
      ? null
      : validateResponderPolicy(input.responderPolicy, new Set(memberBotIds));
    const idempotency = createMessagingIdempotencyClaim(
      "channel.create",
      actor.principalId,
      input.idempotencyKey,
      {
        kind: "direct",
        memberBotIds: [...memberBotIds],
        title,
        purpose,
        responderPolicy: responderPolicy
          ? {
              mode: responderPolicy.mode,
              coordinatorBotId: responderPolicy.coordinatorBotId,
              responseOrder: responderPolicy.responseOrder,
              maxBotTurns: responderPolicy.maxBotTurns,
            }
          : null,
        pinned: input.pinned,
      },
    );
    const replay = await repository.replayChannelMutation({ actor, idempotency });
    if (replay) {
      return Object.freeze({
        outcome: "replayed" as const,
        channel: projectChannel(replay.channel),
        receipt: Object.freeze({ ...replay.receipt }),
      });
    }
    const visibleBots = await resolveVisibleBots(participantDirectory);
    const members = membersFor(memberBotIds, visibleBots);
    const bot = visibleBots.get(memberBotIds[0]!)!;
    const at = canonicalNow(now);
    const channel: ChannelRecord = {
      id: makeId("channel"),
      conversationId: makeId("conversation"),
      kind: "direct",
      title: title ?? bot.name.slice(0, MAX_CHANNEL_TITLE_LENGTH),
      purpose: purpose ?? `Direct durable conversation with ${bot.name}.`.slice(
        0,
        MAX_CHANNEL_PURPOSE_LENGTH,
      ),
      ownerPrincipalId: "user_owner",
      members,
      responderPolicy: responderPolicy ?? Object.freeze({
        mode: "mention_or_coordinator",
        coordinatorBotId: bot.id,
        responseOrder: "sequential",
        maxBotTurns: 1,
      }),
      lifecycle: "active",
      pinned: input.pinned,
      version: 1,
      nextMessageSequence: 1,
      createdAt: at,
      updatedAt: at,
    };
    const result = await repository.createDirectChannel({
      channel,
      actor,
      idempotency,
      expectedBot: {
        id: bot.id,
        principalId: bot.principalId,
        residentBinding: bot.residentBinding,
        version: bot.version,
      },
    });
    if (result.outcome === "identity_collision") {
      throw new MessagingError("channel_id_conflict");
    }
    return Object.freeze({
      outcome: result.outcome,
      channel: projectChannel(result.channel),
      receipt: Object.freeze({ ...result.receipt }),
    });
  }

  async function createGroupChannel(input: {
    context: MessagingActorContext;
    memberBotIds: readonly string[];
    title: string;
    purpose: string;
    pinned: boolean;
    responderPolicy: ResponderPolicy;
    idempotencyKey: string;
  }) {
    const actor = await ownerActor(input.context);
    const memberBotIds = canonicalMemberBotIds(input.memberBotIds);
    if (memberBotIds.length < 2) throw new MessagingError("invalid_membership");
    const responderPolicy = validateResponderPolicy(
      input.responderPolicy,
      new Set(memberBotIds),
    );
    if (typeof input.pinned !== "boolean") throw new MessagingError("request_invalid");
    const title = canonicalText(input.title, MAX_CHANNEL_TITLE_LENGTH);
    const purpose = canonicalText(input.purpose, MAX_CHANNEL_PURPOSE_LENGTH, true);
    const request: JsonValue = {
      kind: "group",
      title,
      purpose,
      memberBotIds: [...memberBotIds],
      responderPolicy: {
        mode: responderPolicy.mode,
        coordinatorBotId: responderPolicy.coordinatorBotId,
        responseOrder: responderPolicy.responseOrder,
        maxBotTurns: responderPolicy.maxBotTurns,
      },
      pinned: input.pinned,
    };
    const idempotency = createMessagingIdempotencyClaim(
      "channel.create",
      actor.principalId,
      input.idempotencyKey,
      request,
    );
    const replay = await repository.replayChannelMutation({ actor, idempotency });
    if (replay) {
      return Object.freeze({
        outcome: "replayed" as const,
        channel: projectChannel(replay.channel),
        receipt: Object.freeze({ ...replay.receipt }),
      });
    }
    const visibleBots = await resolveVisibleBots(participantDirectory);
    const members = membersFor(memberBotIds, visibleBots);
    const at = canonicalNow(now);
    const channel: ChannelRecord = {
      id: makeId("channel"),
      conversationId: makeId("conversation"),
      kind: "group",
      title,
      purpose,
      ownerPrincipalId: "user_owner",
      members,
      responderPolicy,
      lifecycle: "active",
      pinned: input.pinned,
      version: 1,
      nextMessageSequence: 1,
      createdAt: at,
      updatedAt: at,
    };
    const result = await repository.createGroupChannel({ channel, actor, idempotency });
    if (result.outcome === "identity_collision") {
      throw new MessagingError("channel_id_conflict");
    }
    return Object.freeze({
      outcome: result.outcome,
      channel: projectChannel(result.channel),
      receipt: Object.freeze({ ...result.receipt }),
    });
  }

  async function getChannel(input: {
    context: MessagingActorContext;
    channelId: string;
  }): Promise<ChannelProjection> {
    try {
      assertCoordinationId("channel", input.channelId);
    } catch {
      throw new MessagingError("request_invalid");
    }
    const actor = await resolveActor(input.context, "product:read");
    const channel = await repository.getChannelForActor(
      input.channelId,
      actor,
    );
    if (!channel) throw new MessagingError("unknown_channel");
    return projectChannel(channel);
  }

  async function listChannels(input: {
    context: MessagingActorContext;
    cursor: string | null;
    limit: number;
  }) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new MessagingError("request_invalid");
    }
    const actor = await resolveActor(input.context, "product:read");
    const result = await repository.listChannels({
      actor,
      cursor: cursorCodec.decode(input.cursor, actor.principalId),
      limit: input.limit,
    });
    return Object.freeze({
      channels: Object.freeze(result.channels.map(projectChannel)),
      nextCursor: result.nextCursor
        ? cursorCodec.encode(result.nextCursor, actor.principalId)
        : null,
    });
  }

  async function updateChannel(input: {
    context: MessagingActorContext;
    channelId: string;
    expectedVersion: number;
    idempotencyKey: string;
    title: string;
    purpose: string;
    memberBotIds: readonly string[];
    responderPolicy: ResponderPolicy;
    pinned: boolean;
    lifecycle: "active" | "archived";
  }) {
    try {
      assertCoordinationId("channel", input.channelId);
    } catch {
      throw new MessagingError("request_invalid");
    }
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new MessagingError("request_invalid");
    }
    if (
      typeof input.pinned !== "boolean" ||
      (input.lifecycle !== "active" && input.lifecycle !== "archived")
    ) {
      throw new MessagingError("request_invalid");
    }
    const actor = await ownerActor(input.context);
    const memberBotIds = canonicalMemberBotIds(input.memberBotIds);
    const responderPolicy = validateResponderPolicy(
      input.responderPolicy,
      new Set(memberBotIds),
    );
    const title = canonicalText(input.title, MAX_CHANNEL_TITLE_LENGTH);
    const purpose = canonicalText(input.purpose, MAX_CHANNEL_PURPOSE_LENGTH, true);
    const idempotency = createMessagingIdempotencyClaim(
      "channel.update",
      actor.principalId,
      input.idempotencyKey,
      {
        channelId: input.channelId,
        expectedVersion: input.expectedVersion,
        title,
        purpose,
        memberBotIds: [...memberBotIds],
        responderPolicy: {
          mode: responderPolicy.mode,
          coordinatorBotId: responderPolicy.coordinatorBotId,
          responseOrder: responderPolicy.responseOrder,
          maxBotTurns: responderPolicy.maxBotTurns,
        },
        pinned: input.pinned,
        lifecycle: input.lifecycle,
      },
    );
    const replay = await repository.replayChannelMutation({ actor, idempotency });
    if (replay) {
      return Object.freeze({
        outcome: "replayed" as const,
        channel: projectChannel(replay.channel),
        receipt: Object.freeze({ ...replay.receipt }),
      });
    }
    const current = await repository.getChannelForActor(input.channelId, actor);
    if (!current) throw new MessagingError("unknown_channel");
    const currentBotIds = current.members
      .filter((member) => member.kind === "bot")
      .map((member) => member.principalId)
      .sort();
    if (current.kind === "direct" && (
      memberBotIds.length !== 1 ||
      memberBotIds[0] !== currentBotIds[0]
    )) {
      throw new MessagingError("invalid_membership");
    }
    if (current.kind === "group" && memberBotIds.length < 2) {
      throw new MessagingError("invalid_membership");
    }
    const visibleBots = await resolveVisibleBots(participantDirectory);
    const members = membersFor(memberBotIds, visibleBots);
    const updatedAt = canonicalNow(now);
    const channel: ChannelRecord = Object.freeze({
      ...current,
      title,
      purpose,
      members,
      responderPolicy,
      pinned: input.pinned,
      lifecycle: input.lifecycle,
      version: input.expectedVersion + 1,
      updatedAt,
    });
    const result = await repository.updateChannel({
      channel,
      expectedVersion: input.expectedVersion,
      actor,
      idempotency,
    });
    if (result.outcome === "version_conflict") {
      throw new MessagingError("version_conflict");
    }
    if (result.outcome === "identity_collision") {
      throw new MessagingError("channel_id_conflict");
    }
    return Object.freeze({
      outcome: result.outcome,
      channel: projectChannel(result.channel),
      receipt: Object.freeze({ ...result.receipt }),
    });
  }

  return Object.freeze({
    createDirectConversation,
    createGroupChannel,
    getChannel,
    listChannels,
    updateChannel,
  });
}
