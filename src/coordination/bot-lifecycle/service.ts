import { createHash } from "node:crypto";

import type { BotProjection } from "../bots/index.js";
import { BotLifecycleError } from "./errors.js";
import type {
  BotLifecycleOperation,
  BotLifecyclePhase,
  BotLifecycleReceipt,
  CreateBotLifecycleServiceOptions,
  PersistentBotControlRequest,
  PersistentBotCreateRequest,
  ProvisionedResident,
} from "./types.js";

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PROCESS_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/;

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code) return code.slice(0, 128);
  }
  return "adapter_failure";
}

function requestFingerprint(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validProcessManifest(resident: ProvisionedResident): readonly string[] {
  const prefix = `home23-${resident.residentBinding}`;
  if (
    resident.kind !== "persistent_resident" ||
    !Array.isArray(resident.processNames) ||
    resident.processNames.length === 0 ||
    resident.processNames.length > 16
  ) throw new BotLifecycleError("process_manifest_invalid");
  const names = [...new Set(resident.processNames)];
  if (names.length !== resident.processNames.length || names.some((name) =>
    typeof name !== "string" ||
    !PROCESS_NAME.test(name) ||
    (name !== prefix && !name.startsWith(`${prefix}-`))
  )) throw new BotLifecycleError("process_manifest_invalid");
  return Object.freeze(names);
}

function validDate(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new BotLifecycleError("request_invalid", "Lifecycle clock is invalid");
  }
  return value.toISOString();
}

