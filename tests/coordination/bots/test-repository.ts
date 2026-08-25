import type {
  BotAliasRecord,
  BotDirectoryRecord,
  BotDirectoryRepository,
  CommitResidentHeartbeatInput,
  CommitResidentHeartbeatResult,
  CommitResidentRegistrationInput,
  CommitResidentRegistrationResult,
  EnsurePersistentBindingInput,
  EnsurePersistentBindingResult,
} from "../../../src/coordination/bots/index.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class TestBotDirectoryRepository implements BotDirectoryRepository {
  readonly principals = new Set<string>();
  readonly bots = new Map<string, BotDirectoryRecord>();
  readonly aliases = new Map<string, BotAliasRecord>();
  readonly committedMutations: Array<{
    kind: "binding" | "registration" | "heartbeat";
    requestId: string;
    correlationId: string;
  }> = [];

  async ensurePersistentBinding(
    input: EnsurePersistentBindingInput,
  ): Promise<EnsurePersistentBindingResult> {
    const existing = [...this.bots.values()].find(
      (bot) => bot.residentBinding === input.bot.residentBinding,
    );
    const targetBotId = existing?.id ?? input.bot.id;

    for (const alias of input.aliases) {
      const collision = this.aliases.get(`${alias.namespace}\0${alias.aliasDigest}`);
      if (collision && collision.targetId !== targetBotId) {
        return {
          outcome: "alias_collision",
          namespace: alias.namespace,
          existingBotId: collision.targetId,
        };
      }
    }
    const aliasIdentityCollision = input.aliases.some((alias) =>
      [...this.aliases.values()].some((existingAlias) =>
        existingAlias.id === alias.id &&
        (
          existingAlias.namespace !== alias.namespace ||
          existingAlias.aliasDigest !== alias.aliasDigest
        )
      )
    );
    if (aliasIdentityCollision) return { outcome: "identity_collision" };

    if (existing) {
      const sameDefinition =
        existing.name === input.bot.name &&
        existing.purpose === input.bot.purpose &&
        JSON.stringify(existing.requiredCapabilities) ===
          JSON.stringify(input.bot.requiredCapabilities);
      if (!sameDefinition) {
        return { outcome: "binding_conflict", existingBotId: existing.id };
      }
      for (const alias of input.aliases) {
        const key = `${alias.namespace}\0${alias.aliasDigest}`;
        if (!this.aliases.has(key)) {
          this.aliases.set(key, copy({ ...alias, targetId: existing.id }));
        }
      }
      return { outcome: "existing", bot: copy(existing) };
    }

    if (
      this.bots.has(input.bot.id) ||
      this.principals.has(input.bot.principalId) ||
      input.aliases.some((alias) =>
        [...this.aliases.values()].some((existingAlias) => existingAlias.id === alias.id)
      )
    ) {
      return { outcome: "identity_collision" };
    }
    this.principals.add(input.ownerPrincipalId);
    this.principals.add(input.bot.principalId);
    this.bots.set(input.bot.id, copy(input.bot));
    for (const alias of input.aliases) {
      this.aliases.set(`${alias.namespace}\0${alias.aliasDigest}`, copy(alias));
    }
    this.committedMutations.push({
      kind: "binding",
      requestId: input.requestId,
      correlationId: input.correlationId,
    });
    return { outcome: "created", bot: copy(input.bot) };
  }

  async getBotByResidentBinding(
    residentBinding: string,
  ): Promise<BotDirectoryRecord | null> {
    const bot = [...this.bots.values()].find(
      (candidate) => candidate.residentBinding === residentBinding,
    );
    return bot ? copy(bot) : null;
  }

  async getBotById(botId: string): Promise<BotDirectoryRecord | null> {
    const bot = this.bots.get(botId);
    return bot ? copy(bot) : null;
  }

  async listPersistentBots(): Promise<readonly BotDirectoryRecord[]> {
    return [...this.bots.values()].map(copy);
  }

  async resolveActiveAlias(
    namespace: string,
    aliasDigest: string,
  ): Promise<BotAliasRecord | null> {
    const alias = this.aliases.get(`${namespace}\0${aliasDigest}`);
    return alias?.active ? copy(alias) : null;
  }

  async commitResidentRegistration(
    input: CommitResidentRegistrationInput,
  ): Promise<CommitResidentRegistrationResult> {
    const current = this.bots.get(input.botId);
    if (!current) return { outcome: "not_found" };
    if (current.lifecycle !== "active") return { outcome: "inactive" };
    if (
      current.residentBinding !== input.residentBinding ||
      current.version !== input.expectedVersion
    ) {
      return { outcome: "conflict" };
    }
    if (
      current.activeInstanceId !== null &&
      current.activeInstanceId !== input.instanceId &&
      current.activeKeyVersion !== null &&
      (
        input.keyVersion < current.activeKeyVersion ||
        (
          input.keyVersion === current.activeKeyVersion &&
          !input.allowSameKeyReplacement
        )
      )
    ) {
      return { outcome: "superseded_instance" };
    }
    const bot: BotDirectoryRecord = {
      ...current,
      activeInstanceId: input.instanceId,
      activeKeyVersion: input.keyVersion,
      residentProtocolVersion: input.protocolVersion,
      residentCapabilities: [...input.capabilities],
      residentRegisteredAt: input.registeredAt,
      lastHeartbeatAt: input.registeredAt,
      reportedAvailability: input.reportedAvailability,
      version: current.version + 1,
      updatedAt: input.registeredAt,
    };
    this.bots.set(bot.id, copy(bot));
    this.committedMutations.push({
      kind: "registration",
      requestId: input.requestId,
      correlationId: input.correlationId,
    });
    return { outcome: "registered", bot: copy(bot) };
  }

  async commitResidentHeartbeat(
    input: CommitResidentHeartbeatInput,
  ): Promise<CommitResidentHeartbeatResult> {
    const current = this.bots.get(input.botId);
    if (!current) return { outcome: "not_found" };
    if (current.lifecycle !== "active") return { outcome: "inactive" };
    if (
      current.activeInstanceId !== input.instanceId ||
      current.activeKeyVersion !== input.keyVersion
    ) {
      return { outcome: "stale_instance" };
    }
    if (current.version !== input.expectedVersion) return { outcome: "conflict" };
    const bot: BotDirectoryRecord = {
      ...current,
      lastHeartbeatAt: input.heartbeatAt,
      reportedAvailability: input.reportedAvailability,
      version: current.version + 1,
      updatedAt: input.heartbeatAt,
    };
    this.bots.set(bot.id, copy(bot));
    this.committedMutations.push({
      kind: "heartbeat",
      requestId: input.requestId,
      correlationId: input.correlationId,
    });
    return { outcome: "recorded", bot: copy(bot) };
  }
}
