import {
  createHash,
  createHmac,
  hkdfSync,
  timingSafeEqual,
} from "node:crypto";

import {
  DEFAULT_CLOCK_SKEW_MS,
  MAX_CAPABILITY_LIFETIME_MS,
  RESIDENT_PROTOCOL_VERSION,
} from "./constants.js";
import { ResidentProtocolError } from "./errors.js";
import type {
  ConsumeNonce,
  JsonValue,
  ResidentCredential,
  ResidentErrorResponseFrame,
  ResidentPeerRole,
  ResidentRequestFrame,
  ResidentResponseFrame,
  ResidentSuccessResponseFrame,
} from "./types.js";
import { validateCoordinationId } from "../ids/index.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESIDENT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

interface CreateResidentCredentialOptions {
  rootKey: Uint8Array;
  residentSlug: string;
  role: ResidentPeerRole;
  instanceId: string;
  keyVersion: number;
}

interface CreateSignedRequestOptions {
  credential: ResidentCredential;
  audience: string;
  method: string;
  path: string;
  payload: JsonValue;
  requestId: string;
  correlationId: string;
  deadlineAtMs: number;
  fence?: string | null;
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

interface VerifySignedRequestOptions {
  credential: ResidentCredential;
  expectedAudience: string;
  nowMs?: number;
  clockSkewMs?: number;
  consumeNonce: ConsumeNonce;
  validateFence?: (fence: string | null, request: ResidentRequestFrame) => boolean;
}

interface CreateSignedResponseOptions {
  credential: ResidentCredential;
  audience: string;
  serverInstanceId: string;
  requestId: string;
  correlationId: string;
  payload: JsonValue;
  issuedAtMs: number;
  expiresAtMs: number;
  nonce: string;
}

interface CreateSignedErrorResponseOptions {
  credential: ResidentCredential;
  audience: string;
  serverInstanceId: string;
  requestId: string;
  correlationId: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Readonly<Record<string, string | number | boolean | null>>;
  };
  issuedAtMs: number;
  expiresAtMs: number;
  nonce: string;
}

interface VerifySignedResponseOptions {
  credential: ResidentCredential;
  expectedAudience: string;
  expectedServerInstanceId: string;
  expectedRequestId: string;
  expectedCorrelationId: string;
  nowMs?: number;
  clockSkewMs?: number;
  consumeNonce: ConsumeNonce;
}

function assertIdentityPart(value: string, label: string): void {
  if (!INSTANCE_ID_PATTERN.test(value)) throw new TypeError(`${label} is invalid`);
}

function assertNonce(value: string): void {
  if (!NONCE_PATTERN.test(value)) throw new TypeError("nonce is invalid");
}

function assertCredentialIdentity(options: {
  residentSlug: string;
  instanceId: string;
  keyVersion: number;
}): void {
  if (!RESIDENT_SLUG_PATTERN.test(options.residentSlug)) {
    throw new TypeError("residentSlug is invalid");
  }
  assertIdentityPart(options.instanceId, "instanceId");
  if (!Number.isSafeInteger(options.keyVersion) || options.keyVersion < 1) {
    throw new TypeError("keyVersion must be a positive safe integer");
  }
}

