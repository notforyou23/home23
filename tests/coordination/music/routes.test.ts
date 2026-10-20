import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCoordinationApplication, disabledCoordinationFeatureFlags } from "../../../src/coordination/app/index.js";
import { AuthError } from "../../../src/coordination/auth/index.js";
import { createCoordinationHttpServer } from "../../../src/coordination/http/index.js";
import { createJerryStreamService } from "../../../src/coordination/music/jerry-stream.js";

const SHOW_ID = "d39f4acc70114e679236eb670c861616";
const FULL_PATH = `${SHOW_ID}/1986-10-19_01.mp3`;
const TOKEN = "au1.payload.signature";
const KEY = "house-service-key-fixture";
const EXPIRES_AT = "2026-10-21T02:14:27.000Z";
const principal = {
  principalId: "user_owner" as const,
  deviceId: "device-owner",
  sessionId: "session-owner",
  scopes: ["product:read", "message:send"] as const,
};
const flags = {
  ...disabledCoordinationFeatureFlags(),
  "coordination.process.enabled": true,
  "coordination.public_api.enabled": true,
};

function headers(token = "owner-token") {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function started(application: ReturnType<typeof createCoordinationApplication>, t: { after: (fn: () => void) => void }) {
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  return server.start();
}

test("jerry stream requires paired owner auth and a show selector", async (t) => {
  let minted = 0;
  const application = createCoordinationApplication({
    flags,
    services: {
      auth: {
        validateAccessToken: async ({ accessToken, requiredScopes }) => {
          if (accessToken !== "owner-token") throw new AuthError("access_invalid");
          assert.deepEqual(requiredScopes, ["product:read"]);
          return principal;
        },
      },
      jerryStream: {
        mint: async (request) => {
          minted += 1;
          return {
            url: `https://www.shakedownshuffle.com/audio/stash/${request.full_path}?token=${TOKEN}`,
            expires_at: EXPIRES_AT,
            show_id: SHOW_ID,
            files: [{ index: 0, full_path: FULL_PATH, allowed: true, url: `https://www.shakedownshuffle.com/audio/stash/${FULL_PATH}?token=${TOKEN}` }],
          };
        },
      },
    },
  });
  const { origin } = await started(application, t);
  const url = `${origin}/api/v1/music/jerry/stream`;
  assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await fetch(url, { method: "POST", headers: headers("wrong-token"), body: JSON.stringify({ show_id: SHOW_ID }) })).status, 401);
  for (const body of [{}, { show_id: "nope" }, { full_path: "../secret.mp3" }, { show_id: SHOW_ID, extra: true }]) {
    const denied = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(body) });
    assert.equal(denied.status, 400);
    assert.equal(((await denied.json()) as { error: { code: string } }).error.code, "request_invalid");
  }
  assert.equal(minted, 0);
  const accepted = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify({ full_path: FULL_PATH }) });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("cache-control"), "private, no-store");
  const payload = await accepted.json() as { url: string; expires_at: string; show_id: string; files: Array<{ full_path: string }> };
  assert.equal(payload.show_id, SHOW_ID);
  assert.equal(payload.expires_at, EXPIRES_AT);
  assert.match(payload.url, /token=au1\./);
  assert.equal(payload.files[0]?.full_path, FULL_PATH);
  assert.equal(minted, 1);
});

test("missing house key file through the house endpoint is unconfigured", async (t) => {
  const application = createCoordinationApplication({
    flags,
    services: {
      auth: { validateAccessToken: async () => principal },
      jerryStream: createJerryStreamService({
        keyPath: join(tmpdir(), "home23-missing-house-service.key"),
        fetchImpl: async () => {
          throw new Error("fetch must not run");
        },
      }),
    },
  });
  const { origin } = await started(application, t);
  const response = await fetch(`${origin}/api/v1/music/jerry/stream`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ show_id: SHOW_ID }),
  });
  assert.equal(response.status, 503);
  const body = await response.json() as { error: { code: string; retryable: boolean; message: string } };
  assert.equal(body.error.code, "audio_tokens_unconfigured");
  assert.equal(body.error.retryable, true);
  assert.equal(JSON.stringify(body).includes("house-service.key"), false);
});

test("unconfigured jerry stream is a fallback-safe 503", async (t) => {
  const application = createCoordinationApplication({
    flags,
    services: {
      auth: { validateAccessToken: async () => principal },
    },
  });
  const { origin } = await started(application, t);
  const response = await fetch(`${origin}/api/v1/music/jerry/stream`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ show_id: SHOW_ID }),
  });
  assert.equal(response.status, 503);
  assert.equal(((await response.json()) as { error: { code: string; retryable: boolean } }).error.code, "audio_tokens_unconfigured");
});

test("house endpoint forwards a mocked loopback mint and hides the key file", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "home23-jerry-stream-http-"));
  const keyPath = join(dir, "house-service.key");
  writeFileSync(keyPath, `${KEY}\n`, { mode: 0o600 });
  const calls: Array<{ url: string; headers: Headers }> = [];
  const application = createCoordinationApplication({
    flags,
    services: {
      auth: { validateAccessToken: async () => principal },
      jerryStream: createJerryStreamService({
        keyPath,
        fetchImpl: async (input, init = {}) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const headerList = new Headers(init.headers);
          calls.push({ url, headers: headerList });
          assert.equal(headerList.get("x-forwarded-for"), null);
          assert.equal(headerList.get("via"), null);
          return new Response(JSON.stringify({
            scope: "household",
            show_id: SHOW_ID,
            expires_at: EXPIRES_AT,
            files: [{ index: 0, full_path: FULL_PATH, allowed: true, url: `https://www.shakedownshuffle.com/audio/stash/${FULL_PATH}?token=${TOKEN}` }],
          }), { status: 200, headers: { "content-type": "application/json" } });
        },
      }),
    },
  });
  const { origin } = await started(application, t);
  const response = await fetch(`${origin}/api/v1/music/jerry/stream`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ show_id: SHOW_ID }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json() as { url: string | null; files: Array<{ url: string }> };
  assert.equal(payload.url?.includes(TOKEN), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://127.0.0.1:3005/api/v1/audio/household-token");
  assert.equal(calls[0]?.headers.get("x-house-service-key"), KEY);
  const text = JSON.stringify(payload);
  assert.equal(text.includes(KEY), false);
});
