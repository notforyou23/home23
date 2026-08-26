import { createHash } from "node:crypto";

import {
  createDurableAttachmentService,
  LocalArtifactStore,
  SqliteArtifactRepository,
  type ArtifactParticipantDirectory,
  type LocalArtifactStoreOptions,
} from "../artifacts/index.js";
import { openCoordinationDatabase } from "../db/index.js";
import { createAuthService, SqliteAuthRepository } from "../auth/index.js";
import { createBotDirectory, SqliteBotDirectoryRepository } from "../bots/index.js";
import { createBootstrapService, SqliteBootstrapRepository } from "../bootstrap/index.js";
import { createChannelService, SqliteBotConversationBindingAdapter, SqliteMessagingRepository } from "../channels/index.js";
import { SqliteEventRepository } from "../events/index.js";
import { createLeaseService } from "../leases/index.js";
import { createMessageService } from "../messages/index.js";
import { createCanonicalSearchService, SqliteCanonicalSearchRepository } from "../search/index.js";
import { createUnreadService, SqliteUnreadRepository } from "../unread/index.js";
import { createProductWorkControl, createWorkService, M11MessageProvenanceAuthority } from "../work/index.js";
import { generateCoordinationId } from "../ids/index.js";
import { createResidentCredential } from "../resident-protocol/index.js";
import { ResidentUdsClient } from "../transport/uds/index.js";
import { ResidentCoordinationAdapter, ResidentUdsAgentPort, createM11ResidentCoordinationPort } from "../../coordination-adapter/index.js";
import { createDirectMessageSubmissionService } from "./direct-message.js";
import { SqliteDirectMessageContext } from "./direct-message-context.js";
import { createCoordinationHttpServer } from "../http/index.js";
import { createCoordinationApplication } from "./application.js";
import { createCoordinationLifecycle } from "./lifecycle.js";
import {
  createBotLifecycleService,
  type CreateBotLifecycleServiceOptions,
} from "../bot-lifecycle/index.js";
import type { CoordinationRuntimeConfig } from "./runtime-config.js";
import type {
  CoordinationApplication,
  CoordinationFeatureFlags,
  CoordinationLifecycle,
  CoordinationServices,
} from "./index.js";
import {
  compactRetention,
  type RetentionBackupProvider,
  type RetentionException,
  type RetentionReceipt,
  type RetentionStore,
} from "../retention/index.js";
import type { PolicyRequest } from "../policy/index.js";

export interface DurableAttachmentCompositionOptions {
  /** Independent kill switch. This is deliberately not sourced from live config. */
  enabled: boolean;
  databasePath: string;
  rootDirectory: string;
  participantDirectory: ArtifactParticipantDirectory;
  maximumBytes?: LocalArtifactStoreOptions["maximumBytes"];
  draftLifetimeMs?: LocalArtifactStoreOptions["draftLifetimeMs"];
  maximumConcurrentUploads?: LocalArtifactStoreOptions["maximumConcurrentUploads"];
  uploadAdmissionTimeoutMs?: LocalArtifactStoreOptions["uploadAdmissionTimeoutMs"];
  maximumRequestBytes?: number;
  now?: () => Date;
}

/**
 * Internal-only M28 activation bundle. The extra switch is intentional: a
 * registry flag alone must never make resident creation or process control
 * reachable. Every effectful adapter and both trusted authority boundaries
 * must be supplied explicitly by the future owner of activation.
 */
export type BotLifecycleCompositionOptions = Readonly<
  CreateBotLifecycleServiceOptions & {
    enabled: true;
    resolveHttpPolicy(input: {
      operation: "create" | "start" | "stop" | "restart" | "archive" | "restore";
      target: string;
    }): PolicyRequest;
  }
>;

export interface CoordinationRuntimeComposition {
  application: CoordinationApplication;
  lifecycle: CoordinationLifecycle;
}

export interface CoordinationProcess {
  start(): Promise<{ host: string; port: number; origin: string }>;
  drain(): Promise<void>;
  capabilities(): ReturnType<
    ReturnType<typeof createCoordinationApplication>["capabilities"]
  >;
  /** Internal-only M30 invocation. No timer, route, or startup path calls this. */
  invokeRetention(input: RetentionInvocation): Promise<RetentionReceipt>;
}

export interface RetentionInvocation {
  enabled: true;
  asOf: string;
  exceptions?: readonly RetentionException[];
}

