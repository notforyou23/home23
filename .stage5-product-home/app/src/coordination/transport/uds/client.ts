import { randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";

import {
  DEFAULT_MAX_FRAME_BYTES,
  JsonFrameDecoder,
  MAX_CAPABILITY_LIFETIME_MS,
  RESIDENT_PROTOCOL_VERSION,
  ResidentProtocolError,
  createSignedRequest,
  encodeJsonFrame,
  verifySignedResponse,
  type JsonValue,
  type ResidentCredential,
  type ResidentProtocolErrorCode,
  type ResidentResponseFrame,
} from "../../resident-protocol/index.js";
import { generateCoordinationId } from "../../ids/index.js";
import { probeUnixSocketPath } from "./path.js";
import { NonceReplayCache } from "./replay-cache.js";

const HANDSHAKE_METHOD = "HELLO";
const HANDSHAKE_PATH = "/internal/v1/session";

export interface ResidentUdsClientOptions {
  socketPath: string;
  serverInstanceId: string;
  credential: ResidentCredential;
  supportedProtocolVersions?: readonly number[];
  maxFrameBytes?: number;
  connectTimeoutMs?: number;
  now?: () => number;
  nonce?: () => string;
}

export interface ResidentUdsRequestOptions {
  method: string;
  path: string;
  payload: JsonValue;
  deadlineAtMs: number;
  fence?: string | null;
  requestId?: string;
  correlationId?: string;
  signal?: AbortSignal;
}

export interface ResidentUdsResponse {
  protocolVersion: typeof RESIDENT_PROTOCOL_VERSION;
  requestId: string;
  correlationId: string;
  payload: JsonValue;
}

interface PendingRequest {
  requestId: string;
  correlationId: string;
  deadlineTimer: NodeJS.Timeout;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
  resolve: (response: ResidentUdsResponse) => void;
  reject: (error: Error) => void;
}

interface CancelledRequest {
  correlationId: string;
  expiresAt: number;
}

interface HandshakeState {
  requestId: string;
  correlationId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function randomNonce(): string {
  return randomBytes(24).toString("base64url");
}

function protocolErrorFromResponse(frame: Extract<ResidentResponseFrame, { status: "error" }>): ResidentProtocolError {
  return new ResidentProtocolError(
    frame.error.code as ResidentProtocolErrorCode,
    frame.error.message,
    { retryable: frame.error.retryable, details: frame.error.details },
  );
}

export class ResidentUdsClient {
  readonly #options: ResidentUdsClientOptions;
  readonly #responseNonces = new NonceReplayCache();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #recentlyCancelled = new Map<string, CancelledRequest>();
  #socket: Socket | null = null;
  #decoder: JsonFrameDecoder | null = null;
  #connectPromise: Promise<void> | null = null;
  #handshake: HandshakeState | null = null;
  #authenticated = false;
  #closed = false;

  constructor(options: ResidentUdsClientOptions) {
    probeUnixSocketPath(options.socketPath);
    this.#options = options;
    if ((options.supportedProtocolVersions ?? [1]).length === 0) {
      throw new TypeError("supportedProtocolVersions cannot be empty");
    }
  }

  async request(options: ResidentUdsRequestOptions): Promise<ResidentUdsResponse> {
    if (this.#closed) throw new ResidentProtocolError("connection_lost", "resident UDS client is closed");
    const nowMs = this.#now();
    if (options.deadlineAtMs <= nowMs) {
      throw new ResidentProtocolError("deadline_exceeded", "request deadline has elapsed");
    }
    if (options.signal?.aborted) {
      throw new ResidentProtocolError("request_cancelled", "request was cancelled");
    }
    await this.#ensureConnected();
    const requestId = options.requestId ?? generateCoordinationId("request");
    const correlationId = options.correlationId ?? generateCoordinationId("correlation");
    if (this.#pending.has(requestId)) {
      throw new ResidentProtocolError("request_invalid", "requestId is already active");
    }
    const frame = createSignedRequest({
      credential: this.#options.credential,
      audience: this.#options.serverInstanceId,
      method: options.method,
      path: options.path,
      payload: options.payload,
      requestId,
      correlationId,
      deadlineAtMs: options.deadlineAtMs,
      fence: options.fence,
      nonce: this.#nonce(),
      issuedAtMs: nowMs,
      expiresAtMs: Math.min(options.deadlineAtMs, nowMs + MAX_CAPABILITY_LIFETIME_MS),
    });
    const encoded = encodeJsonFrame(frame, this.#options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES);

    return new Promise<ResidentUdsResponse>((resolve, reject) => {
      const deadlineTimer = setTimeout(
        () => this.#cancel(requestId, "deadline_exceeded", "request deadline has elapsed"),
        Math.max(1, options.deadlineAtMs - this.#now()),
      );
      deadlineTimer.unref();
      const pending: PendingRequest = {
        requestId,
        correlationId,
        deadlineTimer,
        abortSignal: options.signal,
        resolve,
        reject,
      };
      if (options.signal) {
        pending.abortListener = () => this.#cancel(requestId, "request_cancelled", "request was cancelled");
        options.signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      this.#pending.set(requestId, pending);
      this.#socket!.write(encoded, (error) => {
        if (error) this.#failPending(requestId, new ResidentProtocolError("connection_lost", "resident socket write failed", { retryable: true }));
      });
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#rejectAll(new ResidentProtocolError("connection_lost", "resident UDS client closed"));
    this.#handshake?.reject(new ResidentProtocolError("connection_lost", "resident UDS client closed"));
    this.#handshake = null;
    const socket = this.#socket;
    this.#resetSocket(socket);
    socket?.destroy();
  }

  async #ensureConnected(): Promise<void> {
    if (this.#authenticated && this.#socket && !this.#socket.destroyed) return;
    if (this.#connectPromise) return this.#connectPromise;
    this.#connectPromise = this.#connect().finally(() => {
      this.#connectPromise = null;
    });
    return this.#connectPromise;
  }

  async #connect(): Promise<void> {
    const socket = createConnection(this.#options.socketPath);
    this.#socket = socket;
    this.#decoder = new JsonFrameDecoder({ maxFrameBytes: this.#options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES });
    this.#authenticated = false;
    socket.on("data", (chunk) => this.#onData(socket, chunk));
    socket.on("error", () => undefined);
    socket.once("close", () => this.#onClose(socket));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new ResidentProtocolError("connection_lost", "resident socket connect timed out", { retryable: true }));
      }, this.#options.connectTimeoutMs ?? 2_000);
      timeout.unref();
      socket.once("connect", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(new ResidentProtocolError("connection_lost", `resident socket connect failed: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`, { retryable: true }));
      });
    });

    const requestId = generateCoordinationId("request");
    const correlationId = generateCoordinationId("correlation");
    const nowMs = this.#now();
    const deadlineAtMs = nowMs + (this.#options.connectTimeoutMs ?? 2_000);
    const hello = createSignedRequest({
      credential: this.#options.credential,
      audience: this.#options.serverInstanceId,
      method: HANDSHAKE_METHOD,
      path: HANDSHAKE_PATH,
      payload: {
        supportedProtocolVersions: [...(this.#options.supportedProtocolVersions ?? [1])],
        serverInstanceId: this.#options.serverInstanceId,
        clientInstanceId: this.#options.credential.instanceId,
      },
      requestId,
      correlationId,
      deadlineAtMs,
      fence: null,
      nonce: this.#nonce(),
      issuedAtMs: nowMs,
      expiresAtMs: deadlineAtMs,
    });
    const handshake = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new ResidentProtocolError(
          "connection_lost",
          "resident socket authentication timed out",
          { retryable: true },
        ));
      }, this.#options.connectTimeoutMs ?? 2_000);
      timer.unref();
      this.#handshake = { requestId, correlationId, resolve, reject, timer };
    });
    socket.write(encodeJsonFrame(hello, this.#options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES));
    return handshake;
  }

  #onData(socket: Socket, chunk: Buffer): void {
    if (socket !== this.#socket || !this.#decoder) return;
    let frames: unknown[];
    try {
      frames = this.#decoder.push(chunk);
    } catch (error) {
      this.#rejectAll(error as Error);
      socket.destroy();
      return;
    }
    for (const value of frames) this.#onFrame(socket, value);
  }

  #onFrame(socket: Socket, value: unknown): void {
    const handshake = this.#handshake;
    if (handshake) {
      try {
        const frame = verifySignedResponse(value, {
          credential: this.#options.credential,
          expectedAudience: this.#options.credential.instanceId,
          expectedServerInstanceId: this.#options.serverInstanceId,
          expectedRequestId: handshake.requestId,
          expectedCorrelationId: handshake.correlationId,
          nowMs: this.#now(),
          consumeNonce: (scope, nonce, expiresAtMs) =>
            this.#responseNonces.consume(scope, nonce, expiresAtMs, this.#now()),
        });
        clearTimeout(handshake.timer);
        this.#handshake = null;
        if (frame.status === "error") {
          handshake.reject(protocolErrorFromResponse(frame));
          socket.destroy();
          return;
        }
        const payload = frame.payload as Record<string, unknown>;
        if (
          payload.protocolVersion !== RESIDENT_PROTOCOL_VERSION ||
          payload.serverInstanceId !== this.#options.serverInstanceId ||
          payload.clientInstanceId !== this.#options.credential.instanceId
        ) {
          throw new ResidentProtocolError("authentication_failed", "resident server negotiation response is invalid");
        }
        this.#authenticated = true;
        handshake.resolve();
      } catch (error) {
        clearTimeout(handshake.timer);
        this.#handshake = null;
        handshake.reject(error as Error);
        socket.destroy();
      }
      return;
    }

    const candidate = value as Partial<ResidentResponseFrame>;
    if (typeof candidate.requestId !== "string") {
      socket.destroy();
      return;
    }
    const pending = this.#pending.get(candidate.requestId);
    const cancelled = this.#recentlyCancelled.get(candidate.requestId);
    const correlationId = pending?.correlationId ?? cancelled?.correlationId;
    if (!correlationId) {
      socket.destroy();
      return;
    }
    try {
      const frame = verifySignedResponse(value, {
        credential: this.#options.credential,
        expectedAudience: this.#options.credential.instanceId,
        expectedServerInstanceId: this.#options.serverInstanceId,
        expectedRequestId: candidate.requestId,
        expectedCorrelationId: correlationId,
        nowMs: this.#now(),
        consumeNonce: (scope, nonce, expiresAtMs) =>
          this.#responseNonces.consume(scope, nonce, expiresAtMs, this.#now()),
      });
      if (!pending) {
        this.#recentlyCancelled.delete(frame.requestId);
        return;
      }
      this.#finishPending(pending);
      if (frame.status === "error") pending.reject(protocolErrorFromResponse(frame));
      else {
        pending.resolve({
          protocolVersion: frame.protocolVersion,
          requestId: frame.requestId,
          correlationId: frame.correlationId,
          payload: frame.payload,
        });
      }
    } catch (error) {
      if (pending) this.#failPending(pending.requestId, error as Error);
      socket.destroy();
    }
  }

  #onClose(socket: Socket): void {
    if (socket !== this.#socket) return;
    const wasAuthenticating = Boolean(this.#handshake);
    const handshake = this.#handshake;
    this.#handshake = null;
    this.#resetSocket(socket);
    if (handshake) {
      clearTimeout(handshake.timer);
      handshake.reject(
        new ResidentProtocolError(
          wasAuthenticating ? "authentication_failed" : "connection_lost",
          wasAuthenticating ? "resident peer authentication failed" : "resident socket closed",
        ),
      );
    }
    this.#rejectAll(new ResidentProtocolError("connection_lost", "resident socket closed", { retryable: true }));
  }

  #cancel(requestId: string, code: "deadline_exceeded" | "request_cancelled", message: string): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#finishPending(pending);
    this.#recentlyCancelled.set(requestId, {
      correlationId: pending.correlationId,
      expiresAt: this.#now() + MAX_CAPABILITY_LIFETIME_MS,
    });
    if (this.#socket && this.#authenticated && !this.#socket.destroyed) {
      const nowMs = this.#now();
      const cancel = createSignedRequest({
        credential: this.#options.credential,
        audience: this.#options.serverInstanceId,
        method: "CANCEL",
        path: `/internal/v1/requests/${requestId}/cancel`,
        payload: { reason: code },
        requestId,
        correlationId: pending.correlationId,
        deadlineAtMs: nowMs + 5_000,
        fence: null,
        nonce: this.#nonce(),
        issuedAtMs: nowMs,
        expiresAtMs: nowMs + 5_000,
      });
      this.#socket.write(encodeJsonFrame(cancel, this.#options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES));
    }
    pending.reject(new ResidentProtocolError(code, message));
    this.#pruneCancelled();
  }

  #finishPending(pending: PendingRequest): void {
    this.#pending.delete(pending.requestId);
    clearTimeout(pending.deadlineTimer);
    if (pending.abortSignal && pending.abortListener) {
      pending.abortSignal.removeEventListener("abort", pending.abortListener);
    }
  }

  #failPending(requestId: string, error: Error): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#finishPending(pending);
    pending.reject(error);
  }

  #rejectAll(error: Error): void {
    for (const pending of [...this.#pending.values()]) {
      this.#finishPending(pending);
      pending.reject(error);
    }
  }

  #resetSocket(socket: Socket | null): void {
    if (socket && socket !== this.#socket) return;
    this.#socket = null;
    this.#decoder = null;
    this.#authenticated = false;
  }

  #pruneCancelled(): void {
    const now = this.#now();
    for (const [requestId, cancelled] of this.#recentlyCancelled) {
      if (cancelled.expiresAt < now) this.#recentlyCancelled.delete(requestId);
    }
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #nonce(): string {
    return this.#options.nonce?.() ?? randomNonce();
  }
}
