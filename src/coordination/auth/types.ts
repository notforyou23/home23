export const HOME23_API_AUDIENCE = "home23-coordination-api-v1" as const;
export const HOME23_AUTH_ISSUER = "home23-coordination" as const;
export const OWNER_PRINCIPAL_ID = "user_owner" as const;

export const AUTH_TOKEN_LIFETIMES = Object.freeze({
  pairingMs: 10 * 60 * 1000,
  accessMs: 15 * 60 * 1000,
  refreshFamilyMs: 30 * 24 * 60 * 60 * 1000,
});

export const PRODUCT_AUTH_SCOPES = Object.freeze([
  "product:read",
  "message:send",
  "attachment:write",
] as const);

export const LEGACY_BRIDGE_AUTH_SCOPES = Object.freeze([
  "legacy-bridge:access",
] as const);

export const HOUSE_AUTH_SCOPES = Object.freeze([
  ...PRODUCT_AUTH_SCOPES,
  ...LEGACY_BRIDGE_AUTH_SCOPES,
] as const);

export type HouseAuthScope = (typeof HOUSE_AUTH_SCOPES)[number];
export type AuthNetwork = "loopback" | "vpn";
export type DevicePlatform = "macos" | "ios";
export type PairingSessionState = "pending" | "redeemed" | "expired" | "locked";
export type DeviceStatus = "active" | "revoked";
export type ClientSessionState =
  | "pairing_pending"
  | "paired"
  | "active"
  | "expired"
  | "revoked"
  | "rotated";
export type RefreshTokenState = "active" | "expired" | "revoked" | "rotated";
export type RefreshRevokeReason =
  | "refresh_replay"
  | "session_revoke"
  | "device_revoke";

export type AuthReasonCode =
  | "pairing_issued"
  | "pairing_redeemed"
  | "pairing_not_found"
  | "pairing_expired"
  | "pairing_already_redeemed"
  | "pairing_locked"
  | "pairing_code_invalid"
  | "operator_auth_required"
  | "network_not_allowed"
  | "request_invalid"
  | "idempotency_conflict"
  | "rate_limit_exceeded"
  | "refresh_rotated"
  | "refresh_invalid"
  | "refresh_expired"
  | "refresh_replay_family_revoked"
  | "session_inactive"
  | "session_revoked"
  | "device_revoked"
  | "device_not_found"
  | "access_valid"
  | "access_invalid"
  | "access_expired"
  | "access_audience_invalid"
  | "access_scope_denied";

export interface AuthAuditRecord {
  at: string;
  requestId?: string;
  correlationId?: string;
  event:
    | "pairing.issue"
    | "pairing.redeem"
    | "session.refresh"
    | "access.validate"
    | "session.revoke"
    | "device.revoke";
  outcome: "allowed" | "denied" | "revoked";
  reason: AuthReasonCode;
  pairingSessionId?: string;
  deviceId?: string;
  sessionId?: string;
  familyId?: string;
  network?: AuthNetwork;
}

export interface AuthAuditSink {
  record(entry: AuthAuditRecord): void;
}

export interface PairingSessionRecord {
  id: string;
  deviceName: string;
  codeVerifier: string;
  state: PairingSessionState;
  failedAttempts: number;
  createdAt: string;
  expiresAt: string;
  redeemedAt?: string;
}

export type RedeemedPairingProjection = Pick<
  PairingSessionRecord,
  "id" | "expiresAt"
> & {
  state: "redeemed";
  redeemedAt: string;
};

