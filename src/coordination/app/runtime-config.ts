import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { CoordinationFeatureFlags } from "./types.js";
import { disabledCoordinationFeatureFlags } from "./application.js";

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
  socketPath: string;
  capabilityToken: string;
  residents: Readonly<Record<"jerry" | "forrest", {
    enabled: boolean;
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
  const socketRoot = resolve(environment.HOME23_COORDINATION_SOCKET_ROOT ?? runtimeRoot);
  if (!isAbsolute(socketRoot) || socketRoot === "/" || socketRoot.includes("\0")) throw new Error("HOME23_COORDINATION_SOCKET_ROOT must be an absolute dedicated directory");
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
  const socketPath = confinedRuntimePath({
    value: environment.HOME23_COORDINATION_SOCKET_PATH,
    name: "HOME23_COORDINATION_SOCKET_PATH",
    runtimeRoot,
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
  const residents = Object.fromEntries((["jerry", "forrest"] as const).map((slug) => {
    const upper = slug.toUpperCase();
    const residentEnabled = flags[`coordination.resident.${slug}.enabled`] === true;
    const socketPath = resolve(environment[`HOME23_COORDINATION_RESIDENT_${upper}_SOCKET_PATH`] ?? resolve(socketRoot, `resident-${slug}.sock`));
    if (socketPath === socketRoot || !socketPath.startsWith(`${socketRoot}/`) || socketPath.includes("\0")) throw new Error(`HOME23_COORDINATION_RESIDENT_${upper}_SOCKET_PATH must remain inside the dedicated socket root`);
    const serverInstanceId = environment[`HOME23_COORDINATION_RESIDENT_${upper}_SERVER_INSTANCE_ID`] ?? `home23-${slug}-harness`;
    const clientInstanceId = environment[`HOME23_COORDINATION_RESIDENT_${upper}_CLIENT_INSTANCE_ID`] ?? `home23-${slug}-harness`;
    const rawVersion = environment[`HOME23_COORDINATION_RESIDENT_${upper}_KEY_VERSION`] ?? "1";
    if (!/^[1-9][0-9]*$/.test(rawVersion) || !Number.isSafeInteger(Number(rawVersion))) throw new Error(`HOME23_COORDINATION_RESIDENT_${upper}_KEY_VERSION must be a positive integer`);
    const key = environment[`HOME23_COORDINATION_RESIDENT_${upper}_KEY`] ?? "";
    if (residentEnabled && !TOKEN_PATTERN.test(key)) throw new Error(`HOME23_COORDINATION_RESIDENT_${upper}_KEY must contain exactly 32 bytes of hex`);
    if (![serverInstanceId, clientInstanceId].every((value) => /^[A-Za-z0-9._:-]{1,128}$/.test(value))) throw new Error(`HOME23_COORDINATION_RESIDENT_${upper} instance IDs are invalid`);
    return [slug, Object.freeze({ enabled: residentEnabled, socketPath, serverInstanceId, clientInstanceId, keyVersion: Number(rawVersion), key })];
  })) as CoordinationRuntimeConfig["residents"];

  return Object.freeze({
    enabled,
    host,
    port,
    databasePath,
    socketPath,
    capabilityToken,
    residents: Object.freeze(residents),
    flags: Object.freeze(flags),
  });
}