export function createResidentCredential(
  options: CreateResidentCredentialOptions,
): ResidentCredential {
  assertCredentialIdentity(options);
  if (options.rootKey.byteLength < 32) {
    throw new TypeError("the coordination capability root key must contain at least 32 bytes");
  }
  const info = Buffer.from(
    `home23-resident-uds:v1:${options.role}:${options.residentSlug}:${options.instanceId}:key-${options.keyVersion}`,
    "utf8",
  );
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      options.rootKey,
      Buffer.from("home23-coordination-capability", "utf8"),
      info,
      32,
    ),
  );
  return Object.freeze({
    residentSlug: options.residentSlug,
    role: options.role,
    instanceId: options.instanceId,
    keyVersion: options.keyVersion,
    key,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("value is not canonical JSON");
}

export function digestResidentPayload(payload: JsonValue): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

function signClaims(key: Buffer, claims: Record<string, unknown>): string {
  return createHmac("sha256", key).update(canonicalJson(claims), "utf8").digest("base64url");
}

function signaturesMatch(key: Buffer, claims: Record<string, unknown>, signature: string): boolean {
  if (!SIGNATURE_PATTERN.test(signature)) return false;
  const expected = Buffer.from(signClaims(key, claims), "base64url");
  const provided = Buffer.from(signature, "base64url");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function iso(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) throw new TypeError("timestamp must be finite");
  return new Date(milliseconds).toISOString();
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function assertCapabilityWindow(
  issuedAt: unknown,
  expiresAt: unknown,
  nowMs: number,
  clockSkewMs: number,
): { issuedAtMs: number; expiresAtMs: number } {
  const issuedAtMs = parseTimestamp(issuedAt);
  const expiresAtMs = parseTimestamp(expiresAt);
  if (issuedAtMs === null || expiresAtMs === null || expiresAtMs <= issuedAtMs) {
    throw new ResidentProtocolError(
      "capability_lifetime_invalid",
      "capability validity window is invalid",
    );
  }
  if (expiresAtMs - issuedAtMs > MAX_CAPABILITY_LIFETIME_MS) {
    throw new ResidentProtocolError(
      "capability_lifetime_invalid",
      "capability lifetime exceeds the protocol maximum",
    );
  }
  if (issuedAtMs > nowMs + clockSkewMs) {
    throw new ResidentProtocolError("capability_not_yet_valid", "capability is not yet valid");
  }
  if (expiresAtMs < nowMs) {
    throw new ResidentProtocolError("capability_expired", "capability has expired");
  }
  return { issuedAtMs, expiresAtMs };
}

function requestClaims(frame: ResidentRequestFrame): Record<string, unknown> {
  return {
    audience: frame.capability.audience,
    correlationId: frame.correlationId,
    deadlineAt: frame.deadlineAt,
    expiresAt: frame.capability.expiresAt,
    fence: frame.fence,
    instanceId: frame.capability.instanceId,
    issuedAt: frame.capability.issuedAt,
    keyVersion: frame.capability.keyVersion,
    kind: frame.kind,
    method: frame.method,
    nonce: frame.capability.nonce,
    path: frame.path,
    payloadDigest: frame.capability.payloadDigest,
    protocolVersion: frame.protocolVersion,
    requestId: frame.requestId,
    residentSlug: frame.capability.residentSlug,
    role: frame.capability.role,
  };
}

function responseClaims(frame: ResidentResponseFrame): Record<string, unknown> {
  return {
    audience: frame.capability.audience,
    clientInstanceId: frame.capability.clientInstanceId,
    correlationId: frame.correlationId,
    expiresAt: frame.capability.expiresAt,
    issuedAt: frame.capability.issuedAt,
    keyVersion: frame.capability.keyVersion,
    kind: frame.kind,
    nonce: frame.capability.nonce,
    payloadDigest: frame.capability.payloadDigest,
    protocolVersion: frame.protocolVersion,
    requestId: frame.requestId,
    residentSlug: frame.capability.residentSlug,
    role: frame.capability.role,
    serverInstanceId: frame.capability.serverInstanceId,
    status: frame.status,
  };
}

export function createSignedRequest(options: CreateSignedRequestOptions): ResidentRequestFrame {
  const method = options.method.toUpperCase();
  if (!/^[A-Z]{3,10}$/.test(method)) throw new TypeError("method is invalid");
  if (!options.path.startsWith("/internal/v1/")) throw new TypeError("path is outside /internal/v1");
  if (!validateCoordinationId("request", options.requestId)) throw new TypeError("requestId is invalid");
  if (!validateCoordinationId("correlation", options.correlationId)) {
    throw new TypeError("correlationId is invalid");
  }
  assertIdentityPart(options.audience, "audience");
  assertNonce(options.nonce);
  const frame: ResidentRequestFrame = {
    kind: "request",
    protocolVersion: RESIDENT_PROTOCOL_VERSION,
    requestId: options.requestId,
    correlationId: options.correlationId,
    method,
    path: options.path,
    deadlineAt: iso(options.deadlineAtMs),
    fence: options.fence ?? null,
    payload: options.payload,
    capability: {
      audience: options.audience,
      residentSlug: options.credential.residentSlug,
      role: options.credential.role,
      instanceId: options.credential.instanceId,
      keyVersion: options.credential.keyVersion,
      nonce: options.nonce,
      issuedAt: iso(options.issuedAtMs),
      expiresAt: iso(options.expiresAtMs),
      payloadDigest: digestResidentPayload(options.payload),
      signature: "",
    },
  };
  frame.capability.signature = signClaims(options.credential.key, requestClaims(frame));
  return frame;
}

export function verifySignedRequest(
  value: unknown,
  options: VerifySignedRequestOptions,
): ResidentRequestFrame {
  if (!value || typeof value !== "object") {
    throw new ResidentProtocolError("request_invalid", "request frame is invalid");
  }
  const frame = value as ResidentRequestFrame;
  if (
    frame.kind !== "request" ||
    frame.protocolVersion !== RESIDENT_PROTOCOL_VERSION ||
    !frame.capability ||
    !validateCoordinationId("request", frame.requestId) ||
    !validateCoordinationId("correlation", frame.correlationId) ||
    typeof frame.method !== "string" ||
    typeof frame.path !== "string" ||
    !frame.path.startsWith("/internal/v1/") ||
    !NONCE_PATTERN.test(frame.capability.nonce ?? "") ||
    !SHA256_PATTERN.test(frame.capability.payloadDigest ?? "")
  ) {
    throw new ResidentProtocolError("request_invalid", "request frame is invalid");
  }
  if (
    frame.capability.audience !== options.expectedAudience ||
    frame.capability.residentSlug !== options.credential.residentSlug ||
    frame.capability.role !== options.credential.role ||
    frame.capability.instanceId !== options.credential.instanceId ||
    frame.capability.keyVersion !== options.credential.keyVersion ||
    !signaturesMatch(options.credential.key, requestClaims(frame), frame.capability.signature)
  ) {
    throw new ResidentProtocolError("authentication_failed", "request authentication failed");
  }
  if (digestResidentPayload(frame.payload) !== frame.capability.payloadDigest) {
    throw new ResidentProtocolError("payload_digest_mismatch", "request payload digest differs");
  }
  const nowMs = options.nowMs ?? Date.now();
  const { expiresAtMs } = assertCapabilityWindow(
    frame.capability.issuedAt,
    frame.capability.expiresAt,
    nowMs,
    options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS,
  );
  const deadlineAtMs = parseTimestamp(frame.deadlineAt);
  if (deadlineAtMs === null) {
    throw new ResidentProtocolError("request_invalid", "request deadline is invalid");
  }
  if (deadlineAtMs > expiresAtMs) {
    throw new ResidentProtocolError(
      "request_invalid",
      "request deadline exceeds the capability validity window",
    );
  }
  if (deadlineAtMs <= nowMs) {
    throw new ResidentProtocolError("deadline_exceeded", "request deadline has elapsed");
  }
  const nonceScope = `${frame.capability.residentSlug}:${frame.capability.role}:${frame.capability.instanceId}:request`;
  if (!options.consumeNonce(nonceScope, frame.capability.nonce, expiresAtMs)) {
    throw new ResidentProtocolError("capability_replayed", "request capability was already used");
  }
  if (options.validateFence && !options.validateFence(frame.fence, frame)) {
    throw new ResidentProtocolError("fence_invalid", "request fence is not current");
  }
  return frame;
}

export function createSignedResponse(
  options: CreateSignedResponseOptions,
): ResidentSuccessResponseFrame {
  if (!validateCoordinationId("request", options.requestId)) throw new TypeError("requestId is invalid");
  if (!validateCoordinationId("correlation", options.correlationId)) {
    throw new TypeError("correlationId is invalid");
  }
  assertIdentityPart(options.audience, "audience");
  assertIdentityPart(options.serverInstanceId, "serverInstanceId");
  assertNonce(options.nonce);
  const frame: ResidentSuccessResponseFrame = {
    kind: "response",
    protocolVersion: RESIDENT_PROTOCOL_VERSION,
    requestId: options.requestId,
    correlationId: options.correlationId,
    status: "ok",
    payload: options.payload,
    capability: {
      audience: options.audience,
      serverInstanceId: options.serverInstanceId,
      residentSlug: options.credential.residentSlug,
      role: options.credential.role,
      clientInstanceId: options.credential.instanceId,
      keyVersion: options.credential.keyVersion,
      nonce: options.nonce,
      issuedAt: iso(options.issuedAtMs),
      expiresAt: iso(options.expiresAtMs),
      payloadDigest: digestResidentPayload(options.payload),
      signature: "",
    },
  };
  frame.capability.signature = signClaims(options.credential.key, responseClaims(frame));
  return frame;
}

export function createSignedErrorResponse(
  options: CreateSignedErrorResponseOptions,
): ResidentErrorResponseFrame {
  if (!validateCoordinationId("request", options.requestId)) throw new TypeError("requestId is invalid");
  if (!validateCoordinationId("correlation", options.correlationId)) {
    throw new TypeError("correlationId is invalid");
  }
  assertIdentityPart(options.audience, "audience");
  assertIdentityPart(options.serverInstanceId, "serverInstanceId");
  assertNonce(options.nonce);
  const error = {
    code: options.error.code,
    message: options.error.message,
    retryable: options.error.retryable,
    requestId: options.requestId,
    details: options.error.details ?? {},
  };
  const frame: ResidentErrorResponseFrame = {
    kind: "response",
    protocolVersion: RESIDENT_PROTOCOL_VERSION,
    requestId: options.requestId,
    correlationId: options.correlationId,
    status: "error",
    error,
    capability: {
      audience: options.audience,
      serverInstanceId: options.serverInstanceId,
      residentSlug: options.credential.residentSlug,
      role: options.credential.role,
      clientInstanceId: options.credential.instanceId,
      keyVersion: options.credential.keyVersion,
      nonce: options.nonce,
      issuedAt: iso(options.issuedAtMs),
      expiresAt: iso(options.expiresAtMs),
      payloadDigest: digestResidentPayload(error as JsonValue),
      signature: "",
    },
  };
  frame.capability.signature = signClaims(options.credential.key, responseClaims(frame));
  return frame;
}

export function verifySignedResponse(
  value: unknown,
  options: VerifySignedResponseOptions,
): ResidentResponseFrame {
  if (!value || typeof value !== "object") {
    throw new ResidentProtocolError("request_invalid", "response frame is invalid");
  }
  const frame = value as ResidentResponseFrame;
  if (
    frame.kind !== "response" ||
    frame.protocolVersion !== RESIDENT_PROTOCOL_VERSION ||
    (frame.status !== "ok" && frame.status !== "error") ||
    !frame.capability ||
    frame.requestId !== options.expectedRequestId ||
    frame.correlationId !== options.expectedCorrelationId ||
    !NONCE_PATTERN.test(frame.capability.nonce ?? "") ||
    !SHA256_PATTERN.test(frame.capability.payloadDigest ?? "")
  ) {
    throw new ResidentProtocolError("request_invalid", "response frame is invalid");
  }
  if (
    frame.capability.audience !== options.expectedAudience ||
    frame.capability.serverInstanceId !== options.expectedServerInstanceId ||
    frame.capability.clientInstanceId !== options.credential.instanceId ||
    frame.capability.residentSlug !== options.credential.residentSlug ||
    frame.capability.role !== options.credential.role ||
    frame.capability.keyVersion !== options.credential.keyVersion ||
    !signaturesMatch(options.credential.key, responseClaims(frame), frame.capability.signature)
  ) {
    throw new ResidentProtocolError("authentication_failed", "response authentication failed");
  }
  const payload = frame.status === "ok" ? frame.payload : frame.error;
  if (digestResidentPayload(payload as JsonValue) !== frame.capability.payloadDigest) {
    throw new ResidentProtocolError("payload_digest_mismatch", "response payload digest differs");
  }
  const nowMs = options.nowMs ?? Date.now();
  const { expiresAtMs } = assertCapabilityWindow(
    frame.capability.issuedAt,
    frame.capability.expiresAt,
    nowMs,
    options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS,
  );
  const nonceScope = `${frame.capability.serverInstanceId}:${frame.capability.clientInstanceId}:response`;
  if (!options.consumeNonce(nonceScope, frame.capability.nonce, expiresAtMs)) {
    throw new ResidentProtocolError("capability_replayed", "response capability was already used");
  }
  return frame;
}
