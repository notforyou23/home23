import { FEATURE_FLAG_REGISTRY } from "../schema/contract-registry.js";
import type {
  CoordinationApplication,
  CoordinationCapabilityDocument,
  CoordinationFeatureFlags,
  CoordinationHttpLimits,
  CoordinationServices,
} from "./types.js";

export const DEFAULT_COORDINATION_HTTP_LIMITS: CoordinationHttpLimits = Object.freeze({
  jsonBodyBytes: 262_144,
  idempotencyKeyMinimum: 16,
  idempotencyKeyMaximum: 128,
});

export function disabledCoordinationFeatureFlags(): CoordinationFeatureFlags {
  return Object.freeze(
    Object.fromEntries(
      Object.keys(FEATURE_FLAG_REGISTRY).map((flag) => [flag, false]),
    ) as unknown as CoordinationFeatureFlags,
  );
}

function coordinationHttpLimits(
  value: CoordinationHttpLimits,
): CoordinationHttpLimits {
  if (
    !Number.isSafeInteger(value.jsonBodyBytes) ||
    value.jsonBodyBytes < 1 ||
    !Number.isSafeInteger(value.idempotencyKeyMinimum) ||
    value.idempotencyKeyMinimum < 1 ||
    !Number.isSafeInteger(value.idempotencyKeyMaximum) ||
    value.idempotencyKeyMaximum < value.idempotencyKeyMinimum
  ) {
    throw new TypeError("coordination HTTP limits are invalid");
  }
  return Object.freeze({ ...value });
}

function capabilityDocument(input: {
  flags: CoordinationFeatureFlags;
  services: CoordinationServices;
  limits: CoordinationHttpLimits;
}): CoordinationCapabilityDocument {
  const processEnabled =
    input.flags["coordination.process.enabled"] === true;
  const mutationsEnabled =
    processEnabled && input.flags["coordination.public_api.enabled"] === true;

  return Object.freeze({
    contractVersion: 1 as const,
    apiBase: "/api/v1" as const,
    pairingAvailable: mutationsEnabled &&
      typeof input.services.auth.issuePairing === "function" &&
      typeof input.services.auth.redeemPairing === "function",
    limits: Object.freeze({ ...input.limits }),
    capabilities: Object.freeze({
      bootstrap: processEnabled && input.services.bootstrap !== undefined,
      channelsRead: processEnabled && input.services.channels !== undefined,
      conversationsRead: processEnabled && input.services.unread !== undefined,
      messagesRead: processEnabled && input.services.messages !== undefined,
      unreadRead: processEnabled && input.services.unread !== undefined,
      // M11's public DTOs and authority-gated receipts are not merged yet.
      messageSubmission:
        mutationsEnabled &&
        input.flags["coordination.resident.jerry.enabled"] === true &&
        input.services.messageSubmission !== undefined &&
        input.services.work !== undefined &&
        input.services.leases !== undefined,
      readCursorMutation: mutationsEnabled && input.services.unread !== undefined,
      search:
        processEnabled &&
        input.flags["coordination.search.canonical"] === true &&
        input.services.search !== undefined,
      eventReplay: processEnabled && input.services.events !== undefined,
      attachments:
        mutationsEnabled && input.services.attachments !== undefined,
      work: processEnabled && input.services.workControl !== undefined,
      workMutation: mutationsEnabled && input.services.workControl !== undefined,
      activity:
        processEnabled && typeof input.services.activity?.list === "function",
      botLifecycle:
        mutationsEnabled &&
        input.flags["coordination.bot_lifecycle.enabled"] === true &&
        input.services.botLifecycleApi !== undefined,
      importShadow: false,
    }),
  });
}

export function createCoordinationApplication(input: {
  flags: CoordinationFeatureFlags;
  services: CoordinationServices;
  limits?: CoordinationHttpLimits;
}): CoordinationApplication {
  const flags = Object.freeze({ ...input.flags });
  const services = Object.freeze({ ...input.services });
  const limits = coordinationHttpLimits(
    input.limits ?? DEFAULT_COORDINATION_HTTP_LIMITS,
  );
  const advertised = capabilityDocument({
    flags,
    services,
    limits,
  });

  return Object.freeze({
    flags,
    services,
    capabilities: () => advertised,
  });
}