export function createBotLifecycleService(options: CreateBotLifecycleServiceOptions) {
  const now = options.now ?? (() => new Date());

  async function authorize(
    request: PersistentBotCreateRequest | PersistentBotControlRequest,
  ) {
    if (!options.authority.enabled()) throw new BotLifecycleError("capability_disabled");
    const epoch = await options.authority.currentEpoch();
    if (
      !epoch || epoch.capability !== "bot_lifecycle" || epoch.mode !== "canonical" ||
      epoch.writer !== options.canonicalWriter
    ) throw new BotLifecycleError("authority_unavailable");
    if (epoch.epoch !== request.expectedAuthorityEpoch) {
      throw new BotLifecycleError("authority_epoch_mismatch");
    }
    const expectedOperation = "operation" in request
      ? `bot_lifecycle.${request.operation}`
      : "bot_lifecycle.create";
    const expectedTarget = "operation" in request ? request.botId : request.residentBinding;
    if (
      request.policy?.action?.actorPrincipalId !== request.actorPrincipalId ||
      request.policy?.action?.operation !== expectedOperation ||
      request.policy?.action?.target !== expectedTarget ||
      request.policy.contextAccess?.kind !== "none"
    ) throw new BotLifecycleError("standing_authority_denied", "Exact lifecycle action mismatch");
    const decision = options.authority.decide(request.policy);
    if (decision.decision !== "allow") {
      throw new BotLifecycleError("standing_authority_denied", decision.reasonCode);
    }
    return { epoch, decision };
  }

  async function priorOrConflict(
    requestId: string,
    operation: BotLifecycleOperation,
    correlationId: string,
    requestDigest: string,
  ): Promise<BotLifecycleReceipt | null> {
    const prior = await options.receipts.get(requestId);
    if (!prior) return null;
    if (
      prior.operation !== operation || prior.correlationId !== correlationId ||
      prior.requestDigest !== requestDigest
    ) {
      throw new BotLifecycleError("request_id_conflict");
    }
    return prior;
  }

  async function save(receipt: BotLifecycleReceipt): Promise<BotLifecycleReceipt> {
    const stored = await options.receipts.putIfAbsent(Object.freeze(receipt));
    if (
      stored.operation !== receipt.operation ||
      stored.correlationId !== receipt.correlationId ||
      requestFingerprint(stored) !== requestFingerprint(receipt)
    ) throw new BotLifecycleError("request_id_conflict");
    return stored;
  }

  async function create(request: PersistentBotCreateRequest): Promise<BotLifecycleReceipt> {
    const digest = requestFingerprint(request);
    const prior = await priorOrConflict(request.requestId, "create", request.correlationId, digest);
    if (prior) return prior;
    if (
      request.actorPrincipalId !== "user_owner" || !SLUG.test(request.residentBinding) ||
      !request.displayName.trim() || !request.purpose.trim()
    ) throw new BotLifecycleError("request_invalid");
    const { epoch, decision } = await authorize(request);
    const phases: BotLifecyclePhase[] = ["authorized"];
    let resident: ProvisionedResident | null = null;
    let bot: BotProjection | null = null;
    try {
      resident = await options.provisioner.inspect(request.residentBinding);
      if (!resident) resident = await options.provisioner.create({
        residentBinding: request.residentBinding,
        displayName: request.displayName.trim(),
        purpose: request.purpose.trim(),
        requiredCapabilities: [...request.requiredCapabilities],
        copyPrivateMemory: false,
      });
      if (resident.residentBinding !== request.residentBinding) {
        throw new BotLifecycleError("request_invalid", "Provisioner returned the wrong resident");
      }
      const processNames = validProcessManifest(resident);
      phases.push("resident_created");
      try {
        bot = await options.mailboxBinder.bindAfterResidentCreated({
          requestId: request.requestId,
          correlationId: request.correlationId,
          actorPrincipalId: request.actorPrincipalId,
          residentBinding: request.residentBinding,
          displayName: request.displayName.trim(),
          purpose: request.purpose.trim(),
          requiredCapabilities: [...request.requiredCapabilities],
        });
      } catch (error) {
        await options.provisioner.archivePartial(resident, "mailbox_bind_failed");
        const receipt = await save({
          requestId: request.requestId, requestDigest: digest, correlationId: request.correlationId,
          operation: "create", residentBinding: request.residentBinding,
          botId: null, mailboxId: null, authorityEpoch: epoch.epoch,
          policyDecision: decision, outcome: "failed", completedPhases: phases,
          processNames, failure: { phase: "mailbox_bind", code: errorCode(error), partialResidentArchived: true },
          createdAt: validDate(now),
        });
        throw new BotLifecycleError("operation_failed", "Mailbox binding failed", receipt);
      }
      if (!bot.conversationId || bot.residentBinding !== request.residentBinding) {
        await options.provisioner.archivePartial(resident, "mailbox_binding_invalid");
        const receipt = await save({
          requestId: request.requestId, requestDigest: digest, correlationId: request.correlationId,
          operation: "create", residentBinding: request.residentBinding,
          botId: bot.id, mailboxId: bot.conversationId, authorityEpoch: epoch.epoch,
          policyDecision: decision, outcome: "failed", completedPhases: phases,
          processNames, failure: { phase: "mailbox_bind", code: "invalid_durable_binding", partialResidentArchived: true },
          createdAt: validDate(now),
        });
        throw new BotLifecycleError("operation_failed", "Mailbox binder did not return a durable binding", receipt);
      }
      phases.push("mailbox_bound");
      return save({
        requestId: request.requestId, requestDigest: digest, correlationId: request.correlationId,
        operation: "create", residentBinding: request.residentBinding,
        botId: bot.id, mailboxId: bot.conversationId, authorityEpoch: epoch.epoch,
        policyDecision: decision, outcome: "succeeded", completedPhases: phases,
        processNames, failure: null, createdAt: validDate(now),
      });
    } catch (error) {
      if (error instanceof BotLifecycleError) throw error;
      const receipt = await save({
        requestId: request.requestId, requestDigest: digest, correlationId: request.correlationId,
        operation: "create", residentBinding: request.residentBinding,
        botId: bot?.id ?? null, mailboxId: bot?.conversationId ?? null,
        authorityEpoch: epoch.epoch, policyDecision: decision, outcome: "failed",
        completedPhases: phases, processNames: resident?.processNames ?? [],
        failure: { phase: "resident_create", code: errorCode(error), partialResidentArchived: false },
        createdAt: validDate(now),
      });
      throw new BotLifecycleError("operation_failed", "Resident creation failed", receipt);
    }
  }

  async function control(request: PersistentBotControlRequest): Promise<BotLifecycleReceipt> {
    const digest = requestFingerprint(request);
    const prior = await priorOrConflict(request.requestId, request.operation, request.correlationId, digest);
    if (prior) return prior;
    if (request.actorPrincipalId !== "user_owner" || !request.botId) {
      throw new BotLifecycleError("request_invalid");
    }
    const { epoch, decision } = await authorize(request);
    const bot = await options.mailboxBinder.getByBotId(request.botId);
    if (!bot || !bot.conversationId) throw new BotLifecycleError("bot_not_found");
    const resident = await options.provisioner.inspect(bot.residentBinding);
    if (!resident) throw new BotLifecycleError("resident_not_found");
    const processNames = validProcessManifest(resident);
    try {
      if (request.operation === "start") await options.processes.startExact(processNames);
      else if (request.operation === "stop") await options.processes.stopExact(processNames);
      else await options.processes.restartExact(processNames);
    } catch (error) {
      const receipt = await save({
        requestId: request.requestId, requestDigest: digest, correlationId: request.correlationId,
        operation: request.operation, residentBinding: bot.residentBinding,
        botId: bot.id, mailboxId: bot.conversationId, authorityEpoch: epoch.epoch,
        policyDecision: decision, outcome: "failed", completedPhases: ["authorized"],
        processNames, failure: { phase: "process_change", code: errorCode(error), partialResidentArchived: false },
        createdAt: validDate(now),
      });
      throw new BotLifecycleError("operation_failed", "Exact process operation failed", receipt);
    }
    return save({
      requestId: request.requestId, requestDigest: digest, correlationId: request.correlationId,
      operation: request.operation, residentBinding: bot.residentBinding,
      botId: bot.id, mailboxId: bot.conversationId, authorityEpoch: epoch.epoch,
      policyDecision: decision, outcome: "succeeded",
      completedPhases: ["authorized", "process_changed"], processNames,
      failure: null, createdAt: validDate(now),
    });
  }

  return Object.freeze({ create, control });
}
