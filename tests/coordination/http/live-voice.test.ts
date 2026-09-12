import assert from "node:assert/strict";
import test from "node:test";
import { createCoordinationApplication, createCoordinationLifecycle, disabledCoordinationFeatureFlags } from "../../../src/coordination/app/index.js";
import { createCoordinationHttpServer } from "../../../src/coordination/http/index.js";
import { AuthError } from "../../../src/coordination/auth/index.js";
import { LiveVoiceError, type LiveVoiceService } from "../../../src/coordination/app/live-voice.js";

test("canonical voice routes authenticate, validate bodies and preserve exact opaque handles", async t => {
  const calls: { method: string; input: any }[] = [];
  let enabled = true;
  let failure = false;
  const liveVoice = {
    capability: async (input: any) => { calls.push({ method: "capability", input }); return { available: true, model: "gpt-live-1" }; },
    start: async (input: any) => { calls.push({ method: "start", input }); if (failure) throw new LiveVoiceError("voice_start_expired");
      return { sessionId: "opaque/session", sdp: "answer", model: "gpt-live-1" }; },
    heartbeat: async (input: any) => { calls.push({ method: "heartbeat", input }); return { sessionId: input.sessionId, active: true }; },
    close: async (input: any) => { calls.push({ method: "close", input }); return { sessionId: input.sessionId, finalized: true, reason: "close_requested", usageSeconds: 10 }; },
    drain: async () => undefined,
  } satisfies LiveVoiceService;
  const application = createCoordinationApplication({ flags: { ...disabledCoordinationFeatureFlags(),
    "coordination.process.enabled": true, "coordination.public_api.enabled": true }, services: {
    auth: { validateAccessToken: async ({ accessToken, requiredScopes }) => {
      if (accessToken !== "test-token") throw new AuthError("access_invalid");
      assert.deepEqual(requiredScopes, ["product:read", "message:send"]);
      return { principalId: "user_owner", deviceId: "device", sessionId: "auth-session", scopes: ["product:read", "message:send"] };
    } },
    liveVoice, messageSubmission: { submitMessage: async () => ({}) }, work: {} as any, leases: {} as any,
    authorityEpochs: { current: () => enabled ? { capability: "messages", epoch: 3, mode: "canonical",
      writer: "home23-coordination", effectiveAtEventSequence: 1, rollbackEpoch: 1 } : null,
      listCurrent: async () => ({ epochs: [], throughEventSequence: 1 }) },
  } });
  const server = createCoordinationHttpServer({ application, lifecycle: createCoordinationLifecycle(), port: 0 });
  t.after(() => server.drain());
  const { origin } = await server.start();
  const base = `${origin}/api/v1/channels/channel/voice`;
  const headers = { authorization: "Bearer test-token", "content-type": "application/json", "idempotency-key": "voice-request-000001" };
  assert.equal((await fetch(base)).status, 401);
  assert.equal(calls.length, 0);
  const capability = await fetch(base, { headers });
  assert.equal(capability.status, 200);
  assert.equal(capability.headers.get("cache-control"), "no-store");
  assert.equal((await capability.json() as any).available, true);
  const post = (path: string, body: unknown, customHeaders = headers) => fetch(path, { method: "POST", headers: customHeaders, body: JSON.stringify(body) });
  assert.equal((await post(`${base}/sessions`, { sdp: "offer" }, { ...headers, "idempotency-key": "short" })).status, 400);
  assert.equal((await post(`${base}/sessions`, { sdp: "offer", reasoningEffort: "invented" })).status, 400);
  assert.equal((await post(`${base}/sessions`, { sdp: "x".repeat(65_537) })).status, 400);
  const started = await post(`${base}/sessions`, { sdp: "offer", modelAlias: "chosen", reasoningEffort: "high" });
  assert.equal(started.status, 201);
  const receipt = await started.json() as any;
  assert.equal(receipt.sessionId, "opaque/session");
  assert.equal(calls.at(-1)?.input.accessToken, "test-token");
  assert.equal(calls.at(-1)?.input.modelAlias, "chosen");
  assert.equal(calls.at(-1)?.input.idempotencyKey, "voice-request-000001");
  const sessionURL = `${base}/sessions/${encodeURIComponent(receipt.sessionId)}`;
  assert.equal((await post(`${sessionURL}/heartbeat`, {})).status, 200);
  assert.equal(calls.at(-1)?.input.sessionId, "opaque/session");
  failure = true;
  const failed = await post(`${base}/sessions`, { sdp: "offer" });
  assert.equal(failed.status, 409);
  assert.equal((await failed.json() as any).error.code, "voice_start_expired");
  enabled = false;
  assert.equal((await post(`${base}/sessions`, { sdp: "offer" })).status, 503);
  // Cleanup must remain reachable when canonical mutation authority has been disabled.
  const ended = await post(`${sessionURL}/close`, {});
  assert.equal(ended.status, 200);
  assert.equal((await ended.json() as any).finalized, true);
});
