import { createHash } from "node:crypto";

import {
  assertCoordinationId,
  generateCoordinationId,
} from "../ids/index.js";
import { RESIDENT_PROTOCOL_VERSION } from "../resident-protocol/index.js";
import {
  STATE_MACHINE_REGISTRY,
  isLegalTransition,
} from "../schema/contract-registry.js";
import { BotDirectoryError } from "./errors.js";
import type {
  ApprovedBotBinding,
  AuthenticatedResidentContext,
  BotAliasDefinition,
  BotAliasRecord,
  BotAvailability,
  BotAvailabilityPolicy,
  BotDirectoryRecord,
  BotDirectoryRepository,
  BotProjection,
  GeneratedBotDirectoryIdKind,
  OwnerBotDirectoryMutationContext,
  RegisterResidentInput,
  ResidentAvailabilityReceipt,
  ResidentHeartbeatInput,
  ResidentReportedAvailability,
} from "./types.js";

const RESIDENT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9._:-]{0,63}$/;
const ALIAS_NAMESPACE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_ALIAS_VALUE_LENGTH = 256;
const MAX_COMMIT_RETRIES = 3;

const m02BotAvailabilityMachine = STATE_MACHINE_REGISTRY.botAvailability;
if (!m02BotAvailabilityMachine) {
  throw new Error("M02 Bot availability contract is missing");
}
const M02_BOT_AVAILABILITY = Object.freeze(
  new Set(m02BotAvailabilityMachine.states),
);

if (
  M02_BOT_AVAILABILITY.size !== 5 ||
  !["offline", "starting", "available", "busy", "degraded"].every((state) =>
    M02_BOT_AVAILABILITY.has(state)
  )
) {
  throw new Error("M02 Bot availability contract drift");
}

export interface CreateBotDirectoryOptions {
  repository: BotDirectoryRepository;
  availabilityPolicy: BotAvailabilityPolicy;
  now?: () => Date;
  idGenerator?: (kind: GeneratedBotDirectoryIdKind) => string;
}

function canonicalNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Bot directory clock returned an invalid date");
  }
  return new Date(value.getTime());
}

function canonicalText(value: string, maximumLength: number): string {
  if (typeof value !== "string") throw new BotDirectoryError("request_invalid");
  const text = value.trim();
  if (!text || text.length > maximumLength || text.includes("\0")) {
    throw new BotDirectoryError("request_invalid");
  }
  return text;
}

function canonicalResidentBinding(value: string): string {
  const binding = canonicalText(value, 63);
  if (!RESIDENT_SLUG_PATTERN.test(binding)) {
    throw new BotDirectoryError("request_invalid");
  }
  return binding;
}

function canonicalInstanceId(value: string): string {
  const instanceId = canonicalText(value, 128);
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new BotDirectoryError("unauthorized_registration");
  }
  return instanceId;
}

function canonicalCapabilities(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > 64) {
    throw new BotDirectoryError("request_invalid");
  }
  const capabilities = values.map((value) => canonicalText(value, 64));
  if (capabilities.some((value) => !CAPABILITY_PATTERN.test(value))) {
    throw new BotDirectoryError("request_invalid");
  }
  return Object.freeze([...new Set(capabilities)].sort());
}

function canonicalAlias(definition: BotAliasDefinition): {
  namespace: string;
  value: string;
} {
  if (!definition || typeof definition !== "object") {
    throw new BotDirectoryError("request_invalid");
  }
  const namespace = canonicalText(definition.namespace, 64).toLowerCase();
  if (!ALIAS_NAMESPACE_PATTERN.test(namespace)) {
    throw new BotDirectoryError("request_invalid");
  }
  const rawValue = canonicalText(definition.value, MAX_ALIAS_VALUE_LENGTH);
  const value = rawValue.normalize("NFC");
  return { namespace, value };
}

export function digestBotAlias(namespace: string, value: string): string {
  const alias = canonicalAlias({ namespace, value });
  return createHash("sha256")
    .update("home23-bot-alias:v1\0", "utf8")
    .update(alias.namespace, "utf8")
    .update("\0", "utf8")
    .update(alias.value, "utf8")
    .digest("hex");
}

function assertAvailabilityPolicy(policy: BotAvailabilityPolicy): void {
  if (
    !Number.isSafeInteger(policy.degradedAfterMs) ||
    !Number.isSafeInteger(policy.offlineAfterMs) ||
    policy.degradedAfterMs <= 0 ||
    policy.offlineAfterMs <= policy.degradedAfterMs
  ) {
    throw new TypeError(
      "Bot availability policy requires positive degradedAfterMs below offlineAfterMs",
    );
  }
}

