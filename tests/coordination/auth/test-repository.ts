import { timingSafeEqual } from "node:crypto";

import type {
  AuthRepository,
  AuthIdempotencyClaim,
  AuthIdempotencyResult,
  AuthorizationState,
  PairingCreationCommit,
  PairingCreationResult,
  PairingFailureResult,
  PairingRedemptionCommit,
  PairingRedemptionResult,
  PairingSessionRecord,
  RefreshRotationCommit,
  RefreshRotationResult,
  RefreshContext,
  RevokeResult,
} from "../../../src/coordination/auth/index.js";

type StoredIdempotencyResult = AuthIdempotencyResult;

interface StoredIdempotency {
  claim: AuthIdempotencyClaim;
  result: StoredIdempotencyResult;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function equalDigest(left: string, right: string): boolean {
  const supplied = Buffer.from(left, "hex");
  const expected = Buffer.from(right, "hex");
  const comparable = supplied.length === expected.length
    ? supplied
    : Buffer.alloc(expected.length);
  return timingSafeEqual(comparable, expected) && supplied.length === expected.length;
}

export class TestAuthRepository implements AuthRepository {
  readonly pairings = new Map<string, PairingSessionRecord>();
  readonly devices = new Map<string, PairingRedemptionCommit["device"]>();
  readonly sessions = new Map<string, PairingRedemptionCommit["session"]>();
  readonly refreshTokens = new Map<string, PairingRedemptionCommit["refreshToken"]>();
  readonly idempotency = new Map<string, StoredIdempotency>();

  private idempotencyKey(input: Pick<
    AuthIdempotencyClaim,
    "principalId" | "operation" | "idempotencyKeyDigest"
  >): string {
    return `${input.principalId}\0${input.operation}\0${input.idempotencyKeyDigest}`;
  }

  async getIdempotency(input: Pick<
    AuthIdempotencyClaim,
    "principalId" | "operation" | "idempotencyKeyDigest"
  >): Promise<{ requestDigest: string; result: AuthIdempotencyResult } | null> {
    const stored = this.idempotency.get(this.idempotencyKey(input));
    return stored
      ? { requestDigest: stored.claim.requestDigest, result: copy(stored.result) }
      : null;
  }

  private existing(input: AuthIdempotencyClaim): StoredIdempotency | "conflict" | null {
    const stored = this.idempotency.get(this.idempotencyKey(input));
    if (!stored) return null;
    return stored.claim.requestDigest === input.requestDigest ? stored : "conflict";
  }

  private commitIdempotency(
    input: AuthIdempotencyClaim,
    result: StoredIdempotencyResult,
  ): void {
    this.idempotency.set(this.idempotencyKey(input), {
      claim: copy(input),
      result: copy(result),
    });
  }

  async createPairing(input: PairingCreationCommit): Promise<PairingCreationResult> {
    const existing = this.existing(input.idempotency);
    if (existing === "conflict") return { outcome: "conflict" };
    if (existing) {
      if (existing.result.kind !== "pairing") throw new Error("idempotency fixture kind mismatch");
      return { outcome: "replayed", pairing: copy(existing.result.pairing) };
    }
    if (this.pairings.has(input.pairing.id)) throw new Error("duplicate pairing fixture ID");
    this.pairings.set(input.pairing.id, copy(input.pairing));
    this.commitIdempotency(input.idempotency, {
      kind: "pairing",
      pairing: {
        id: input.pairing.id,
        state: input.pairing.state,
        expiresAt: input.pairing.expiresAt,
      },
    });
    return { outcome: "created", pairing: copy(input.pairing) };
  }

  async getPairing(id: string): Promise<PairingSessionRecord | null> {
    const record = this.pairings.get(id);
    return record ? copy(record) : null;
  }

