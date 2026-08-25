import { randomBytes } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";

import {
  DEFAULT_MAX_FRAME_BYTES,
  JsonFrameDecoder,
  MAX_CAPABILITY_LIFETIME_MS,
  RESIDENT_PROTOCOL_VERSION,
  ResidentProtocolError,
  createSignedErrorResponse,
  createSignedResponse,
  encodeJsonFrame,
  verifySignedRequest,
  type JsonValue,
  type ResidentCredential,
  type ResidentProtocolErrorCode,
  type ResidentRequestFrame,
} from "../../resident-protocol/index.js";
import { prepareUnixSocketPath, type PreparedUnixSocketPath } from "./path.js";
import { NonceReplayCache } from "./replay-cache.js";

const HANDSHAKE_METHOD = "HELLO";
const HANDSHAKE_PATH = "/internal/v1/session";

export interface ResidentUdsRequestContext {
  signal: AbortSignal;
  credential: Omit<ResidentCredential, "key">;
  requestId: string;
  correlationId: string;
}

export interface ResidentUdsServerOptions {
  socketPath: string;
  serverInstanceId: string;
  credentials: readonly ResidentCredential[];
  handleRequest: (
    request: ResidentRequestFrame,
    context: ResidentUdsRequestContext,
  ) => Promise<JsonValue> | JsonValue;
  validateFence?: (fence: string | null, request: ResidentRequestFrame) => boolean;
  maxFrameBytes?: number;
  maxConnections?: number;
  maxConcurrentRequests?: number;
  requestRateLimit?: { limit: number; intervalMs: number };
  handshakeTimeoutMs?: number;
  now?: () => number;
  nonce?: () => string;
}

export interface ResidentUdsStartupReceipt {
  protocolVersion: typeof RESIDENT_PROTOCOL_VERSION;
  socketPath: string;
  pathBytes: number;
  maxPathBytes: number;
  platform: NodeJS.Platform;
  directoryMode: number;
  socketMode: number;
}

interface ActiveRequest {
  controller: AbortController;
  correlationId: string;
  deadlineTimer: NodeJS.Timeout;
}

interface ConnectionState {
  socket: Socket;
  credential: ResidentCredential | null;
  decoder: JsonFrameDecoder;
  activeRequests: Map<string, ActiveRequest>;
  handshakeTimer: NodeJS.Timeout;
  serial: Promise<void>;
}

interface RateWindow {
  startedAt: number;
  count: number;
}

function credentialKey(credential: Pick<ResidentCredential, "residentSlug" | "role" | "instanceId" | "keyVersion">): string {
  return `${credential.residentSlug}:${credential.role}:${credential.instanceId}:${credential.keyVersion}`;
}

function randomNonce(): string {
  return randomBytes(24).toString("base64url");
}

function safeError(error: unknown): ResidentProtocolError {
  if (error instanceof ResidentProtocolError) return error;
  return new ResidentProtocolError("internal_error", "resident request failed", { retryable: true });
}

function asProtocolCode(code: string): ResidentProtocolErrorCode {
  return code as ResidentProtocolErrorCode;
}

export class ResidentUdsServer {
  readonly #options: ResidentUdsServerOptions;
  readonly #credentialByIdentity = new Map<string, ResidentCredential>();
  readonly #nonceCache = new NonceReplayCache();
  readonly #sockets = new Set<Socket>();
  readonly #rateWindows = new Map<string, RateWindow>();
  readonly #activeRequestKeys = new Set<string>();
  #server: Server | null = null;
  #socketIdentity: { dev: bigint; ino: bigint } | null = null;
  #closing = false;

