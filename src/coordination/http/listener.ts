import { createServer, type Server } from "node:http";
import { isIP } from "node:net";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

import {
  createCoordinationLifecycle,
  type CoordinationApplication,
  type CoordinationLifecycle,
} from "../app/index.js";
import { createCoordinationRouter } from "./router.js";

const LOOPBACK_LISTENER_HOSTS = Object.freeze(["127.0.0.1", "::1"]);

export function assertCoordinationListenerHost(host: string): string {
  if (
    typeof host !== "string" ||
    host.trim() !== host ||
    isIP(host) === 0 ||
    !LOOPBACK_LISTENER_HOSTS.includes(host)
  ) {
    throw new Error(`coordination listener host is not explicitly allowed: ${host}`);
  }
  return host;
}

export type CoordinationHttpServerState =
  | "idle"
  | "starting"
  | "listening"
  | "draining"
  | "stopped";

export interface CoordinationHttpAddress {
  host: string;
  port: number;
  origin: string;
}

export interface CoordinationHttpServer {
  start(): Promise<CoordinationHttpAddress>;
  drain(): Promise<void>;
  state(): CoordinationHttpServerState;
  lifecycle: CoordinationLifecycle;
}

function listenerAddress(server: Server, host: string): CoordinationHttpAddress {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("coordination HTTP listener did not expose an IP address");
  }
  const info = address as AddressInfo;
  const originHost = info.family === "IPv6" || host.includes(":")
    ? `[${host}]`
    : host;
  return Object.freeze({
    host,
    port: info.port,
    origin: `http://${originHost}:${info.port}`,
  });
}

export function createCoordinationHttpServer(input: {
  application: CoordinationApplication;
  lifecycle?: CoordinationLifecycle;
  host?: string;
  port?: number;
}): CoordinationHttpServer {
  const host = assertCoordinationListenerHost(input.host ?? "127.0.0.1");
  const port = input.port ?? 7346;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("coordination listener port must be an integer from 0 through 65535");
  }
  const lifecycle = input.lifecycle ?? createCoordinationLifecycle();
  const router = createCoordinationRouter({
    application: input.application,
    lifecycle,
  });
  // Node's idle-connection cleanup does not cover an unfinished first request.
  // Once headers arrive, the router owns the request and lets normal work finish.
  const pendingRequests = new Set<Socket>();
  const server = createServer((request, response) => {
    pendingRequests.delete(request.socket);
    router(request, response);
  });
  let serverState: CoordinationHttpServerState = "idle";
  let startPromise: Promise<CoordinationHttpAddress> | null = null;
  let drainPromise: Promise<void> | null = null;
  server.on("connection", (socket) => {
    if (serverState === "draining" || serverState === "stopped") {
      socket.destroy();
      return;
    }
    pendingRequests.add(socket);
    socket.once("close", () => pendingRequests.delete(socket));
  });

  function start(): Promise<CoordinationHttpAddress> {
    if (serverState === "starting" || serverState === "listening") {
      if (!startPromise) throw new Error("coordination HTTP start state is inconsistent");
      return startPromise;
    }
    if (serverState !== "idle") {
      return Promise.reject(new Error(`coordination HTTP server cannot start from ${serverState}`));
    }
    serverState = "starting";
    startPromise = new Promise<CoordinationHttpAddress>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        serverState = "stopped";
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        if (serverState === "starting") serverState = "listening";
        resolve(listenerAddress(server, host));
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
    return startPromise;
  }

  function closeListener(): Promise<void> {
    if (!server.listening) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections?.();
      for (const socket of pendingRequests) socket.destroy();
    });
  }

  function drain(): Promise<void> {
    if (drainPromise) return drainPromise;
    serverState = "draining";
    const lifecycleDrain = lifecycle.drain();
    const listenerDrain = (async () => {
      if (startPromise) {
        try {
          await startPromise;
        } catch {
          return;
        }
      }
      await closeListener();
    })();
    const closeIdle = () => server.closeIdleConnections?.();
    void lifecycleDrain.then(closeIdle, closeIdle);
    drainPromise = Promise.all([
      listenerDrain,
      lifecycleDrain,
    ]).then(
      () => { serverState = "stopped"; },
      (error) => {
        serverState = "stopped";
        throw error;
      },
    );
    return drainPromise;
  }

  return Object.freeze({
    start,
    drain,
    state: () => serverState,
    lifecycle,
  });
}