  async recordPairingFailure(input: {
    pairingSessionId: string;
    at: string;
    maximumFailures: number;
    idempotency: AuthIdempotencyClaim;
  }): Promise<PairingFailureResult> {
    const existing = this.existing(input.idempotency);
    if (existing === "conflict") return { outcome: "conflict" };
    if (existing) {
      if (existing.result.kind !== "pairing_failure") throw new Error("idempotency fixture kind mismatch");
      return copy(existing.result.result);
    }
    const record = this.pairings.get(input.pairingSessionId);
    if (!record) return { outcome: "not_found" };
    if (record.state !== "pending") return { outcome: "terminal", state: record.state };
    if (record.expiresAt <= input.at) {
      record.state = "expired";
      const result = { outcome: "expired" } as const;
      this.commitIdempotency(input.idempotency, { kind: "pairing_failure", result });
      return result;
    }
    record.failedAttempts += 1;
    if (record.failedAttempts >= input.maximumFailures) {
      record.state = "locked";
      const result = { outcome: "locked" } as const;
      this.commitIdempotency(input.idempotency, { kind: "pairing_failure", result });
      return result;
    }
    const result = { outcome: "pending", failedAttempts: record.failedAttempts } as const;
    this.commitIdempotency(input.idempotency, { kind: "pairing_failure", result });
    return result;
  }

  async redeemPairing(
    input: PairingRedemptionCommit,
  ): Promise<PairingRedemptionResult> {
    const existing = this.existing(input.idempotency);
    if (existing === "conflict") return { outcome: "conflict" };
    if (existing) {
      if (existing.result.kind === "pairing_failure") {
        const result = existing.result.result;
        if (result.outcome === "expired") return { outcome: "expired" };
        throw new Error("idempotency fixture pairing failure is not a redemption result");
      }
      if (existing.result.kind !== "redemption") throw new Error("idempotency fixture kind mismatch");
      return {
        outcome: "replayed",
        pairing: copy(existing.result.pairing),
        device: copy(existing.result.device),
        session: copy(existing.result.session),
      };
    }
    const pairing = this.pairings.get(input.pairingSessionId);
    if (!pairing) return { outcome: "not_found" };
    if (pairing.state !== "pending") {
      return { outcome: "terminal", state: pairing.state };
    }
    if (pairing.expiresAt <= input.redeemedAt) {
      pairing.state = "expired";
      const result = { outcome: "expired" } as const;
      this.commitIdempotency(input.idempotency, { kind: "pairing_failure", result });
      return result;
    }
    pairing.state = "redeemed";
    pairing.redeemedAt = input.redeemedAt;
    const redeemedPairing = {
      id: pairing.id,
      state: "redeemed",
      expiresAt: pairing.expiresAt,
      redeemedAt: input.redeemedAt,
    } as const;
    this.devices.set(input.device.id, copy(input.device));
    this.sessions.set(input.session.id, copy(input.session));
    this.refreshTokens.set(input.refreshToken.id, copy(input.refreshToken));
    this.commitIdempotency(input.idempotency, {
      kind: "redemption",
      pairing: copy(redeemedPairing),
      device: copy(input.device),
      session: copy(input.session),
    });
    return {
      outcome: "redeemed",
      pairing: copy(redeemedPairing),
      device: copy(input.device),
      session: copy(input.session),
    };
  }

  async rotateRefresh(input: RefreshRotationCommit): Promise<RefreshRotationResult> {
    const existing = this.existing(input.idempotency);
    if (existing === "conflict") return { outcome: "conflict" };
    if (existing) {
      if (existing.result.kind === "refresh_failure") return copy(existing.result.result);
      if (existing.result.kind !== "refresh") throw new Error("idempotency fixture kind mismatch");
      return {
        outcome: "replayed",
        session: copy(existing.result.session),
        device: copy(existing.result.device),
      };
    }
    const current = this.refreshTokens.get(input.currentTokenId);
    if (!current || !equalDigest(input.presentedTokenDigest, current.tokenDigest)) {
      return { outcome: "invalid" };
    }
    if (current.state === "rotated") {
      this.revokeFamily(current.familyId, input.rotatedAt, "refresh_replay");
      const result = { outcome: "replay", familyId: current.familyId } as const;
      this.commitIdempotency(input.idempotency, { kind: "refresh_failure", result });
      return result;
    }
    if (current.state === "revoked") return { outcome: "revoked" };
    if (current.state === "expired" || current.expiresAt <= input.rotatedAt) {
      current.state = "expired";
      const result = { outcome: "expired" } as const;
      this.commitIdempotency(input.idempotency, { kind: "refresh_failure", result });
      return result;
    }
    const currentSession = this.sessions.get(current.sessionId);
    const device = currentSession ? this.devices.get(currentSession.deviceId) : undefined;
    if (!currentSession || currentSession.state !== "active") {
      return { outcome: "session_inactive" };
    }
    if (!device || device.status !== "active") return { outcome: "device_inactive" };

    current.state = "rotated";
    current.rotatedAt = input.rotatedAt;
    current.rotatedToTokenId = input.successorToken.id;
    currentSession.state = "rotated";
    currentSession.rotatedAt = input.rotatedAt;
    currentSession.rotatedToSessionId = input.successorSession.id;
    this.sessions.set(input.successorSession.id, copy(input.successorSession));
    this.refreshTokens.set(input.successorToken.id, copy(input.successorToken));
    this.commitIdempotency(input.idempotency, {
      kind: "refresh",
      device: copy(device),
      session: copy(input.successorSession),
    });
    return {
      outcome: "rotated",
      session: copy(input.successorSession),
      device: copy(device),
    };
  }