function isResidentReportedAvailability(
  value: unknown,
): value is ResidentReportedAvailability {
  return (
    typeof value === "string" &&
    value !== "offline" &&
    M02_BOT_AVAILABILITY.has(value)
  );
}

function isCapabilityComplete(record: BotDirectoryRecord): boolean {
  const capabilities = new Set(record.residentCapabilities);
  return record.requiredCapabilities.every((capability) => capabilities.has(capability));
}

function availabilityAt(
  record: BotDirectoryRecord,
  at: Date,
  policy: BotAvailabilityPolicy,
): BotAvailability {
  if (
    record.lifecycle !== "active" ||
    !record.lastHeartbeatAt ||
    !record.reportedAvailability
  ) {
    return "offline";
  }
  const heartbeatAt = Date.parse(record.lastHeartbeatAt);
  if (!Number.isFinite(heartbeatAt)) return "degraded";
  const ageMs = at.getTime() - heartbeatAt;
  if (ageMs >= policy.offlineAfterMs) return "offline";
  if (
    ageMs < 0 ||
    ageMs >= policy.degradedAfterMs ||
    !isCapabilityComplete(record)
  ) {
    return "degraded";
  }
  return record.reportedAvailability;
}

function isVisible(record: BotDirectoryRecord): boolean {
  return (
    record.lifecycle === "active" &&
    record.continuingIdentity === true &&
    record.durableMailbox === true
  );
}

function isLifecycleReadable(record: BotDirectoryRecord): boolean {
  return (
    (record.lifecycle === "active" || record.lifecycle === "archived") &&
    record.continuingIdentity === true &&
    record.durableMailbox === true
  );
}

