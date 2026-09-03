import { createHash } from "node:crypto";

import {
  ArtifactError,
  createDurableAttachmentService,
  createResidentArtifactPromotionPort,
  LocalArtifactStore,
  resolveArtifactActor,
  SqliteArtifactRepository,
  type ArtifactParticipantDirectory,
  type LocalArtifactStoreOptions,
} from "../artifacts/index.js";
import { openCoordinationDatabase } from "../db/index.js";
import { createAuthService, SqliteAuthRepository } from "../auth/index.js";
import { BotDirectoryError, createBotDirectory, SqliteBotDirectoryRepository } from "../bots/index.js";
import { createBootstrapService, SqliteBootstrapRepository } from "../bootstrap/index.js";
import {
  createChannelService,
  MessagingError,
  SqliteBotConversationBindingAdapter,
  SqliteMessagingRepository,
} from "../channels/index.js";
import { SqliteEventRepository } from "../events/index.js";
import { SqliteCommunicationEventRepository } from "../communications/index.js";
import { createLeaseService } from "../leases/index.js";
import { createMessageService } from "../messages/index.js";
import { createCanonicalSearchService, SqliteCanonicalSearchRepository } from "../search/index.js";
import { createUnreadService, SqliteUnreadRepository } from "../unread/index.js";
import { createProductWorkControl, createWorkService, M11MessageProvenanceAuthority } from "../work/index.js";
import { generateCoordinationId } from "../ids/index.js";
import { HOUSE_RESIDENT_CAPABILITIES } from "../house-resident-capabilities.js";
import { createResidentCredential } from "../resident-protocol/index.js";
import { ResidentUdsClient } from "../transport/uds/index.js";
import { ResidentCoordinationAdapter, ResidentUdsAgentPort, createM11ResidentCoordinationPort } from "../../coordination-adapter/index.js";
import {
  createCanonicalMessageRecorder,
  createDirectMessageSubmissionService,
  type DirectMessageResidentTarget,
} from "./direct-message.js";
import { SqliteDirectMessageContext } from "./direct-message-context.js";
import { createOnDemandBotRuntime } from "./on-demand-bot-runtime.js";
import { createGroupChannelMessageService } from "./channel-message.js";
import { SqliteGroupChannelMessageContext } from "./channel-message-context.js";
import { createSqliteActivityReadService } from "./activity-read.js";
import {
  ChannelCoordinatorError,
  createChannelCoordinator,
} from "../channel-coordinator/index.js";
import { createRoundService } from "../rounds/index.js";
import { createCoordinationHttpServer } from "../http/index.js";
import { createCoordinationApplication } from "./application.js";
import { createCoordinationLifecycle } from "./lifecycle.js";
import {
  createBotLifecycleService,
  derivePersistentBotBinding,
  SqliteBotLifecycleReceiptStore,
  SqlitePersistentMailboxBinder,
  type CreateBotLifecycleServiceOptions,
} from "../bot-lifecycle/index.js";
import type { CoordinationRuntimeConfig } from "./runtime-config.js";
import type {
  CoordinationApplication,
  CoordinationAttachmentPort,
  CoordinationChannelCoordinatorPort,
  CoordinationFeatureFlags,
  CoordinationLifecycle,
  CoordinationMessageSubmissionPort,
  CoordinationServices,
} from "./index.js";
import {
  compactRetention,
  type RetentionBackupProvider,
  type RetentionException,
  type RetentionReceipt,
  type RetentionStore,
} from "../retention/index.js";
import { classifyPolicy, type PolicyRequest } from "../policy/index.js";
import {
  isCanonicalAttachmentsAuthority,
  isCanonicalBotLifecycleAuthority,
  isCanonicalMessagesAuthority,
  COORDINATION_BOT_LIFECYCLE_WRITER,
  COORDINATION_MESSAGES_WRITER,
  type AuthorityEpoch,
} from "../epochs/index.js";
import type { AuthorityCapability } from "../import/index.js";

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
 * Internal-only lifecycle activation bundle. The extra switch is intentional:
 * a registry flag alone must never make durable Bot creation reachable. The
 * supplied binder owns only canonical identity/mailbox/channel writes; it has
 * no resident-provisioning or process-control dependency.
 */
