import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, isAbsolute } from "node:path";

import { ResidentProtocolError } from "../../resident-protocol/index.js";

export interface UnixSocketPathProbe {
  socketPath: string;
  pathBytes: number;
  maxPathBytes: number;
  platform: NodeJS.Platform;
}

export interface PreparedUnixSocketPath extends UnixSocketPathProbe {
  directory: string;
  directoryMode: number;
}

export function unixSocketPathLimit(platform: NodeJS.Platform = process.platform): number {
  if (platform === "linux") return 107;
  return 103;
}

export function probeUnixSocketPath(
  socketPath: string,
  options: { platform?: NodeJS.Platform; maxPathBytes?: number } = {},
): UnixSocketPathProbe {
  if (!socketPath || !isAbsolute(socketPath) || socketPath.includes("\0")) {
    throw new ResidentProtocolError("request_invalid", "Unix socket path must be absolute and contain no NUL byte");
  }
  const platform = options.platform ?? process.platform;
  const maxPathBytes = options.maxPathBytes ?? unixSocketPathLimit(platform);
  const pathBytes = Buffer.byteLength(socketPath, "utf8");
  if (pathBytes > maxPathBytes) {
    throw new ResidentProtocolError("request_invalid", "Unix socket path exceeds the platform byte limit", {
      details: { pathBytes, maxPathBytes },
    });
  }
  return { socketPath, pathBytes, maxPathBytes, platform };
}

async function socketIsActive(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (value: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish(false);
      else finish(false, error);
    });
  });
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

export async function prepareUnixSocketPath(
  socketPath: string,
): Promise<PreparedUnixSocketPath> {
  const probe = probeUnixSocketPath(socketPath);
  const directory = dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`Unix socket parent is not a real directory: ${directory}`);
  }
  const uid = currentUid();
  if (uid !== null && before.uid !== uid) {
    throw new Error(`Unix socket parent is not owned by the current user: ${directory}`);
  }
  await chmod(directory, 0o700);
  const secured = await lstat(directory);
  if ((secured.mode & 0o777) !== 0o700) {
    throw new Error(`Unix socket parent permissions are not 0700: ${directory}`);
  }

  let existing;
  try {
    existing = await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing) {
    if (!existing.isSocket()) {
      throw new Error(`refusing to replace a non-socket at ${socketPath}`);
    }
    if (uid !== null && existing.uid !== uid) {
      throw new Error(`refusing to replace a socket not owned by the current user: ${socketPath}`);
    }
    if (await socketIsActive(socketPath)) {
      throw new Error(`Unix socket already has an active listener: ${socketPath}`);
    }
    const confirmed = await lstat(socketPath);
    if (confirmed.dev !== existing.dev || confirmed.ino !== existing.ino || !confirmed.isSocket()) {
      throw new Error(`Unix socket changed during startup probe: ${socketPath}`);
    }
    await unlink(socketPath);
  }

  return { ...probe, directory, directoryMode: secured.mode & 0o777 };
}