function projectBot(
  record: BotDirectoryRecord,
  at: Date,
  policy: BotAvailabilityPolicy,
): BotProjection {
  return Object.freeze({
    id: record.id,
    principalId: record.principalId,
    name: record.name,
    purpose: record.purpose,
    lifecycle: record.lifecycle,
    availability: availabilityAt(record, at, policy),
    conversationId: record.conversationId,
    residentBinding: record.residentBinding,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function assertMutationIds(context: {
  requestId: string;
  correlationId: string;
}): { requestId: string; correlationId: string } {
  try {
    assertCoordinationId("request", context.requestId);
    assertCoordinationId("correlation", context.correlationId);
  } catch {
    throw new BotDirectoryError("request_invalid");
  }
  return {
    requestId: context.requestId,
    correlationId: context.correlationId,
  };
}

function assertAuthenticatedContext(
  context: AuthenticatedResidentContext,
  botBinding?: string,
): {
  residentBinding: string;
  instanceId: string;
  keyVersion: number;
  requestId: string;
  correlationId: string;
} {
  const peer = context?.credential;
  if (!peer || peer.role !== "resident") {
    throw new BotDirectoryError("unauthorized_registration");
  }
  let residentBinding: string;
  try {
    residentBinding = canonicalResidentBinding(peer.residentSlug);
  } catch {
    throw new BotDirectoryError("unauthorized_registration");
  }
  const instanceId = canonicalInstanceId(peer.instanceId);
  if (!Number.isSafeInteger(peer.keyVersion) || peer.keyVersion < 1) {
    throw new BotDirectoryError("unauthorized_registration");
  }
  if (botBinding !== undefined) {
    let requestedBinding: string;
    try {
      requestedBinding = canonicalResidentBinding(botBinding);
    } catch {
      throw new BotDirectoryError("unauthorized_registration");
    }
    if (requestedBinding !== residentBinding) {
      throw new BotDirectoryError("unauthorized_registration");
    }
  }
  return {
    residentBinding,
    instanceId,
    keyVersion: peer.keyVersion,
    ...assertMutationIds(context),
  };
}

function receipt(
  record: BotDirectoryRecord,
  at: Date,
  policy: BotAvailabilityPolicy,
): ResidentAvailabilityReceipt {
  return Object.freeze({
    botId: record.id,
    principalId: record.principalId,
    availability: availabilityAt(record, at, policy),
    version: record.version,
  });
}

export function createBotDirectory(options: CreateBotDirectoryOptions) {
  const { repository, availabilityPolicy } = options;
  assertAvailabilityPolicy(availabilityPolicy);
  const now = options.now ?? (() => new Date());
  const idGenerator = options.idGenerator ?? ((kind) => generateCoordinationId(kind));

  function makeId(kind: GeneratedBotDirectoryIdKind): string {
    const value = idGenerator(kind);
    assertCoordinationId(kind, value);
    return value;
  }

  async function ensurePersistentBinding(
    definition: ApprovedBotBinding,
    context: OwnerBotDirectoryMutationContext,
  ): Promise<BotProjection> {
    if (
      !definition ||
      definition.continuingIdentity !== true ||
      definition.durableMailbox !== true
    ) {
      throw new BotDirectoryError("binding_not_persistent");
    }
    if (context?.principalId !== "user_owner") {
      throw new BotDirectoryError("unauthorized_registration");
    }
    const mutationIds = assertMutationIds(context);
    const residentBinding = canonicalResidentBinding(definition.residentBinding);
    const name = canonicalText(definition.name, 128);
    const purpose = canonicalText(definition.purpose, 512);
    const requiredCapabilities = canonicalCapabilities(definition.requiredCapabilities);
    const at = canonicalNow(now);
    const timestamp = at.toISOString();
    const botId = makeId("bot");
    const aliasesByKey = new Map<string, { namespace: string; value: string }>();
    for (const aliasDefinition of [
      { namespace: "resident", value: residentBinding },
      ...definition.aliases,
    ]) {
      const alias = canonicalAlias(aliasDefinition);
      aliasesByKey.set(`${alias.namespace}\0${digestBotAlias(alias.namespace, alias.value)}`, alias);
    }
    const aliases: BotAliasRecord[] = [...aliasesByKey.values()].map((alias) => ({
      id: makeId("alias"),
      namespace: alias.namespace,
      aliasDigest: digestBotAlias(alias.namespace, alias.value),
      targetType: "bot",
      targetId: botId,
      active: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    const bot: BotDirectoryRecord = {
      id: botId,
      principalId: botId,
      name,
      purpose,
      lifecycle: "active",
      conversationId: null,
      residentBinding,
      continuingIdentity: true,
      durableMailbox: true,
      requiredCapabilities,
      activeInstanceId: null,
      activeKeyVersion: null,
      residentProtocolVersion: null,
      residentCapabilities: [],
      residentRegisteredAt: null,
      lastHeartbeatAt: null,
      reportedAvailability: null,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const result = await repository.ensurePersistentBinding({
      ownerPrincipalId: "user_owner",
      actorPrincipalId: "user_owner",
      ...mutationIds,
      bot,
      aliases,
    });
    if (result.outcome === "alias_collision") {
      throw new BotDirectoryError("alias_collision", {
        namespace: result.namespace,
        existingBotId: result.existingBotId,
      });
    }
    if (result.outcome === "binding_conflict") {
      throw new BotDirectoryError("binding_conflict", {
        existingBotId: result.existingBotId,
      });
    }
    if (result.outcome === "identity_collision") {
      throw new BotDirectoryError("identity_collision");
    }
    return projectBot(result.bot, at, availabilityPolicy);
  }

  async function listVisibleBots(): Promise<readonly BotProjection[]> {
    const at = canonicalNow(now);
    const records = await repository.listPersistentBots();
    return Object.freeze(
      records
        .filter(isVisible)
        .map((record) => projectBot(record, at, availabilityPolicy))
        .sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 :
            left.id < right.id ? -1 : left.id > right.id ? 1 : 0
        ),
    );
  }

  async function listLifecycleBots(): Promise<readonly BotProjection[]> {
    const at = canonicalNow(now);
    const records = await repository.listPersistentBots();
    return Object.freeze(
      records
        .filter(isLifecycleReadable)
        .map((record) => projectBot(record, at, availabilityPolicy))
        .sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 :
            left.id < right.id ? -1 : left.id > right.id ? 1 : 0
        ),
    );
  }

  async function getLifecycleBot(botId: string): Promise<BotProjection | null> {
    const record = await repository.getBotById(botId);
    if (!record || !isLifecycleReadable(record)) return null;
    return projectBot(record, canonicalNow(now), availabilityPolicy);
  }

  async function resolveAlias(
    namespace: string,
    value: string,
  ): Promise<BotProjection | null> {
    const alias = canonicalAlias({ namespace, value });
    const record = await repository.resolveActiveAlias(
      alias.namespace,
      digestBotAlias(alias.namespace, alias.value),
    );
    if (!record || record.targetType !== "bot") return null;
    const bot = await repository.getBotById(record.targetId);
    if (!bot || !isVisible(bot)) return null;
    return projectBot(bot, canonicalNow(now), availabilityPolicy);
  }

  async function registerResident(
    input: RegisterResidentInput,
  ): Promise<ResidentAvailabilityReceipt> {
    const peer = assertAuthenticatedContext(input.context, input.botBinding);
    if (input.protocolVersion !== RESIDENT_PROTOCOL_VERSION) {
      throw new BotDirectoryError("protocol_version_unsupported");
    }
    const capabilities = canonicalCapabilities(input.capabilities);
    for (let attempt = 0; attempt < MAX_COMMIT_RETRIES; attempt += 1) {
      const at = canonicalNow(now);
      const current = await repository.getBotByResidentBinding(peer.residentBinding);
      if (!current || !isVisible(current) || current.lifecycle !== "active") {
        throw new BotDirectoryError("unauthorized_registration");
      }
      const currentAvailability = availabilityAt(current, at, availabilityPolicy);
      const hasCapabilities = current.requiredCapabilities.every((capability) =>
        capabilities.includes(capability)
      );
      const sameCredential =
        current.activeInstanceId === peer.instanceId &&
        current.activeKeyVersion === peer.keyVersion;
      const replacingInstance =
        current.activeInstanceId !== null &&
        current.activeInstanceId !== peer.instanceId;
      if (
        current.activeInstanceId !== null &&
        !sameCredential &&
        current.activeKeyVersion !== null &&
        (
          peer.keyVersion < current.activeKeyVersion ||
          (
            replacingInstance &&
            peer.keyVersion === current.activeKeyVersion &&
            currentAvailability !== "offline"
          )
        )
      ) {
        throw new BotDirectoryError("registration_stale");
      }
      const reportedAvailability: ResidentReportedAvailability = !hasCapabilities
        ? currentAvailability === "offline" ? "starting" : "degraded"
        : currentAvailability === "offline" || currentAvailability === "starting"
          ? "starting"
          : replacingInstance
            ? "degraded"
          : current.reportedAvailability ?? "starting";
      const result = await repository.commitResidentRegistration({
        botId: current.id,
        expectedVersion: current.version,
        residentBinding: peer.residentBinding,
        instanceId: peer.instanceId,
        keyVersion: peer.keyVersion,
        allowSameKeyReplacement: currentAvailability === "offline",
        protocolVersion: input.protocolVersion,
        capabilities,
        reportedAvailability,
        registeredAt: at.toISOString(),
        actorPrincipalId: current.principalId,
        requestId: peer.requestId,
        correlationId: peer.correlationId,
      });
      if (result.outcome === "conflict") continue;
      if (result.outcome === "superseded_instance") {
        throw new BotDirectoryError("registration_stale");
      }
      if (result.outcome !== "registered") {
        throw new BotDirectoryError("unauthorized_registration");
      }
      return receipt(result.bot, at, availabilityPolicy);
    }
    throw new BotDirectoryError("storage_conflict");
  }

  async function heartbeatResident(
    input: ResidentHeartbeatInput,
  ): Promise<ResidentAvailabilityReceipt> {
    const peer = assertAuthenticatedContext(input.context);
    if (!isResidentReportedAvailability(input.availability)) {
      throw new BotDirectoryError("request_invalid");
    }
    for (let attempt = 0; attempt < MAX_COMMIT_RETRIES; attempt += 1) {
      const at = canonicalNow(now);
      const current = await repository.getBotByResidentBinding(peer.residentBinding);
      if (!current || !isVisible(current) || current.lifecycle !== "active") {
        throw new BotDirectoryError("unauthorized_registration");
      }
      if (
        current.activeInstanceId !== peer.instanceId ||
        current.activeKeyVersion !== peer.keyVersion
      ) {
        throw new BotDirectoryError("registration_stale");
      }
      const currentAvailability = availabilityAt(current, at, availabilityPolicy);
      if (currentAvailability === "offline") {
        throw new BotDirectoryError("registration_stale");
      }
      if (!isCapabilityComplete(current) && input.availability !== "degraded") {
        throw new BotDirectoryError("availability_transition_invalid");
      }
      if (
        currentAvailability !== input.availability &&
        !isLegalTransition("botAvailability", currentAvailability, input.availability)
      ) {
        throw new BotDirectoryError("availability_transition_invalid");
      }
      const result = await repository.commitResidentHeartbeat({
        botId: current.id,
        expectedVersion: current.version,
        instanceId: peer.instanceId,
        keyVersion: peer.keyVersion,
        reportedAvailability: input.availability,
        heartbeatAt: at.toISOString(),
        actorPrincipalId: current.principalId,
        requestId: peer.requestId,
        correlationId: peer.correlationId,
      });
      if (result.outcome === "conflict") continue;
      if (result.outcome === "stale_instance") {
        throw new BotDirectoryError("registration_stale");
      }
      if (result.outcome !== "recorded") {
        throw new BotDirectoryError("unauthorized_registration");
      }
      return receipt(result.bot, at, availabilityPolicy);
    }
    throw new BotDirectoryError("storage_conflict");
  }

  return Object.freeze({
    ensurePersistentBinding,
    listVisibleBots,
    listLifecycleBots,
    getLifecycleBot,
    resolveAlias,
    registerResident,
    heartbeatResident,
  });
}
