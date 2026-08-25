import type { ResidentUdsRequestContext } from "../transport/uds/index.js";

export type BotLifecycle = "provisioning" | "active" | "archived" | "failed";
export type BotAvailability =
  | "offline"
  | "starting"
  | "available"
  | "busy"
  | "degraded";
export type ResidentReportedAvailability = Exclude<BotAvailability, "offline">;

export type GeneratedBotDirectoryIdKind = "bot" | "alias";

export interface BotAliasDefinition {
  namespace: string;
  value: string;
}

export interface ApprovedBotBinding {
  residentBinding: string;
  name: string;
  purpose: string;
  continuingIdentity: boolean;
  durableMailbox: boolean;
  requiredCapabilities: readonly string[];
  aliases: readonly BotAliasDefinition[];
}

export interface BotDirectoryRecord {
  id: string;
  principalId: string;
  name: string;
  purpose: string;
  lifecycle: BotLifecycle;
  conversationId: string | null;
  residentBinding: string;
  continuingIdentity: boolean;
  durableMailbox: boolean;
  requiredCapabilities: readonly string[];
  activeInstanceId: string | null;
  activeKeyVersion: number | null;
  residentProtocolVersion: number | null;
  residentCapabilities: readonly string[];
  residentRegisteredAt: string | null;
  lastHeartbeatAt: string | null;
  reportedAvailability: ResidentReportedAvailability | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface BotAliasRecord {
  id: string;
  namespace: string;
  aliasDigest: string;
  targetType: "bot";
  targetId: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BotProjection {
  id: string;
  principalId: string;
  name: string;
  purpose: string;
  lifecycle: BotLifecycle;
  availability: BotAvailability;
  conversationId: string | null;
  residentBinding: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface EnsurePersistentBindingInput {
  ownerPrincipalId: "user_owner";
  actorPrincipalId: "user_owner";
  requestId: string;
  correlationId: string;
  bot: BotDirectoryRecord;
  aliases: readonly BotAliasRecord[];
}

export type EnsurePersistentBindingResult =
  | { outcome: "created" | "existing"; bot: BotDirectoryRecord }
  | { outcome: "binding_conflict"; existingBotId: string }
  | {
      outcome: "alias_collision";
      namespace: string;
      existingBotId: string;
    }
  | { outcome: "identity_collision" };

export interface CommitResidentRegistrationInput {
  botId: string;
  expectedVersion: number;
  residentBinding: string;
  instanceId: string;
  keyVersion: number;
  allowSameKeyReplacement: boolean;
  protocolVersion: number;
  capabilities: readonly string[];
  reportedAvailability: ResidentReportedAvailability;
  registeredAt: string;
  actorPrincipalId: string;
  requestId: string;
  correlationId: string;
}

export type CommitResidentRegistrationResult =
  | { outcome: "registered"; bot: BotDirectoryRecord }
  | {
      outcome:
        | "not_found"
        | "inactive"
        | "conflict"
        | "superseded_instance";
    };

export interface CommitResidentHeartbeatInput {
  botId: string;
  expectedVersion: number;
  instanceId: string;
  keyVersion: number;
  reportedAvailability: ResidentReportedAvailability;
  heartbeatAt: string;
  actorPrincipalId: string;
  requestId: string;
  correlationId: string;
}

export type CommitResidentHeartbeatResult =
  | { outcome: "recorded"; bot: BotDirectoryRecord }
  | {
      outcome:
        | "not_found"
        | "inactive"
        | "stale_instance"
        | "conflict";
    };

export interface BotDirectoryRepository {
  ensurePersistentBinding(
    input: EnsurePersistentBindingInput,
  ): Promise<EnsurePersistentBindingResult>;
  getBotByResidentBinding(
    residentBinding: string,
  ): Promise<BotDirectoryRecord | null>;
  getBotById(botId: string): Promise<BotDirectoryRecord | null>;
  listPersistentBots(): Promise<readonly BotDirectoryRecord[]>;
  resolveActiveAlias(
    namespace: string,
    aliasDigest: string,
  ): Promise<BotAliasRecord | null>;
  commitResidentRegistration(
    input: CommitResidentRegistrationInput,
  ): Promise<CommitResidentRegistrationResult>;
  commitResidentHeartbeat(
    input: CommitResidentHeartbeatInput,
  ): Promise<CommitResidentHeartbeatResult>;
}

/** Passed directly from M05 only after UDS request authentication succeeds. */
export type AuthenticatedResidentContext = Pick<
  ResidentUdsRequestContext,
  "credential" | "requestId" | "correlationId"
>;

export interface OwnerBotDirectoryMutationContext {
  principalId: "user_owner";
  requestId: string;
  correlationId: string;
}

export interface RegisterResidentInput {
  context: AuthenticatedResidentContext;
  botBinding: string;
  protocolVersion: number;
  capabilities: readonly string[];
}

export interface ResidentHeartbeatInput {
  context: AuthenticatedResidentContext;
  availability: ResidentReportedAvailability;
}

export interface ResidentAvailabilityReceipt {
  botId: string;
  principalId: string;
  availability: BotAvailability;
  version: number;
}

export interface BotAvailabilityPolicy {
  degradedAfterMs: number;
  offlineAfterMs: number;
}
