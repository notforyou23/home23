import { executeChessOperation, resolveChessMoveTurnId } from '../chess/operations.js';
import { createHomeUpdateService } from '../home-update/service.js';
import { StockfishEngine } from '../chess/stockfish.js';
import { NativeChessService } from '../chess/service.js';
import { createChessTurnDispatcher } from '../chess/turns.js';
import { ConsoleCatalog } from "../console/catalog.js";
import { ConsoleService } from "../console/service.js";
import type { ConsoleRoot } from "../console/types.js";
import { createRequire } from "node:module";
import { CoordinationHttpError } from "../http/errors.js";
import type { MessagingActorContext } from '../channels/types.js';
import { createLiveVoiceService, type LiveVoiceService } from './live-voice.js';
import { createLiveVoiceTranscriptPort } from './live-voice-transcripts.js';
import { ProjectContinuityStore } from '../projects/continuity.js';
import { boundHistoricalContext } from '../../agent/historical-context.js';
import { createResidentNotifications } from './resident-notifications.js';
import { createResidentContactProjection } from './resident-contact.js';
import { projectResidentWork } from './resident-work-projection.js';
import { createResidentAssignments } from './resident-assignments.js';
import { dirname, join, resolve } from 'node:path';
import { createScheduledChannelTurns } from './scheduled-turns.js';
import { createBotInvocationService } from './bot-invocations.js';
import { resolveMessagingActor } from '../channels/access.js';
import { createChannelOperationConsumer } from './channel-operations.js';
import { createResidentOutcomeStore, workTerminalEvidence } from './resident-outcomes.js';
import { createWorkingThreadStop } from "./working-thread-stop.js";
import { createForegroundDetachmentConsumer } from "./foreground-detachments.js";
import { residentFence } from "../../coordination-adapter/resident-uds.js";
import type { CoordinationTurnOrigin } from "../../agent/types.js";
import { createHash } from "node:crypto";

