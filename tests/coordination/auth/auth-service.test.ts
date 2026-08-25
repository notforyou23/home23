import assert from "node:assert/strict";
import test from "node:test";

import { type AuthAuditRecord } from "../../../src/coordination/auth/index.js";

import { TestAuthRepository } from "./test-repository.js";
import { createTestAuthService as createAuthService, mutation } from "./test-context.js";

test("a local operator issues one pairing code and a VPN client redeems it", async () => {
  const repository = new TestAuthRepository();
  const audit: AuthAuditRecord[] = [];
  const now = new Date("2026-08-25T12:00:00.000Z");
  const service = createAuthService({
    repository,
    keyMaterial: Buffer.alloc(32, 0x41),
    now: () => now,
    audit: { record: (entry) => audit.push(entry) },
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

  assert.equal(issued.pairingSession.state, "pending");
  assert.equal(issued.pairingSession.expiresAt, "2026-08-25T12:10:00.000Z");
  assert.equal(paired.pairingSession.state, "redeemed");
  assert.equal(paired.device.principalId, "user_owner");
  assert.equal(paired.clientSession.state, "active");
  assert.deepEqual(paired.clientSession.scopes, [
    "product:read",
    "message:send",
    "attachment:write",
  ]);
  assert.equal(paired.accessExpiresAt, "2026-08-25T12:15:00.000Z");
  assert.equal(paired.refreshExpiresAt, "2026-09-24T12:00:00.000Z");
  assert.match(paired.accessToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.match(paired.refreshToken, /^h23r1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(paired.tokenDelivery, "returned_once_and_never_logged");
  assert.deepEqual(audit.map((entry) => entry.reason), [
    "pairing_issued",
    "pairing_redeemed",
  ]);
  assert.equal(audit.every((entry) => /^req_/.test(entry.requestId ?? "")), true);
  assert.equal(audit.every((entry) => /^cor_/.test(entry.correlationId ?? "")), true);
});

test("a redeemed pairing code is refused on its second use", async () => {
  const repository = new TestAuthRepository();
  const audit: AuthAuditRecord[] = [];
  const service = createAuthService({
    repository,
    keyMaterial: Buffer.alloc(32, 0x42),
    now: () => new Date("2026-08-25T13:00:00.000Z"),
    audit: { record: (entry) => audit.push(entry) },
  });
  const issued = await service.issuePairing({
    deviceName: "Owner iPhone",
    operator: { authenticated: true, network: "loopback" },
    mutation: mutation("issue"),
  });
  const redemption = {
    pairingSessionId: issued.pairingSession.id,
    pairingCode: issued.pairingCode,
    network: "vpn" as const,
    device: { platform: "ios" as const, name: "Owner iPhone", appBuild: "1.0.0" },
    mutation: mutation("redeem-first"),
  };
  await service.redeemPairing(redemption);

  await assert.rejects(service.redeemPairing({
    ...redemption,
    mutation: mutation("redeem-second"),
  }), {
    name: "AuthError",
    reasonCode: "pairing_already_redeemed",
    httpStatus: 409,
    message: "pairing_already_redeemed",
  });
  assert.deepEqual(audit.map((entry) => entry.reason), [
    "pairing_issued",
    "pairing_redeemed",
    "pairing_already_redeemed",
  ]);
});

test("refresh rotates the token and session once without extending the family lifetime", async () => {
  const repository = new TestAuthRepository();
  const audit: AuthAuditRecord[] = [];
  let now = new Date("2026-08-25T14:00:00.000Z");
  const service = createAuthService({
    repository,
    keyMaterial: Buffer.alloc(32, 0x43),
    now: () => now,
    audit: { record: (entry) => audit.push(entry) },
  });
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
  now = new Date("2026-08-25T14:05:00.000Z");

  const rotated = await service.refreshSession({
    refreshToken: paired.refreshToken,
    network: "vpn",
    mutation: mutation("refresh"),
  });

  assert.notEqual(rotated.clientSession.id, paired.clientSession.id);
  assert.equal(rotated.clientSession.deviceId, paired.device.id);
  assert.equal(rotated.clientSession.familyId, paired.clientSession.familyId);
  assert.equal(rotated.clientSession.state, "active");
  assert.equal(repository.sessions.get(paired.clientSession.id)?.state, "rotated");
  assert.equal(rotated.accessExpiresAt, "2026-08-25T14:20:00.000Z");
  assert.equal(rotated.refreshExpiresAt, paired.refreshExpiresAt);
  assert.notEqual(rotated.refreshToken, paired.refreshToken);
  assert.equal(rotated.tokenDelivery, "returned_once_and_never_logged");
  assert.equal(audit.at(-1)?.reason, "refresh_rotated");
});

test("replay of an old refresh token revokes its family and rejects the successor access token", async () => {
  const repository = new TestAuthRepository();
  const audit: AuthAuditRecord[] = [];
  let now = new Date("2026-08-25T15:00:00.000Z");
  const service = createAuthService({
    repository,
    keyMaterial: Buffer.alloc(32, 0x44),
    now: () => now,
    audit: { record: (entry) => audit.push(entry) },
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
  now = new Date("2026-08-25T15:01:00.000Z");
  const successor = await service.refreshSession({
    refreshToken: paired.refreshToken,
    network: "vpn",
    mutation: mutation("refresh-first"),
  });
  const replayMutation = mutation("refresh-replay");

  await assert.rejects(
    service.refreshSession({
      refreshToken: paired.refreshToken,
      network: "vpn",
      mutation: replayMutation,
    }),
    {
      name: "AuthError",
      reasonCode: "refresh_replay_family_revoked",
      httpStatus: 409,
    },
  );
  await assert.rejects(
    service.refreshSession({
      refreshToken: paired.refreshToken,
      network: "vpn",
      mutation: replayMutation,
    }),
    {
      name: "AuthError",
      reasonCode: "refresh_replay_family_revoked",
      httpStatus: 409,
    },
  );
  await assert.rejects(
    service.validateAccessToken({
      accessToken: successor.accessToken,
      network: "vpn",
      requiredScopes: ["product:read"],
    }),
    { name: "AuthError", reasonCode: "session_revoked", httpStatus: 401 },
  );
  assert.equal(
    repository.sessions.get(successor.clientSession.id)?.revokeReason,
    "refresh_replay",
  );
  assert.deepEqual(audit.slice(-2).map((entry) => entry.reason), [
    "refresh_replay_family_revoked",
    "session_revoked",
  ]);
});

test("revoking the current session refuses its access token on the protected auth fixture", async () => {
  const repository = new TestAuthRepository();
  const audit: AuthAuditRecord[] = [];
  const service = createAuthService({
    repository,
    keyMaterial: Buffer.alloc(32, 0x45),
    now: () => new Date("2026-08-25T16:00:00.000Z"),
    audit: { record: (entry) => audit.push(entry) },
  });
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

  const revoked = await service.revokeCurrentSession({
    accessToken: paired.accessToken,
    network: "loopback",
    mutation: mutation("session-revoke"),
  });

  assert.deepEqual(revoked, { sessionId: paired.clientSession.id, state: "revoked" });
  await assert.rejects(
    service.validateAccessToken({
      accessToken: paired.accessToken,
      network: "loopback",
      requiredScopes: ["product:read"],
    }),
    { name: "AuthError", reasonCode: "session_revoked", httpStatus: 401 },
  );
  assert.deepEqual(audit.slice(-2).map((entry) => entry.reason), [
    "session_revoked",
    "session_revoked",
  ]);
});

test("revoking a device refuses its access token on the protected auth fixture", async () => {
  const repository = new TestAuthRepository();
  const audit: AuthAuditRecord[] = [];
  const service = createAuthService({
    repository,
    keyMaterial: Buffer.alloc(32, 0x46),
    now: () => new Date("2026-08-25T17:00:00.000Z"),
    audit: { record: (entry) => audit.push(entry) },
  });
  const issued = await service.issuePairing({
    deviceName: "Owner iPhone",
    operator: { authenticated: true, network: "loopback" },
    mutation: mutation("issue"),
  });
  const paired = await service.redeemPairing({
    pairingSessionId: issued.pairingSession.id,
    pairingCode: issued.pairingCode,
    network: "vpn",
    device: { platform: "ios", name: "Owner iPhone", appBuild: "1.0.0" },
    mutation: mutation("redeem"),
  });

  const revoked = await service.revokeDevice({
    deviceId: paired.device.id,
    operator: { authenticated: true, network: "loopback" },
    mutation: mutation("device-revoke"),
  });

  assert.deepEqual(revoked, { deviceId: paired.device.id, status: "revoked" });
  await assert.rejects(
    service.validateAccessToken({
      accessToken: paired.accessToken,
      network: "vpn",
      requiredScopes: ["product:read"],
    }),
    { name: "AuthError", reasonCode: "device_revoked", httpStatus: 401 },
  );
  assert.deepEqual(audit.slice(-2).map((entry) => entry.reason), [
    "device_revoked",
    "device_revoked",
  ]);
});

test("five wrong pairing codes lock the pairing with only stable audit reasons", async () => {
  const repository = new TestAuthRepository();
  const audit: AuthAuditRecord[] = [];
  const service = createAuthService({
    repository,
    keyMaterial: Buffer.alloc(32, 0x48),
    now: () => new Date("2026-08-25T19:00:00.000Z"),
    audit: { record: (entry) => audit.push(entry) },
  });
  const issued = await service.issuePairing({
    deviceName: "Owner Mac",
    operator: { authenticated: true, network: "loopback" },
    mutation: mutation("issue"),
  });
  const attempt = () => service.redeemPairing({
    pairingSessionId: issued.pairingSession.id,
    pairingCode: "AAAAA-AAAAA",
    network: "vpn",
    device: { platform: "macos" as const, name: "Owner Mac", appBuild: "1.0.0" },
    mutation: mutation("wrong-code"),
  });
  for (let count = 0; count < 4; count += 1) {
    await assert.rejects(attempt(), {
      name: "AuthError",
      reasonCode: "pairing_code_invalid",
      httpStatus: 401,
    });
  }
  await assert.rejects(attempt(), {
    name: "AuthError",
    reasonCode: "pairing_locked",
    httpStatus: 409,
  });
  assert.equal(repository.pairings.get(issued.pairingSession.id)?.state, "locked");
  assert.deepEqual(audit.map((entry) => entry.reason), [
    "pairing_issued",
    "pairing_code_invalid",
    "pairing_code_invalid",
    "pairing_code_invalid",
    "pairing_code_invalid",
    "pairing_locked",
  ]);
});

test("a public-network redemption is denied before pairing code use", async () => {
  const repository = new TestAuthRepository();
  const audit: AuthAuditRecord[] = [];
  const service = createAuthService({
    repository,
    keyMaterial: Buffer.alloc(32, 0x49),
    now: () => new Date("2026-08-25T20:00:00.000Z"),
    audit: { record: (entry) => audit.push(entry) },
  });
  const issued = await service.issuePairing({
    deviceName: "Owner Mac",
    operator: { authenticated: true, network: "loopback" },
    mutation: mutation("issue"),
  });

  await assert.rejects(
    service.redeemPairing({
      pairingSessionId: issued.pairingSession.id,
      pairingCode: issued.pairingCode,
      network: "public" as "vpn",
      device: { platform: "macos", name: "Owner Mac", appBuild: "1.0.0" },
      mutation: mutation("public-redeem"),
    }),
    { name: "AuthError", reasonCode: "network_not_allowed", httpStatus: 403 },
  );
  assert.equal(repository.pairings.get(issued.pairingSession.id)?.state, "pending");
  assert.equal(audit.at(-1)?.reason, "network_not_allowed");
});

test("a diagnostic audit sink failure cannot strand a committed pairing credential", async () => {
  const repository = new TestAuthRepository();
  let auditFailures = 0;
  const service = createAuthService({
    repository,
    keyMaterial: Buffer.alloc(32, 0x52),
    now: () => new Date("2026-08-25T23:00:00.000Z"),
    audit: { record: () => { throw new Error("diagnostic sink unavailable"); } },
    onAuditFailure: () => { auditFailures += 1; },
  });

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

  assert.equal(paired.clientSession.state, "active");
  assert.equal(repository.sessions.has(paired.clientSession.id), true);
  assert.equal(auditFailures, 2);
});

test("same-digest mutation retries return the exact original one-use auth response", async () => {
  const repository = new TestAuthRepository();
  let now = new Date("2026-08-26T00:00:00.000Z");
  const service = createAuthService({
    repository,
    keyMaterial: Buffer.alloc(32, 0x53),
    now: () => now,
  });
  const issueInput = {
    deviceName: "Owner Mac",
    operator: { authenticated: true, network: "loopback" },
    mutation: {
      idempotencyKey: "m06-pairing-issue-0001",
      requestId: "req_0198d95f-6c00-7000-8000-0000000000b1",
      correlationId: "cor_0198d95f-6c00-7000-8000-0000000000b2",
    },
  } as const;
  const issued = await service.issuePairing(issueInput);
  assert.deepEqual(await service.issuePairing(issueInput), issued);

  const redeemInput = {
    pairingSessionId: issued.pairingSession.id,
    pairingCode: issued.pairingCode,
    network: "loopback",
    device: { platform: "macos", name: "Owner Mac", appBuild: "1.0.0" },
    mutation: {
      idempotencyKey: "m06-pairing-redeem-001",
      requestId: "req_0198d95f-6c00-7000-8000-0000000000b3",
      correlationId: "cor_0198d95f-6c00-7000-8000-0000000000b4",
    },
  } as const;
  const paired = await service.redeemPairing(redeemInput);
  assert.deepEqual(await service.redeemPairing(redeemInput), paired);
  assert.deepEqual(await service.issuePairing(issueInput), issued);

  now = new Date("2026-08-26T00:01:00.000Z");
  const refreshInput = {
    refreshToken: paired.refreshToken,
    network: "vpn",
    mutation: {
      idempotencyKey: "m06-session-refresh-001",
      requestId: "req_0198d95f-6c00-7000-8000-0000000000b5",
      correlationId: "cor_0198d95f-6c00-7000-8000-0000000000b6",
    },
  } as const;
  const refreshed = await service.refreshSession(refreshInput);
  assert.deepEqual(await service.refreshSession(refreshInput), refreshed);
  const tamperedRefresh = `${paired.refreshToken.slice(0, -1)}${
    paired.refreshToken.endsWith("A") ? "B" : "A"
  }`;
  await assert.rejects(
    service.refreshSession({ ...refreshInput, refreshToken: tamperedRefresh }),
    { name: "AuthError", reasonCode: "idempotency_conflict", httpStatus: 409 },
  );
  assert.deepEqual(await service.redeemPairing(redeemInput), paired);
  assert.deepEqual(
    await service.validateAccessToken({
      accessToken: refreshed.accessToken,
      network: "vpn",
      requiredScopes: ["product:read"],
    }),
    {
      principalId: "user_owner",
      deviceId: refreshed.device.id,
      sessionId: refreshed.clientSession.id,
      scopes: ["product:read", "message:send", "attachment:write"],
    },
  );
});

test("concurrent same-key issuance commits once and a different digest conflicts", async () => {
  const repository = new TestAuthRepository();
  const service = createAuthService({
    repository,
    keyMaterial: Buffer.alloc(32, 0x54),
    now: () => new Date("2026-08-26T01:00:00.000Z"),
  });
  const mutationContext = mutation("concurrent-issue");
  const input = {
    deviceName: "Owner Mac",
    operator: { authenticated: true, network: "loopback" },
    mutation: mutationContext,
  } as const;

  const [first, second] = await Promise.all([
    service.issuePairing(input),
    service.issuePairing(input),
  ]);

  assert.deepEqual(second, first);
  assert.equal(repository.pairings.size, 1);
  await assert.rejects(
    service.issuePairing({ ...input, deviceName: "Different request" }),
    { name: "AuthError", reasonCode: "idempotency_conflict", httpStatus: 409 },
  );
});

test("expired pairing redemption persists the pending-to-expired transition", async () => {
  const repository = new TestAuthRepository();
  let now = new Date("2026-08-26T02:00:00.000Z");
  const service = createAuthService({
    repository,
    keyMaterial: Buffer.alloc(32, 0x55),
    now: () => now,
  });
  const issued = await service.issuePairing({
    deviceName: "Owner Mac",
    operator: { authenticated: true, network: "loopback" },
    mutation: mutation("expiry-issue"),
  });
  now = new Date(issued.pairingSession.expiresAt);
  const expiryMutation = mutation("expiry-redeem");
  const expiredInput = {
    pairingSessionId: issued.pairingSession.id,
    pairingCode: issued.pairingCode,
    network: "loopback",
    device: { platform: "macos", name: "Owner Mac", appBuild: "1.0.0" },
    mutation: expiryMutation,
  } as const;

  await assert.rejects(
    service.redeemPairing(expiredInput),
    { name: "AuthError", reasonCode: "pairing_expired", httpStatus: 410 },
  );
  assert.equal(repository.pairings.get(issued.pairingSession.id)?.state, "expired");
  await assert.rejects(
    service.redeemPairing(expiredInput),
    { name: "AuthError", reasonCode: "pairing_expired", httpStatus: 410 },
  );
  await assert.rejects(
    service.redeemPairing({
      ...expiredInput,
      device: { ...expiredInput.device, name: "Changed request" },
    }),
    { name: "AuthError", reasonCode: "idempotency_conflict", httpStatus: 409 },
  );
});
