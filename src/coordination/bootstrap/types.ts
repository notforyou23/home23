import type { HouseAuthScope } from "../auth/index.js";
import type {
  MessagingActorContext,
  MessagingParticipantDirectory,
} from "../channels/index.js";
import type { EventReadDatabase } from "../events/index.js";

export interface BootstrapAvailabilityPolicy {
  degradedAfterMs: number;
  offlineAfterMs: number;
}

export interface BootstrapBotProjection {
  id: string;
  name: string;
  lifecycle: string;
  availability: "offline" | "starting" | "available" | "busy" | "degraded";
  conversationId: string | null;
  version: number;
}

export interface BootstrapChannelProjection {
  id: string;
  conversationId: string;
  kind: "direct" | "group";
  title: string;
  lifecycle: "active" | "archived";
  version: number;
}

export interface BootstrapConversationProjection {
  id: string;
  channelId: string;
  latestSequence: number;
  unreadCount: number;
  version: number;
}

export interface BootstrapSnapshot {
  bots: readonly BootstrapBotProjection[];
  channels: readonly BootstrapChannelProjection[];
  conversations: readonly BootstrapConversationProjection[];
  unreadTotal: number;
}

export interface BootstrapProjectionBoundary {
  snapshot: BootstrapSnapshot;
  throughEventSequence: number;
}

export interface BootstrapRepository {
  readProjection(input: {
    principalId: string;
    at: string;
    availabilityPolicy: BootstrapAvailabilityPolicy;
  }): BootstrapProjectionBoundary;
}

export interface BootstrapResponse {
  contractVersion: 1;
  minimumClientBuild: number;
  serverTime: string;
  requestId: string;
  correlationId: string;
  home: { id: string; name: string; primaryBotId: string };
  client: {
    sessionId: string;
    deviceId: string;
    principalId: "user_owner";
    scopes: readonly HouseAuthScope[];
  };
  connection: { mode: string; displayName: string; reachable: boolean };
  capabilities: {
    channels: boolean;
    attachments: boolean;
    search: boolean;
    push: boolean;
    eventReplay: boolean;
    botLifecycle: boolean;
  };
  limits: {
    attachmentBytes: number;
    attachmentCountPerMessage: number;
    jsonBodyBytes: number;
    idempotencyKeyMinimum: number;
    idempotencyKeyMaximum: number;
  };
  snapshot: BootstrapSnapshot;
  eventCursor: number;
  throughEventSequence: number;
}

export interface CreateBootstrapServiceOptions {
  repository: BootstrapRepository;
  participantDirectory: MessagingParticipantDirectory;
  now?: () => Date;
  minimumClientBuild: number;
  home: BootstrapResponse["home"];
  connection: BootstrapResponse["connection"];
  capabilities: BootstrapResponse["capabilities"];
  limits: BootstrapResponse["limits"];
  availabilityPolicy: BootstrapAvailabilityPolicy;
}

export interface BootstrapService {
  getBootstrap(input: { context: MessagingActorContext }): Promise<BootstrapResponse>;
}

export type BootstrapReadDatabase = EventReadDatabase;
