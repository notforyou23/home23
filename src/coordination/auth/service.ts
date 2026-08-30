import { randomBytes as secureRandomBytes } from "node:crypto";

import {
  AccessTokenVerificationError,
  issueAccessToken,
  verifyAccessToken,
} from "./access-token.js";
import {
  createPairingCodeVerifier,
  deriveAuthKey,
  deriveOpaqueId,
  derivePairingCode,
  deriveRefreshCredential,
  digestMutationRequest,
  digestRefreshToken,
  parseRefreshToken,
  verifyPairingCode,
  type AuthRandomBytes,
} from "./crypto.js";
import { AuthError } from "./errors.js";
import type { AuthFailureReasonCode } from "./errors.js";
import {
  FixedWindowRateLimiter,
  type AuthRateLimitPolicyName,
} from "./rate-limit.js";
import { assertCoordinationId, generateCoordinationId } from "../ids/index.js";
import {
  AUTH_TOKEN_LIFETIMES,
  HOUSE_AUTH_SCOPES,
  LEGACY_BRIDGE_AUTH_SCOPES,
  PRODUCT_AUTH_SCOPES,
  OWNER_PRINCIPAL_ID,
  type AuthAuditRecord,
  type AuthAuditSink,
  type AuthIdempotencyClaim,
  type AuthIdempotencyResult,
  type AuthMutationContext,
  type AuthMutationOperation,
  type AuthNetwork,
  type AuthRepository,
  type ClientSessionRecord,
  type DevicePlatform,
  type DeviceRecord,
  type HouseAuthScope,
  type PairingFailureResult,
  type PairingRedemptionResult,
  type RedeemedPairingProjection,
  type PairingSessionRecord,
  type RefreshRotationResult,
  type RefreshTokenRecord,
} from "./types.js";

const MAX_PAIRING_FAILURES = 5;
const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7e]{16,128}$/;
const NOOP_AUDIT: AuthAuditSink = Object.freeze({ record: () => undefined });

type GeneratedAuthIdKind = "pairingSession" | "device" | "clientSession";

export interface CreateAuthServiceOptions {
  repository: AuthRepository;
  keyMaterial: Uint8Array;
  now?: () => Date;
  randomBytes?: AuthRandomBytes;
  audit?: AuthAuditSink;
  onAuditFailure?: () => void;
  idGenerator?: (kind: GeneratedAuthIdKind) => string;
  admissionVerifier: AuthAdmissionVerifier;
  rateLimiter?: FixedWindowRateLimiter;
}

export type AuthAdmissionDecision =
  | { allowed: true; network: AuthNetwork; rateLimitKey: string }
  | { allowed: false; reason: "operator_auth_required" | "network_not_allowed" };

/** M12 supplies verified operator and transport-peer facts through this seam. */
export interface AuthAdmissionVerifier {
  verifyLocalOperator(evidence: unknown): AuthAdmissionDecision;
  verifyClient(evidence: unknown): AuthAdmissionDecision;
}

export interface PairingIssueResult {
  pairingSession: Pick<PairingSessionRecord, "id" | "state" | "expiresAt">;
  pairingCode: string;
}

export interface PairingSuccessResult {
  pairingSession: Pick<PairingSessionRecord, "id" | "state" | "expiresAt"> & {
    redeemedAt: string;
  };
  device: DeviceRecord;
  clientSession: ClientSessionRecord;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  tokenDelivery: "returned_once_and_never_logged";
}

export interface SessionTokenResult {
  device: DeviceRecord;
  clientSession: ClientSessionRecord;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  tokenDelivery: "returned_once_and_never_logged";
}

export interface AuthPrincipalContext {
  principalId: typeof OWNER_PRINCIPAL_ID;
  deviceId: string;
  sessionId: string;
  scopes: readonly HouseAuthScope[];
}

function canonicalNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("auth clock returned an invalid date");
  }
  return new Date(value.getTime());
}

function canonicalText(value: string, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > maximumLength || text.includes("\0")) return null;
  return text;
}