  constructor(options: ResidentUdsServerOptions) {
    this.#options = options;
    for (const credential of options.credentials) {
      const key = credentialKey(credential);
      if (this.#credentialByIdentity.has(key)) throw new TypeError(`duplicate resident credential: ${key}`);
      this.#credentialByIdentity.set(key, credential);
    }
    if (this.#credentialByIdentity.size === 0) throw new TypeError("at least one resident credential is required");
    if (!Number.isSafeInteger(options.maxConcurrentRequests ?? 16) || (options.maxConcurrentRequests ?? 16) < 1) {
      throw new TypeError("maxConcurrentRequests must be positive");
    }
    const rate = options.requestRateLimit ?? { limit: 64, intervalMs: 1_000 };
    if (!Number.isSafeInteger(rate.limit) || rate.limit < 1 || !Number.isSafeInteger(rate.intervalMs) || rate.intervalMs < 1) {
      throw new TypeError("requestRateLimit must contain positive safe integers");
    }
  }

  async start(): Promise<ResidentUdsStartupReceipt> {
    if (this.#server) throw new Error("resident UDS server is already started");
    this.#closing = false;
    const prepared = await prepareUnixSocketPath(this.#options.socketPath);
    const server = createServer((socket) => this.#accept(socket));
    server.maxConnections = this.#options.maxConnections ?? 32;
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.#options.socketPath);
      });
      await chmod(this.#options.socketPath, 0o600);
      const socketStat = await lstat(this.#options.socketPath, { bigint: true });
      if (!socketStat.isSocket() || Number(socketStat.mode & 0o777n) !== 0o600) {
        throw new Error("Unix socket permissions are not exactly 0600");
      }
      if (typeof process.getuid === "function" && Number(socketStat.uid) !== process.getuid()) {
        throw new Error("Unix socket is not owned by the current user");
      }
      this.#socketIdentity = { dev: socketStat.dev, ino: socketStat.ino };
      return this.#receipt(prepared, Number(socketStat.mode & 0o777n));
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    for (const socket of this.#sockets) socket.destroy();
    const server = this.#server;
    this.#server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await this.#unlinkOwnedSocket();
    this.#closing = false;
  }

  #receipt(prepared: PreparedUnixSocketPath, socketMode: number): ResidentUdsStartupReceipt {
    return {
      protocolVersion: RESIDENT_PROTOCOL_VERSION,
      socketPath: prepared.socketPath,
      pathBytes: prepared.pathBytes,
      maxPathBytes: prepared.maxPathBytes,
      platform: prepared.platform,
      directoryMode: prepared.directoryMode,
      socketMode,
    };
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket);
    const state: ConnectionState = {
      socket,
      credential: null,
      decoder: new JsonFrameDecoder({ maxFrameBytes: this.#options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES }),
      activeRequests: new Map(),
      handshakeTimer: setTimeout(
        () => socket.destroy(),
        this.#options.handshakeTimeoutMs ?? 2_000,
      ),
      serial: Promise.resolve(),
    };
    state.handshakeTimer.unref();
    socket.on("data", (chunk) => {
      let frames: unknown[];
      try {
        frames = state.decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        state.serial = state.serial
          .then(() => this.#handleFrame(state, frame))
          .catch(() => {
            socket.destroy();
          });
      }
    });
    socket.once("close", () => {
      clearTimeout(state.handshakeTimer);
      for (const active of state.activeRequests.values()) {
        clearTimeout(active.deadlineTimer);
        active.controller.abort(new Error("resident socket closed"));
      }
      state.activeRequests.clear();
      this.#sockets.delete(socket);
    });
    socket.on("error", () => undefined);
  }

  async #handleFrame(state: ConnectionState, value: unknown): Promise<void> {
    if (!state.credential) {
      await this.#handleHandshake(state, value);
      return;
    }
    const untrusted = value as Partial<ResidentRequestFrame>;
    const isCancel = untrusted.method === "CANCEL";
    let request: ResidentRequestFrame;
    try {
      request = verifySignedRequest(value, {
        credential: state.credential,
        expectedAudience: this.#options.serverInstanceId,
        nowMs: this.#now(),
        consumeNonce: (scope, nonce, expiresAtMs) =>
          this.#nonceCache.consume(scope, nonce, expiresAtMs, this.#now()),
        validateFence: isCancel ? undefined : this.#options.validateFence,
      });
    } catch (error) {
      const requestId = untrusted.requestId;
      const correlationId = untrusted.correlationId;
      if (typeof requestId !== "string" || typeof correlationId !== "string") {
        state.socket.destroy();
        return;
      }
      this.#sendError(state, requestId, correlationId, safeError(error));
      return;
    }

    if (request.method === "CANCEL") {
      const expectedPath = `/internal/v1/requests/${request.requestId}/cancel`;
      const active = state.activeRequests.get(request.requestId);
      if (request.path === expectedPath && active?.correlationId === request.correlationId) {
        active.controller.abort(new Error("authenticated client cancellation"));
      }
      return;
    }
    if (!this.#consumeRate(state.credential)) {
      this.#sendError(
        state,
        request.requestId,
        request.correlationId,
        new ResidentProtocolError("request_rate_limited", "resident request rate limit exceeded", { retryable: true }),
      );
      return;
    }
    const activeRequestKey = `${credentialKey(state.credential)}:${request.requestId}`;
    if (this.#activeRequestKeys.has(activeRequestKey)) {
      this.#sendError(
        state,
        request.requestId,
        request.correlationId,
        new ResidentProtocolError("request_invalid", "requestId is already active"),
      );
      return;
    }
    if (this.#activeRequestKeys.size >= (this.#options.maxConcurrentRequests ?? 16)) {
      this.#sendError(
        state,
        request.requestId,
        request.correlationId,
        new ResidentProtocolError("server_busy", "resident request concurrency limit exceeded", { retryable: true }),
      );
      return;
    }
    this.#activeRequestKeys.add(activeRequestKey);
    void this.#dispatch(state, request, activeRequestKey).catch(() => {
      state.socket.destroy();
    });
  }

  async #handleHandshake(state: ConnectionState, value: unknown): Promise<void> {
    const candidate = value as Partial<ResidentRequestFrame>;
    const capability = candidate.capability;
    if (!capability || typeof capability !== "object") {
      state.socket.destroy();
      return;
    }
    const credential = this.#credentialByIdentity.get(
      `${capability.residentSlug}:${capability.role}:${capability.instanceId}:${capability.keyVersion}`,
    );
    if (!credential) {
      state.socket.destroy();
      return;
    }
    let hello: ResidentRequestFrame;
    try {
      hello = verifySignedRequest(value, {
        credential,
        expectedAudience: this.#options.serverInstanceId,
        nowMs: this.#now(),
        consumeNonce: (scope, nonce, expiresAtMs) =>
          this.#nonceCache.consume(scope, nonce, expiresAtMs, this.#now()),
      });
    } catch {
      state.socket.destroy();
      return;
    }
    const payload = hello.payload as Record<string, unknown>;
    if (
      hello.method !== HANDSHAKE_METHOD ||
      hello.path !== HANDSHAKE_PATH ||
      hello.fence !== null ||
      !payload ||
      payload.serverInstanceId !== this.#options.serverInstanceId ||
      payload.clientInstanceId !== credential.instanceId ||
      !Array.isArray(payload.supportedProtocolVersions)
    ) {
      state.socket.destroy();
      return;
    }
    const versions = payload.supportedProtocolVersions.filter(Number.isSafeInteger) as number[];
    if (!versions.includes(RESIDENT_PROTOCOL_VERSION)) {
      this.#sendError(
        { ...state, credential },
        hello.requestId,
        hello.correlationId,
        new ResidentProtocolError(
          "protocol_version_unsupported",
          "no supported resident protocol version overlaps",
        ),
        true,
      );
      return;
    }

    clearTimeout(state.handshakeTimer);
    state.credential = credential;
    const nowMs = this.#now();
    const response = createSignedResponse({
      credential,
      audience: credential.instanceId,
      serverInstanceId: this.#options.serverInstanceId,
      requestId: hello.requestId,
      correlationId: hello.correlationId,
      payload: {
        protocolVersion: RESIDENT_PROTOCOL_VERSION,
        serverInstanceId: this.#options.serverInstanceId,
        clientInstanceId: credential.instanceId,
      },
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + Math.min(30_000, MAX_CAPABILITY_LIFETIME_MS),
      nonce: this.#nonce(),
    });
    this.#write(state.socket, response);
  }

  async #dispatch(
    state: ConnectionState,
    request: ResidentRequestFrame,
    activeRequestKey: string,
  ): Promise<void> {
    const credential = state.credential!;
    const controller = new AbortController();
    const deadlineMs = Date.parse(request.deadlineAt);
    const deadlineTimer = setTimeout(
      () => controller.abort(new Error("resident request deadline elapsed")),
      Math.max(1, deadlineMs - this.#now()),
    );
    deadlineTimer.unref();
    state.activeRequests.set(request.requestId, {
      controller,
      correlationId: request.correlationId,
      deadlineTimer,
    });
    let abortHandler: (() => void) | undefined;
    try {
      const handlerPromise = Promise.resolve().then(() =>
        this.#options.handleRequest(request, {
          signal: controller.signal,
          credential: {
            residentSlug: credential.residentSlug,
            role: credential.role,
            instanceId: credential.instanceId,
            keyVersion: credential.keyVersion,
          },
          requestId: request.requestId,
          correlationId: request.correlationId,
        }),
      );
      const abortPromise = new Promise<never>((_resolve, reject) => {
        abortHandler = () => reject(new Error("resident request aborted"));
        controller.signal.addEventListener("abort", abortHandler, { once: true });
      });
      const payload = await Promise.race([handlerPromise, abortPromise]);
      if (controller.signal.aborted) {
        const code = this.#now() >= deadlineMs ? "deadline_exceeded" : "request_cancelled";
        this.#sendError(
          state,
          request.requestId,
          request.correlationId,
          new ResidentProtocolError(code, code === "deadline_exceeded" ? "request deadline elapsed" : "request was cancelled"),
        );
      } else {
        const nowMs = this.#now();
        this.#write(
          state.socket,
          createSignedResponse({
            credential,
            audience: credential.instanceId,
            serverInstanceId: this.#options.serverInstanceId,
            requestId: request.requestId,
            correlationId: request.correlationId,
            payload,
            issuedAtMs: nowMs,
            expiresAtMs: nowMs + Math.min(30_000, MAX_CAPABILITY_LIFETIME_MS),
            nonce: this.#nonce(),
          }),
        );
      }
    } catch (error) {
      if (controller.signal.aborted) {
        const code = this.#now() >= deadlineMs ? "deadline_exceeded" : "request_cancelled";
        this.#sendError(
          state,
          request.requestId,
          request.correlationId,
          new ResidentProtocolError(code, code === "deadline_exceeded" ? "request deadline elapsed" : "request was cancelled"),
        );
      } else {
        this.#sendError(state, request.requestId, request.correlationId, safeError(error));
      }
    } finally {
      if (abortHandler) controller.signal.removeEventListener("abort", abortHandler);
      clearTimeout(deadlineTimer);
      state.activeRequests.delete(request.requestId);
      this.#activeRequestKeys.delete(activeRequestKey);
    }
  }

  #sendError(
    state: Pick<ConnectionState, "socket" | "credential">,
    requestId: string,
    correlationId: string,
    error: ResidentProtocolError,
    end = false,
  ): void {
    if (!state.credential) {
      state.socket.destroy();
      return;
    }
    const nowMs = this.#now();
    const frame = createSignedErrorResponse({
      credential: state.credential,
      audience: state.credential.instanceId,
      serverInstanceId: this.#options.serverInstanceId,
      requestId,
      correlationId,
      error: {
        code: asProtocolCode(error.code),
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      },
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + Math.min(30_000, MAX_CAPABILITY_LIFETIME_MS),
      nonce: this.#nonce(),
    });
    const encoded = encodeJsonFrame(frame, this.#options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES);
    if (end) state.socket.end(encoded);
    else state.socket.write(encoded);
  }

  #write(socket: Socket, value: unknown): void {
    socket.write(encodeJsonFrame(value, this.#options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES));
  }

  #consumeRate(credential: ResidentCredential): boolean {
    const rule = this.#options.requestRateLimit ?? { limit: 64, intervalMs: 1_000 };
    const key = credentialKey(credential);
    const now = this.#now();
    let window = this.#rateWindows.get(key);
    if (!window || now - window.startedAt >= rule.intervalMs) {
      window = { startedAt: now, count: 0 };
      this.#rateWindows.set(key, window);
    }
    if (window.count >= rule.limit) return false;
    window.count += 1;
    return true;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #nonce(): string {
    return this.#options.nonce?.() ?? randomNonce();
  }

  async #unlinkOwnedSocket(): Promise<void> {
    const identity = this.#socketIdentity;
    this.#socketIdentity = null;
    if (!identity) return;
    try {
      const current = await lstat(this.#options.socketPath, { bigint: true });
      if (current.isSocket() && current.dev === identity.dev && current.ino === identity.ino) {
        await unlink(this.#options.socketPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
