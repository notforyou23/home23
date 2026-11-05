import assert from "node:assert/strict";
import test from "node:test";

import {
  JsonFrameDecoder,
  MAX_CAPABILITY_LIFETIME_MS,
  RESIDENT_PROTOCOL_VERSION,
  ResidentProtocolError,
  createResidentCredential,
  createSignedRequest,
  createSignedResponse,
  encodeJsonFrame,
  verifySignedRequest,
  verifySignedResponse,
} from "../../../src/coordination/resident-protocol/index.js";

const REQUEST_ID = "req_0198d95f-6c00-7000-8000-0000000000a1";
const CORRELATION_ID = "cor_0198d95f-6c00-7000-8000-0000000000a2";
const NOW_MS = Date.parse("2026-08-25T12:00:00.000Z");

function credential(instanceId = "resident-jerry-1") {
  return createResidentCredential({
    rootKey: Buffer.alloc(32, 0x23),
    residentSlug: "jerry",
    role: "resident",
    instanceId,
    keyVersion: 1,
  });
}

function signedRequest(overrides: {
  audience?: string;
  instanceId?: string;
  issuedAtMs?: number;
  expiresAtMs?: number;
  deadlineAtMs?: number;
  nonce?: string;
  fence?: string | null;
} = {}) {
  const selectedCredential = credential(overrides.instanceId);
  return {
    selectedCredential,
    frame: createSignedRequest({
      credential: selectedCredential,
      audience: overrides.audience ?? "coordination-kernel-1",
      method: "POST",
      path: "/internal/v1/attempts/att_1/heartbeat",
      payload: { leaseId: "lse_1", observedStatus: "running" },
      requestId: REQUEST_ID,
      correlationId: CORRELATION_ID,
      deadlineAtMs: overrides.deadlineAtMs ?? NOW_MS + 5_000,
      fence: overrides.fence === undefined ? "fence-7" : overrides.fence,
      nonce: overrides.nonce ?? "nonce-request-0001",
      issuedAtMs: overrides.issuedAtMs ?? NOW_MS,
      expiresAtMs: overrides.expiresAtMs ?? NOW_MS + 10_000,
    }),
  };
}

function expectProtocolCode(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ResidentProtocolError);
    assert.equal(error.code, code);
    return true;
  });
}

test("length-prefixed JSON framing survives fragmentation and coalescing", () => {
  const first = encodeJsonFrame({ kind: "one", value: "hello" }, 128);
  const second = encodeJsonFrame({ kind: "two", value: 23 }, 128);
  const decoder = new JsonFrameDecoder({ maxFrameBytes: 128 });

  assert.deepEqual(decoder.push(first.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(first.subarray(2, 7)), []);
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(7), second])), [
    { kind: "one", value: "hello" },
    { kind: "two", value: 23 },
  ]);
});

test("framing rejects an oversized length before buffering its body", () => {
  const decoder = new JsonFrameDecoder({ maxFrameBytes: 32 });
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(33);

  expectProtocolCode(() => decoder.push(prefix), "frame_too_large");
  assert.equal(decoder.bufferedBytes, 0);
});

test("an exact signed request verifies once for its bound audience and instance", () => {
  const { frame, selectedCredential } = signedRequest();
  const verified = verifySignedRequest(frame, {
    credential: selectedCredential,
    expectedAudience: "coordination-kernel-1",
    nowMs: NOW_MS + 1,
    consumeNonce: () => true,
    validateFence: (fence) => fence === "fence-7",
  });

  assert.equal(RESIDENT_PROTOCOL_VERSION, 1);
  assert.equal(verified.requestId, REQUEST_ID);
  assert.equal(verified.correlationId, CORRELATION_ID);
  assert.deepEqual(verified.payload, { leaseId: "lse_1", observedStatus: "running" });
});

test("credential derivation cryptographically separates resident instances", () => {
  assert.notDeepEqual(
    credential("resident-jerry-1").key,
    credential("resident-jerry-2").key,
  );
});

test("request construction rejects a weak or delimiter-bearing replay nonce", () => {
  assert.throws(
    () => signedRequest({ nonce: "short:nonce" }),
    /nonce is invalid/,
  );
});

test("request verification rejects payload tampering and the wrong audience or instance", () => {
  const { frame, selectedCredential } = signedRequest();
  const common = {
    credential: selectedCredential,
    expectedAudience: "coordination-kernel-1",
    nowMs: NOW_MS + 1,
    consumeNonce: () => true,
  };

  expectProtocolCode(
    () => verifySignedRequest({ ...frame, payload: { leaseId: "lse_other" } }, common),
    "payload_digest_mismatch",
  );
  expectProtocolCode(
    () => verifySignedRequest(frame, { ...common, expectedAudience: "coordination-kernel-2" }),
    "authentication_failed",
  );
  expectProtocolCode(
    () => verifySignedRequest(frame, { ...common, credential: credential("resident-jerry-2") }),
    "authentication_failed",
  );
});

