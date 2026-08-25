import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { CoordinationFeatureFlags } from "./types.js";
import { disabledCoordinationFeatureFlags } from "./application.js";

const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

export interface CoordinationRuntimeConfig {
  enabled: boolean;
  host: "127.0.0.1" | "::1";
  port: number;
  databasePath: string;
  socketPath: string;
  capabilityToken: string;
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

  const flags = {
    ...disabledCoordinationFeatureFlags(),
    "coordination.process.enabled": enabled,
    "coordination.public_api.enabled": enabled && exactBoolean(
      environment.HOME23_COORDINATION_PUBLIC_API_ENABLED,
      "HOME23_COORDINATION_PUBLIC_API_ENABLED",
    ),
  };

  return Object.freeze({
    enabled,
    host,
    port,
    databasePath,
    socketPath,
    capabilityToken,
    flags: Object.freeze(flags),
  });
}
