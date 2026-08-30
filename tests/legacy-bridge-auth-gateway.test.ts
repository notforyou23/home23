import assert from "node:assert/strict";
import test from "node:test";
import { authorizeLegacyBridgeRequest } from "../src/legacy-bridge-auth-gateway.js";

test("gateway rejects the upstream static secret and accepts only online legacy scope", async () => {
  const base = { staticToken: "s".repeat(32), coordinationOrigin: "http://127.0.0.1:7346" };
  assert.equal(await authorizeLegacyBridgeRequest({ ...base, authorization: `Bearer ${"s".repeat(32)}` }), "unauthorized");
  assert.equal(await authorizeLegacyBridgeRequest({
    ...base,
    authorization: "Bearer scoped",
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, scopes: ["legacy-bridge:access"] }), { status: 200 }),
  }), "scoped");
  assert.equal(await authorizeLegacyBridgeRequest({
    ...base,
    authorization: "Bearer canary",
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, scopes: ["product:read"] }), { status: 200 }),
  }), "unauthorized");
  assert.equal(await authorizeLegacyBridgeRequest({
    ...base,
    authorization: "Bearer revoked",
    fetchImpl: async () => new Response("{}", { status: 401 }),
  }), "unauthorized");
});