function pairingFailure(result: PairingRedemptionResult): never {
  switch (result.outcome) {
    case "conflict":
      throw new AuthError("idempotency_conflict");
    case "not_found":
      throw new AuthError("pairing_not_found");
    case "expired":
      throw new AuthError("pairing_expired");
    case "terminal":
      if (result.state === "redeemed") throw new AuthError("pairing_already_redeemed");
      if (result.state === "locked") throw new AuthError("pairing_locked");
      throw new AuthError("pairing_expired");
    case "redeemed":
    case "replayed":
      throw new AuthError("request_invalid");
  }
}

function pairingAttemptFailure(result: PairingFailureResult): never {
  switch (result.outcome) {
    case "conflict":
      throw new AuthError("idempotency_conflict");
    case "locked":
      throw new AuthError("pairing_locked");
    case "not_found":
      throw new AuthError("pairing_not_found");
    case "expired":
      throw new AuthError("pairing_expired");
    case "terminal":
      if (result.state === "redeemed") throw new AuthError("pairing_already_redeemed");
      if (result.state === "locked") throw new AuthError("pairing_locked");
      throw new AuthError("pairing_expired");
    case "pending":
      throw new AuthError("pairing_code_invalid");
  }
}

function pairingAttemptReason(result: PairingFailureResult): AuthFailureReasonCode {
  if (result.outcome === "conflict") return "idempotency_conflict";
  if (result.outcome === "locked" ||
      (result.outcome === "terminal" && result.state === "locked")) {
    return "pairing_locked";
  }
  if (result.outcome === "not_found") return "pairing_not_found";
  if (result.outcome === "expired" ||
      (result.outcome === "terminal" && result.state === "expired")) {
    return "pairing_expired";
  }
  if (result.outcome === "terminal" && result.state === "redeemed") {
    return "pairing_already_redeemed";
  }
  return "pairing_code_invalid";
}

function refreshFailureReason(result: RefreshRotationResult): AuthFailureReasonCode {
  if (result.outcome === "conflict") return "idempotency_conflict";
  if (result.outcome === "replay") return "refresh_replay_family_revoked";
  if (result.outcome === "expired") return "refresh_expired";
  if (result.outcome === "device_inactive") return "device_revoked";
  if (result.outcome === "revoked") return "session_revoked";
  if (result.outcome === "session_inactive") return "session_inactive";
  return "refresh_invalid";
}

function accessFailureReason(error: unknown):
  | "access_expired"
  | "access_audience_invalid"
  | "access_invalid" {
  if (error instanceof AccessTokenVerificationError && error.kind === "expired") {
    return "access_expired";
  }
  if (error instanceof AccessTokenVerificationError && error.kind === "audience") {
    return "access_audience_invalid";
  }
  return "access_invalid";
}

function canonicalRequest(value: unknown): string {
  return JSON.stringify(value);
}