import {
  ArtifactError,
  createDurableAttachmentService,
  createResidentArtifactPromotionPort,
  LocalArtifactStore,
  resolveArtifactActor,
  SqliteArtifactRepository,
  type ArtifactParticipantDirectory,
  type AttachmentSummary,
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
import { createResidentCredential, ResidentProtocolError, type ResidentCredential } from "../resident-protocol/index.js";
import { ResidentUdsClient, ResidentUdsServer } from "../transport/uds/index.js";
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
import {
  COORDINATION_COMPLETION_PATH,
  COORDINATION_UDS_SERVER_INSTANCE_ID,
  createSpecialistCompletionConsumer,
  type SpecialistCompletionResidentTarget,
} from "./specialist-completion.js";
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
import { ApnsClient } from "../../push/apns-client.js";
import {
  ApnsPusher,
  type ConnectedAgentsMessageNotification,
} from "../../push/apns-pusher.js";
import { ConnectedAgentsDeliveryStore } from "../../push/connected-agents-delivery-store.js";
import { ConnectedAgentsNotificationService } from "../../push/connected-agents.js";
import { DeviceRegistry } from "../../push/device-registry.js";

const RESIDENT_ATTESTATION_INTERVAL_MS = 20_000;

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
  const primaryResident = config.home?.primaryResident ?? "jerry";
  const database = openCoordinationDatabase({
    path: config.databasePath,
    applicationVersion: "home23-coordination-m12-shadow",
  });
  const residentContact = createResidentContactProjection(database,
    join(dirname(config.databasePath), 'resident-contact'),
    Object.entries(config.residents).filter(([, value]) => value.enabled).map(([slug]) => slug));
  const residentAssignments = createResidentAssignments(database);
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
  const nativeChess = new NativeChessService({ database, engine: new StockfishEngine() });
  const channels = createChannelService({ repository: messagingRepository, participantDirectory, cursorSigningKey: channelCursorKey });
  const projects = new ProjectContinuityStore(config.botRootDirectory,
    (context, channelId) => channels.getChannel({context, channelId}),
    async id => (await botRepository.getBotById(id))?.residentBinding.startsWith('bot-') === true);
  let helperRuntime: ReturnType<typeof createOnDemandBotRuntime> | undefined;
  let helperScheduledTurn: ((bot: import('../bots/index.js').BotDirectoryRecord, input: import('./scheduled-turns.js').ScheduledChannelTurn) => Promise<unknown>) | undefined;
  let helperChannelOperation: import('../../agent/types.js').ToolContext['coordinationChannelOperation'];

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
  const notificationConfiguration =
    config.flags["coordination.public_api.enabled"] === true
      ? config.push
      : undefined;
  const notificationClient = notificationConfiguration?.enabled === true
    ? new ApnsClient(notificationConfiguration.apns)
    : undefined;
  const notificationRegistry = notificationConfiguration?.enabled === true
    ? new DeviceRegistry(notificationConfiguration.registryPath)
    : undefined;
  const connectedAgentsDeliveryStore = notificationConfiguration?.enabled === true
    ? new ConnectedAgentsDeliveryStore(
        `${notificationConfiguration.registryPath}.connected-agents-delivery-receipts`,
      )
    : undefined;
  const notificationPusher = notificationClient && notificationRegistry && connectedAgentsDeliveryStore
    ? new ApnsPusher(notificationClient, notificationRegistry, "Home23", {
        connectedAgentsDeliveryStore,
        connectedAgentsBadgeCount: (registration) => {
          if (!registration.coordination_session_id || !registration.coordination_device_id) throw new Error('notification session is missing');
          const session = database.readOne<{ principalId: string }>(
            `SELECT principal_id AS principalId FROM client_sessions
             WHERE id=? AND device_id=? AND state='active'`,
            registration.coordination_session_id, registration.coordination_device_id);
          if (!session) throw new Error('notification session is no longer current');
          return new SqliteUnreadRepository(database).badgeCountForPrincipal(session.principalId);
        },
        connectedAgentsRegistrationIsCurrent: (registration) => {
          if (!registration.coordination_device_id ||
              !registration.coordination_session_id) return false;
          return database.readOne<{ current: number }>(
            `SELECT 1 AS current
             FROM client_sessions session
             JOIN devices device ON device.id = session.device_id
             WHERE session.id = ? AND session.device_id = ?
               AND session.state = 'active' AND device.status = 'active'`,
            registration.coordination_session_id,
            registration.coordination_device_id,
          )?.current === 1;
        },
      })
    : undefined;
  const deviceNotifications = notificationPusher && notificationRegistry
    ? new ConnectedAgentsNotificationService(
        notificationRegistry,
        notificationPusher,
        notificationConfiguration!.apns.bundle_id,
        {
          conversationTitle: (channelId) =>
            database.readOne<{ title: string }>(
              "SELECT title FROM channels WHERE id = ?",
              channelId,
            )?.title ?? null,
          macosBundleId: notificationConfiguration!.apns.macos_bundle_id,
        },
      )
    : undefined;
  const prepareConnectedAgentsNotificationRecovery = ():
  readonly ConnectedAgentsMessageNotification[] => {
    if (!connectedAgentsDeliveryStore || !notificationPusher) return Object.freeze([]);
    let checkpoint = connectedAgentsDeliveryStore.checkpoint();
    if (checkpoint === undefined) {
      const latest = database.readOne<{
        messageId: string;
        createdAt: string;
      }>(
        `SELECT m.id AS messageId, m.created_at AS createdAt
         FROM messages m
         WHERE m.author_kind = 'bot' AND m.kind = 'result'
         ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
      );
      let baseline = latest
        ? { created_at: latest.createdAt, message_id: latest.messageId }
        : null;
      // A pre-checkpoint receipt means a prior process already began the new
      // delivery protocol. Start immediately before its earliest Message so a
      // release upgrade resumes it without waking on unrelated old history.
      const receiptMessageIds = [...new Set(
        connectedAgentsDeliveryStore.snapshot().map(receipt => receipt.message_id),
      )];
      if (receiptMessageIds.length > 0) {
        const earliest = database.readOne<{ messageId: string; createdAt: string }>(
          `SELECT id AS messageId, created_at AS createdAt FROM messages
           WHERE id IN (${receiptMessageIds.map(() => "?").join(",")})
             AND author_kind = 'bot' AND kind = 'result'
           ORDER BY created_at ASC, id ASC LIMIT 1`,
          ...receiptMessageIds,
        );
        if (earliest) {
          const predecessor = database.readOne<{ messageId: string; createdAt: string }>(
            `SELECT id AS messageId, created_at AS createdAt FROM messages
             WHERE author_kind = 'bot' AND kind = 'result'
               AND (created_at < ? OR (created_at = ? AND id < ?))
             ORDER BY created_at DESC, id DESC LIMIT 1`,
            earliest.createdAt,
            earliest.createdAt,
            earliest.messageId,
          );
          baseline = predecessor
            ? { created_at: predecessor.createdAt, message_id: predecessor.messageId }
            : null;
        }
      }
      checkpoint = connectedAgentsDeliveryStore.initializeCheckpoint(baseline);
    }
    const parameters: Array<string> = [];
    const afterCheckpoint = checkpoint === null
      ? ""
      : ` AND (m.created_at > ? OR (m.created_at = ? AND m.id > ?))`;
    if (checkpoint !== null) {
      parameters.push(checkpoint.created_at, checkpoint.created_at, checkpoint.message_id);
    }
    const rows = database.readAll<{
      conversationId: string;
      channelId: string;
      messageId: string;
      createdAt: string;
      workId: string | null;
      displayName: string;
      conversationTitle: string | null;
      preview: string | null;
      hasAttachments: number;
    }>(
      `SELECT h.id AS conversationId, m.channel_id AS channelId,
              m.id AS messageId, m.created_at AS createdAt,
              m.work_id AS workId, m.author_display_name AS displayName,
              c.title AS conversationTitle, m.body_text AS preview,
              EXISTS (
                SELECT 1 FROM message_artifacts link WHERE link.message_id = m.id
              ) AS hasAttachments
       FROM messages m
       JOIN conversation_handles h ON h.channel_id = m.channel_id
       JOIN channels c ON c.id = m.channel_id
       WHERE m.author_kind = 'bot' AND m.kind = 'result'
         AND m.stored_visibility = 'visible'
         AND NOT EXISTS (
           SELECT 1 FROM messages tombstone
           WHERE tombstone.tombstones_message_id = m.id
         )${afterCheckpoint}
       ORDER BY m.created_at ASC, m.id ASC`,
      ...parameters,
    );
    return Object.freeze(rows.map(row => Object.freeze({
      conversationId: row.conversationId,
      channelId: row.channelId,
      messageId: row.messageId,
      createdAt: row.createdAt,
      ...(row.workId === null ? {} : { workId: row.workId }),
      displayName: row.displayName,
      ...(row.conversationTitle ? { conversationTitle: row.conversationTitle } : {}),
      preview: row.preview,
      hasAttachments: Boolean(row.hasAttachments),
    })));
  };
  const notificationCapabilityAvailable = () => deviceNotifications !== undefined;
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
      const primary = await botRepository.getBotByResidentBinding(primaryResident);
      if (!primary) throw new Error("primary resident Bot binding is unavailable");
      return createBootstrapService({ repository: new SqliteBootstrapRepository(database), participantDirectory,
        minimumClientBuild: 1, home: { id: config.home?.id ?? "home_00000000-0000-7000-8000-000000000000", name: config.home?.name ?? "Home23", primaryBotId: primary.id },
        connection: { mode: "loopback", displayName: "This Home23", reachable: true },
        capabilities: { channels: config.flags["coordination.channels.enabled"] === true && isCanonicalMessagesAuthority(currentAuthority("messages")), attachments: attachmentCapabilityAvailable(), search: config.flags["coordination.search.canonical"] === true, push: notificationCapabilityAvailable(), eventReplay: true, botLifecycle: botLifecycleCapabilityAvailable() },
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
  const completionCredentials: ResidentCredential[] = [];
  const completionTargets = new Map<string, SpecialistCompletionResidentTarget>();
  let completionIngress: ResidentUdsServer | undefined;
  const residentInitializers: Array<readonly [string, () => Promise<void>]> = [];
  const residentAttestationFailures = new Set<string>();
  let residentAttestationTimer: NodeJS.Timeout | undefined;
  let residentWorkProjectionTimer: NodeJS.Timeout | undefined;
  let residentAttestationRun: Promise<void> | undefined;
  const refreshResidentAttestations = (): Promise<void> => {
    if (residentAttestationRun) return residentAttestationRun;
    const run = Promise.all(residentInitializers.map(async ([residentSlug, initialize]) => {
      try {
        await initialize();
        if (residentAttestationFailures.delete(residentSlug)) {
          console.log(`[home23-coordination] ${residentSlug} resident attestation recovered`);
        }
      } catch (error) {
        if (!residentAttestationFailures.has(residentSlug)) {
          residentAttestationFailures.add(residentSlug);
          console.error(`[home23-coordination] ${residentSlug} resident initialization failed:`,
            error instanceof Error ? error.message : error);
        }
      }
    })).then(() => undefined).finally(() => {
      if (residentAttestationRun === run) residentAttestationRun = undefined;
    });
    residentAttestationRun = run;
    return run;
  };
  const stopResidentAttestations = async () => {
    if (outcomeTimer) clearInterval(outcomeTimer);
    if (residentWorkProjectionTimer) clearInterval(residentWorkProjectionTimer);
    if (residentAttestationTimer) clearInterval(residentAttestationTimer);
    residentAttestationTimer = undefined;
    await residentAttestationRun;
  };
  let liveVoice: LiveVoiceService | undefined;
  const lifecycle = createCoordinationLifecycle([{
    name: "live-voice",
    drain: async () => liveVoice?.drain(),
    close: async () => liveVoice?.drain(),
  }, {
    name: "coordination-completion-ingress",
    drain: async () => completionIngress?.close(),
    close: async () => completionIngress?.close(),
  }, {
    name: "resident-attestation",
    drain: stopResidentAttestations,
    close: stopResidentAttestations,
  }, {
    name: "helper-services",
    drain: async () => helperRuntime?.close(),
    close: async () => helperRuntime?.close(),
  }, {
    name: "resident-uds-clients",
    drain: async () => undefined,
    close: async () => {
      for (const residentAgent of residentAgents.values()) await residentAgent.close();
    },
  }, ...(notificationClient === undefined ? [] : [{
    name: "connected-agents-apns",
    drain: async () => {
      await notificationPusher?.drainConnectedAgentsDeliveries();
    },
    close: async () => {
      await notificationPusher?.drainConnectedAgentsDeliveries();
      notificationClient.close();
    },
  }]), {
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
  let outcomeTimer: ReturnType<typeof setInterval> | undefined;
  let processResidentOutcomes: (() => Promise<void>) | undefined;
  let reconcileChessTurns: (() => Promise<void>) | undefined;
  let reconcileScheduledTurns: (() => void) | undefined;
  let reconcileBotInvocations: (() => Promise<void>) | undefined;
  let stopInvokedBot: ((workId: string) => Promise<void>) | undefined;
  let dispatchWorkingThread: ((workId: string) => Promise<void>) | undefined;
  let awaitWorkingSettlement: ((workId: string) => Promise<void>) | undefined;
  const residentAdapters = new Map<string, ResidentCoordinationAdapter>();
  let directMessageContext: SqliteDirectMessageContext | undefined;
  let groupMessageContext: SqliteGroupChannelMessageContext | undefined;
  if (isCanonicalMessagesAuthority(currentAuthority("messages"))) {
    const residentTargets = new Map<string, DirectMessageResidentTarget>();
    for (const legacySlug of ["jerry", "forrest"] as const) {
      if (config.flags[`coordination.resident.${legacySlug}.enabled`] === true && !config.residents[legacySlug]?.enabled) {
        throw new Error(`${legacySlug} resident configuration is required when its feature is enabled`);
      }
    }
    for (const [residentSlug, residentConfig] of Object.entries(config.residents)) {
      if (!residentConfig.enabled) continue;
      // Legacy feature flags remain independent kill switches for existing homes.
      if ((residentSlug === "jerry" || residentSlug === "forrest") &&
          config.flags[`coordination.resident.${residentSlug}.enabled`] !== true) continue;
      const residentRootKey = Buffer.from(residentConfig.key, "hex");
      const credential = createResidentCredential({
        residentSlug,
        role: "resident",
        instanceId: residentConfig.clientInstanceId,
        keyVersion: residentConfig.keyVersion,
        rootKey: residentRootKey,
      });
      residentRootKey.fill(0);
      completionCredentials.push(credential);
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
      completionTargets.set(residentSlug, Object.freeze({
        serverInstanceId: residentConfig.serverInstanceId,
        clientInstanceId: residentConfig.clientInstanceId,
        keyVersion: residentConfig.keyVersion,
        context: residentContext,
        ...(artifactPromotion === undefined ? {} : { artifactPromotion }),
      }));
      const residentAdapter = new ResidentCoordinationAdapter(
          residentAgent,
          createM11ResidentCoordinationPort(leases),
          undefined,
          communications,
          artifactPromotion,
        );
      residentAdapters.set(residentSlug, residentAdapter);
      residentTargets.set(residentSlug, Object.freeze({
        resident: residentAdapter,
        holderInstanceId: residentConfig.serverInstanceId,
        models: { modelCatalog: attestedModelCatalog },
        context: residentContext,
      }));
    }
    {
      const resolveResident = (residentBinding: string) =>
        residentTargets.get(residentBinding);
      const onDemandBots = helperRuntime = createOnDemandBotRuntime({
        botsRootDirectory: config.botRootDirectory,
        bots: { getBotById: (botId) => botRepository.getBotById(botId) },
        leases,
        communications,
        scheduledTurn: (bot, input) => {
          if (!helperScheduledTurn) throw new Error('House scheduler is starting');
          return helperScheduledTurn(bot, input);
        },
        channelOperation: input => {
          if (!helperChannelOperation) throw new Error('House channel services are starting');
          return helperChannelOperation(input);
        },
        ...(artifactRepository === undefined
          ? {}
          : {
              artifactPromotion: (bot) => createResidentArtifactPromotionPort({
                database,
                store: () => attachmentStore,
                participantDirectory,
                context: (binding) => ({
                  principalId: binding.holderPrincipalId,
                  requestId: binding.requestId,
                  correlationId: binding.correlationId,
                  identity: {
                    kind: "on_demand_bot" as const,
                    bot: { botId: bot.id, residentBinding: bot.residentBinding },
                  },
                }),
              }),
              inputAttachmentRoot: attachmentConfiguration!.rootDirectory,
            }),
      });
      stopInvokedBot = async (workId) => {
        const current = leases.current(workId);
        if (current.work.state !== 'cancelling') return;
        const bot = await botRepository.getBotById(current.work.targetPrincipalId);
        if (!bot) throw new Error('Invoked Bot identity unavailable');
        const binding = { workId, attemptId: current.attempt.id, leaseId: current.lease.id,
          holderPrincipalId: current.attempt.holderPrincipalId, holderInstanceId: current.attempt.holderInstanceId,
          authorityReference: current.attempt.authorityReference, fencingToken: current.attempt.fencingToken,
          requestId: generateCoordinationId('request'), correlationId: generateCoordinationId('correlation') };
        const resident = residentAdapters.get(bot.residentBinding);
        if (resident) await resident.stopRevoked(binding);
        else await onDemandBots.stopRevoked(bot.id, binding);
      };
      const materializeAttachments = async (
        attachmentSummaries: readonly AttachmentSummary[],
      ) => {
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
      };
      directMessageContext = new SqliteDirectMessageContext(
        database,
        messages,
        materializeAttachments,
      );
      const directSubmission = createDirectMessageSubmissionService({
        outcomes: createResidentOutcomeStore(database),
        messages,
        communications,
        ...(deviceNotifications === undefined ? {} : { notifications: deviceNotifications }),
        context: directMessageContext,
        recoverWorkingContext: async (child) => {
          if (child.roundId === null) return directMessageContext!.recover(child);
          if (!groupMessageContext) throw new Error("Working Thread group context unavailable");
          const prepared = await groupMessageContext.recover(child);
          const target = prepared.selectedTargets.find(t => t.targetPrincipalId === child.targetPrincipalId);
          if (!target) throw new Error("Working Thread resident is not the selected group target");
          return { originMessageId: prepared.originMessageId, prepared: {
            ...target, channelId: prepared.channelId, conversationId: prepared.conversationId,
            instruction: prepared.instruction, attachments: prepared.attachments, manifest: prepared.manifest,
            historyBackfill: boundHistoricalContext(prepared.transcript
              .filter(message => message.messageId !== prepared.originMessageId)
              .map(message => ({ messageId: message.messageId,
              sequence: message.sequence, role: message.authorPrincipalId === child.targetPrincipalId ? "assistant" as const : "user" as const,
              text: message.text, createdAt: message.createdAt }))),
          } };
        },
        work,
        leases,
        resolveResident,
        resolveExecutionTarget: onDemandBots.resolve,
        authority: { current: () => currentAuthority("messages") },
        beginWork: lifecycle.beginWork,
        recoveryIdentity: () => ({ requestId: generateCoordinationId("request"), correlationId: generateCoordinationId("correlation") }),
      });
      dispatchWorkingThread = directSubmission.dispatchWorkingThread;
      processResidentOutcomes = directSubmission.processResidentOutcomes;
      awaitWorkingSettlement = directSubmission.awaitSettlement;
      const groupSubmission = config.flags["coordination.channels.enabled"] === true
        ? (() => {
            groupMessageContext = new SqliteGroupChannelMessageContext(
              database,
              messages,
              materializeAttachments,
            );
            const coordinator = createChannelCoordinator({
              presentation: messageId => {
                const row=database.readOne<{kind:string}>("SELECT aggregate_kind AS kind FROM events WHERE aggregate_version=1 AND ((aggregate_kind='bot_invocation' AND aggregate_id=?) OR (aggregate_kind='scheduled_channel_run' AND json_extract(payload_json,'$.messageId')=?))",messageId,messageId);
                return row ? {title:row.kind==='bot_invocation'?'Helper assignment':'Scheduled channel run',summary:row.kind==='bot_invocation'?'A helper assignment requested by Jerry.':'A scheduled assignment in this topic channel.'} : undefined;
              },
              database,
              rounds: createRoundService({ database, generateId: generateCoordinationId }),
              work,
              enabled: true,
              expectedAuthorityWriter: COORDINATION_MESSAGES_WRITER,
            });
            return createGroupChannelMessageService({
              joinedInvocation: messageId => !!database.readOne("SELECT sequence FROM events WHERE aggregate_version = 1 AND ((aggregate_kind = 'bot_invocation' AND aggregate_id = ?) OR (aggregate_kind = 'scheduled_channel_run' AND json_extract(payload_json, '$.messageId') = ?))", messageId, messageId),
              messages,
              context: groupMessageContext,
              coordinator,
              work,
              leases,
              resolveResident,
              resolveExecutionTarget: async (target) => {
                const bot = await botRepository.getBotById(target.targetBotId);
                return onDemandBots.resolve({
                  ...target,
                  conversationId: bot?.conversationId ?? target.conversationId,
                });
              },
              authority: { current: () => currentAuthority("messages") },
              recordMessage: createCanonicalMessageRecorder(
                communications,
                deviceNotifications,
              ),
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
        ) => {
          if (input.botId) {
            if (!groupSubmission) throw new MessagingError("request_invalid");
            return groupSubmission.selectionOptions(input);
          }
          return directSubmission.selectionOptions(input);
        },
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
  if (messageSubmission && directMessageContext && completionCredentials.length > 0) {
    const consumeCompletion = createSpecialistCompletionConsumer({
      work,
      leases,
      messages,
      communications,
      directContext: directMessageContext,
      ...(groupMessageContext === undefined ? {} : { groupContext: groupMessageContext }),
      resolveResident: (residentBinding) => completionTargets.get(residentBinding),
      assertAuthority: () => {
        if (!isCanonicalMessagesAuthority(currentAuthority("messages"))) {
          throw new MessagingError("authority_unavailable");
        }
      },
      recordMessage: createCanonicalMessageRecorder(communications, deviceNotifications),
      beginWork: lifecycle.beginWork,
    });
    const detachments = createForegroundDetachmentConsumer({
      database, work,
      resolveResident: (slug) => completionTargets.get(slug) ?? null,
      schedule: (workId) => { queueMicrotask(() => {
        void dispatchWorkingThread?.(workId).catch((error) => console.error("[home23-coordination] Working Thread dispatch failed", error));
      }); },
    });
    const executiveContext = (origin: CoordinationTurnOrigin): MessagingActorContext => {
      const helper = database.readOne<{id:string; residentBinding:string}>("SELECT id,resident_binding AS residentBinding FROM bots WHERE id=? AND lifecycle='active' AND resident_binding LIKE 'bot-%'",origin.holderPrincipalId);
      if (helper && origin.authorityReference===`bot:${helper.id}`) return {principalId:helper.id,
        requestId:generateCoordinationId('request'),correlationId:generateCoordinationId('correlation'),
        identity:{kind:'on_demand_bot',bot:{botId:helper.id,residentBinding:helper.residentBinding}}};
      const resident = completionTargets.get(origin.authorityReference.replace(/^resident:/,''));
      if (!resident) throw new Error('House agent unavailable');
      return resident.context({ principalId: origin.holderPrincipalId,
        requestId: generateCoordinationId('request'), correlationId: generateCoordinationId('correlation') });
    };
    const botInvocations = createBotInvocationService({
      database, work, leases, channels, submit: messageSubmission, beginWork: lifecycle.beginWork,
      authorize: detachments.authorize, context: executiveContext,
      currentCredential: (credential, origin) => {
        if (credential.role==='on_demand_bot') return credential.instanceId===`home23-core-on-demand:${origin.holderPrincipalId}` &&
          origin.holderInstanceId===credential.instanceId && origin.authorityReference===`bot:${origin.holderPrincipalId}` &&
          !!database.readOne("SELECT id FROM bots WHERE id=? AND resident_binding=? AND lifecycle='active' AND active_instance_id IS NULL",origin.holderPrincipalId,credential.residentSlug);
        const resident = completionTargets.get(credential.residentSlug);
        return !!resident && resident.clientInstanceId===credential.instanceId && resident.keyVersion===credential.keyVersion &&
          origin.holderInstanceId===resident.serverInstanceId && origin.authorityReference===`resident:${credential.residentSlug}`;
      },
      stopChild: workId => stopInvokedBot?.(workId) ?? Promise.resolve(),
    });
    reconcileBotInvocations = botInvocations.reconcile;
    const scheduledTurns = createScheduledChannelTurns({database, channels, submit: messageSubmission, beginWork: lifecycle.beginWork,
      canDispatch: input => !input.jobId.startsWith('native-chess:') || !!database.readOne(
        "SELECT i.id FROM chess_turn_intents i JOIN chess_games g ON g.id=i.game_id AND g.version=i.game_version AND g.status='active' WHERE i.run_id=? AND i.status IN ('queued','dispatched')", input.runId),
      expireWork: workId => {
        const current = work.get(workId);
        if (!current) throw new Error('Scheduled execution unavailable');
        const bot = database.readOne<{residentBinding:string}>("SELECT resident_binding AS residentBinding FROM bots WHERE principal_id=?",current.targetPrincipalId);
        if (!bot) throw new Error('Scheduling agent unavailable');
        const ids = {principalId:current.targetPrincipalId,requestId:generateCoordinationId('request'),correlationId:generateCoordinationId('correlation')};
        const context: MessagingActorContext = bot.residentBinding.startsWith('bot-')
          ? {...ids,identity:{kind:'on_demand_bot',bot:{botId:current.targetPrincipalId,residentBinding:bot.residentBinding}}}
          : completionTargets.get(bot.residentBinding)!.context(ids);
        const result = workControl.cancel({workId,idempotencyKey:`scheduled-deadline:${workId}`,context});
        if (result.outcome === 'cancellation_requested' && queueJoinedStop(workId)) {
          reconcileJoinedStops();
        }
      },
      context: (botId) => {
        if (botId) {
          const bot=database.readOne<{residentBinding:string}>("SELECT resident_binding AS residentBinding FROM bots WHERE id=? AND lifecycle='active'",botId);
          if (!bot) throw new Error('Scheduling agent is unavailable');
          if (bot.residentBinding.startsWith('bot-')) return {principalId:botId,requestId:generateCoordinationId('request'),correlationId:generateCoordinationId('correlation'),identity:{kind:'on_demand_bot',bot:{botId,residentBinding:bot.residentBinding}}};
          const resident=completionTargets.get(bot.residentBinding);
          if (!resident) throw new Error('Scheduling resident unavailable');
          return resident.context({principalId:botId,requestId:generateCoordinationId('request'),correlationId:generateCoordinationId('correlation')});
        }
        const resident = completionTargets.get(primaryResident);
        if (!resident) throw new Error('Executive resident unavailable');
        return resident.context({principalId:database.readOne<{id:string}>("SELECT id FROM bots WHERE resident_binding = ? AND lifecycle = 'active'",primaryResident)!.id,requestId:generateCoordinationId('request'),correlationId:generateCoordinationId('correlation')});
      }});
    reconcileChessTurns = createChessTurnDispatcher({ chess: nativeChess, accepting: () => lifecycle.state() === 'accepting', run: scheduledTurns.run });
    helperScheduledTurn=(bot,input)=>scheduledTurns.run(input,bot.id);
    reconcileScheduledTurns = scheduledTurns.reconcile;
    const channelOperations = createChannelOperationConsumer({
      chess: async (context, origin, args, key) => {
        const actor = { principalId: context.principalId,
          ...((args.operation === 'chess_move' || (args.operation === 'chess_control' && args.action === 'resign')) && typeof args.gameId === 'string'
            ? { turnId: resolveChessMoveTurnId(database, origin, context.principalId, args.gameId) }
            : {}) };
        return executeChessOperation(nativeChess, actor, args, key);
      },
      authorize: detachments.authorize,
      authorizeRead: detachments.authorizeRead,
      assertCurrentDirection: id => { residentAssignments.assertOpen(id); detachments.assertCurrentDirection(id); },
      invoke: botInvocations.call,
      channels,
      listBots: () => botDirectory.listVisibleBots(),
      reportOutcome: residentAssignments.report,
      cancelWork: async (context, workId, idempotencyKey) => {
        const assigned = work.get(workId);
        if (!assigned || assigned.targetPrincipalId !== context.principalId) throw new Error('Work is outside this resident assignment scope');
        return stoppedWorkControl.cancel({ context, workId, idempotencyKey });
      },
      workDiagnostics: (principalId, args, origin) => {
        const id = typeof args.work_id === 'string' ? args.work_id : null;
        if (args.operation === 'work_status' && !id) throw new Error('work_id is required');
        const limit = Math.min(100, Math.max(1, Math.floor(Number(args.limit) || 20)));
        const rows = database.readAll(`SELECT w.id, w.channel_id AS channelId, w.state,
          w.terminal_reason AS terminalReason, w.current_attempt_id AS attemptId,
          p.parent_work_id AS parentWorkId, json_extract(p.assignment_json, '$.toolName') AS toolName,
          coalesce(t.title, substr(m.body_text,1,160), 'Work') AS title,
          coalesce(t.summary, m.body_text) AS summary, m.id AS originMessageId,
          m.body_text AS originalRequest, w.created_at AS createdAt, w.terminal_at AS terminalAt
          FROM works w LEFT JOIN work_planned_invocations p ON p.work_id = w.id
          LEFT JOIN work_thread_presentations t ON t.work_id=w.id
          LEFT JOIN messages m ON m.id=w.origin_message_id
          WHERE w.target_principal_id = ? ${id ? 'AND w.id = ?' : args.include_terminal === true ? '' : "AND w.state NOT IN ('succeeded','failed','cancelled')"}
          ${!id && args.assignments_only === true ? "AND (w.kind='resident_work_thread' OR t.work_id IS NOT NULL)" : ''}
          ORDER BY w.created_at DESC LIMIT ?`, principalId, ...(id ? [id] : []), limit);
        const unseenOwnerMessages = database.readAll(`SELECT m.id AS messageId,m.channel_sequence AS sequence,m.body_text AS text,m.created_at AS createdAt
          FROM works w JOIN context_manifests c ON c.id=w.context_manifest_id
          JOIN messages m ON m.channel_id=w.channel_id AND m.channel_sequence>c.channel_watermark
          WHERE w.id=? AND m.author_kind='owner' AND m.kind='text' AND m.stored_visibility='visible'
            AND NOT EXISTS(SELECT 1 FROM events e WHERE e.aggregate_kind='scheduled_channel_run'
              AND e.aggregate_version=1 AND json_extract(e.payload_json,'$.messageId')=m.id)
          ORDER BY m.channel_sequence`, origin.workId);
        const assignments = residentAssignments.list(principalId, args.include_terminal === true, limit);
        const ownerContact = database.readOne<{ messageId: string; text: string }>(`SELECT m.id AS messageId,m.body_text AS text
          FROM works w JOIN messages m ON m.id=w.origin_message_id WHERE w.id=?
          AND w.kind IN ('resident_turn','channel.bot_turn') AND m.author_kind='owner' AND m.kind='text' AND m.body_text IS NOT NULL AND m.stored_visibility='visible'
          AND NOT EXISTS(SELECT 1 FROM resident_outcomes o WHERE o.review_work_id=w.id)
          AND NOT EXISTS(SELECT 1 FROM events e WHERE e.aggregate_kind='scheduled_channel_run'
            AND e.aggregate_version=1 AND json_extract(e.payload_json,'$.messageId')=m.id)`, origin.workId);
        return { registry: 'canonical', work: !id && args.assignments_only === true ? assignments : id ? rows.map(row => ({ ...row, terminalEvidence: workTerminalEvidence(database, id) })) : rows,
          assignments, unseenOwnerMessages, ...residentAssignments.direction(origin.workId), ownerContact: ownerContact ?? null };
      },
      botOperation: async (context, args, key) => {
        if (!productionBotLifecycle || !botLifecycleCapabilityAvailable()) throw new Error('Bot lifecycle unavailable');
        const actor = await resolveMessagingActor(context, participantDirectory, 'message:send');
        if (actor.kind !== 'bot') throw new Error('House agent authority required');
        const operation = String(args.operation).replace('bot_', '') as 'create' | 'archive' | 'restore';
        const target = operation === 'create'
          ? derivePersistentBotBinding({ requestId: key, displayName: String(args.displayName ?? '') })
          : String(args.botId ?? '');
        const policy = {
          action: { actorPrincipalId: actor.principalId, operation: `bot_lifecycle.${operation}`, target, parameters: {} },
          factSource: { kind: 'trusted_policy_boundary' as const, reference: 'home23:house-agent-mandate:v1' },
          standing: { scope: 'within' as const, delegation: 'within' as const, budget: 'within' as const,
            audience: 'within' as const, allowlist: 'within' as const },
          impactClasses: [], contextAccess: { kind: 'none' as const },
        };
        const common = { requestId: key, correlationId: context.correlationId, actorPrincipalId: actor.principalId,
          executiveActor: actor, policy, expectedAuthorityEpoch: currentAuthority('bot_lifecycle')!.epoch };
        return operation === 'create'
          ? productionBotLifecycle.service.create({ ...common, displayName: String(args.displayName ?? ''), purpose: String(args.purpose ?? '') })
          : productionBotLifecycle.service.control({ ...common, botId: target, operation });
      },
      history: (context,args,origin) => messages.listMessages({context,
        channelId: typeof args.channelId==='string'?args.channelId:origin.channelId,
        limit: Math.min(100,Math.max(1,Number(args.limit)||50)),
        ...(Number.isSafeInteger(args.beforeSequence)?{beforeSequence:args.beforeSequence as number}:{})}),
      project: (context, origin, args) => {
        const channelId = typeof args.channelId==='string' ? args.channelId : origin.channelId;
        return args.operation==='project_write'
          ? projects.write(context,{channelId,name:String(args.name??''),text:args.text as string,expectedRevision:String(args.expectedRevision??'')})
          : projects.read(context,channelId);
      },
      context: executiveContext,
    });
    helperChannelOperation = input => {
      const bot = database.readOne<{residentBinding:string}>("SELECT resident_binding AS residentBinding FROM bots WHERE id=? AND lifecycle='active' AND resident_binding LIKE 'bot-%'", input.origin.holderPrincipalId);
      if (!bot) throw new Error('Helper identity unavailable');
      return channelOperations({role:'on_demand_bot',residentSlug:bot.residentBinding,instanceId:input.origin.holderInstanceId,keyVersion:0},input);
    };
    const notifyResident = createResidentNotifications({ database, messages,
      resolveResident: slug => completionTargets.get(slug),
      recordMessage: createCanonicalMessageRecorder(communications, deviceNotifications) });
    const detachmentPath = "/internal/v1/foreground-detachments";
    completionIngress = new ResidentUdsServer({
      socketPath: config.socketPath,
      serverInstanceId: COORDINATION_UDS_SERVER_INSTANCE_ID,
      credentials: completionCredentials,
      validateFence: (fence, request) => {
        if (request.method !== "POST") return false;
        if (request.path === COORDINATION_COMPLETION_PATH || request.path === "/internal/v1/scheduled-turns" || request.path === "/internal/v1/resident-notifications") return fence === null;
        if (request.path !== detachmentPath && request.path !== `${detachmentPath}/start` && request.path !== "/internal/v1/channel-operations") return false;
        const payload = request.payload as unknown as { parentOrigin?: CoordinationTurnOrigin; origin?: CoordinationTurnOrigin };
        const origin = request.path === detachmentPath ? payload?.parentOrigin : payload?.origin;
        try { return !!origin && fence === residentFence(origin); } catch { return false; }
      },
      handleRequest: (request, context) => {
        if (!isCanonicalMessagesAuthority(currentAuthority("messages"))) throw new MessagingError("authority_unavailable");
        if (request.method === "POST" && request.path === "/internal/v1/resident-notifications") {
          const done = lifecycle.beginWork();
          return notifyResident(context.credential, request.payload).finally(done);
        }
        if (request.method === "POST" && request.path === "/internal/v1/scheduled-turns") {
          const resident = completionTargets.get(primaryResident);
          if (config.flags['coordination.channels.enabled'] !== true || !resident || context.credential.residentSlug !== primaryResident ||
            context.credential.instanceId !== resident.clientInstanceId || context.credential.keyVersion !== resident.keyVersion)
            throw new MessagingError('authority_unavailable');
          return scheduledTurns.run(request.payload).then(value => JSON.parse(JSON.stringify(value)));
        }
        if (request.method === "POST" && request.path === "/internal/v1/channel-operations") {
          const operation = (request.payload as unknown as { args?: { operation?: unknown } })?.args?.operation;
          if (typeof operation !== 'string' || ((!operation.startsWith('bot_') || operation === 'bot_invoke') && config.flags['coordination.channels.enabled'] !== true))
            throw new MessagingError('authority_unavailable');
          return channelOperations(context.credential, request.payload).then(value => JSON.parse(JSON.stringify(value)));
        }
        if (request.method === "POST" && request.path === detachmentPath) {
          return { ...detachments.admit({ credential: context.credential, request: request.payload }) };
        }
        if (request.method === "POST" && request.path === `${detachmentPath}/start`) {
          const payload = request.payload as unknown as { origin: CoordinationTurnOrigin; invocationId: string };
          const result = detachments.start({ credential: context.credential, origin: payload.origin, invocationId: payload.invocationId });
          return { accepted: result.started, workId: payload.origin.workId, invocationId: payload.invocationId };
        }
        if (request.method !== "POST" || request.path !== COORDINATION_COMPLETION_PATH) {
          throw new ResidentProtocolError("request_invalid", "unknown coordination operation");
        }
        return consumeCompletion(request.payload, context);
      },
    });
  }
  const stopRevokedWorkingThread = createWorkingThreadStop({
    database, work, leases, residentAdapters, residentAgents,
    awaitSettlement: (workId) => awaitWorkingSettlement?.(workId) ?? Promise.resolve(),
  });
  const pendingJoinedStops = new Set<string>();
  const stopsInFlight = new Set<string>();
  const queueJoinedStop = (workId: string): boolean => {
    const joined = database.readOne<{id:string}>("SELECT w.id FROM works w WHERE w.id=? AND w.state='cancelling' AND (w.kind='resident_work_thread' OR EXISTS(SELECT 1 FROM work_thread_presentations p WHERE p.work_id=w.id))", workId);
    if (!joined) return false;
    pendingJoinedStops.add(workId);
    return true;
  };
  const reconcileJoinedStops = () => {
    for (const workId of pendingJoinedStops) {
      if (stopsInFlight.has(workId)) continue;
      const done=lifecycle.beginWork();stopsInFlight.add(workId);
      void Promise.resolve().then(async()=>{
        await stopInvokedBot?.(workId);
        await stopRevokedWorkingThread(workId,{requestId:generateCoordinationId('request'),correlationId:generateCoordinationId('correlation')});
      }).catch(error=>console.error('[joined-stop] awaiting confirmation',error))
        .finally(()=>{
          stopsInFlight.delete(workId);
          try {
            if (work.get(workId)?.state !== 'cancelling') pendingJoinedStops.delete(workId);
          } finally { done(); }
        });
    }
  };
  const stoppedWorkControl = {
    ...workControl,
    async cancel(input: Parameters<typeof workControl.cancel>[0]) {
      const result = workControl.cancel(input);
      if (result.outcome !== "cancellation_requested") return result;
      queueJoinedStop(input.workId);
      if (!stopsInFlight.has(input.workId)) {
        stopsInFlight.add(input.workId);
        try {
          await stopInvokedBot?.(input.workId);
          await stopRevokedWorkingThread(input.workId, input.context);
        } finally {
          stopsInFlight.delete(input.workId);
          if (work.get(input.workId)?.state !== 'cancelling') pendingJoinedStops.delete(input.workId);
        }
      }
      const projection = workControl.get(input);
      return { outcome: projection.state === "cancelled" ? "cancelled" as const : "cancellation_requested" as const,
        replayed: result.replayed, work: projection };
    },
  };
  if (messageSubmission && directMessageContext) {
    liveVoice = createLiveVoiceService({ auth, targets: directMessageContext, messages,
      submission: messageSubmission, work,
      transcripts: createLiveVoiceTranscriptPort({ messages, targets: directMessageContext,
        resolveResident: binding => completionTargets.get(binding),
        recordMessage: createCanonicalMessageRecorder(communications),
        assertAuthority() {
          if (!isCanonicalMessagesAuthority(currentAuthority("messages"))) {
            throw new MessagingError("authority_unavailable");
          }
        } }),
      journalDirectory: join(dirname(config.databasePath), "voice-sessions"),
      isAccepting: () => lifecycle.state() === "accepting" });
  }
  const resolveInstancePaths = createRequire(import.meta.url)("../../../shared/agent-instance-paths.cjs").resolveAgentInstancePaths as (root:string,slug:string)=>{instanceRoot:string;conversationsDir:string};
  const consoleRoot = config.home23Root ?? resolve(dirname(config.databasePath),"../../..");
  const consoleBotRoot = config.botRootDirectory ?? join(dirname(config.databasePath),"..","bots");
  const consoleCatalog = new ConsoleCatalog(async () => {
    const bots = database.readAll<{id:string;name:string;binding:string}>("SELECT id,name,resident_binding AS binding FROM bots");
    const roots:ConsoleRoot[]=[];
    for(const [slug,resident] of Object.entries(config.residents)) {
      if(!resident.enabled) continue;
      const paths=resolveInstancePaths(consoleRoot,slug);
      const instanceDir=resident.instanceDirectory??paths.instanceRoot;
      const bot=bots.find(bot=>bot.binding===slug);
      roots.push({id:`resident:${slug}`,actor:{id:bot?.id??slug,name:bot?.name??slug},runtimeKind:'resident',
        jobsDir:join(instanceDir,'coding-jobs'),workDir:join(instanceDir,'async-work'),
        historyDir:resident.conversationsDirectory??join(instanceDir,'conversations'),historyNamespace:slug,executionOutputDir:join(instanceDir,'execution-output')});
    }
    for(const bot of bots.filter(bot=>bot.binding.startsWith('bot-'))) {
      const root=join(consoleBotRoot,bot.id);
      roots.push({id:`helper:${bot.id}`,actor:{id:bot.id,name:bot.name},runtimeKind:'helper',jobsDir:join(root,'coding-jobs'),
        workDir:join(root,'async-work'),historyDir:join(root,'state','history'),historyNamespace:bot.id,executionOutputDir:join(root,'execution-output')});
    }
    return roots;
  });
  const consoleRuntimeAvailability=new Map<string,{checked:number;available:Promise<boolean>}>();
  const executionConsole = new ConsoleService({catalog:consoleCatalog,
    authorize:async(source,context)=>{
      if(source.channelId) await channels.getChannel({context,channelId:source.channelId});
      else if(source.source.workId) workControl.get({context,workId:source.source.workId});
    },
    controls:{
      available:async(source)=>{
        const id=source.target.runtimeId;
        if(id.startsWith('helper:')) return helperRuntime?.executionControlsAvailable(id.slice(7))??false;
        const cached=consoleRuntimeAvailability.get(id);
        if(cached&&Date.now()-cached.checked<5000) return cached.available;
        const port=residentAgents.get(id.replace(/^resident:/,''));
        const available=port?.executionCapabilities({requestId:generateCoordinationId('request'),correlationId:generateCoordinationId('correlation')}).catch(()=>false)??Promise.resolve(false);
        consoleRuntimeAvailability.set(id,{checked:Date.now(),available});
        return available;
      },
      execute:async(source,request,context)=>{
        const id=source.target.runtimeId;
        if(id.startsWith('helper:')&&helperRuntime?.executionControlsAvailable(id.slice(7))) return helperRuntime.executeControl(id.slice(7),request);
        const port=residentAgents.get(id.replace(/^resident:/,''));
        if(!port) throw new CoordinationHttpError('console_control_unavailable',503,true);
        try { return await port.executeControl(request,{requestId:context.requestId,correlationId:context.correlationId}); }
        catch { throw new CoordinationHttpError('console_control_unconfirmed',503,true,{},'Execution control acknowledgement unavailable; retry with the same Idempotency-Key.'); }
      },
    },
  });
  const application = createCoordinationApplication({
    flags: config.flags,
    services: {
      auth, bootstrap, bots: botDirectory, channels, projects, messages, unread, search, console:executionConsole, chess:nativeChess,
      ...(config.home23Root ? { homeUpdate: createHomeUpdateService(config.home23Root) } : {}),
      ...(liveVoice === undefined ? {} : { liveVoice }),
      work, workControl: stoppedWorkControl, leases, events, communications,
      authorityEpochs,
      ...(attachments === undefined ? {} : { attachments }),
      ...(messageSubmission === undefined ? {} : { messageSubmission }),
      ...(activity === undefined ? {} : { activity }),
      ...(deviceNotifications === undefined ? {} : { deviceNotifications }),
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
      let notificationRecovery: readonly ConnectedAgentsMessageNotification[] = [];
      try {
        workControl.recoverCancellations({
          requestId: generateCoordinationId("request"),
          correlationId: generateCoordinationId("correlation"),
        });
        await initializeAttachments();
        await completionIngress?.start();
        notificationRecovery = prepareConnectedAgentsNotificationRecovery();
        address = await server.start();
        if (helperRuntime) {
          const helpers=database.readAll<{targetBotId:string; targetPrincipalId:string; residentBinding:string; conversationId:string; channelId:string; targetBotDisplayName:string}>(
            "SELECT b.id AS targetBotId,b.principal_id AS targetPrincipalId,b.resident_binding AS residentBinding,b.conversation_id AS conversationId,b.name AS targetBotDisplayName,h.channel_id AS channelId FROM bots b JOIN conversation_handles h ON h.id=b.conversation_id WHERE b.lifecycle='active' AND b.resident_binding LIKE 'bot-%'");
          await helperRuntime.resume(helpers);
        }
      } catch (error) {
        await server.drain().catch(() => undefined);
        throw error;
      }
      const projectResidentWorkSnapshot = () => {
        try { projectResidentWork(database, join(dirname(config.databasePath), 'resident-contact'), Object.entries(config.residents).filter(([, value]) => value.enabled).map(([slug]) => slug)); } catch (error) { console.error('[resident-work]', error); }
      };
      projectResidentWorkSnapshot();
      residentWorkProjectionTimer = setInterval(projectResidentWorkSnapshot, 30_000);
      residentWorkProjectionTimer.unref?.();
      outcomeTimer = setInterval(() => {
        try { residentContact.pump(); } catch (error) { console.error('[resident-contact]', error); }
        void reconcileChessTurns?.().catch(error => console.error('[native-chess]', error));
        try { reconcileScheduledTurns?.(); } catch (error) { console.error('[scheduled-turns]', error); }
        try { reconcileJoinedStops(); } catch(error) { console.error('[joined-stop]',error); }
        void reconcileBotInvocations?.().catch(error => console.error('[bot-invocations]', error));
        void processResidentOutcomes?.().catch(error => console.error('[resident-outcomes]', error));
      }, 2_000);
      outcomeTimer.unref?.();
      if (residentInitializers.length > 0) {
        void refreshResidentAttestations();
        residentAttestationTimer = setInterval(
          () => { void refreshResidentAttestations().then(async () => {
            for (const pending of work.listResidentRecoverable("resident_work_thread", 100)) {
              if (pending.state === "cancelling") {
                await stopRevokedWorkingThread(pending.id, { requestId: generateCoordinationId("request"), correlationId: generateCoordinationId("correlation") }).catch(() => undefined);
              } else await dispatchWorkingThread?.(pending.id).catch(() => undefined);
            }
            for (const completed of work.listSucceededMissingResult("resident_work_thread", 100)) {
              await dispatchWorkingThread?.(completed.id).catch(() => undefined);
            }
          }).catch(() => undefined); },
          RESIDENT_ATTESTATION_INTERVAL_MS,
        );
        residentAttestationTimer.unref?.();
      }
      if (notificationPusher && notificationRecovery.length > 0) {
        void notificationPusher.reconcileConnectedAgentsMessages(notificationRecovery)
          .catch((error: unknown) => {
            console.error(
              "[home23-coordination] Connected Agents notification recovery failed:",
              error instanceof Error ? error.message : error,
            );
          });
      }
      for (const pending of database.readAll<{id:string}>("SELECT w.id FROM works w WHERE w.state='cancelling' AND (w.kind='resident_work_thread' OR EXISTS(SELECT 1 FROM work_thread_presentations p WHERE p.work_id=w.id))")) {
        pendingJoinedStops.add(pending.id);
      }
      reconcileJoinedStops();
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
