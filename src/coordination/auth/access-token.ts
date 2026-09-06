import jwt from "jsonwebtoken";

import {
  AUTH_TOKEN_LIFETIMES,
  HOUSE_AUTH_SCOPES,
  HOME23_API_AUDIENCE,
  HOME23_AUTH_ISSUER,
  OWNER_PRINCIPAL_ID,
  type ClientSessionRecord,
  type DeviceRecord,
  type HouseAuthScope,
} from "./types.js";
import { assertCoordinationId } from "../ids/index.js";

export interface IssueAccessTokenInput {
  session: ClientSessionRecord;
  device: DeviceRecord;
  issuedAt: Date;
  tokenId: string;
}

export function issueAccessToken(
  signingKey: Uint8Array,
  input: IssueAccessTokenInput,
): string {
  const issuedAt = Math.floor(input.issuedAt.getTime() / 1000);
  const key = Buffer.from(signingKey);
  try {
    return jwt.sign(
      {
        contractVersion: 1,
        tokenType: "access",
        sessionId: input.session.id,
        deviceId: input.device.id,
        scopes: input.session.scopes,
        iat: issuedAt,
      },
      key,
      {
        algorithm: "HS256",
        audience: HOME23_API_AUDIENCE,
        issuer: HOME23_AUTH_ISSUER,
        subject: OWNER_PRINCIPAL_ID,
        jwtid: input.tokenId,
        expiresIn: Math.floor(AUTH_TOKEN_LIFETIMES.accessMs / 1000),
      },
    );
  } finally {
    key.fill(0);
  }
}

export interface AccessTokenClaims {
  contractVersion: 1;
  tokenType: "access";
  sessionId: string;
  deviceId: string;
  scopes: HouseAuthScope[];
  principalId: typeof OWNER_PRINCIPAL_ID;
}

export class AccessTokenVerificationError extends Error {
  constructor(readonly kind: "invalid" | "expired" | "audience") {
    super(`access_token_${kind}`);
  }
}

export function verifyAccessToken(
  signingKey: Uint8Array,
  token: string,
  now: Date,
): AccessTokenClaims {
  const key = Buffer.from(signingKey);
  try {
    if (
      typeof token !== "string" ||
      Buffer.byteLength(token, "utf8") > 4096 ||
      token.split(".").length !== 3
    ) {
      throw new AccessTokenVerificationError("invalid");
    }
    const decoded = jwt.verify(token, key, {
      algorithms: ["HS256"],
      issuer: HOME23_AUTH_ISSUER,
      subject: OWNER_PRINCIPAL_ID,
      clockTimestamp: Math.floor(now.getTime() / 1000),
      maxAge: Math.floor(AUTH_TOKEN_LIFETIMES.accessMs / 1000),
    });
    if (!decoded || typeof decoded === "string") {
      throw new AccessTokenVerificationError("invalid");
    }
    if (decoded.aud !== HOME23_API_AUDIENCE) {
      throw new AccessTokenVerificationError("audience");
    }
    if (
      decoded.contractVersion !== 1 ||
      decoded.tokenType !== "access" ||
      decoded.sub !== OWNER_PRINCIPAL_ID ||
      typeof decoded.sessionId !== "string" ||
      typeof decoded.deviceId !== "string" ||
      typeof decoded.jti !== "string" ||
      !/^[A-Za-z0-9_-]{22}$/.test(decoded.jti) ||
      !Number.isSafeInteger(decoded.iat) ||
      !Number.isSafeInteger(decoded.exp) ||
      (decoded.exp as number) - (decoded.iat as number) !==
        AUTH_TOKEN_LIFETIMES.accessMs / 1000 ||
      !Array.isArray(decoded.scopes) ||
      decoded.scopes.length !== new Set(decoded.scopes).size ||
      decoded.scopes.some((scope) =>
        typeof scope !== "string" ||
        !(HOUSE_AUTH_SCOPES as readonly string[]).includes(scope)
      )
    ) {
      throw new AccessTokenVerificationError("invalid");
    }
    try {
      assertCoordinationId("clientSession", decoded.sessionId);
      assertCoordinationId("device", decoded.deviceId);
    } catch {
      throw new AccessTokenVerificationError("invalid");
    }
    return Object.freeze({
      contractVersion: 1,
      tokenType: "access",
      sessionId: decoded.sessionId,
      deviceId: decoded.deviceId,
      scopes: [...decoded.scopes] as HouseAuthScope[],
      principalId: OWNER_PRINCIPAL_ID,
    });
  } catch (error) {
    if (error instanceof AccessTokenVerificationError) throw error;
    if (error instanceof jwt.TokenExpiredError) {
      throw new AccessTokenVerificationError("expired");
    }
    throw new AccessTokenVerificationError("invalid");
  } finally {
    key.fill(0);
  }
}
