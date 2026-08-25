import {
  createDurableAttachmentService,
  LocalArtifactStore,
  SqliteArtifactRepository,
  type ArtifactParticipantDirectory,
  type LocalArtifactStoreOptions,
} from "../artifacts/index.js";
import { openCoordinationDatabase } from "../db/index.js";
import { createCoordinationHttpServer } from "../http/index.js";
import { createCoordinationApplication } from "./application.js";
import { createCoordinationLifecycle } from "./lifecycle.js";
import type { CoordinationRuntimeConfig } from "./runtime-config.js";
import type {
  CoordinationApplication,
  CoordinationFeatureFlags,
  CoordinationLifecycle,
  CoordinationServices,
} from "./index.js";

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
  services: Omit<CoordinationServices, "attachments">;
  attachments?: Partial<DurableAttachmentCompositionOptions>;
}): Promise<CoordinationRuntimeComposition> {
  // Runtime callers cannot bypass construction by smuggling a raw or
  // preassembled attachment value through the otherwise shared service bag.
  const { attachments: _ignoredAttachment, ...services } =
    input.services as CoordinationServices;
  if (
    input.flags["coordination.process.enabled"] !== true ||
    input.flags["coordination.public_api.enabled"] !== true ||
    !isCompleteAttachmentOptions(input.attachments)
  ) {
    return Object.freeze({
      application: createCoordinationApplication({ flags: input.flags, services }),
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
        services: { ...services, attachments },
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
): CoordinationProcess {
  if (!config.enabled) {
    throw new Error("the disabled coordination process cannot be composed");
  }
  const database = openCoordinationDatabase({
    path: config.databasePath,
    applicationVersion: "home23-coordination-m12-shadow",
  });
  const lifecycle = createCoordinationLifecycle([{
    name: "coordination-database",
    drain: async () => undefined,
    close: async () => database.close(),
  }]);
  const application = createCoordinationApplication({
    flags: config.flags,
    services: {
      // Pairing/session composition is deliberately deferred. Until that
      // dependency exists, every protected route fails closed.
      auth: {
        validateAccessToken: async () => {
          throw new Error("coordination authentication is unavailable in shadow mode");
        },
      },
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
  });
}
