export {
  BotDirectoryError,
  type BotDirectoryErrorCode,
} from "./errors.js";
export {
  createBotDirectory,
  digestBotAlias,
  type CreateBotDirectoryOptions,
} from "./service.js";
export { SqliteBotDirectoryRepository } from "./sqlite-repository.js";
export {
  BOT_DIRECTORY_SCHEMA_DELTA_CANONICAL_JSON,
  BOT_DIRECTORY_SCHEMA_DELTA_PROPOSAL,
  BOT_DIRECTORY_SCHEMA_DELTA_SHA256,
  computeBotDirectorySchemaDeltaDigest,
} from "./schema-delta.js";
export type {
  ApprovedBotBinding,
  AuthenticatedResidentContext,
  BotAliasDefinition,
  BotAliasRecord,
  BotAvailability,
  BotAvailabilityPolicy,
  BotDirectoryRecord,
  BotDirectoryRepository,
  BotLifecycle,
  BotProjection,
  CommitResidentHeartbeatInput,
  CommitResidentHeartbeatResult,
  CommitResidentRegistrationInput,
  CommitResidentRegistrationResult,
  EnsurePersistentBindingInput,
  EnsurePersistentBindingResult,
  GeneratedBotDirectoryIdKind,
  OwnerBotDirectoryMutationContext,
  RegisterResidentInput,
  ResidentAvailabilityReceipt,
  ResidentHeartbeatInput,
  ResidentReportedAvailability,
} from "./types.js";
