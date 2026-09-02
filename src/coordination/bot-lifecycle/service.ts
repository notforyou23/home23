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
} from "./types.js";

const SAFE_BINDING_CHARACTER = /[a-z0-9]/;
const PERMANENT_RESIDENT_BINDINGS = new Set(["jerry", "forrest"]);

function canonicalCreateFields(request: PersistentBotCreateRequest): {
  displayName: string;
  purpose: string;
} {
  const displayName = typeof request.displayName === "string" ? request.displayName.trim() : "";
  const purpose = typeof request.purpose === "string" ? request.purpose.trim() : "";
  if (
    !displayName || displayName.length > 128 || displayName.includes("\0") ||
    !purpose || purpose.length > 512 || purpose.includes("\0")
  ) throw new BotLifecycleError("request_invalid");
  return { displayName, purpose };
}

/**
 * Storage still requires a resident_binding value. For lightweight Bots it is
 * a logical compatibility slug only, derived inside Core from the canonical
 * name and idempotency key. It is never a daemon/process/instance identity.
 */
export function derivePersistentBotBinding(input: {
  requestId: string;
  displayName: string;
}): string {
  const displayName = input.displayName.trim();
  if (!displayName || displayName.includes("\0") || typeof input.requestId !== "string" || !input.requestId) {
    throw new BotLifecycleError("request_invalid");
  }
  const folded = displayName.normalize("NFKD").toLowerCase();
  let base = "";
  let separator = false;
  for (const character of folded) {
    if (/\p{Mark}/u.test(character)) continue;
    if (SAFE_BINDING_CHARACTER.test(character)) {
      if (separator && base) base += "-";
      base += character;
      separator = false;
    } else if (base) {
      separator = true;
    }
  }
  base = base.replace(/-+$/u, "") || "bot";
  const suffix = createHash("sha256").update(input.requestId, "utf8").digest("hex").slice(0, 16);
  base = base.slice(0, 42).replace(/-+$/u, "") || "bot";
  return `bot-${base}-${suffix}`;
}

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

function validDate(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new BotLifecycleError("request_invalid", "Lifecycle clock is invalid");
  }
  return value.toISOString();
}

function assertCoherentBot(
  bot: BotProjection,
  expected: {
    lifecycle: "active" | "archived";
    residentBinding?: string;
    displayName?: string;
    purpose?: string;
    principalId?: string;
    botId?: string;
    mailboxId?: string;
  },
): void {
  if (
    typeof bot.id !== "string" || !bot.id ||
    bot.principalId !== (expected.principalId ?? bot.id) ||
    (expected.botId !== undefined && bot.id !== expected.botId) ||
    typeof bot.conversationId !== "string" || !bot.conversationId ||
    (expected.mailboxId !== undefined && bot.conversationId !== expected.mailboxId) ||
    typeof bot.residentBinding !== "string" || !bot.residentBinding ||
    (expected.residentBinding !== undefined && bot.residentBinding !== expected.residentBinding) ||
    bot.lifecycle !== expected.lifecycle ||
    (expected.displayName !== undefined && bot.name !== expected.displayName) ||
    (expected.purpose !== undefined && bot.purpose !== expected.purpose)
  ) {
    throw Object.assign(new Error("Bot binder returned an incoherent durable identity"), {
      code: "invalid_durable_binding",
    });
  }
}