  async getRefreshContext(tokenId: string): Promise<RefreshContext | null> {
    const token = this.refreshTokens.get(tokenId);
    if (!token) return null;
    const session = this.sessions.get(token.sessionId);
    const device = session ? this.devices.get(session.deviceId) : undefined;
    if (!session || !device) return null;
    return { token: copy(token), session: copy(session), device: copy(device) };
  }

  async getAuthorizationState(sessionId: string): Promise<AuthorizationState | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const device = this.devices.get(session.deviceId);
    if (!device) return null;
    const familyRevoked = [...this.refreshTokens.values()].some(
      (token) => token.familyId === session.familyId && token.state === "revoked",
    );
    return { session: copy(session), device: copy(device), familyRevoked };
  }

  async revokeSession(input: {
    sessionId: string;
    revokedAt: string;
    reason: "session_revoke";
    idempotency: AuthIdempotencyClaim;
  }): Promise<RevokeResult> {
    const existing = this.existing(input.idempotency);
    if (existing === "conflict") return { outcome: "conflict" };
    if (existing) {
      if (existing.result.kind !== "revoke") throw new Error("idempotency fixture kind mismatch");
      return { outcome: "replayed" };
    }
    const session = this.sessions.get(input.sessionId);
    if (!session) return { outcome: "not_found" };
    if (session.state !== "active") return { outcome: "already_inactive" };
    this.revokeFamily(session.familyId, input.revokedAt, input.reason);
    this.commitIdempotency(input.idempotency, { kind: "revoke", result: { outcome: "revoked" } });
    return { outcome: "revoked" };
  }

  async revokeDevice(input: {
    deviceId: string;
    revokedAt: string;
    reason: "device_revoke";
    idempotency: AuthIdempotencyClaim;
  }): Promise<RevokeResult> {
    const existing = this.existing(input.idempotency);
    if (existing === "conflict") return { outcome: "conflict" };
    if (existing) {
      if (existing.result.kind !== "revoke") throw new Error("idempotency fixture kind mismatch");
      return { outcome: "replayed" };
    }
    const device = this.devices.get(input.deviceId);
    if (!device) return { outcome: "not_found" };
    if (device.status !== "active") return { outcome: "already_inactive" };
    device.status = "revoked";
    device.revokedAt = input.revokedAt;
    for (const session of this.sessions.values()) {
      if (session.deviceId === device.id) {
        this.revokeFamily(session.familyId, input.revokedAt, input.reason);
      }
    }
    this.commitIdempotency(input.idempotency, { kind: "revoke", result: { outcome: "revoked" } });
    return { outcome: "revoked" };
  }

  private revokeFamily(
    familyId: string,
    revokedAt: string,
    reason: "refresh_replay" | "session_revoke" | "device_revoke",
  ): void {
    for (const token of this.refreshTokens.values()) {
      if (token.familyId !== familyId) continue;
      token.state = "revoked";
      token.revokedAt = revokedAt;
      token.revokeReason = reason;
    }
    for (const session of this.sessions.values()) {
      if (session.familyId !== familyId || session.state !== "active") continue;
      session.state = "revoked";
      session.revokedAt = revokedAt;
      session.revokeReason = reason;
    }
  }
}
