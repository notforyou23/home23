import type { createAuthService } from "../auth/index.js";
import type { BootstrapService } from "../bootstrap/index.js";
import type { MessagingActorContext } from "../channels/index.js";
import type { CanonicalSearchService } from "../search/index.js";
import type { createUnreadService } from "../unread/index.js";
import type { FEATURE_FLAG_REGISTRY } from "../schema/contract-registry.js";

export type CoordinationFeatureFlags = Readonly<{
  [Flag in keyof typeof FEATURE_FLAG_REGISTRY]: boolean;
}>;

export type CoordinationAuthPort = Pick<
  ReturnType<typeof createAuthService>,
  "validateAccessToken"
>;

export type CoordinationUnreadPort = Pick<
  ReturnType<typeof createUnreadService>,
  "markRead"
>;

/**
 * M11 owns the durable-before-start Work/Attempt/Lease transaction. M12 only
 * forwards a validated public message intent through this port.
 */
export interface CoordinationMessageSubmissionRequest {
  messageId: string;
  clientMessageId: string;
  text: string | null;
  attachmentIds: readonly string[];
  mentions: readonly string[];
  replyToMessageId: string | null;
  readonly [additionalProperty: string]: unknown;
}

export interface CoordinationMessageSubmissionPort {
  submitMessage(input: {
    context: MessagingActorContext;
    channelId: string;
    idempotencyKey: string;
    body: CoordinationMessageSubmissionRequest;
  }): Promise<Readonly<Record<string, unknown>>>;
}

/** M11 supplies this without exposing its repository or lifecycle internals. */
export interface CoordinationWorkPort {
  getWork(input: {
    context: MessagingActorContext;
    workId: string;
  }): Promise<Readonly<Record<string, unknown>>>;
  cancelWork(input: {
    context: MessagingActorContext;
    workId: string;
    idempotencyKey: string;
  }): Promise<Readonly<Record<string, unknown>>>;
  retryWork(input: {
    context: MessagingActorContext;
    workId: string;
    idempotencyKey: string;
  }): Promise<Readonly<Record<string, unknown>>>;
}

export interface CoordinationServices {
  auth: CoordinationAuthPort;
  bootstrap?: BootstrapService;
  unread?: CoordinationUnreadPort;
  search?: CanonicalSearchService;
  messageSubmission?: CoordinationMessageSubmissionPort;
  work?: CoordinationWorkPort;
}

export interface CoordinationHttpLimits {
  jsonBodyBytes: number;
  idempotencyKeyMinimum: number;
  idempotencyKeyMaximum: number;
}

export interface CoordinationAdvertisedCapabilities {
  bootstrap: boolean;
  channelsRead: boolean;
  conversationsRead: boolean;
  messagesRead: boolean;
  unreadRead: boolean;
  messageSubmission: boolean;
  readCursorMutation: boolean;
  search: boolean;
  eventReplay: boolean;
  attachments: boolean;
  work: boolean;
  workMutation: boolean;
  activity: boolean;
  botLifecycle: boolean;
  importShadow: boolean;
}

export interface CoordinationCapabilityDocument {
  contractVersion: 1;
  apiBase: "/api/v1";
  pairingAvailable: boolean;
  limits: CoordinationHttpLimits;
  capabilities: CoordinationAdvertisedCapabilities;
}

export interface CoordinationApplication {
  readonly flags: CoordinationFeatureFlags;
  readonly services: CoordinationServices;
  capabilities(): CoordinationCapabilityDocument;
}