export type BotLifecycleCompositionOptions = Readonly<
  CreateBotLifecycleServiceOptions & {
    enabled: true;
    resolveHttpPolicy(input: {
      operation: "create" | "archive" | "restore";
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
 * Internal optional dependencies accepted by the canonical process. Activity
 * is deliberately absent here: the process composes its complete M08/M11 read
 * boundary itself, so callers cannot replace it with a raw projector.
 */
export type CoordinationProcessProjectionDependencies = Readonly<Pick<
  CoordinationServices,
  "channelCoordinator"
> & { retention?: RetentionCompositionOptions }>;

function composeBotLifecycle(
  flags: CoordinationFeatureFlags,
  lifecycleOptions: Partial<BotLifecycleCompositionOptions> | undefined,
) {
  if (
    flags["coordination.process.enabled"] !== true ||
    flags["coordination.public_api.enabled"] !== true ||
    flags["coordination.bot_lifecycle.enabled"] !== true ||
    lifecycleOptions?.enabled !== true ||
    lifecycleOptions.authority === undefined ||
    lifecycleOptions.mailboxBinder === undefined ||
    lifecycleOptions.receipts === undefined ||
    typeof lifecycleOptions.resolveHttpPolicy !== "function" ||
    typeof lifecycleOptions.canonicalWriter !== "string" ||
    lifecycleOptions.canonicalWriter.length === 0
  ) return undefined;
  const options = lifecycleOptions as BotLifecycleCompositionOptions;
  const service = createBotLifecycleService(options);
  const epoch = async () => {
    const current = await options.authority.currentEpoch();
    if (!current) throw new Error("bot lifecycle authority is unavailable");
    return current.epoch;
  };
  const api = Object.freeze({
    create: async (request: any) => service.create({
      requestId: request.idempotencyKey,
      correlationId: request.context.correlationId,
      actorPrincipalId: "user_owner",
      displayName: request.displayName,
      purpose: request.purpose,
      policy: options.resolveHttpPolicy({
        operation: "create",
        target: derivePersistentBotBinding({
          requestId: request.idempotencyKey,
          displayName: request.displayName,
        }),
      }),
      expectedAuthorityEpoch: await epoch(),
    }),
    control: async (request: any) => service.control({
      requestId: request.idempotencyKey,
      correlationId: request.context.correlationId,
      actorPrincipalId: "user_owner",
      botId: request.botId,
      operation: request.operation,
      policy: options.resolveHttpPolicy({
        operation: request.operation,
        target: request.botId,
      }),
      expectedAuthorityEpoch: await epoch(),
    }),
  });
  return Object.freeze({ service, api });
}

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

  const botLifecycle = composeBotLifecycle(input.flags, input.botLifecycle);
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
  const currentAuthority = (capability: AuthorityCapability): AuthorityEpoch | null => {
    const epoch = database.readOne<AuthorityEpoch>(
      `SELECT capability, epoch, mode, writer,
              effective_at_event_sequence AS effectiveAtEventSequence,
              rollback_epoch AS rollbackEpoch
       FROM authority_epochs
       WHERE capability = ?
       ORDER BY epoch DESC LIMIT 1`,
      capability,
    );
    return epoch ? Object.freeze(epoch) : null;
  };
  const authorityEpochs = Object.freeze({
    current: currentAuthority,
    listCurrent: async () => Object.freeze({
      epochs: Object.freeze(database.readAll<AuthorityEpoch>(
        `SELECT capability, epoch, mode, writer,
                effective_at_event_sequence AS effectiveAtEventSequence,
                rollback_epoch AS rollbackEpoch
         FROM authority_epochs current
         WHERE epoch = (SELECT MAX(newest.epoch) FROM authority_epochs newest
                        WHERE newest.capability = current.capability)
         ORDER BY capability`,
      ).map((epoch) => Object.freeze(epoch))),
      throughEventSequence: database.readOne<{ sequence: number }>(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events",
      )?.sequence ?? 0,
    }),
  });
  const productionBotLifecycle =
    isCanonicalMessagesAuthority(currentAuthority("messages")) &&
    isCanonicalBotLifecycleAuthority(currentAuthority("bot_lifecycle"))
      ? composeBotLifecycle(config.flags, {
          enabled: true,
          canonicalWriter: COORDINATION_BOT_LIFECYCLE_WRITER,
          authority: {
            enabled: () =>
              config.flags["coordination.process.enabled"] === true &&
              config.flags["coordination.public_api.enabled"] === true &&
              config.flags["coordination.bot_lifecycle.enabled"] === true &&
              isCanonicalMessagesAuthority(currentAuthority("messages")) &&
              isCanonicalBotLifecycleAuthority(currentAuthority("bot_lifecycle")),
            currentEpoch: async () => currentAuthority("bot_lifecycle"),
            decide: (request) => classifyPolicy(request, new Date()),
          },
          mailboxBinder: new SqlitePersistentMailboxBinder({
            database,
          }),
          receipts: new SqliteBotLifecycleReceiptStore(database),
          resolveHttpPolicy: ({ operation, target }) => Object.freeze({
            action: Object.freeze({
              actorPrincipalId: "user_owner",
              operation: `bot_lifecycle.${operation}`,
              target,
              parameters: Object.freeze({}),
            }),
            factSource: Object.freeze({
              kind: "trusted_policy_boundary" as const,
              reference: "home23:authenticated-owner-bot-lifecycle:v1",
            }),
            standing: Object.freeze({
              scope: "within" as const,
              delegation: "within" as const,
              budget: "within" as const,
              audience: "within" as const,
              allowlist: "within" as const,
            }),
            impactClasses: Object.freeze([]),
            contextAccess: Object.freeze({ kind: "none" as const }),
          }),
        })
      : undefined;
  const botLifecycleCapabilityAvailable = () =>
    productionBotLifecycle !== undefined &&
    isCanonicalMessagesAuthority(currentAuthority("messages")) &&
    isCanonicalBotLifecycleAuthority(currentAuthority("bot_lifecycle"));
  const attachmentConfiguration = config.attachments;
  const attachmentComposed =
    config.flags["coordination.process.enabled"] === true &&
    config.flags["coordination.public_api.enabled"] === true &&
    attachmentConfiguration?.enabled === true &&
    isCanonicalAttachmentsAuthority(currentAuthority("attachments"));
  const artifactRepository = attachmentComposed
    ? new SqliteArtifactRepository(database)
    : undefined;
  const messagingRepository = new SqliteMessagingRepository(database, {
    botConversationBinding: new SqliteBotConversationBindingAdapter(),
    messageProvenanceAuthorization: new M11MessageProvenanceAuthority(),
    ...(artifactRepository === undefined
      ? {}
      : { artifactMessageLink: artifactRepository }),
  });
  const channels = createChannelService({ repository: messagingRepository, participantDirectory, cursorSigningKey: channelCursorKey });
  const messages = createMessageService({
    repository: messagingRepository,
    participantDirectory,
    ...(artifactRepository === undefined
      ? {}
      : {
          resolveAttachmentActor: (context: Parameters<typeof resolveArtifactActor>[0]) =>
            resolveArtifactActor(context, participantDirectory),
        }),
  });
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
  // The process owns this complete adapter, but an independent runtime switch
  // still controls whether it is injected. The application additionally
  // requires a canonical Activity epoch before advertising or serving it.
  const activity = config.activity?.enabled === true
    ? createSqliteActivityReadService({ database, events, messages })
    : undefined;
  const communications = new SqliteCommunicationEventRepository(database);
  let attachmentService: ReturnType<typeof createDurableAttachmentService> | undefined;
  let attachmentStore: LocalArtifactStore | undefined;
  let attachmentInitialization: Promise<void> | undefined;
  const requireAttachmentService = () => {
    if (!attachmentService) throw new ArtifactError("storage_unavailable");
    return attachmentService;
  };
  const attachments: CoordinationAttachmentPort | undefined = artifactRepository === undefined
    ? undefined
    : Object.freeze({
        create: (input: Parameters<CoordinationAttachmentPort["create"]>[0]) =>
          requireAttachmentService().create(input),
        getMetadata: (input: Parameters<CoordinationAttachmentPort["getMetadata"]>[0]) =>
          requireAttachmentService().getMetadata(input),
        openDownload: (input: Parameters<CoordinationAttachmentPort["openDownload"]>[0]) =>
          requireAttachmentService().openDownload(input),
      });
  const initializeAttachments = (): Promise<void> => {
    if (!artifactRepository || !attachmentConfiguration) return Promise.resolve();
    attachmentInitialization ??= (async () => {
      const store = await LocalArtifactStore.open({
        rootDirectory: attachmentConfiguration.rootDirectory,
        repository: artifactRepository,
        maximumBytes: attachmentConfiguration.maximumBytes,
      });
      attachmentStore = store;
      attachmentService = createDurableAttachmentService({
        database,
        repository: artifactRepository,
        store,
        participantDirectory,
        maximumRequestBytes: attachmentConfiguration.maximumBytes + 64 * 1024,
      });
    })();
    return attachmentInitialization;
  };
  const attachmentCapabilityAvailable = () =>
    attachments !== undefined &&
    isCanonicalAttachmentsAuthority(currentAuthority("attachments"));
  const bootstrap = {
    getBootstrap: async (input: Parameters<ReturnType<typeof createBootstrapService>["getBootstrap"]>[0]) => {
      const primary = await botRepository.getBotByResidentBinding("jerry");
      if (!primary) throw new Error("primary Jerry Bot binding is unavailable");
      return createBootstrapService({ repository: new SqliteBootstrapRepository(database), participantDirectory,
        minimumClientBuild: 1, home: { id: "home_00000000-0000-7000-8000-000000000000", name: "Home23", primaryBotId: primary.id },
        connection: { mode: "loopback", displayName: "This Home23", reachable: true },
        capabilities: { channels: false, attachments: attachmentCapabilityAvailable(), search: false, push: false, eventReplay: true, botLifecycle: botLifecycleCapabilityAvailable() },
        limits: {
          attachmentBytes: attachmentCapabilityAvailable()
            ? attachmentConfiguration?.maximumBytes ?? 0
            : 0,
          attachmentCountPerMessage: attachmentCapabilityAvailable()
            ? attachmentConfiguration?.maximumCountPerMessage ?? 0
            : 0,
          jsonBodyBytes: 262_144,
          idempotencyKeyMinimum: 16,
          idempotencyKeyMaximum: 128,
        },
        availabilityPolicy: { degradedAfterMs: 30_000, offlineAfterMs: 120_000 },
      }).getBootstrap(input);
    },
  };
  const residentAgents = new Map<string, ResidentUdsAgentPort>();
  const residentInitializers: Array<readonly [string, () => Promise<void>]> = [];
  const lifecycle = createCoordinationLifecycle([{
    name: "resident-uds-clients",
    drain: async () => undefined,
    close: async () => {
      for (const residentAgent of residentAgents.values()) await residentAgent.close();
    },
  }, {
    name: "coordination-database",
    drain: async () => undefined,
    close: async () => database.close(),
  }]);
  type RecoveringMessageSubmission = CoordinationMessageSubmissionPort & {
    recoverResidentWork(): Promise<Readonly<{
      discovered: number;
      scheduled: number;
      refused: number;
    }>>;
  };
  let messageSubmission: RecoveringMessageSubmission | undefined;
  let composedChannelCoordinator: CoordinationChannelCoordinatorPort | undefined;
  if (isCanonicalMessagesAuthority(currentAuthority("messages"))) {
    const residentTargets = new Map<string, DirectMessageResidentTarget>();
    for (const residentSlug of ["jerry", "forrest"] as const) {
      if (config.flags[`coordination.resident.${residentSlug}.enabled`] !== true) continue;
      const residentConfig = config.residents[residentSlug];
      if (!residentConfig?.enabled) {
        throw new Error(`${residentSlug} resident configuration is required when its feature is enabled`);
      }
      const residentRootKey = Buffer.from(residentConfig.key, "hex");
      const credential = createResidentCredential({
        residentSlug,
        role: "resident",
        instanceId: residentConfig.clientInstanceId,
        keyVersion: residentConfig.keyVersion,
        rootKey: residentRootKey,
      });
      residentRootKey.fill(0);
      const client = new ResidentUdsClient({
        socketPath: residentConfig.socketPath,
        serverInstanceId: residentConfig.serverInstanceId,
        credential,
      });
      const residentAgent = new ResidentUdsAgentPort({ client, residentSlug });
      residentAgents.set(residentSlug, residentAgent);
      const residentCredentialContext = (requestId: string, correlationId: string) => ({
        requestId,
        correlationId,
        credential: {
          residentSlug,
          role: "resident" as const,
          instanceId: residentConfig.serverInstanceId,
          keyVersion: residentConfig.keyVersion,
        },
      });
      const attestedModelCatalog = async (identity: {
        requestId: string;
        correlationId: string;
      }) => {
        const { requestId, correlationId } = identity;
        const catalog = await residentAgent.modelCatalog({ requestId, correlationId });
        const context = residentCredentialContext(requestId, correlationId);
        const current = await botRepository.getBotByResidentBinding(residentSlug);
        if (!current) throw new Error(`${residentSlug} resident binding is unavailable`);
        const sameCapabilities = current.residentCapabilities.length === catalog.capabilities.length &&
          catalog.capabilities.every((capability) => current.residentCapabilities.includes(capability));
        const register = () => botDirectory.registerResident({
          context,
          botBinding: residentSlug,
          protocolVersion: 1,
          capabilities: catalog.capabilities,
        });
        if (current.activeInstanceId !== residentConfig.serverInstanceId ||
            current.activeKeyVersion !== residentConfig.keyVersion || !sameCapabilities) {
          await register();
        }
        try {
          await botDirectory.heartbeatResident({ context, availability: "available" });
        } catch (error) {
          if (!(error instanceof BotDirectoryError) || error.code !== "registration_stale") throw error;
          await register();
          await botDirectory.heartbeatResident({ context, availability: "available" });
        }
        return catalog;
      };
      residentInitializers.push([residentSlug, async () => {
        await attestedModelCatalog({
          requestId: generateCoordinationId("request"),
          correlationId: generateCoordinationId("correlation"),
        });
      }]);
      const residentContext = ({ principalId, requestId, correlationId }:
        Parameters<DirectMessageResidentTarget["context"]>[0]) => ({
        principalId,
        requestId,
        correlationId,
        identity: {
          kind: "resident" as const,
          resident: {
            requestId,
            correlationId,
            credential: {
              residentSlug,
              role: "resident" as const,
              instanceId: residentConfig.serverInstanceId,
              keyVersion: residentConfig.keyVersion,
            },
          },
        },
      });
      const artifactPromotion = artifactRepository === undefined
        ? undefined
        : createResidentArtifactPromotionPort({
            database,
            store: () => attachmentStore,
            participantDirectory,
            context: (binding) => residentContext({
              principalId: binding.holderPrincipalId,
              requestId: binding.requestId,
              correlationId: binding.correlationId,
            }),
          });
      residentTargets.set(residentSlug, Object.freeze({
        resident: new ResidentCoordinationAdapter(
          residentAgent,
          createM11ResidentCoordinationPort(leases),
          undefined,
          communications,
          artifactPromotion,
        ),
        holderInstanceId: residentConfig.serverInstanceId,
        models: { modelCatalog: attestedModelCatalog },
        context: residentContext,
      }));
    }
    {
      const resolveResident = (residentBinding: string) =>
        residentTargets.get(residentBinding);
      const onDemandBots = createOnDemandBotRuntime({
        botsRootDirectory: config.botRootDirectory,
        bots: { getBotById: (botId) => botRepository.getBotById(botId) },
        leases,
        communications,
      });
      const directSubmission = createDirectMessageSubmissionService({
        messages,
        communications,
        context: new SqliteDirectMessageContext(
          database,
          messages,
          async (attachmentSummaries) => {
            const store = attachmentStore;
            if (!store) throw new MessagingError("invalid_relation");
            return Object.freeze(await Promise.all(attachmentSummaries.map(async (summary) => {
              const reference = await store.verifiedLocalReference(summary);
              return Object.freeze({
                artifactId: reference.id,
                name: reference.name,
                contentType: reference.contentType,
                byteCount: reference.byteCount,
                sha256: reference.sha256,
                path: reference.path,
              });
            })));
          },
        ),
        work,
        leases,
        resolveResident,
        resolveExecutionTarget: onDemandBots.resolve,
        authority: { current: () => currentAuthority("messages") },
        beginWork: lifecycle.beginWork,
        recoveryIdentity: () => ({ requestId: generateCoordinationId("request"), correlationId: generateCoordinationId("correlation") }),
      });
      const groupSubmission = config.flags["coordination.channels.enabled"] === true
        ? (() => {
            const coordinator = createChannelCoordinator({
              database,
              rounds: createRoundService({ database, generateId: generateCoordinationId }),
              work,
              enabled: true,
              expectedAuthorityWriter: COORDINATION_MESSAGES_WRITER,
            });
            return createGroupChannelMessageService({
              messages,
              context: new SqliteGroupChannelMessageContext(database, messages),
              coordinator,
              work,
              leases,
              resolveResident,
              authority: { current: () => currentAuthority("messages") },
              recordMessage: createCanonicalMessageRecorder(communications),
              beginWork: lifecycle.beginWork,
              recoveryIdentity: () => ({
                requestId: generateCoordinationId("request"),
                correlationId: generateCoordinationId("correlation"),
              }),
            });
          })()
        : undefined;
      composedChannelCoordinator = groupSubmission?.channelCoordinator;
      messageSubmission = Object.freeze({
        submitMessage: async (
          input: Parameters<CoordinationMessageSubmissionPort["submitMessage"]>[0],
        ) => {
          const channel = database.readOne<{ kind: "direct" | "group" }>(
            "SELECT kind FROM channels WHERE id = ? AND lifecycle = 'active'",
            input.channelId,
          );
          if (!channel) throw new MessagingError("unknown_channel");
          if (channel.kind === "group") {
            if (!groupSubmission) {
              throw new ChannelCoordinatorError(
                "capability_off",
                "Channel coordination capability is off",
              );
            }
            return groupSubmission.submitMessage(input);
          }
          return directSubmission.submitMessage(input);
        },
        selectionOptions: (
          input: Parameters<NonNullable<CoordinationMessageSubmissionPort["selectionOptions"]>>[0],
        ) => directSubmission.selectionOptions(input),
        recoverResidentWork: async () => {
          const direct = await directSubmission.recoverResidentWork();
          const group = groupSubmission === undefined
            ? { discovered: 0, scheduled: 0, refused: 0 }
            : await groupSubmission.recoverResidentWork();
          return Object.freeze({
            discovered: direct.discovered + group.discovered,
            scheduled: direct.scheduled + group.scheduled,
            refused: direct.refused + group.refused,
          });
        },
      });
    }
  }
  const application = createCoordinationApplication({
    flags: config.flags,
    services: {
      auth, bootstrap, bots: botDirectory, channels, messages, unread, search,
      work, workControl, leases, events, communications,
      authorityEpochs,
      ...(attachments === undefined ? {} : { attachments }),
      ...(messageSubmission === undefined ? {} : { messageSubmission }),
      ...(activity === undefined ? {} : { activity }),
      ...(productionBotLifecycle === undefined ? {} : {
        botLifecycle: productionBotLifecycle.service,
        botLifecycleApi: productionBotLifecycle.api,
      }),
      ...(dependencies.channelCoordinator === undefined && composedChannelCoordinator === undefined
        ? {}
        : { channelCoordinator: dependencies.channelCoordinator ?? composedChannelCoordinator }),
    },
  });
  const server = createCoordinationHttpServer({
    application,
    lifecycle,
    host: config.host,
    port: config.port,
  });
  return Object.freeze({
    start: async () => {
      let address: Awaited<ReturnType<typeof server.start>>;
      try {
        workControl.recoverCancellations({
          requestId: generateCoordinationId("request"),
          correlationId: generateCoordinationId("correlation"),
        });
        await initializeAttachments();
        address = await server.start();
      } catch (error) {
        await server.drain().catch(() => undefined);
        throw error;
      }
      for (const [residentSlug, initialize] of residentInitializers) {
        void initialize().catch((error: unknown) => {
          console.error(`[home23-coordination] ${residentSlug} resident initialization failed:`,
            error instanceof Error ? error.message : error);
        });
      }
      if (messageSubmission) {
        void messageSubmission.recoverResidentWork().then((receipt) => {
          if (receipt.discovered > 0) {
            console.log(`[home23-coordination] direct-message recovery discovered=${receipt.discovered} scheduled=${receipt.scheduled} refused=${receipt.refused}`);
          }
        }).catch((error: unknown) => {
          console.error("[home23-coordination] direct-message recovery failed:", error instanceof Error ? error.message : error);
        });
      }
      return address;
    },
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
