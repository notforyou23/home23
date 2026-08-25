import type { createAuthService } from "../auth/index.js";
import type { BootstrapService } from "../bootstrap/index.js";
import type { projectTrustedM11Activity } from "../activity/index.js";
import type { MessagingActorContext } from "../channels/index.js";
import type { ArtifactDownload, ArtifactProjection } from "../artifacts/index.js";
import type { Readable } from "node:stream";
import type { createLeaseService } from "../leases/index.js";
import type { CanonicalSearchService } from "../search/index.js";
import type { FEATURE_FLAG_REGISTRY } from "../schema/contract-registry.js";
import type { createUnreadService } from "../unread/index.js";
import type { createWorkService } from "../work/index.js";
import type { createChannelCoordinator } from "../channel-coordinator/index.js";
import type { SqliteEventRepository } from "../events/index.js";

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
  }): Promise<Readonly<Record<string, unknown> & { response?: Promise<unknown> }>>;
}

/** Exact M11 durable Work boundary; public DTO/auth adaptation remains later work. */
export type CoordinationWorkPort = Pick<
  ReturnType<typeof createWorkService>,
  "create" | "cancelQueued" | "get"
>;

/** Exact M11 fenced execution boundary; no resident process is activated by injection. */
export type CoordinationLeasePort = ReturnType<typeof createLeaseService>;

/**
 * Dependency-safe M18 projection seam. Its input still requires authenticated
 * trusted M08 membership and complete trusted M11 fact assembly. Injection
 * alone never advertises or exposes a public Activity route.
 */
export type CoordinationActivityPort = typeof projectTrustedM11Activity;

/**
 * Complete M10 public boundary. Implementations must resolve the authenticated
 * actor through the M10 access boundary, durably replay/conflict idempotency
 * keys, stream bytes into M10 quarantine, and use the repository's authorized
 * Channel-reader lookup. A raw LocalArtifactStore is intentionally not enough
 * to activate M12 attachment routes.
 */
export interface CoordinationAttachmentPort {
  create(input: {
    context: MessagingActorContext;
    idempotencyKey: string;
    contentType: string;
    contentLength: number | null;
    body: Readable;
  }): Promise<ArtifactProjection>;
  getMetadata(input: {
    context: MessagingActorContext;
    artifactId: string;
  }): Promise<ArtifactProjection>;
  openDownload(input: {
    context: MessagingActorContext;
    artifactId: string;
    rangeHeader?: string;
  }): Promise<ArtifactDownload>;
}

export interface CoordinationServices {
  auth: CoordinationAuthPort;
  bootstrap?: BootstrapService;
  unread?: CoordinationUnreadPort;
  search?: CanonicalSearchService;
  messageSubmission?: CoordinationMessageSubmissionPort;
  work?: CoordinationWorkPort;
  leases?: CoordinationLeasePort;
  activity?: CoordinationActivityPort;
  attachments?: CoordinationAttachmentPort;
  /** Optional internal M16 seam. Presence never advertises or activates Channels. */
  channelCoordinator?: ReturnType<typeof createChannelCoordinator>;
  events?: SqliteEventRepository;
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
