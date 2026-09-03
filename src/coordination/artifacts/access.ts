import type {
  MessagingActorContext,
  MessagingParticipantDirectory,
  ResolvedMessagingActor,
} from "../channels/index.js";
import { assertCoordinationId } from "../ids/index.js";
import { ArtifactError } from "./errors.js";

const attachmentWriteActors = new WeakSet<object>();
const attachmentReadActors = new WeakSet<object>();

export function assertArtifactWriteActor(actor: ResolvedMessagingActor): void {
  if (!actor || typeof actor !== "object" || !attachmentWriteActors.has(actor)) {
    throw new ArtifactError("scope_denied");
  }
}

export function assertArtifactReadActor(actor: ResolvedMessagingActor): void {
  if (!actor || typeof actor !== "object" || !attachmentReadActors.has(actor)) {
    throw new ArtifactError("scope_denied");
  }
}

export async function resolveArtifactReader(
  context: MessagingActorContext,
  directory: MessagingParticipantDirectory,
): Promise<ResolvedMessagingActor> {
  const actor = await resolveArtifactIdentity(context, directory, "product:read");
  attachmentReadActors.add(actor);
  return actor;
}

function invalidIdentity(): never {
  throw new ArtifactError("identity_context_mismatch");
}

function assertReceiptIds(context: MessagingActorContext): void {
  try {
    assertCoordinationId("principal", context.principalId);
    assertCoordinationId("request", context.requestId);
    assertCoordinationId("correlation", context.correlationId);
  } catch {
    invalidIdentity();
  }
}

/**
 * Attachment admission boundary. Public routing remains owned by M23, but any
 * such route must resolve its authentication context here before invoking the
 * byte store.
 */
export async function resolveArtifactActor(
  context: MessagingActorContext,
  directory: MessagingParticipantDirectory,
): Promise<ResolvedMessagingActor> {
  const actor = await resolveArtifactIdentity(context, directory, "attachment:write");
  attachmentWriteActors.add(actor);
  attachmentReadActors.add(actor);
  return actor;
}

async function resolveArtifactIdentity(
  context: MessagingActorContext,
  directory: MessagingParticipantDirectory,
  ownerScope: "attachment:write" | "product:read",
): Promise<ResolvedMessagingActor> {
  if (!context || typeof context !== "object" || !context.identity) invalidIdentity();
  assertReceiptIds(context);
  if (context.identity.kind === "owner") {
    const auth = context.identity.auth;
    if (context.principalId !== "user_owner" || auth?.principalId !== "user_owner") {
      invalidIdentity();
    }
    try {
      assertCoordinationId("device", auth.deviceId);
      assertCoordinationId("clientSession", auth.sessionId);
    } catch {
      invalidIdentity();
    }
    if (!Array.isArray(auth.scopes) || !auth.scopes.includes(ownerScope)) {
      throw new ArtifactError("scope_denied");
    }
    const actor = Object.freeze({
      principalId: "user_owner",
      kind: "owner" as const,
      displayName: "Owner",
      requestId: context.requestId,
      correlationId: context.correlationId,
      residentCredential: null,
    });
    return actor;
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
    const actor = Object.freeze({
      principalId: binding.principalId,
      kind: "bot" as const,
      displayName: binding.name,
      requestId: context.requestId,
      correlationId: context.correlationId,
      residentCredential: null,
    });
    return actor;
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
  const binding = await directory.getBotByResidentBinding(credential.residentSlug);
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
    binding.residentRegisteredAt === null
  ) {
    invalidIdentity();
  }
  if (
    !binding.requiredCapabilities.includes("attachments") ||
    !binding.residentCapabilities.includes("attachments")
  ) {
    throw new ArtifactError("scope_denied");
  }
  const actor = Object.freeze({
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
  return actor;
}
