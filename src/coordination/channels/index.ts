export {
  MESSAGING_FAILURE_MATRIX,
  MessagingError,
  type MessagingErrorCode,
} from "./errors.js";
export {
  createChannelService,
  type CreateChannelServiceOptions,
} from "./service.js";
export { SqliteMessagingRepository } from "./repository.js";
export type { SqliteMessagingRepositoryOptions } from "./repository.js";
export { SqliteBotConversationBindingAdapter } from "./bot-conversation-binding.js";
export { resolveMessagingActor, resolveVisibleBots } from "./access.js";
export { createMessagingIdempotencyClaim } from "./idempotency.js";
export {
  MESSAGING_SCHEMA_DELTA_CANONICAL_JSON,
  MESSAGING_SCHEMA_DELTA_PROPOSAL,
  MESSAGING_SCHEMA_DELTA_SHA256,
  MESSAGING_SCHEMA_DELTA_SQL,
  computeMessagingSchemaDeltaDigest,
} from "./schema-delta.js";
export type {
  BotConversationBindingResult,
  BotConversationBindingTransactionPort,
  ChannelKind,
  ChannelLifecycle,
  ChannelListCursor,
  ChannelMember,
  ChannelProjection,
  ChannelRecord,
  ChannelRepository,
  CreateChannelCommit,
  CreateDirectChannelCommit,
  CreateDirectChannelResult,
  CreateGroupChannelResult,
  GeneratedChannelIdKind,
  MemberKind,
  MemberRole,
  MessagingActorContext,
  MessagingIdempotencyClaim,
  MessagingMutationReceipt,
  MessagingParticipantDirectory,
  MessagingResidentAuthority,
  OnDemandBotMessagingIdentity,
  OwnerMessagingIdentity,
  RequiredMessagingScope,
  ResolvedMessagingActor,
  ResidentMessagingIdentity,
  ResponderPolicy,
  UpdateChannelCommit,
  UpdateChannelResult,
} from "./types.js";