export interface RetentionCompositionOptions {
  /** Independent kill switch; deliberately absent from runtime/live config. */
  enabled: true;
  store: RetentionStore;
  backupProvider: RetentionBackupProvider;
}

/**
 * Internal M16/M18 dependencies accepted by the canonical process. Both are
 * absent by default and remain behind their domain capability checks; merely
 * injecting either dependency does not register or advertise a public route.
 */
export type CoordinationProcessProjectionDependencies = Readonly<Pick<
  CoordinationServices,
  "activity" | "channelCoordinator"
> & { retention?: RetentionCompositionOptions }>;

function isCompleteAttachmentOptions(
  value: Partial<DurableAttachmentCompositionOptions> | undefined,
): value is DurableAttachmentCompositionOptions {
  return value?.enabled === true &&
    typeof value.databasePath === "string" && value.databasePath.length > 0 &&
    typeof value.rootDirectory === "string" && value.rootDirectory.length > 0 &&
    value.participantDirectory !== undefined &&
    typeof value.participantDirectory.getBotByResidentBinding === "function" &&
    typeof value.participantDirectory.resolveAlias === "function" &&
    typeof value.participantDirectory.listVisibleBots === "function";
}

/**
 * Production-safe M10/M12 composition boundary. No durable resource is opened
 * until every activation flag and dependency is present. Resources opened by
 * this factory are enrolled in M12 drain and are closed on partial startup.
 */