export function createAuthService(options: CreateAuthServiceOptions) {
  const {
    repository,
    keyMaterial,
    audit = NOOP_AUDIT,
    onAuditFailure,
    admissionVerifier,
  } = options;
  const now = options.now ?? (() => new Date());
  const randomBytes = options.randomBytes ?? secureRandomBytes;
  const idGenerator = options.idGenerator ?? ((kind) => generateCoordinationId(kind));
  const rateLimiter = options.rateLimiter ?? new FixedWindowRateLimiter();
  const material = Buffer.from(keyMaterial);
  const accessSigningKey = deriveAuthKey(material, "access-signing");
  const refreshDigestKey = deriveAuthKey(material, "refresh-digest");
  const credentialGenerationKey = deriveAuthKey(material, "credential-generation");
  const idempotencyDigestKey = deriveAuthKey(material, "idempotency-request-digest");
  material.fill(0);

  function record(entry: AuthAuditRecord): void {
    try {
      audit.record(Object.freeze({ ...entry }));
    } catch {
      try {
        onAuditFailure?.();
      } catch {
        // The health hook is also diagnostic and may not affect auth state.
      }
    }
  }

  function makeId(kind: GeneratedAuthIdKind): string {
    const value = idGenerator(kind);
    assertCoordinationId(kind, value);
    return value;
  }

  function admit(
    kind: "operator" | "client",
    evidence: unknown,
  ): { network: AuthNetwork; rateLimitKey: string } {
    const decision = kind === "operator"
      ? admissionVerifier.verifyLocalOperator(evidence)
      : admissionVerifier.verifyClient(evidence);
    if (!decision.allowed) throw new AuthError(decision.reason);
    if (
      (decision.network !== "loopback" && decision.network !== "vpn") ||
      (kind === "operator" && decision.network !== "loopback") ||
      typeof decision.rateLimitKey !== "string" ||
      !decision.rateLimitKey ||
      decision.rateLimitKey.length > 256 ||
      decision.rateLimitKey.includes("\0")
    ) {
      throw new Error("auth admission verifier returned invalid trusted facts");
    }
    return decision;
  }

  function consumeMutationRate(
    admission: { rateLimitKey: string },
    policy: AuthRateLimitPolicyName,
    at: Date,
  ): void {
    if (!rateLimiter.consume({
      policy,
      key: admission.rateLimitKey,
      nowMs: at.getTime(),
    }).allowed) {
      throw new AuthError("rate_limit_exceeded");
    }
  }

  function claim(
    operation: AuthMutationOperation,
    mutation: AuthMutationContext,
    request: unknown,
    at: Date,
  ): AuthIdempotencyClaim {
    if (!mutation || !IDEMPOTENCY_KEY_PATTERN.test(mutation.idempotencyKey)) {
      throw new AuthError("request_invalid");
    }
    try {
      assertCoordinationId("request", mutation.requestId);
      assertCoordinationId("correlation", mutation.correlationId);
    } catch {
      throw new AuthError("request_invalid");
    }
    return {
      principalId: OWNER_PRINCIPAL_ID,
      operation,
      idempotencyKeyDigest: digestMutationRequest(
        idempotencyDigestKey,
        "idempotency-key",
        mutation.idempotencyKey,
      ),
      requestId: mutation.requestId,
      correlationId: mutation.correlationId,
      requestDigest: digestMutationRequest(
        idempotencyDigestKey,
        operation,
        canonicalRequest(request),
      ),
      at: at.toISOString(),
    };
  }

  async function resolveIdempotency(
    input: AuthIdempotencyClaim,
  ): Promise<AuthIdempotencyResult | null> {
    const existing = await repository.getIdempotency(input);
    if (existing && existing.requestDigest !== input.requestDigest) {
      throw new AuthError("idempotency_conflict");
    }
    return existing?.result ?? null;
  }

  function accessFor(session: ClientSessionRecord, device: DeviceRecord, context: string): string {
    return issueAccessToken(accessSigningKey, {
      session,
      device,
      issuedAt: new Date(session.createdAt),
      tokenId: deriveOpaqueId(credentialGenerationKey, "access-jti", context),
    });
  }

  function pairingDelivery(input: {
    pairing: RedeemedPairingProjection;
    device: DeviceRecord;
    session: ClientSessionRecord;
    credentialContext: string;
  }): PairingSuccessResult {
    const refresh = deriveRefreshCredential(
      refreshDigestKey,
      credentialGenerationKey,
      input.credentialContext,
    );
    return {
      pairingSession: {
        id: input.pairing.id,
        state: input.pairing.state,
        expiresAt: input.pairing.expiresAt,
        redeemedAt: input.pairing.redeemedAt,
      },
      device: input.device,
      clientSession: input.session,
      accessToken: accessFor(input.session, input.device, input.credentialContext),
      refreshToken: refresh.raw,
      accessExpiresAt: input.session.accessExpiresAt,
      refreshExpiresAt: input.session.refreshExpiresAt,
      tokenDelivery: "returned_once_and_never_logged",
    };
  }

  function refreshDelivery(input: {
    device: DeviceRecord;
    session: ClientSessionRecord;
    credentialContext: string;
  }): SessionTokenResult {
    const refresh = deriveRefreshCredential(
      refreshDigestKey,
      credentialGenerationKey,
      input.credentialContext,
    );
    return {
      device: input.device,
      clientSession: input.session,
      accessToken: accessFor(input.session, input.device, input.credentialContext),
      refreshToken: refresh.raw,
      accessExpiresAt: input.session.accessExpiresAt,
      refreshExpiresAt: input.session.refreshExpiresAt,
      tokenDelivery: "returned_once_and_never_logged",
    };
  }

  async function issuePairing(input: {
    deviceName: string;
    operator: unknown;
    mutation: AuthMutationContext;
  }): Promise<PairingIssueResult> {
    const at = canonicalNow(now);
    const admission = admit("operator", input.operator);
    const deviceName = canonicalText(input.deviceName, 128);
    if (!deviceName) throw new AuthError("request_invalid");
    const idempotency = claim("pairing.issue", input.mutation, { deviceName }, at);
    const existing = await resolveIdempotency(idempotency);
    if (existing && existing.kind !== "pairing") {
      throw new Error("auth repository returned an invalid pairing replay kind");
    }
    if (!existing) consumeMutationRate(admission, "pairingIssue", at);
    const pairingId = existing?.pairing.id ?? makeId("pairingSession");
    const pairingCode = derivePairingCode(
      credentialGenerationKey,
      `${idempotency.operation}\0${input.mutation.idempotencyKey}\0${pairingId}`,
    );
    if (existing) {
      record({
        at: at.toISOString(), requestId: idempotency.requestId,
        correlationId: idempotency.correlationId, event: "pairing.issue",
        outcome: "allowed", reason: "pairing_issued",
        pairingSessionId: existing.pairing.id, network: admission.network,
      });
      return { pairingSession: existing.pairing, pairingCode };
    }
    const pairing: PairingSessionRecord = {
      id: pairingId,
      deviceName,
      codeVerifier: await createPairingCodeVerifier(pairingCode, randomBytes),
      state: "pending",
      failedAttempts: 0,
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + AUTH_TOKEN_LIFETIMES.pairingMs).toISOString(),
    };
    const committed = await repository.createPairing({ pairing, idempotency });
    if (committed.outcome === "conflict") throw new AuthError("idempotency_conflict");
    const deliveredPairingCode = committed.pairing.id === pairingId
      ? pairingCode
      : derivePairingCode(
          credentialGenerationKey,
          `${idempotency.operation}\0${input.mutation.idempotencyKey}\0${committed.pairing.id}`,
        );
    record({
      at: at.toISOString(), requestId: idempotency.requestId,
      correlationId: idempotency.correlationId,
      event: "pairing.issue", outcome: "allowed",
      reason: "pairing_issued", pairingSessionId: committed.pairing.id, network: "loopback",
    });
    return {
      pairingSession: {
        id: committed.pairing.id,
        state: committed.pairing.state,
        expiresAt: committed.pairing.expiresAt,
      },
      pairingCode: deliveredPairingCode,
    };
  }

  async function redeemPairing(input: {
    pairingSessionId: string;
    pairingCode: string;
    network: unknown;
    device: { platform: DevicePlatform; name: string; appBuild: string };
    credentialProfile?: "product" | "legacy_bridge";
    mutation: AuthMutationContext;
  }): Promise<PairingSuccessResult> {
    const at = canonicalNow(now);
    let admission: { network: AuthNetwork; rateLimitKey: string };
    try {
      admission = admit("client", input.network);
    } catch (error) {
      const reason = error instanceof AuthError ? error.reasonCode : "network_not_allowed";
      record({ at: at.toISOString(), event: "pairing.redeem", outcome: "denied", reason });
      throw error;
    }
    try {
      assertCoordinationId("pairingSession", input.pairingSessionId);
    } catch {
      throw new AuthError("request_invalid");
    }
    const deviceName = canonicalText(input.device?.name, 128);
    const appBuild = canonicalText(input.device?.appBuild, 64);
    if (!deviceName || !appBuild || (input.device.platform !== "macos" && input.device.platform !== "ios")) {
      throw new AuthError("request_invalid");
    }
    if (
      typeof input.pairingCode !== "string" ||
      Buffer.byteLength(input.pairingCode, "utf8") > 32
    ) {
      throw new AuthError("request_invalid");
    }
    const credentialProfile = input.credentialProfile ?? "product";
    if (credentialProfile !== "product" && credentialProfile !== "legacy_bridge") {
      throw new AuthError("request_invalid");
    }
    const idempotency = claim("pairing.redeem", input.mutation, {
      pairingSessionId: input.pairingSessionId,
      pairingCode: input.pairingCode,
      device: { platform: input.device.platform, name: deviceName, appBuild },
      credentialProfile,
    }, at);
    const existing = await resolveIdempotency(idempotency);
    const credentialContext = `${idempotency.operation}\0${input.mutation.idempotencyKey}\0${input.pairingSessionId}`;
    if (existing) {
      if (existing.kind === "pairing_failure") {
        const reason = pairingAttemptReason(existing.result);
        record({
          at: at.toISOString(), requestId: idempotency.requestId,
          correlationId: idempotency.correlationId, event: "pairing.redeem",
          outcome: "denied", reason, pairingSessionId: input.pairingSessionId,
          network: admission.network,
        });
        pairingAttemptFailure(existing.result);
      }
      if (existing.kind !== "redemption") {
        throw new Error("auth repository returned an invalid redemption replay kind");
      }
      record({
        at: at.toISOString(), requestId: idempotency.requestId,
        correlationId: idempotency.correlationId, event: "pairing.redeem",
        outcome: "allowed", reason: "pairing_redeemed",
        pairingSessionId: existing.pairing.id, deviceId: existing.device.id,
        sessionId: existing.session.id, familyId: existing.session.familyId,
        network: admission.network,
      });
      return pairingDelivery({
        pairing: existing.pairing,
        device: existing.device,
        session: existing.session,
        credentialContext,
      });
    }
    consumeMutationRate(admission, "pairingRedeem", at);
    const pairing = await repository.getPairing(input.pairingSessionId);
    if (!pairing) throw new AuthError("pairing_not_found");
    if (!(await verifyPairingCode(input.pairingCode, pairing.codeVerifier))) {
      const failure = await repository.recordPairingFailure({
        pairingSessionId: pairing.id,
        at: at.toISOString(),
        maximumFailures: MAX_PAIRING_FAILURES,
        idempotency,
      });
      const reason = pairingAttemptReason(failure);
      record({
        at: at.toISOString(), requestId: idempotency.requestId,
        correlationId: idempotency.correlationId, event: "pairing.redeem",
        outcome: "denied", reason, pairingSessionId: pairing.id,
        network: admission.network,
      });
      pairingAttemptFailure(failure);
    }

    const familyId = deriveOpaqueId(credentialGenerationKey, "refresh-family", credentialContext);
    const refresh = deriveRefreshCredential(refreshDigestKey, credentialGenerationKey, credentialContext);
    const accessExpiresAt = new Date(at.getTime() + AUTH_TOKEN_LIFETIMES.accessMs).toISOString();
    const refreshExpiresAt = new Date(at.getTime() + AUTH_TOKEN_LIFETIMES.refreshFamilyMs).toISOString();
    const device: DeviceRecord = {
      id: makeId("device"), principalId: OWNER_PRINCIPAL_ID,
      platform: input.device.platform, name: deviceName, appBuild, status: "active",
      createdAt: at.toISOString(), lastSeenAt: at.toISOString(),
    };
    const session: ClientSessionRecord = {
      id: makeId("clientSession"), deviceId: device.id, principalId: OWNER_PRINCIPAL_ID,
      familyId, state: "active", scopes: credentialProfile === "legacy_bridge"
        ? LEGACY_BRIDGE_AUTH_SCOPES
        : PRODUCT_AUTH_SCOPES,
      accessExpiresAt, refreshExpiresAt, createdAt: at.toISOString(),
    };
    const refreshToken: RefreshTokenRecord = {
      id: refresh.id, familyId, sessionId: session.id, tokenDigest: refresh.digest,
      state: "active", createdAt: at.toISOString(), expiresAt: refreshExpiresAt,
    };
    const committed = await repository.redeemPairing({
      pairingSessionId: pairing.id, redeemedAt: at.toISOString(), device, session,
      refreshToken, idempotency,
    });
    if (committed.outcome !== "redeemed" && committed.outcome !== "replayed") {
      const reason = committed.outcome === "conflict"
        ? "idempotency_conflict"
        : committed.outcome === "not_found"
          ? "pairing_not_found"
          : committed.outcome === "expired"
            ? "pairing_expired"
            : committed.state === "redeemed"
              ? "pairing_already_redeemed"
              : committed.state === "locked"
                ? "pairing_locked"
                : "pairing_expired";
      record({
        at: at.toISOString(), requestId: idempotency.requestId,
        correlationId: idempotency.correlationId,
        event: "pairing.redeem", outcome: "denied", reason,
        pairingSessionId: pairing.id, network: admission.network,
      });
      pairingFailure(committed);
    }
    record({
      at: at.toISOString(), requestId: idempotency.requestId,
      correlationId: idempotency.correlationId,
      event: "pairing.redeem", outcome: "allowed", reason: "pairing_redeemed",
      pairingSessionId: committed.pairing.id, deviceId: committed.device.id,
      sessionId: committed.session.id, familyId: committed.session.familyId, network: admission.network,
    });
    return pairingDelivery({
      pairing: committed.pairing,
      device: committed.device,
      session: committed.session,
      credentialContext,
    });
  }

  async function refreshSession(input: {
    refreshToken: string;
    network: unknown;
    mutation: AuthMutationContext;
  }): Promise<SessionTokenResult> {
    const at = canonicalNow(now);
    const admission = admit("client", input.network);
    if (
      typeof input.refreshToken !== "string" ||
      Buffer.byteLength(input.refreshToken, "utf8") > 256
    ) {
      throw new AuthError("request_invalid");
    }
    const idempotency = claim("session.refresh", input.mutation, { refreshToken: input.refreshToken }, at);
    const existing = await resolveIdempotency(idempotency);
    const parsed = parseRefreshToken(input.refreshToken);
    if (!parsed) {
      if (!existing) consumeMutationRate(admission, "refresh", at);
      record({
        at: at.toISOString(), requestId: idempotency.requestId,
        correlationId: idempotency.correlationId, event: "session.refresh",
        outcome: "denied", reason: "refresh_invalid", network: admission.network,
      });
      throw new AuthError("refresh_invalid");
    }
    const credentialContext = `${idempotency.operation}\0${input.mutation.idempotencyKey}\0${parsed.id}`;
    if (existing) {
      if (existing.kind === "refresh_failure") {
        const reason = refreshFailureReason(existing.result);
        record({
          at: at.toISOString(), requestId: idempotency.requestId,
          correlationId: idempotency.correlationId, event: "session.refresh",
          outcome: existing.result.outcome === "replay" ? "revoked" : "denied",
          reason, familyId: existing.result.outcome === "replay"
            ? existing.result.familyId
            : undefined,
          network: admission.network,
        });
        throw new AuthError(reason);
      }
      if (existing.kind !== "refresh") {
        throw new Error("auth repository returned an invalid refresh replay kind");
      }
      record({
        at: at.toISOString(), requestId: idempotency.requestId,
        correlationId: idempotency.correlationId, event: "session.refresh",
        outcome: "allowed", reason: "refresh_rotated",
        deviceId: existing.device.id, sessionId: existing.session.id,
        familyId: existing.session.familyId, network: admission.network,
      });
      return refreshDelivery({
        device: existing.device,
        session: existing.session,
        credentialContext,
      });
    }
    consumeMutationRate(admission, "refresh", at);
    const context = await repository.getRefreshContext(parsed.id);
    if (!context) {
      record({
        at: at.toISOString(), requestId: idempotency.requestId,
        correlationId: idempotency.correlationId, event: "session.refresh",
        outcome: "denied", reason: "refresh_invalid", network: admission.network,
      });
      throw new AuthError("refresh_invalid");
    }
    const successorCredential = deriveRefreshCredential(refreshDigestKey, credentialGenerationKey, credentialContext);
    const accessExpiresAt = new Date(at.getTime() + AUTH_TOKEN_LIFETIMES.accessMs).toISOString();
    const successorSession: ClientSessionRecord = {
      id: makeId("clientSession"), deviceId: context.device.id, principalId: OWNER_PRINCIPAL_ID,
      familyId: context.token.familyId, state: "active", scopes: context.session.scopes,
      accessExpiresAt, refreshExpiresAt: context.token.expiresAt, createdAt: at.toISOString(),
    };
    const successorToken: RefreshTokenRecord = {
      id: successorCredential.id, familyId: context.token.familyId,
      sessionId: successorSession.id, tokenDigest: successorCredential.digest,
      state: "active", createdAt: at.toISOString(), expiresAt: context.token.expiresAt,
    };
    const rotated = await repository.rotateRefresh({
      currentTokenId: parsed.id,
      presentedTokenDigest: digestRefreshToken(input.refreshToken, refreshDigestKey),
      rotatedAt: at.toISOString(), successorSession, successorToken, idempotency,
    });
    if (rotated.outcome !== "rotated" && rotated.outcome !== "replayed") {
      const reason = refreshFailureReason(rotated);
      record({
        at: at.toISOString(), requestId: idempotency.requestId,
        correlationId: idempotency.correlationId, event: "session.refresh",
        outcome: rotated.outcome === "replay" ? "revoked" : "denied", reason,
        deviceId: context.device.id, sessionId: context.session.id,
        familyId: context.token.familyId, network: admission.network,
      });
      throw new AuthError(reason);
    }
    record({
      at: at.toISOString(), requestId: idempotency.requestId,
      correlationId: idempotency.correlationId,
      event: "session.refresh", outcome: "allowed", reason: "refresh_rotated",
      deviceId: rotated.device.id, sessionId: rotated.session.id,
      familyId: rotated.session.familyId, network: admission.network,
    });
    return refreshDelivery({
      device: rotated.device,
      session: rotated.session,
      credentialContext,
    });
  }

  async function validateAccessToken(input: {
    accessToken: string;
    network: unknown;
    requiredScopes?: readonly HouseAuthScope[];
  }): Promise<AuthPrincipalContext> {
    const at = canonicalNow(now);
    const admission = admit("client", input.network);
    let claims;
    try {
      claims = verifyAccessToken(accessSigningKey, input.accessToken, at);
    } catch (error) {
      const reason = accessFailureReason(error);
      record({ at: at.toISOString(), event: "access.validate", outcome: "denied", reason, network: admission.network });
      throw new AuthError(reason);
    }
    const requiredScopes = input.requiredScopes ?? [];
    if (requiredScopes.length !== new Set(requiredScopes).size || requiredScopes.some((scope) => !(HOUSE_AUTH_SCOPES as readonly string[]).includes(scope))) {
      throw new AuthError("request_invalid");
    }
    const state = await repository.getAuthorizationState(claims.sessionId);
    let deniedReason: "session_inactive" | "session_revoked" | "device_revoked" | "access_expired" | "access_invalid" | "access_scope_denied" | undefined;
    if (!state) deniedReason = "session_inactive";
    else if (state.device.status !== "active") deniedReason = "device_revoked";
    else if (state.session.state === "revoked" || state.familyRevoked) deniedReason = "session_revoked";
    else if (state.session.state !== "active") deniedReason = "session_inactive";
    else if (state.session.accessExpiresAt <= at.toISOString() || state.session.refreshExpiresAt <= at.toISOString()) deniedReason = "access_expired";
    else if (
      state.session.deviceId !== claims.deviceId || state.device.id !== claims.deviceId ||
      state.session.principalId !== claims.principalId || state.device.principalId !== claims.principalId ||
      state.session.scopes.length !== claims.scopes.length ||
      state.session.scopes.some((scope, index) => scope !== claims.scopes[index])
    ) deniedReason = "access_invalid";
    else if (requiredScopes.some((scope) => !claims.scopes.includes(scope))) deniedReason = "access_scope_denied";
    if (deniedReason) {
      record({ at: at.toISOString(), event: "access.validate", outcome: "denied", reason: deniedReason, deviceId: claims.deviceId, sessionId: claims.sessionId, familyId: state?.session.familyId, network: admission.network });
      throw new AuthError(deniedReason);
    }
    record({ at: at.toISOString(), event: "access.validate", outcome: "allowed", reason: "access_valid", deviceId: claims.deviceId, sessionId: claims.sessionId, familyId: state?.session.familyId, network: admission.network });
    return Object.freeze({ principalId: claims.principalId, deviceId: claims.deviceId, sessionId: claims.sessionId, scopes: Object.freeze([...claims.scopes]) });
  }

  async function revokeCurrentSession(input: {
    accessToken: string;
    network: unknown;
    mutation: AuthMutationContext;
  }): Promise<{ sessionId: string; state: "revoked" }> {
    const at = canonicalNow(now);
    const admission = admit("client", input.network);
    let claims;
    try {
      claims = verifyAccessToken(accessSigningKey, input.accessToken, at);
    } catch (error) {
      throw new AuthError(accessFailureReason(error));
    }
    const idempotency = claim("session.revoke", input.mutation, { sessionId: claims.sessionId }, at);
    const existing = await resolveIdempotency(idempotency);
    if (existing) {
      if (existing.kind !== "revoke" ||
          (existing.result.outcome !== "revoked" && existing.result.outcome !== "replayed")) {
        throw new Error("auth repository returned an invalid session revoke replay kind");
      }
      record({
        at: at.toISOString(), requestId: idempotency.requestId,
        correlationId: idempotency.correlationId, event: "session.revoke",
        outcome: "revoked", reason: "session_revoked", deviceId: claims.deviceId,
        sessionId: claims.sessionId, network: admission.network,
      });
      return { sessionId: claims.sessionId, state: "revoked" };
    }
    consumeMutationRate(admission, "protectedMutation", at);
    const result = await repository.revokeSession({
      sessionId: claims.sessionId, revokedAt: at.toISOString(), reason: "session_revoke", idempotency,
    });
    if (result.outcome === "conflict") throw new AuthError("idempotency_conflict");
    if (result.outcome !== "revoked" && result.outcome !== "replayed") throw new AuthError("session_inactive");
    record({
      at: at.toISOString(), requestId: idempotency.requestId,
      correlationId: idempotency.correlationId, event: "session.revoke",
      outcome: "revoked", reason: "session_revoked", deviceId: claims.deviceId,
      sessionId: claims.sessionId, network: admission.network,
    });
    return { sessionId: claims.sessionId, state: "revoked" };
  }

  async function revokeDevice(input: {
    deviceId: string;
    operator: unknown;
    mutation: AuthMutationContext;
  }): Promise<{ deviceId: string; status: "revoked" }> {
    const at = canonicalNow(now);
    const admission = admit("operator", input.operator);
    try {
      assertCoordinationId("device", input.deviceId);
    } catch {
      throw new AuthError("request_invalid");
    }
    const idempotency = claim("device.revoke", input.mutation, { deviceId: input.deviceId }, at);
    const existing = await resolveIdempotency(idempotency);
    if (existing) {
      if (existing.kind !== "revoke" ||
          (existing.result.outcome !== "revoked" && existing.result.outcome !== "replayed")) {
        throw new Error("auth repository returned an invalid device revoke replay kind");
      }
      record({
        at: at.toISOString(), requestId: idempotency.requestId,
        correlationId: idempotency.correlationId, event: "device.revoke",
        outcome: "revoked", reason: "device_revoked", deviceId: input.deviceId,
        network: admission.network,
      });
      return { deviceId: input.deviceId, status: "revoked" };
    }
    consumeMutationRate(admission, "protectedMutation", at);
    const result = await repository.revokeDevice({ deviceId: input.deviceId, revokedAt: at.toISOString(), reason: "device_revoke", idempotency });
    if (result.outcome === "conflict") throw new AuthError("idempotency_conflict");
    if (result.outcome === "not_found") throw new AuthError("device_not_found");
    record({
      at: at.toISOString(), requestId: idempotency.requestId,
      correlationId: idempotency.correlationId, event: "device.revoke",
      outcome: "revoked", reason: "device_revoked", deviceId: input.deviceId,
      network: admission.network,
    });
    return { deviceId: input.deviceId, status: "revoked" };
  }

  return Object.freeze({
    issuePairing,
    redeemPairing,
    refreshSession,
    validateAccessToken,
    revokeCurrentSession,
    revokeDevice,
  });
}
