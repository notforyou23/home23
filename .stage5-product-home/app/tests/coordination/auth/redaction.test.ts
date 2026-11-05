import assert from "node:assert/strict";
import test from "node:test";

import {
  createPairingCodeVerifier,
  redactAuthDiagnostic,
  verifyPairingCode,
  type AuthAuditRecord,
} from "../../../src/coordination/auth/index.js";

import { TestAuthRepository } from "./test-repository.js";
import { createTestAuthService as createAuthService, mutation } from "./test-context.js";

test("pairing verification and free-form redaction share the bounded accepted syntax", async () => {
  const verifier = await createPairingCodeVerifier("ABCDE-FG234");
  for (const accepted of ["ABCDE-FG234", "abcdefg234", "abcde fg234"]) {
    assert.equal(await verifyPairingCode(accepted, verifier), true);
    assert.equal(redactAuthDiagnostic(`failed ${accepted}`), "failed [REDACTED]");
  }
  for (const rejected of ["ABCDE--FG234", "ABCDE  FG234", " ABCDE-FG234 "]) {
    assert.equal(await verifyPairingCode(rejected, verifier), false);
  }
});

test("auth diagnostic redaction removes credentials while preserving receipt identifiers", () => {
  const pairingCode = "ABCDE-FG234";
  const refreshToken = `h23r1.${"a".repeat(22)}.${"b".repeat(43)}`;
  const accessToken = `${"c".repeat(24)}.${"d".repeat(24)}.${"e".repeat(43)}`;
  assert.deepEqual(
    redactAuthDiagnostic({
      reason: "refresh_invalid",
      pairingSessionId: "pair_receipt-id",
      pairingCode,
      nested: {
        refresh_token: refreshToken,
        authorization: `Bearer ${accessToken}`,
        cookie: `access=${accessToken}`,
      },
    }),
    {
      reason: "refresh_invalid",
      pairingSessionId: "pair_receipt-id",
      pairingCode: "[REDACTED]",
      nested: {
        refresh_token: "[REDACTED]",
        authorization: "[REDACTED]",
        cookie: "[REDACTED]",
      },
    },
  );
  assert.deepEqual(
    redactAuthDiagnostic({
      message: `redeem failed for ${pairingCode}`,
      error: new Error(`rejected ${pairingCode}`),
      acceptedVariants: ["abcdefg234", "abcde fg234"],
      bytes: Buffer.from(refreshToken),
      signing_key: "not-for-logs",
      accessSigningKey: "not-for-logs",
      credentialGenerationKey: "not-for-logs",
      idempotencyDigestKey: "not-for-logs",
    }),
    {
      message: "redeem failed for [REDACTED]",
      error: { name: "Error", message: "rejected [REDACTED]" },
      acceptedVariants: ["[REDACTED]", "[REDACTED]"],
      bytes: "[REDACTED:BINARY]",
      signing_key: "[REDACTED]",
      accessSigningKey: "[REDACTED]",
      credentialGenerationKey: "[REDACTED]",
      idempotencyDigestKey: "[REDACTED]",
    },
  );
});

test("actual pairing and rotation audit receipts and stored records contain no raw secret", async () => {
  const repository = new TestAuthRepository();
  const audit: AuthAuditRecord[] = [];
  let now = new Date("2026-08-25T18:00:00.000Z");
  const service = createAuthService({
    repository,
    keyMaterial: Buffer.alloc(32, 0x47),
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
  now = new Date("2026-08-25T18:01:00.000Z");
  const refreshMutation = mutation("refresh-secret-key");
  refreshMutation.idempotencyKey = paired.refreshToken;
  const rotated = await service.refreshSession({
    refreshToken: paired.refreshToken,
    network: "vpn",
    mutation: refreshMutation,
  });
  await assert.rejects(
    service.refreshSession({
      refreshToken: paired.refreshToken,
      network: "vpn",
      mutation: mutation("refresh-replay"),
    }),
  );

  const receiptBytes = JSON.stringify(audit);
  const storedBytes = JSON.stringify({
    pairings: [...repository.pairings.values()],
    devices: [...repository.devices.values()],
    sessions: [...repository.sessions.values()],
    refreshTokens: [...repository.refreshTokens.values()],
    idempotency: [...repository.idempotency.values()],
  });
  for (const secret of [
    issued.pairingCode,
    paired.accessToken,
    paired.refreshToken,
    rotated.accessToken,
    rotated.refreshToken,
  ]) {
    assert.equal(receiptBytes.includes(secret), false);
    assert.equal(storedBytes.includes(secret), false);
  }
  const rawCredentialField = /h23r1\.|Bearer |"pairingCode":|"accessToken":|"refreshToken":/;
  assert.doesNotMatch(receiptBytes, rawCredentialField);
  assert.doesNotMatch(storedBytes, rawCredentialField);
  assert.match([...repository.pairings.values()][0]?.codeVerifier ?? "", /^scrypt\$/);
  assert.match([...repository.refreshTokens.values()][0]?.tokenDigest ?? "", /^[0-9a-f]{64}$/);
});