export async function createCoordinationRuntimeComposition(input: {
  flags: CoordinationFeatureFlags;
  services: Omit<CoordinationServices, "attachments" | "botLifecycle" | "botLifecycleApi">;
  attachments?: Partial<DurableAttachmentCompositionOptions>;
  botLifecycle?: Partial<BotLifecycleCompositionOptions>;
}): Promise<CoordinationRuntimeComposition> {
  // Runtime callers cannot bypass construction by smuggling a raw or
  // preassembled attachment value through the otherwise shared service bag.
  const {
    attachments: _ignoredAttachment,
    botLifecycle: _ignoredBotLifecycle,
    botLifecycleApi: _ignoredBotLifecycleApi,
    ...services
  } =
    input.services as CoordinationServices;

  const lifecycleOptions = input.botLifecycle;
  const botLifecycle =
    input.flags["coordination.process.enabled"] === true &&
    input.flags["coordination.public_api.enabled"] === true &&
    input.flags["coordination.bot_lifecycle.enabled"] === true &&
    lifecycleOptions?.enabled === true &&
    lifecycleOptions.authority !== undefined &&
    lifecycleOptions.provisioner !== undefined &&
    lifecycleOptions.mailboxBinder !== undefined &&
    lifecycleOptions.processes !== undefined &&
    lifecycleOptions.receipts !== undefined &&
    typeof lifecycleOptions.resolveHttpPolicy === "function" &&
    typeof lifecycleOptions.canonicalWriter === "string" &&
    lifecycleOptions.canonicalWriter.length > 0
      ? (() => {
          const service = createBotLifecycleService(lifecycleOptions as BotLifecycleCompositionOptions);
          const epoch = async () => {
            const current = await lifecycleOptions.authority!.currentEpoch();
            if (!current) throw new Error("bot lifecycle authority is unavailable");
            return current.epoch;
          };
          const api = Object.freeze({
            create: async (request: any) => service.create({
              requestId: request.idempotencyKey, correlationId: request.context.correlationId,
              actorPrincipalId: "user_owner", residentBinding: request.residentBinding,
              displayName: request.displayName, purpose: request.purpose,
              requiredCapabilities: request.requiredCapabilities,
              policy: lifecycleOptions.resolveHttpPolicy!(
                { operation: "create", target: request.residentBinding },
              ),
              expectedAuthorityEpoch: await epoch(),
            }),
            control: async (request: any) => service.control({
              requestId: request.idempotencyKey, correlationId: request.context.correlationId,
              actorPrincipalId: "user_owner", botId: request.botId, operation: request.operation,
              policy: lifecycleOptions.resolveHttpPolicy!(
                { operation: request.operation, target: request.botId },
              ),
              expectedAuthorityEpoch: await epoch(),
            }),
          });
          return Object.freeze({ service, api });
        })()
      : undefined;
  const composedServices = botLifecycle === undefined
    ? services
    : { ...services, botLifecycle: botLifecycle.service, botLifecycleApi: botLifecycle.api };
  if (
    input.flags["coordination.process.enabled"] !== true ||
    input.flags["coordination.public_api.enabled"] !== true ||
    !isCompleteAttachmentOptions(input.attachments)
  ) {
    return Object.freeze({
      application: createCoordinationApplication({ flags: input.flags, services: composedServices }),
      lifecycle: createCoordinationLifecycle(),
    });
  }

  const options = input.attachments;
  const database = openCoordinationDatabase({
    path: options.databasePath,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  try {
    const repository = new SqliteArtifactRepository(database);
    const store = await LocalArtifactStore.open({
      rootDirectory: options.rootDirectory,
      repository,
      ...(options.maximumBytes === undefined ? {} : { maximumBytes: options.maximumBytes }),
      ...(options.draftLifetimeMs === undefined ? {} : { draftLifetimeMs: options.draftLifetimeMs }),
      ...(options.maximumConcurrentUploads === undefined ? {} : { maximumConcurrentUploads: options.maximumConcurrentUploads }),
      ...(options.uploadAdmissionTimeoutMs === undefined ? {} : { uploadAdmissionTimeoutMs: options.uploadAdmissionTimeoutMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const attachments = createDurableAttachmentService({
      database,
      repository,
      store,
      participantDirectory: options.participantDirectory,
      ...(options.maximumRequestBytes === undefined ? {} : { maximumRequestBytes: options.maximumRequestBytes }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const lifecycle = createCoordinationLifecycle([{
      name: "coordination-database",
      drain: async () => undefined,
      close: async () => database.close(),
    }]);
    return Object.freeze({
      application: createCoordinationApplication({
        flags: input.flags,
        services: { ...composedServices, attachments },
      }),
      lifecycle,
    });
  } catch (error) {
    database.close();
    throw error;
  }
}

export function createCoordinationProcess(
  config: CoordinationRuntimeConfig,
  dependencies: CoordinationProcessProjectionDependencies = {},
): CoordinationProcess {
  if (!config.enabled) {
    throw new Error("the disabled coordination process cannot be composed");
  }
  const database = openCoordinationDatabase({
    path: config.databasePath,
    applicationVersion: "home23-coordination-m12-shadow",
  });
  const rootKey = createHash("sha256").update("home23-coordination-auth-v1\0").update(config.capabilityToken).digest();
  const channelCursorKey = createHash("sha256").update("home23-coordination-channel-cursor-v1\0").update(config.capabilityToken).digest();
  const searchCursorKey = createHash("sha256").update("home23-coordination-search-cursor-v1\0").update(config.capabilityToken).digest();
  const auth = createAuthService({
    repository: new SqliteAuthRepository(database), keyMaterial: rootKey,
    admissionVerifier: {
      verifyLocalOperator: (evidence) => evidence === "loopback" ? { allowed: true, network: "loopback", rateLimitKey: "operator:loopback" } : { allowed: false, reason: "operator_auth_required" },
      verifyClient: (evidence) => evidence === "loopback" ? { allowed: true, network: "loopback", rateLimitKey: "client:loopback" } : { allowed: false, reason: "network_not_allowed" },
    },
  });
  rootKey.fill(0);
  const botRepository = new SqliteBotDirectoryRepository(database);
  const botDirectory = createBotDirectory({ repository: botRepository, availabilityPolicy: { degradedAfterMs: 30_000, offlineAfterMs: 120_000 } });
  const participantDirectory = Object.freeze({
    listVisibleBots: botDirectory.listVisibleBots,
    resolveAlias: botDirectory.resolveAlias,
    getBotByResidentBinding: (binding: string) => botRepository.getBotByResidentBinding(binding),
  });
  const messagingRepository = new SqliteMessagingRepository(database, {
    botConversationBinding: new SqliteBotConversationBindingAdapter(),
    messageProvenanceAuthorization: new M11MessageProvenanceAuthority(),
  });
  const channels = createChannelService({ repository: messagingRepository, participantDirectory, cursorSigningKey: channelCursorKey });
  const messages = createMessageService({ repository: messagingRepository, participantDirectory });
  const search = createCanonicalSearchService({
    repository: new SqliteCanonicalSearchRepository(database),
    participantDirectory,
    cursorSigningKey: searchCursorKey,
    resolveCanary: () => null,
  });
  channelCursorKey.fill(0);
  searchCursorKey.fill(0);
  const unread = createUnreadService({ repository: new SqliteUnreadRepository(database), participantDirectory });
  const work = createWorkService({ database, generateId: generateCoordinationId });
  const leases = createLeaseService({ database, generateId: generateCoordinationId, leaseTtlMs: 60_000 });
  const workControl = createProductWorkControl({ database, work, leases });
  const events = new SqliteEventRepository(database);
  const bootstrap = {
    getBootstrap: async (input: Parameters<ReturnType<typeof createBootstrapService>["getBootstrap"]>[0]) => {
      const primary = await botRepository.getBotByResidentBinding("jerry");
      if (!primary) throw new Error("primary Jerry Bot binding is unavailable");
      return createBootstrapService({ repository: new SqliteBootstrapRepository(database), participantDirectory,
        minimumClientBuild: 1, home: { id: "home_local", name: "Home23", primaryBotId: primary.id },
        connection: { mode: "loopback", displayName: "This Home23", reachable: true },
        capabilities: { channels: false, attachments: false, search: false, push: false, eventReplay: true, botLifecycle: false },
        limits: { attachmentBytes: 0, attachmentCountPerMessage: 0, jsonBodyBytes: 262_144, idempotencyKeyMinimum: 16, idempotencyKeyMaximum: 128 },
        availabilityPolicy: { degradedAfterMs: 30_000, offlineAfterMs: 120_000 },
      }).getBootstrap(input);
    },
  };
  let residentAgent: ResidentUdsAgentPort | undefined;
  let messageSubmission;
  if (config.flags["coordination.resident.jerry.enabled"] === true) {
    const jerry = config.residents?.jerry;
    if (!jerry) throw new Error("Jerry resident configuration is required when its feature is enabled");
    const residentRootKey = Buffer.from(jerry.key, "hex");
    const credential = createResidentCredential({ residentSlug: "jerry", role: "resident", instanceId: jerry.clientInstanceId, keyVersion: jerry.keyVersion, rootKey: residentRootKey });
    residentRootKey.fill(0);
    const client = new ResidentUdsClient({ socketPath: jerry.socketPath, serverInstanceId: jerry.serverInstanceId, credential });
    residentAgent = new ResidentUdsAgentPort({ client, residentSlug: "jerry" });
    const resident = new ResidentCoordinationAdapter(residentAgent, createM11ResidentCoordinationPort(leases));
    const context = new SqliteDirectMessageContext(database, messages);
    messageSubmission = createDirectMessageSubmissionService({ messages, context: { prepare: async (input) => { const prepared = await context.prepare(input); if (prepared.residentBinding !== "jerry") throw new Error("target resident is not enabled"); return prepared; } }, work, leases, resident,
      holderInstanceId: jerry.serverInstanceId,
      residentContext: ({ residentBinding, principalId, requestId, correlationId }) => {
        if (residentBinding !== "jerry") throw new Error("target resident is not enabled");
        return { principalId, requestId, correlationId, identity: { kind: "resident", resident: { requestId, correlationId, credential: { residentSlug: residentBinding, role: "resident", instanceId: jerry.serverInstanceId, keyVersion: jerry.keyVersion } } } };
      },
    });
  }
  const lifecycle = createCoordinationLifecycle([{
    name: "resident-uds-client", drain: async () => undefined, close: async () => residentAgent?.close(),
  }, {
    name: "coordination-database",
    drain: async () => undefined,
    close: async () => database.close(),
  }]);
  const application = createCoordinationApplication({
    flags: config.flags,
    services: {
      auth, bootstrap, bots: botDirectory, channels, messages, unread, search,
      work, workControl, leases, events,
      ...(messageSubmission === undefined ? {} : { messageSubmission }),
      ...(dependencies.activity === undefined
        ? {}
        : { activity: dependencies.activity }),
      ...(dependencies.channelCoordinator === undefined
        ? {}
        : { channelCoordinator: dependencies.channelCoordinator }),
    },
  });
  const server = createCoordinationHttpServer({
    application,
    lifecycle,
    host: config.host,
    port: config.port,
  });
  return Object.freeze({
    start: () => server.start(),
    drain: () => server.drain(),
    capabilities: () => application.capabilities(),
    invokeRetention: (input: RetentionInvocation) => {
      if (
        config.flags["coordination.compaction.enabled"] !== true ||
        dependencies.retention?.enabled !== true ||
        input.enabled !== true
      ) {
        return Promise.reject(new Error("retention compaction is disabled"));
      }
      return compactRetention(
        dependencies.retention.store,
        dependencies.retention.backupProvider,
        { ...input, enabled: true },
      );
    },
  });
}
