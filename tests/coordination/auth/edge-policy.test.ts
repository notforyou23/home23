import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTH_RATE_LIMIT_POLICIES,
  FixedWindowRateLimiter,
  createAuthService,
  createCorsPolicy,
} from "../../../src/coordination/auth/index.js";
import { createTestAuthService, mutation } from "./test-context.js";
import { TestAuthRepository } from "./test-repository.js";

test("CORS denies unlisted browser origins and allows explicit bearer-token origins", () => {
  assert.throws(
    () => createCorsPolicy({ allowedOrigins: ["http://public.example"] }),
    /cleartext origins are restricted to loopback/,
  );
  const policy = createCorsPolicy({
    allowedOrigins: [
      "http://127.0.0.1:5002",
      "https://home23.example.ts.net",
    ],
  });

  assert.deepEqual(
    policy.evaluate({ origin: null, method: "GET", requestHeaders: [] }),
    { allowed: true, responseHeaders: {} },
  );
  assert.deepEqual(
    policy.evaluate({
      origin: "https://attacker.example",
      method: "POST",
      requestHeaders: ["authorization", "content-type"],
    }),
    {
      allowed: false,
      reason: "cors_origin_denied",
      responseHeaders: { Vary: "Origin" },
    },
  );
  assert.deepEqual(
    policy.evaluate({
      origin: "https://home23.example.ts.net",
      method: "OPTIONS",
      requestedMethod: "POST",
      requestHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
    }),
    {
      allowed: true,
      responseHeaders: {
        "Access-Control-Allow-Origin": "https://home23.example.ts.net",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "authorization, content-type, idempotency-key, last-event-id",
        "Access-Control-Max-Age": "600",
        Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
      },
    },
  );
  assert.equal(
    Object.hasOwn(
      policy.evaluate({
        origin: "http://127.0.0.1:5002",
        method: "GET",
        requestHeaders: [],
      }).responseHeaders,
      "Access-Control-Allow-Credentials",
    ),
    false,
  );
});

test("fixed-window auth limits deny the first over-limit pairing attempt deterministically", () => {
  assert.deepEqual(AUTH_RATE_LIMIT_POLICIES.pairingRedeem, {
    limit: 10,
    windowMs: 15 * 60 * 1000,
  });
  const limiter = new FixedWindowRateLimiter();
  let result;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    result = limiter.consume({
      policy: "pairingRedeem",
      key: "vpn-peer-digest-1",
      nowMs: 1_000,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 10 - attempt);
  }
  result = limiter.consume({
    policy: "pairingRedeem",
    key: "vpn-peer-digest-1",
    nowMs: 1_000,
  });
  assert.deepEqual(result, {
    allowed: false,
    reason: "rate_limit_exceeded",
    limit: 10,
    remaining: 0,
    resetAtMs: 901_000,
    retryAfterMs: 900_000,
  });
  assert.equal(
    limiter.consume({
      policy: "pairingRedeem",
      key: "vpn-peer-digest-1",
      nowMs: 901_000,
    }).allowed,
    true,
  );
});

test("rate-limit windows are cardinality-bounded and stale entries are pruned", () => {
  const limiter = new FixedWindowRateLimiter(2);
  assert.equal(limiter.consume({ policy: "refresh", key: "peer-1", nowMs: 0 }).allowed, true);
  assert.equal(limiter.consume({ policy: "refresh", key: "peer-2", nowMs: 0 }).allowed, true);
  assert.deepEqual(
    limiter.consume({ policy: "refresh", key: "peer-3", nowMs: 0 }),
    {
      allowed: false,
      reason: "rate_limit_exceeded",
      limit: 30,
      remaining: 0,
      resetAtMs: 60_000,
      retryAfterMs: 60_000,
    },
  );
  assert.equal(limiter.activeWindowCount, 2);
  assert.equal(limiter.consume({ policy: "refresh", key: "peer-3", nowMs: 60_000 }).allowed, true);
  assert.equal(limiter.activeWindowCount, 1);
});

test("auth service admission enforces the pairing-issue policy before persistence", async () => {
  const repository = new TestAuthRepository();
  const service = createTestAuthService({
    repository,
    keyMaterial: Buffer.alloc(32, 0x56),
    now: () => new Date("2026-08-26T03:00:00.000Z"),
  });
  const firstMutation = mutation("limited-issue-first");
  const firstInput = {
    deviceName: "Device 0",
    operator: { authenticated: true, network: "loopback" },
    mutation: firstMutation,
  } as const;
  const first = await service.issuePairing(firstInput);
  for (let attempt = 1; attempt < 5; attempt += 1) {
    await service.issuePairing({
      deviceName: `Device ${attempt}`,
      operator: { authenticated: true, network: "loopback" },
      mutation: mutation(`limited-issue-${attempt}`),
    });
  }
  assert.deepEqual(await service.issuePairing(firstInput), first);
  await assert.rejects(
    service.issuePairing({
      deviceName: "Device over limit",
      operator: { authenticated: true, network: "loopback" },
      mutation: mutation("limited-issue-over"),
    }),
    { name: "AuthError", reasonCode: "rate_limit_exceeded", httpStatus: 429 },
  );
  assert.equal(repository.pairings.size, 5);
});

test("a malformed trusted-admission adapter fails closed on a public client network", async () => {
  const service = createAuthService({
    repository: new TestAuthRepository(),
    keyMaterial: Buffer.alloc(32, 0x57),
    admissionVerifier: {
      verifyLocalOperator: () => ({
        allowed: true,
        network: "loopback",
        rateLimitKey: "operator",
      }),
      verifyClient: () => ({
        allowed: true,
        network: "public",
        rateLimitKey: "malformed-adapter",
      } as never),
    },
  });

  await assert.rejects(
    service.validateAccessToken({ accessToken: "invalid", network: {} }),
    /auth admission verifier returned invalid trusted facts/,
  );
});