test("request verification rejects replayed, stale, and overlong capabilities", () => {
  const { frame, selectedCredential } = signedRequest();
  const seen = new Set<string>();
  const verify = () =>
    verifySignedRequest(frame, {
      credential: selectedCredential,
      expectedAudience: "coordination-kernel-1",
      nowMs: NOW_MS + 1,
      consumeNonce: (scope, nonce) => {
        const key = `${scope}:${nonce}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
    });

  verify();
  expectProtocolCode(verify, "capability_replayed");

  const stale = signedRequest({
    issuedAtMs: NOW_MS - 10_000,
    expiresAtMs: NOW_MS - 1,
    deadlineAtMs: NOW_MS + 1_000,
    nonce: "nonce-stale-000001",
  });
  expectProtocolCode(
    () =>
      verifySignedRequest(stale.frame, {
        credential: stale.selectedCredential,
        expectedAudience: "coordination-kernel-1",
        nowMs: NOW_MS,
        consumeNonce: () => true,
      }),
    "capability_expired",
  );

  const overlong = signedRequest({
    expiresAtMs: NOW_MS + MAX_CAPABILITY_LIFETIME_MS + 1,
    deadlineAtMs: NOW_MS + 1_000,
    nonce: "nonce-overlong-0001",
  });
  expectProtocolCode(
    () =>
      verifySignedRequest(overlong.frame, {
        credential: overlong.selectedCredential,
        expectedAudience: "coordination-kernel-1",
        nowMs: NOW_MS,
        consumeNonce: () => true,
      }),
    "capability_lifetime_invalid",
  );
});

test("deadline and fence validation fail closed before dispatch", () => {
  const expiredDeadline = signedRequest({ deadlineAtMs: NOW_MS - 1 });
  expectProtocolCode(
    () =>
      verifySignedRequest(expiredDeadline.frame, {
        credential: expiredDeadline.selectedCredential,
        expectedAudience: "coordination-kernel-1",
        nowMs: NOW_MS,
        consumeNonce: () => true,
      }),
    "deadline_exceeded",
  );

  const deadlineBeyondCapability = signedRequest({
    expiresAtMs: NOW_MS + 5_000,
    deadlineAtMs: NOW_MS + 5_001,
    nonce: "nonce-deadline-outside-capability",
  });
  expectProtocolCode(
    () =>
      verifySignedRequest(deadlineBeyondCapability.frame, {
        credential: deadlineBeyondCapability.selectedCredential,
        expectedAudience: "coordination-kernel-1",
        nowMs: NOW_MS,
        consumeNonce: () => true,
      }),
    "request_invalid",
  );

  const invalidFence = signedRequest();
  expectProtocolCode(
    () =>
      verifySignedRequest(invalidFence.frame, {
        credential: invalidFence.selectedCredential,
        expectedAudience: "coordination-kernel-1",
        nowMs: NOW_MS,
        consumeNonce: () => true,
        validateFence: () => false,
      }),
    "fence_invalid",
  );
});

test("the resident authenticates the response and retains request correlation", () => {
  const selectedCredential = credential();
  const response = createSignedResponse({
    credential: selectedCredential,
    audience: selectedCredential.instanceId,
    serverInstanceId: "coordination-kernel-1",
    requestId: REQUEST_ID,
    correlationId: CORRELATION_ID,
    payload: { accepted: true },
    issuedAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 5_000,
    nonce: "nonce-response-1",
  });

  const verified = verifySignedResponse(response, {
    credential: selectedCredential,
    expectedAudience: selectedCredential.instanceId,
    expectedServerInstanceId: "coordination-kernel-1",
    expectedRequestId: REQUEST_ID,
    expectedCorrelationId: CORRELATION_ID,
    nowMs: NOW_MS + 1,
    consumeNonce: () => true,
  });
  assert.deepEqual(verified.payload, { accepted: true });

  expectProtocolCode(
    () =>
      verifySignedResponse(response, {
        credential: selectedCredential,
        expectedAudience: selectedCredential.instanceId,
        expectedServerInstanceId: "coordination-kernel-restarted",
        expectedRequestId: REQUEST_ID,
        expectedCorrelationId: CORRELATION_ID,
        nowMs: NOW_MS + 1,
        consumeNonce: () => true,
      }),
    "authentication_failed",
  );
});
