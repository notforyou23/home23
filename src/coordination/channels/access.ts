import { assertCoordinationId } from "../ids/index.js";
import { MessagingError } from "./errors.js";
import type {
  MessagingActorContext,
  MessagingParticipantDirectory,
  RequiredMessagingScope,
  ResolvedMessagingActor,
} from "./types.js";

function invalidIdentity(): never {
  throw new MessagingError("identity_context_mismatch");
}

function assertReceiptIds(context: MessagingActorContext): void {
  try {
    assertCoordinationId("principal", context.principalId);
    assertCoordinationId("request", context.requestId);
    assertCoordinationId("correlation", context.correlationId);
  } catch {
    throw new MessagingError("request_invalid");
  }
}

export async function resolveMessagingActor(
  context: MessagingActorContext,
  directory: MessagingParticipantDirectory,
  requiredScope: RequiredMessagingScope,
): Promise<ResolvedMessagingActor> {
  if (!context || typeof context !== "object" || !context.identity) {
    invalidIdentity();
  }
  assertReceiptIds(context);
  if (context.identity.kind === "owner") {
    const auth = context.identity.auth;
    if (
      context.principalId !== "user_owner" ||
      auth?.principalId !== "user_owner"
    ) {
      invalidIdentity();
    }
    try {
      assertCoordinationId("device", auth.deviceId);
      assertCoordinationId("clientSession", auth.sessionId);
    } catch {
      invalidIdentity();
    }
    if (!Array.isArray(auth.scopes) || !auth.scopes.includes(requiredScope)) {
      throw new MessagingError("scope_denied");
    }
    return Object.freeze({
      principalId: "user_owner",
      kind: "owner" as const,
      displayName: "Owner",
      requestId: context.requestId,
      correlationId: context.correlationId,
      residentCredential: null,
    });
  }

  if (context.identity.kind === "on_demand_bot") {
    const identity = context.identity.bot;
    if (
      typeof identity?.botId !== "string" ||
      typeof identity?.residentBinding !== "string" ||
      !identity.residentBinding.startsWith("bot-") ||
      identity.residentBinding === "jerry" ||
      identity.residentBinding === "forrest" ||
      identity.botId !== context.principalId
    ) {
      invalidIdentity();
    }
    const binding = await directory.getBotByResidentBinding(identity.residentBinding);
    if (
      !binding ||
      binding.id !== identity.botId ||
      binding.principalId !== identity.botId ||
      binding.residentBinding !== identity.residentBinding ||
      binding.lifecycle !== "active" ||
      !binding.continuingIdentity ||
      !binding.durableMailbox ||
      binding.conversationId === null ||
      !binding.requiredCapabilities.includes("messages") ||
      binding.activeInstanceId !== null ||
      binding.activeKeyVersion !== null ||
      binding.residentProtocolVersion !== null ||
      binding.residentRegisteredAt !== null ||
      binding.residentCapabilities.length !== 0
    ) {
      invalidIdentity();
    }
    return Object.freeze({
      principalId: binding.principalId,
      kind: "bot" as const,
      displayName: binding.name,
      requestId: context.requestId,
      correlationId: context.correlationId,
      residentCredential: null,
    });
  }

  if (context.identity.kind !== "resident") invalidIdentity();
  const resident = context.identity.resident;
  const credential = resident?.credential;
  if (
    resident?.requestId !== context.requestId ||
    resident?.correlationId !== context.correlationId ||
    credential?.role !== "resident" ||
    typeof credential.residentSlug !== "string" ||
    !credential.residentSlug ||
    typeof credential.instanceId !== "string" ||
    !credential.instanceId ||
    !Number.isSafeInteger(credential.keyVersion) ||
    credential.keyVersion < 1
  ) {
    invalidIdentity();
  }
  const bot = await directory.resolveAlias("resident", credential.residentSlug);
  if (!bot || bot.principalId !== context.principalId) invalidIdentity();
  const binding = await directory.getBotByResidentBinding(
    credential.residentSlug,
  );
  if (
    !binding ||
    binding.id !== bot.id ||
    binding.principalId !== bot.principalId ||
    binding.residentBinding !== credential.residentSlug ||
    binding.lifecycle !== "active" ||
    !binding.continuingIdentity ||
    !binding.durableMailbox ||
    binding.activeInstanceId !== credential.instanceId ||
    binding.activeKeyVersion !== credential.keyVersion ||
    binding.residentProtocolVersion !== 1 ||
    binding.residentRegisteredAt === null ||
    !binding.requiredCapabilities.includes("messages") ||
    !binding.residentCapabilities.includes("messages")
  ) {
    invalidIdentity();
  }
  return Object.freeze({
    principalId: bot.principalId,
    kind: "bot" as const,
    displayName: bot.name,
    requestId: context.requestId,
    correlationId: context.correlationId,
    residentCredential: Object.freeze({
      residentBinding: credential.residentSlug,
      instanceId: credential.instanceId,
      keyVersion: credential.keyVersion,
    }),
  });
}

export async function resolveVisibleBots(
  directory: MessagingParticipantDirectory,
): Promise<ReadonlyMap<string, {
  id: string;
  principalId: string;
  name: string;
  residentBinding: string;
  version: number;
}>> {
  const visible = await directory.listVisibleBots();
  return new Map(visible.map((bot) => [bot.principalId, {
    id: bot.id,
    principalId: bot.principalId,
    name: bot.name,
    residentBinding: bot.residentBinding,
    version: bot.version,
  }]));
}