export function createBotLifecycleService(options: CreateBotLifecycleServiceOptions) {
  const now = options.now ?? (() => new Date());

  async function authorize(
    request: PersistentBotCreateRequest | PersistentBotControlRequest,
    target: string,
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
    if (
      request.policy?.action?.actorPrincipalId !== request.actorPrincipalId ||
      request.policy?.action?.operation !== expectedOperation ||
      request.policy?.action?.target !== target ||
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
    if (request.actorPrincipalId !== "user_owner") throw new BotLifecycleError("request_invalid");
    const fields = canonicalCreateFields(request);
    const residentBinding = derivePersistentBotBinding({
      requestId: request.requestId,
      displayName: fields.displayName,
    });
    const { epoch, decision } = await authorize(request, residentBinding);
    const phases: BotLifecyclePhase[] = ["authorized"];
    let bot: BotProjection | null = null;
    try {
      bot = await options.mailboxBinder.bindDurableBot({
        requestId: request.requestId,
        correlationId: request.correlationId,
        actorPrincipalId: request.actorPrincipalId,
        residentBinding,
        displayName: fields.displayName,
        purpose: fields.purpose,
      });
      assertCoherentBot(bot, {
        lifecycle: "active",
        residentBinding,
        displayName: fields.displayName,
        purpose: fields.purpose,
      });
      phases.push("mailbox_bound");
      return save({
        requestId: request.requestId,
        requestDigest: digest,
        correlationId: request.correlationId,
        operation: "create",
        residentBinding,
        botId: bot.id,
        mailboxId: bot.conversationId,
        authorityEpoch: epoch.epoch,
        policyDecision: decision,
        outcome: "succeeded",
        completedPhases: phases,
        failure: null,
        createdAt: validDate(now),
      });
    } catch (error) {
      if (error instanceof BotLifecycleError) throw error;
      const receipt = await save({
        requestId: request.requestId,
        requestDigest: digest,
        correlationId: request.correlationId,
        operation: "create",
        residentBinding,
        botId: bot?.id ?? null,
        mailboxId: bot?.conversationId ?? null,
        authorityEpoch: epoch.epoch,
        policyDecision: decision,
        outcome: "failed",
        completedPhases: phases,
        failure: { phase: "mailbox_bind", code: errorCode(error) },
        createdAt: validDate(now),
      });
      throw new BotLifecycleError("operation_failed", "Durable Bot binding failed", receipt);
    }
  }

  async function control(request: PersistentBotControlRequest): Promise<BotLifecycleReceipt> {
    if (request.operation !== "archive" && request.operation !== "restore") {
      throw new BotLifecycleError("request_invalid");
    }
    const digest = requestFingerprint(request);
    const prior = await priorOrConflict(request.requestId, request.operation, request.correlationId, digest);
    if (prior) return prior;
    if (request.actorPrincipalId !== "user_owner" || !request.botId) {
      throw new BotLifecycleError("request_invalid");
    }
    const { epoch, decision } = await authorize(request, request.botId);
    const bot = await options.mailboxBinder.getByBotId(request.botId);
    if (!bot || !bot.conversationId) throw new BotLifecycleError("bot_not_found");
    try {
      assertCoherentBot(bot, { lifecycle: bot.lifecycle === "archived" ? "archived" : "active" });
    } catch {
      throw new BotLifecycleError("invalid_durable_binding");
    }
    if (PERMANENT_RESIDENT_BINDINGS.has(bot.residentBinding)) {
      throw new BotLifecycleError(
        "permanent_resident_protected",
        "Permanent house residents cannot be archived or restored",
      );
    }
    const lifecycleTarget = request.operation === "archive" ? "archived" : "active";
    const completedPhase = request.operation === "archive" ? "mailbox_archived" : "mailbox_restored";
    if (bot.lifecycle === lifecycleTarget) {
      return save({
        requestId: request.requestId,
        requestDigest: digest,
        correlationId: request.correlationId,
        operation: request.operation,
        residentBinding: bot.residentBinding,
        botId: bot.id,
        mailboxId: bot.conversationId,
        authorityEpoch: epoch.epoch,
        policyDecision: decision,
        outcome: "succeeded",
        completedPhases: ["authorized"],
        failure: null,
        createdAt: validDate(now),
      });
    }
    if (!(bot.lifecycle === "active" || bot.lifecycle === "archived")) {
      throw new BotLifecycleError("request_invalid", "Bot lifecycle cannot be transitioned");
    }
    const changedAt = validDate(now);
    try {
      const transitioned = await options.mailboxBinder.transitionLifecycle({
        botId: bot.id,
        from: request.operation === "archive" ? "active" : "archived",
        to: lifecycleTarget,
        requestId: request.requestId,
        correlationId: request.correlationId,
        actorPrincipalId: request.actorPrincipalId,
        changedAt,
      });
      assertCoherentBot(transitioned, {
        lifecycle: lifecycleTarget,
        residentBinding: bot.residentBinding,
        principalId: bot.principalId,
        botId: bot.id,
        mailboxId: bot.conversationId,
      });
    } catch (error) {
      const receipt = await save({
        requestId: request.requestId,
        requestDigest: digest,
        correlationId: request.correlationId,
        operation: request.operation,
        residentBinding: bot.residentBinding,
        botId: bot.id,
        mailboxId: bot.conversationId,
        authorityEpoch: epoch.epoch,
        policyDecision: decision,
        outcome: "failed",
        completedPhases: ["authorized"],
        failure: { phase: "mailbox_transition", code: errorCode(error) },
        createdAt: changedAt,
      });
      throw new BotLifecycleError("operation_failed", "Mailbox lifecycle transition failed", receipt);
    }
    return save({
      requestId: request.requestId,
      requestDigest: digest,
      correlationId: request.correlationId,
      operation: request.operation,
      residentBinding: bot.residentBinding,
      botId: bot.id,
      mailboxId: bot.conversationId,
      authorityEpoch: epoch.epoch,
      policyDecision: decision,
      outcome: "succeeded",
      completedPhases: ["authorized", completedPhase],
      failure: null,
      createdAt: changedAt,
    });
  }

  return Object.freeze({ create, control });
}
