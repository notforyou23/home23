import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { DEFAULT_MAXIMUM_ARTIFACT_BYTES } from "../artifacts/index.js";
import type { CoordinationFeatureFlags } from "./types.js";
import { disabledCoordinationFeatureFlags } from "./application.js";
import type { ApnsConfig } from "../../push/types.js";
import { CONNECTED_AGENTS_MAC_BUNDLE_ID } from "../../push/types.js";

const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

export const COORDINATION_FLAG_ENV = Object.freeze({
  "coordination.process.enabled": "HOME23_COORDINATION_ENABLED",
  "coordination.public_api.enabled": "HOME23_COORDINATION_PUBLIC_API_ENABLED",
  "coordination.resident.jerry.enabled": "HOME23_COORDINATION_RESIDENT_JERRY_ENABLED",
  "coordination.resident.forrest.enabled": "HOME23_COORDINATION_RESIDENT_FORREST_ENABLED",
  "coordination.channels.enabled": "HOME23_COORDINATION_CHANNELS_ENABLED",
  "coordination.search.canonical": "HOME23_COORDINATION_SEARCH_CANONICAL",
  "coordination.import.shadow_enabled": "HOME23_COORDINATION_IMPORT_SHADOW_ENABLED",
  "coordination.apple.mac_cutover": "HOME23_COORDINATION_APPLE_MAC_CUTOVER",
  "coordination.apple.iphone_cutover": "HOME23_COORDINATION_APPLE_IPHONE_CUTOVER",
  "coordination.bot_lifecycle.enabled": "HOME23_COORDINATION_BOT_LIFECYCLE_ENABLED",
  "coordination.compaction.enabled": "HOME23_COORDINATION_COMPACTION_ENABLED",
} as const satisfies Record<keyof CoordinationFeatureFlags, string>);

export interface CoordinationRuntimeConfig {
  enabled: boolean;
  host: "127.0.0.1" | "::1";
  port: number;
  databasePath: string;
  /** Maintained installation root for read-only execution inventory. */
  home23Root?: string;
  /** Core-owned private state for deliberately created processless Bots. */
  botRootDirectory: string;
  socketPath: string;
  capabilityToken: string;
  activity?: Readonly<{
    /** Independent read-surface kill switch; authority remains mandatory. */
    enabled: boolean;
  }>;
  attachments?: Readonly<{
    /** Independent kill switch; authority remains a separate mandatory gate. */
    enabled: boolean;
    rootDirectory: string;
    maximumBytes: number;
    maximumCountPerMessage: number;
  }>;
  push?: Readonly<{
    /** Independent activation switch; incomplete APNs configuration is fatal. */
    enabled: boolean;
    registryPath: string;
    apns: ApnsConfig;
  }>;
  /** Absent on legacy programmatic configurations; defaults remain Jerry/Home23. */
  home?: Readonly<{ id: string; name: string; primaryResident: string }>;
  residents: Readonly<Record<string, {
    enabled: boolean;
    instanceDirectory?: string;
    conversationsDirectory?: string;
    socketPath: string;
    serverInstanceId: string;
    clientInstanceId: string;
    keyVersion: number;
    key: string;
  }>>;
  flags: CoordinationFeatureFlags;
}

function exactBoolean(value: string | undefined, name: string): boolean {
  if (value === "true") return true;
  if (value === "false" || value === undefined || value === "") return false;
  throw new Error(`${name} must be exactly true or false`);
}

