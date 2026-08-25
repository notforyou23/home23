import type { AuthPrincipalContext, HouseAuthScope } from "../auth/index.js";
import type {
  AuthenticatedResidentContext,
  BotDirectoryRecord,
  BotProjection,
} from "../bots/index.js";
import type { CoordinationTransaction } from "../db/index.js";

export type ChannelKind = "direct" | "group";
export type ChannelLifecycle = "active" | "archived";
export type MemberKind = "owner" | "bot";
export type MemberRole = "owner" | "member";

export interface ChannelMember {
  principalId: string;
  kind: MemberKind;
  role: MemberRole;
}

export interface ResponderPolicy {
  mode: "mentions_only" | "mention_or_coordinator";
  coordinatorBotId: string | null;
  responseOrder: "parallel" | "sequential";
  maxBotTurns: number;
}

export interface ChannelRecord {
  id: string;
  conversationId: string;
  kind: ChannelKind;
  title: string;
  purpose: string;
  ownerPrincipalId: "user_owner";
  members: readonly ChannelMember[];
  responderPolicy: ResponderPolicy;
  lifecycle: ChannelLifecycle;
  pinned: boolean;
  version: number;
  nextMessageSequence: number;
  createdAt: string;
  updatedAt: string;
}

export type ChannelProjection = Omit<ChannelRecord, "nextMessageSequence">;

export interface OwnerMessagingIdentity {
  kind: "owner";
  auth: AuthPrincipalContext;
}

export interface ResidentMessagingIdentity {
  kind: "resident";
  resident: AuthenticatedResidentContext;
}

export interface MessagingActorContext {
  principalId: string;
  requestId: string;
  correlationId: string;
  identity: OwnerMessagingIdentity | ResidentMessagingIdentity;
}

export interface MessagingParticipantDirectory extends MessagingResidentAuthority {
  listVisibleBots(): Promise<readonly BotProjection[]>;
  resolveAlias(namespace: string, value: string): Promise<BotProjection | null>;
}

/** Exact M07 record authority used to prove the current authenticated resident binding. */
export interface MessagingResidentAuthority {
  getBotByResidentBinding(residentBinding: string): Promise<BotDirectoryRecord | null>;
}

export interface ResolvedMessagingActor {
  principalId: string;
  kind: MemberKind;
  displayName: string;
  requestId: string;
  correlationId: string;
  residentCredential: {
    residentBinding: string;
    instanceId: string;
    keyVersion: number;
  } | null;
}

export interface MessagingIdempotencyClaim {
  operation:
    | "channel.create"
    | "channel.update"
    | "message.append"
    | "read_cursor.update";
  keyDigest: string;
  requestDigest: string;
}

export interface MessagingMutationReceipt {
  resourceVersion: number;
  eventSequence: number;
  requestId: string;
  correlationId: string;
}

export interface BotConversationBindingResult {
  botId: string;
  botVersion: number;
}

/**
 * M07/M04 integration seam. M08 deliberately supplies no implementation: the accepted
 * Bot authority must update its row through this M04 transaction. The enclosing M08
 * mutation emits the locked composite channel.created event containing botId/botVersion.
 */
export interface BotConversationBindingTransactionPort {
  bindDirectConversation(
    transaction: CoordinationTransaction,
    input: {
      botId: string;
      botPrincipalId: string;
      conversationId: string;
      updatedAt: string;
    },
  ): BotConversationBindingResult;
}

export interface CreateChannelCommit {
  channel: ChannelRecord;
  actor: ResolvedMessagingActor;
  idempotency: MessagingIdempotencyClaim;
}

export type CreateDirectChannelResult =
  | {
      outcome: "created" | "existing" | "replayed";
      channel: ChannelRecord;
      receipt: MessagingMutationReceipt;
    }
  | { outcome: "identity_collision" };

export type CreateGroupChannelResult =
  | {
      outcome: "created" | "replayed";
      channel: ChannelRecord;
      receipt: MessagingMutationReceipt;
    }
  | { outcome: "identity_collision" };

export interface ChannelListCursor {
  updatedAt: string;
  channelId: string;
}

export interface ListChannelsResult {
  channels: readonly ChannelRecord[];
  nextCursor: ChannelListCursor | null;
}

export interface UpdateChannelCommit {
  channel: ChannelRecord;
  expectedVersion: number;
  actor: ResolvedMessagingActor;
  idempotency: MessagingIdempotencyClaim;
}

export type UpdateChannelResult =
  | {
      outcome: "committed" | "replayed";
      channel: ChannelRecord;
      receipt: MessagingMutationReceipt;
    }
  | { outcome: "version_conflict" }
  | { outcome: "identity_collision" };

export interface ChannelRepository {
  replayChannelMutation(input: {
    actor: ResolvedMessagingActor;
    idempotency: MessagingIdempotencyClaim;
  }): Promise<{
    channel: ChannelRecord;
    receipt: MessagingMutationReceipt;
  } | null>;
  createDirectChannel(input: CreateChannelCommit): Promise<CreateDirectChannelResult>;
  createGroupChannel(input: CreateChannelCommit): Promise<CreateGroupChannelResult>;
  getChannelForActor(
    channelId: string,
    actor: ResolvedMessagingActor,
  ): Promise<ChannelRecord | null>;
  listChannels(input: {
    actor: ResolvedMessagingActor;
    cursor: ChannelListCursor | null;
    limit: number;
  }): Promise<ListChannelsResult>;
  updateChannel(input: UpdateChannelCommit): Promise<UpdateChannelResult>;
}

export type RequiredMessagingScope = Extract<
  HouseAuthScope,
  "product:read" | "message:send"
>;

export type GeneratedChannelIdKind = "channel" | "conversation";