export interface DeviceRecord {
  id: string;
  principalId: typeof OWNER_PRINCIPAL_ID;
  platform: DevicePlatform;
  name: string;
  appBuild: string;
  status: DeviceStatus;
  createdAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

export interface ClientSessionRecord {
  id: string;
  deviceId: string;
  principalId: typeof OWNER_PRINCIPAL_ID;
  familyId: string;
  state: ClientSessionState;
  scopes: readonly HouseAuthScope[];
  accessExpiresAt: string;
  refreshExpiresAt: string;
  createdAt: string;
  rotatedAt?: string;
  rotatedToSessionId?: string;
  revokedAt?: string;
  revokeReason?: RefreshRevokeReason;
}

export interface RefreshTokenRecord {
  id: string;
  familyId: string;
  sessionId: string;
  tokenDigest: string;
  state: RefreshTokenState;
  createdAt: string;
  expiresAt: string;
  rotatedAt?: string;
  rotatedToTokenId?: string;
  revokedAt?: string;
  revokeReason?: RefreshRevokeReason;
}

export interface PairingRedemptionCommit {
  pairingSessionId: string;
  redeemedAt: string;
  device: DeviceRecord;
  session: ClientSessionRecord;
  refreshToken: RefreshTokenRecord;
  idempotency: AuthIdempotencyClaim;
}

export type AuthMutationOperation =
  | "pairing.issue"
  | "pairing.redeem"
  | "session.refresh"
  | "session.revoke"
  | "device.revoke";

export interface AuthMutationContext {
  idempotencyKey: string;
  requestId: string;
  correlationId: string;
}

/** Safe metadata that must be committed atomically with state and its auth event. */
export interface AuthIdempotencyClaim {
  principalId: typeof OWNER_PRINCIPAL_ID;
  operation: AuthMutationOperation;
  idempotencyKeyDigest: string;
  requestId: string;
  correlationId: string;
  requestDigest: string;
  at: string;
}

export interface PairingCreationCommit {
  pairing: PairingSessionRecord;
  idempotency: AuthIdempotencyClaim;
}

export type PairingCreationResult =
  | {
      outcome: "created" | "replayed";
      pairing: Pick<PairingSessionRecord, "id" | "state" | "expiresAt">;
    }
  | { outcome: "conflict" };

export type PairingRedemptionResult =
  | {
      outcome: "redeemed";
      pairing: RedeemedPairingProjection;
      device: DeviceRecord;
      session: ClientSessionRecord;
    }
  | {
      outcome: "replayed";
      pairing: RedeemedPairingProjection;
      device: DeviceRecord;
      session: ClientSessionRecord;
    }
  | { outcome: "conflict" }
  | { outcome: "not_found" }
  | { outcome: "expired" }
  | { outcome: "terminal"; state: PairingSessionState };

export type PairingFailureResult =
  | { outcome: "not_found" }
  | { outcome: "expired" }
  | { outcome: "locked" }
  | { outcome: "terminal"; state: PairingSessionState }
  | { outcome: "pending"; failedAttempts: number }
  | { outcome: "conflict" };

export interface RefreshRotationCommit {
  currentTokenId: string;
  presentedTokenDigest: string;
  rotatedAt: string;
  successorSession: ClientSessionRecord;
  successorToken: RefreshTokenRecord;
  idempotency: AuthIdempotencyClaim;
}

export type RefreshRotationResult =
  | {
      outcome: "rotated";
      session: ClientSessionRecord;
      device: DeviceRecord;
    }
  | {
      outcome: "replayed";
      session: ClientSessionRecord;
      device: DeviceRecord;
    }
  | { outcome: "conflict" }
  | { outcome: "replay"; familyId: string }
  | {
      outcome:
        | "invalid"
        | "expired"
        | "revoked"
        | "session_inactive"
        | "device_inactive";
    };

export interface AuthorizationState {
  session: ClientSessionRecord;
  device: DeviceRecord;
  familyRevoked: boolean;
}

export interface RefreshContext {
  token: RefreshTokenRecord;
  session: ClientSessionRecord;
  device: DeviceRecord;
}

export type RevokeResult = {
  outcome: "revoked" | "replayed" | "not_found" | "already_inactive" | "conflict";
};

export type AuthIdempotencyResult =
  | {
      kind: "pairing";
      pairing: Pick<PairingSessionRecord, "id" | "state" | "expiresAt">;
    }
  | { kind: "pairing_failure"; result: PairingFailureResult }
  | {
      kind: "redemption";
      pairing: RedeemedPairingProjection;
      device: DeviceRecord;
      session: ClientSessionRecord;
    }
  | { kind: "refresh"; device: DeviceRecord; session: ClientSessionRecord }
  | { kind: "refresh_failure"; result: RefreshRotationResult }
  | { kind: "revoke"; result: RevokeResult };

export interface AuthRepository {
  getIdempotency(input: Pick<
    AuthIdempotencyClaim,
    "principalId" | "operation" | "idempotencyKeyDigest"
  >): Promise<{ requestDigest: string; result: AuthIdempotencyResult } | null>;
  createPairing(input: PairingCreationCommit): Promise<PairingCreationResult>;
  getPairing(id: string): Promise<PairingSessionRecord | null>;
  recordPairingFailure(input: {
    pairingSessionId: string;
    at: string;
    maximumFailures: number;
    idempotency: AuthIdempotencyClaim;
  }): Promise<PairingFailureResult>;
  redeemPairing(input: PairingRedemptionCommit): Promise<PairingRedemptionResult>;
  getRefreshContext(tokenId: string): Promise<RefreshContext | null>;
  rotateRefresh(input: RefreshRotationCommit): Promise<RefreshRotationResult>;
  getAuthorizationState(sessionId: string): Promise<AuthorizationState | null>;
  revokeSession(input: {
    sessionId: string;
    revokedAt: string;
    reason: "session_revoke";
    idempotency: AuthIdempotencyClaim;
  }): Promise<RevokeResult>;
  revokeDevice(input: {
    deviceId: string;
    revokedAt: string;
    reason: "device_revoke";
    idempotency: AuthIdempotencyClaim;
  }): Promise<RevokeResult>;
}