function confinedRuntimePath(input: {
  value: string | undefined;
  name: string;
  runtimeRoot: string;
  requireParent: boolean;
}): string {
  const value = input.value ?? "";
  if (!value || !isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${input.name} must be an absolute runtime path`);
  }
  const resolved = resolve(value);
  const boundary = `${input.runtimeRoot}/`;
  if (resolved === input.runtimeRoot || !resolved.startsWith(boundary)) {
    throw new Error(`${input.name} must remain inside the coordination runtime root`);
  }
  if (input.requireParent) {
    const parent = resolve(resolved, "..");
    if (!existsSync(parent) || !statSync(parent).isDirectory()) {
      throw new Error(`${input.name} parent directory is missing`);
    }
    const realParent = realpathSync(parent);
    const realRuntimeRoot = realpathSync(input.runtimeRoot);
    if (relative(realRuntimeRoot, realParent).startsWith("..")) {
      throw new Error(`${input.name} parent escapes the coordination runtime root`);
    }
  }
  return resolved;
}

export function loadCoordinationRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CoordinationRuntimeConfig {
  const enabled = exactBoolean(
    environment.HOME23_COORDINATION_ENABLED,
    "HOME23_COORDINATION_ENABLED",
  );
  const home23Root = environment.HOME23_ROOT;
  if (!home23Root || !isAbsolute(home23Root)) {
    throw new Error("HOME23_ROOT must be an absolute path");
  }
  const runtimeRoot = resolve(home23Root, "instances", ".house", "coordination");
  const botRootDirectory = resolve(home23Root, "instances", ".house", "bots");
  const socketRootValue = environment.HOME23_COORDINATION_SOCKET_ROOT ?? runtimeRoot;
  if (!isAbsolute(socketRootValue) || socketRootValue.includes("\0")) throw new Error("HOME23_COORDINATION_SOCKET_ROOT must be an absolute dedicated directory");
  const socketRoot = resolve(socketRootValue);
  if (socketRoot === "/") throw new Error("HOME23_COORDINATION_SOCKET_ROOT must be an absolute dedicated directory");
  const host = environment.HOME23_COORDINATION_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("HOME23_COORDINATION_HOST must be an explicit loopback literal");
  }
  const rawPort = environment.HOME23_COORDINATION_PORT ?? "7346";
  if (!/^[0-9]+$/.test(rawPort)) {
    throw new Error("HOME23_COORDINATION_PORT must be an integer");
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("HOME23_COORDINATION_PORT must be between 1 and 65535");
  }

  const databasePath = confinedRuntimePath({
    value: environment.HOME23_COORDINATION_DB_PATH,
    name: "HOME23_COORDINATION_DB_PATH",
    runtimeRoot,
    requireParent: enabled,
  });
  // macOS Unix sockets need a short pathname. The Host supplies a dedicated
  // private socket root while durable state remains in the installed home.
  // Legacy Core sockets inside the durable runtime root remain valid too.
  const requestedSocket = resolve(environment.HOME23_COORDINATION_SOCKET_PATH ?? runtimeRoot);
  const coreSocketRoot = requestedSocket.startsWith(`${runtimeRoot}/`) ? runtimeRoot : socketRoot;
  if (enabled && coreSocketRoot !== runtimeRoot) {
    const directory = existsSync(coreSocketRoot) && lstatSync(coreSocketRoot);
    if (!directory || !directory.isDirectory() || directory.isSymbolicLink()
      || directory.uid !== process.getuid?.() || (directory.mode & 0o077)) {
      throw new Error("HOME23_COORDINATION_SOCKET_ROOT must be an owned private directory");
    }
  }
  const socketPath = confinedRuntimePath({
    value: environment.HOME23_COORDINATION_SOCKET_PATH,
    name: "HOME23_COORDINATION_SOCKET_PATH",
    runtimeRoot: coreSocketRoot,
    requireParent: enabled,
  });
  const capabilityToken = environment.HOME23_COORDINATION_CAPABILITY_TOKEN ?? "";
  if (enabled && !TOKEN_PATTERN.test(capabilityToken)) {
    throw new Error(
      "HOME23_COORDINATION_CAPABILITY_TOKEN must contain exactly 32 bytes of hex",
    );
  }

  const parsedFlags = Object.fromEntries(
    Object.entries(COORDINATION_FLAG_ENV).map(([flag, variable]) => [
      flag,
      exactBoolean(environment[variable], variable),
    ]),
  ) as Record<keyof CoordinationFeatureFlags, boolean>;
  const flags = {
    ...disabledCoordinationFeatureFlags(),
    ...parsedFlags,
    "coordination.process.enabled": enabled,
    // A subordinate flag can remove capability, never create authority while
    // its parent gate is closed.
    "coordination.public_api.enabled": enabled && parsedFlags["coordination.public_api.enabled"] === true,
    "coordination.resident.jerry.enabled": enabled && parsedFlags["coordination.resident.jerry.enabled"] === true,
    "coordination.resident.forrest.enabled": enabled && parsedFlags["coordination.resident.forrest.enabled"] === true,
  };
  const requestedAttachmentsEnabled = exactBoolean(
    environment.HOME23_COORDINATION_ATTACHMENTS_ENABLED,
    "HOME23_COORDINATION_ATTACHMENTS_ENABLED",
  );
  const attachmentsEnabled = enabled && requestedAttachmentsEnabled;
  const requestedActivityEnabled = exactBoolean(
    environment.HOME23_COORDINATION_ACTIVITY_ENABLED,
    "HOME23_COORDINATION_ACTIVITY_ENABLED",
  );
  const activityEnabled = enabled && requestedActivityEnabled;
  const requestedPushEnabled = exactBoolean(
    environment.HOME23_COORDINATION_PUSH_ENABLED,
    "HOME23_COORDINATION_PUSH_ENABLED",
  );
  const pushEnabled = enabled && requestedPushEnabled;
  const attachmentRoot = confinedRuntimePath({
    value: environment.HOME23_COORDINATION_ATTACHMENTS_ROOT ??
      resolve(runtimeRoot, "attachments"),
    name: "HOME23_COORDINATION_ATTACHMENTS_ROOT",
    runtimeRoot,
    requireParent: attachmentsEnabled,
  });
  const pushRegistryPath = confinedRuntimePath({
    value: environment.HOME23_COORDINATION_PUSH_REGISTRY_PATH ??
      resolve(runtimeRoot, "connected-agents-device-registry.json"),
    name: "HOME23_COORDINATION_PUSH_REGISTRY_PATH",
    runtimeRoot,
    requireParent: pushEnabled,
  });
  const apnsEnvironment = environment.HOME23_COORDINATION_APNS_DEFAULT_ENV ?? "production";
  const apns = Object.freeze({
    team_id: environment.HOME23_COORDINATION_APNS_TEAM_ID ?? "",
    key_id: environment.HOME23_COORDINATION_APNS_KEY_ID ?? "",
    key_path: environment.HOME23_COORDINATION_APNS_KEY_PATH ?? "",
    bundle_id: environment.HOME23_COORDINATION_APNS_BUNDLE_ID ?? "",
    macos_bundle_id: environment.HOME23_COORDINATION_APNS_MAC_BUNDLE_ID
      ?? CONNECTED_AGENTS_MAC_BUNDLE_ID,
    default_env: apnsEnvironment as "sandbox" | "production",
  });
  if (pushEnabled && (
    !/^[A-Z0-9]{10}$/.test(apns.team_id) ||
    !/^[A-Z0-9]{10}$/.test(apns.key_id) ||
    !isAbsolute(apns.key_path) ||
    !/^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$/.test(apns.bundle_id) ||
    !/^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$/.test(apns.macos_bundle_id) ||
    (apnsEnvironment !== "sandbox" && apnsEnvironment !== "production")
  )) {
    throw new Error("complete Connected Agents APNs configuration is required when push is enabled");
  }
  const configuredSlugs: unknown = environment.HOME23_COORDINATION_RESIDENT_SLUGS
    ? JSON.parse(environment.HOME23_COORDINATION_RESIDENT_SLUGS) : ["jerry", "forrest"];
  if (!Array.isArray(configuredSlugs) || configuredSlugs.length < 1 || configuredSlugs.length > 32 ||
      configuredSlugs.some(slug => typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) || slug.startsWith("bot-")) ||
      new Set(configuredSlugs).size !== configuredSlugs.length) throw new Error("coordination resident slugs are invalid");
  const primaryResident = environment.HOME23_COORDINATION_PRIMARY_RESIDENT ?? "jerry";
  if (!configuredSlugs.includes(primaryResident)) throw new Error("coordination primary resident is not configured");
  const home = Object.freeze({
    id: environment.HOME23_COORDINATION_HOME_ID ?? "home_00000000-0000-7000-8000-000000000000",
    name: environment.HOME23_COORDINATION_HOME_NAME ?? "Home23",
    primaryResident,
  });
  if (!/^home_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(home.id) ||
      !home.name.trim() || home.name.length > 256 || home.name.includes("\0")) throw new Error("coordination home identity is invalid");
  const residents = Object.fromEntries((configuredSlugs as string[]).map((slug) => {
    const upper = slug.toUpperCase().replaceAll("-", "_");
    const requestedResidentEnabled = exactBoolean(environment[`HOME23_COORDINATION_RESIDENT_${upper}_ENABLED`], `HOME23_COORDINATION_RESIDENT_${upper}_ENABLED`);
    const residentEnabled = enabled && requestedResidentEnabled;
    const socketPath = resolve(environment[`HOME23_COORDINATION_RESIDENT_${upper}_SOCKET_PATH`] ?? resolve(socketRoot, `resident-${slug}.sock`));
    if (socketPath === socketRoot || !socketPath.startsWith(`${socketRoot}/`) || socketPath.includes("\0")) throw new Error(`HOME23_COORDINATION_RESIDENT_${upper}_SOCKET_PATH must remain inside the dedicated socket root`);
    const serverInstanceId = environment[`HOME23_COORDINATION_RESIDENT_${upper}_SERVER_INSTANCE_ID`] ?? `home23-${slug}-harness`;
    const clientInstanceId = environment[`HOME23_COORDINATION_RESIDENT_${upper}_CLIENT_INSTANCE_ID`] ?? `home23-${slug}-harness`;
    const rawVersion = environment[`HOME23_COORDINATION_RESIDENT_${upper}_KEY_VERSION`] ?? "1";
    if (!/^[1-9][0-9]*$/.test(rawVersion) || !Number.isSafeInteger(Number(rawVersion))) throw new Error(`HOME23_COORDINATION_RESIDENT_${upper}_KEY_VERSION must be a positive integer`);
    const key = environment[`HOME23_COORDINATION_RESIDENT_${upper}_KEY`] ?? "";
    if (residentEnabled && !TOKEN_PATTERN.test(key)) throw new Error(`HOME23_COORDINATION_RESIDENT_${upper}_KEY must contain exactly 32 bytes of hex`);
    if (![serverInstanceId, clientInstanceId].every((value) => /^[A-Za-z0-9._:-]{1,128}$/.test(value))) throw new Error(`HOME23_COORDINATION_RESIDENT_${upper} instance IDs are invalid`);
    const instanceDirectory=environment[`HOME23_COORDINATION_RESIDENT_${upper}_INSTANCE_DIR`];
    const conversationsDirectory=environment[`HOME23_COORDINATION_RESIDENT_${upper}_CONVERSATIONS_DIR`];
    for(const value of [instanceDirectory,conversationsDirectory]) if(value!==undefined&&(!isAbsolute(value)||value.includes("\0"))) throw new Error("Console resident roots must be absolute paths");
    return [slug, Object.freeze({ enabled: residentEnabled, instanceDirectory, conversationsDirectory, socketPath, serverInstanceId, clientInstanceId, keyVersion: Number(rawVersion), key })];
  })) as CoordinationRuntimeConfig["residents"];

  return Object.freeze({
    enabled,
    host,
    port,
    databasePath,
    home23Root,
    botRootDirectory,
    socketPath,
    capabilityToken,
    activity: Object.freeze({ enabled: activityEnabled }),
    attachments: Object.freeze({
      enabled: attachmentsEnabled,
      rootDirectory: attachmentRoot,
      maximumBytes: DEFAULT_MAXIMUM_ARTIFACT_BYTES,
      maximumCountPerMessage: 10,
    }),
    ...(pushEnabled
      ? { push: Object.freeze({ enabled: true, registryPath: pushRegistryPath, apns }) }
      : {}),
    home,
    residents: Object.freeze(residents),
    flags: Object.freeze(flags),
  });
}
