import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";

import {
  HOME23_AUTH_ISSUER,
  OWNER_PRINCIPAL_ID,
  deriveAuthKey,
} from "../../../src/coordination/auth/index.js";

import { TestAuthRepository } from "./test-repository.js";
import { createTestAuthService as createAuthService, mutation } from "./test-context.js";

test("protected auth accepts an active house-audience HS256 token and rejects tamper and expiry", async () => {
  const repository = new TestAuthRepository();
  let now = new Date("2026-08-25T21:00:00.000Z");
  const service = createAuthService({
    repository,
    keyMaterial: Buffer.alloc(32, 0x50),
    now: () => now,
  });
  const issued = await service.issuePairing({
    deviceName: "Owner Mac",
    operator: { authenticated: true, network: "loopback" },
    mutation: mutation("issue"),
  });
  const paired = await service.redeemPairing({
    pairingSessionId: issued.pairingSession.id,
    pairingCode: issued.pairingCode,
    network: "vpn",
    device: { platform: "macos", name: "Owner Mac", appBuild: "1.0.0" },
    mutation: mutation("redeem"),
  });

  const decoded = jwt.decode(paired.accessToken, { complete: true });
  assert.equal(decoded?.header.alg, "HS256");
  const principal = await service.validateAccessToken({
    accessToken: paired.accessToken,
    network: "vpn",
    requiredScopes: ["product:read", "message:send"],
  });
  assert.deepEqual(principal, {
    principalId: "user_owner",
    deviceId: paired.device.id,
    sessionId: paired.clientSession.id,
    scopes: ["product:read", "message:send", "attachment:write"],
  });
  assert.equal(principal.scopes.some((scope) => scope.includes("resident")), false);

  await assert.rejects(
    service.validateAccessToken({
      accessToken: `${paired.accessToken.slice(0, -1)}x`,
      network: "vpn",
    }),
    { name: "AuthError", reasonCode: "access_invalid", httpStatus: 401 },
  );
  now = new Date("2026-08-25T21:15:00.000Z");
  await assert.rejects(
    service.validateAccessToken({ accessToken: paired.accessToken, network: "vpn" }),
    { name: "AuthError", reasonCode: "access_expired", httpStatus: 401 },
  );
});

test("a correctly signed token for any audience other than the house API is rejected", async () => {
  const repository = new TestAuthRepository();
  const keyMaterial = Buffer.alloc(32, 0x51);
  const now = new Date("2026-08-25T22:00:00.000Z");
  const service = createAuthService({ repository, keyMaterial, now: () => now });
  const issued = await service.issuePairing({
    deviceName: "Owner Mac",
    operator: { authenticated: true, network: "loopback" },
    mutation: mutation("issue"),
  });
  const paired = await service.redeemPairing({
    pairingSessionId: issued.pairingSession.id,
    pairingCode: issued.pairingCode,
    network: "loopback",
    device: { platform: "macos", name: "Owner Mac", appBuild: "1.0.0" },
    mutation: mutation("redeem"),
  });
  const issuedAt = Math.floor(now.getTime() / 1000);
  const wrongAudienceToken = jwt.sign(
    {
      contractVersion: 1,
      tokenType: "access",
      sessionId: paired.clientSession.id,
      deviceId: paired.device.id,
      scopes: paired.clientSession.scopes,
      iat: issuedAt,
    },
    deriveAuthKey(keyMaterial, "access-signing"),
    {
      algorithm: "HS256",
      audience: "resident-private-api",
      issuer: HOME23_AUTH_ISSUER,
      subject: OWNER_PRINCIPAL_ID,
      jwtid: "a".repeat(22),
      expiresIn: 15 * 60,
    },
  );

  await assert.rejects(
    service.validateAccessToken({ accessToken: wrongAudienceToken, network: "loopback" }),
    { name: "AuthError", reasonCode: "access_audience_invalid", httpStatus: 401 },
  );
});
