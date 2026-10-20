import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CoordinationHttpError } from "../../../src/coordination/http/errors.js";
import {
  DEFAULT_HOUSEHOLD_TOKEN_URL,
  assertNoProxyHeaders,
  createJerryStreamService,
  showIdFromFullPath,
} from "../../../src/coordination/music/jerry-stream.js";
import { redactStashSecrets } from "../../../src/coordination/music/redact.js";

const SHOW_ID = "d39f4acc70114e679236eb670c861616";
const FULL_PATH = `${SHOW_ID}/1986-10-19_01.mp3`;
const TOKEN = "au1.payload.signature";
const KEY = "house-service-key-fixture";
const EXPIRES_AT = "2026-10-21T02:14:27.000Z";

function mintPayload(overrides: Record<string, unknown> = {}) {
  const url = `https://www.shakedownshuffle.com/audio/stash/${FULL_PATH}?token=${TOKEN}`;
  return {
    token: TOKEN,
    scope: "household",
    show_id: SHOW_ID,
    expires_at: EXPIRES_AT,
    ttl_seconds: 21600,
    preview: null,
    files: [
      {
        index: 0,
        full_path: FULL_PATH,
        allowed: true,
        allowed_bytes: null,
        allowed_seconds: null,
        url,
      },
    ],
    ...overrides,
  };
}

function keyFile(contents = `${KEY}\n`) {
  const dir = mkdtempSync(join(tmpdir(), "home23-jerry-stream-"));
  const path = join(dir, "house-service.key");
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

function captureFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return new Response(JSON.stringify(mintPayload()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

function serviceError(error: unknown): CoordinationHttpError {
  assert.ok(error instanceof CoordinationHttpError);
  return error;
}

test("redactStashSecrets strips token query values, au1 tokens, and the house key header", () => {
  const redacted = redactStashSecrets(
    `GET https://www.shakedownshuffle.com/audio/stash/${FULL_PATH}?token=${TOKEN} X-House-Service-Key: ${KEY}`,
  );
  assert.equal(redacted.includes(TOKEN), false);
  assert.equal(redacted.includes(KEY), false);
  assert.match(redacted, /token=\[redacted\]/);
  assert.match(redacted, /X-House-Service-Key: \[redacted\]/);
});

test("showIdFromFullPath reads the 32-hex prefix and ignores old names", () => {
  assert.equal(showIdFromFullPath(FULL_PATH), SHOW_ID);
  assert.equal(showIdFromFullPath("1986-10-19_01.mp3"), null);
});

test("mints a household token without proxy headers and returns the tokened url", async () => {
  const { calls, fetchImpl } = captureFetch();
  const logs: string[] = [];
  const service = createJerryStreamService({
    keyPath: keyFile(),
    fetchImpl,
    warn: (message) => logs.push(message),
  });
  const result = await service.mint({ full_path: FULL_PATH });
  assert.equal(result.show_id, SHOW_ID);
  assert.equal(result.expires_at, EXPIRES_AT);
  assert.equal(result.url, `https://www.shakedownshuffle.com/audio/stash/${FULL_PATH}?token=${TOKEN}`);
  assert.equal(result.files[0]?.full_path, FULL_PATH);
  assert.equal(result.files[0]?.allowed, true);
  assert.equal(result.files[0]?.index, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, DEFAULT_HOUSEHOLD_TOKEN_URL);
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(calls[0]?.init.body, JSON.stringify({ full_path: FULL_PATH }));
  const headers = new Headers(calls[0]?.init.headers);
  assert.equal(headers.get("x-house-service-key"), KEY);
  assert.equal(headers.get("content-type"), "application/json");
  for (const name of ["x-forwarded-for", "x-forwarded-host", "forwarded", "via", "x-real-ip"]) {
    assert.equal(headers.has(name), false, name);
  }
  assertNoProxyHeaders(calls[0]?.init.headers);
  assert.deepEqual(logs, []);
});

test("reuses an in-memory cache per show until shortly before expires_at", async () => {
  const { calls, fetchImpl } = captureFetch();
  let now = Date.parse("2026-10-20T21:00:00.000Z");
  const service = createJerryStreamService({
    keyPath: keyFile(),
    fetchImpl,
    now: () => now,
  });
  const first = await service.mint({ show_id: SHOW_ID });
  const second = await service.mint({ full_path: FULL_PATH });
  assert.equal(calls.length, 1);
  assert.equal(second.url, first.files[0]?.url);
  now = Date.parse(EXPIRES_AT) - 1_000;
  await service.mint({ show_id: SHOW_ID });
  assert.equal(calls.length, 2);
});

test("empty house service key file is unconfigured", async () => {
  const service = createJerryStreamService({
    keyPath: keyFile("   \n"),
    fetchImpl: async () => {
      throw new Error("fetch must not run");
    },
  });
  await assert.rejects(() => service.mint({ show_id: SHOW_ID }), (error: unknown) => {
    assert.equal(serviceError(error).code, "audio_tokens_unconfigured");
    return true;
  });
});

test("missing house service key file is unconfigured", async () => {
  const service = createJerryStreamService({
    keyPath: join(tmpdir(), "home23-missing-house-service.key"),
    fetchImpl: async () => {
      throw new Error("fetch must not run");
    },
  });
  await assert.rejects(() => service.mint({ show_id: SHOW_ID }), (error: unknown) => {
    const failure = serviceError(error);
    assert.equal(failure.code, "audio_tokens_unconfigured");
    assert.equal(failure.httpStatus, 503);
    assert.equal(failure.retryable, true);
    assert.equal(failure.message.includes("house-service"), false);
    return true;
  });
});

test("maps upstream mint errors to stable house codes", async () => {
  const cases = [
    { status: 401, error: "service_key_required", code: "service_key_required", httpStatus: 401, retryable: false },
    { status: 403, error: "local_only", code: "local_only", httpStatus: 403, retryable: false },
    { status: 404, error: "show_not_found", code: "show_not_found", httpStatus: 404, retryable: false },
    { status: 503, error: "audio_tokens_unconfigured", code: "audio_tokens_unconfigured", httpStatus: 503, retryable: true },
    { status: 503, error: "audio_tokens_unavailable", code: "audio_tokens_unavailable", httpStatus: 503, retryable: true },
  ] as const;
  for (const item of cases) {
    const service = createJerryStreamService({
      keyPath: keyFile(),
      fetchImpl: async () => new Response(JSON.stringify({ error: item.error }), { status: item.status }),
    });
    await assert.rejects(() => service.mint({ show_id: SHOW_ID }), (error: unknown) => {
      const failure = serviceError(error);
      assert.equal(failure.code, item.code);
      assert.equal(failure.httpStatus, item.httpStatus);
      assert.equal(failure.retryable, item.retryable);
      assert.equal(JSON.stringify(failure).includes(TOKEN), false);
      assert.equal(JSON.stringify(failure).includes(KEY), false);
      return true;
    });
  }
});

test("connection failures and token-bearing error text become unavailable without leaking secrets", async () => {
  const logs: string[] = [];
  const service = createJerryStreamService({
    keyPath: keyFile(),
    fetchImpl: async () => {
      throw new Error(`connect failed https://www.shakedownshuffle.com/audio/stash/${FULL_PATH}?token=${TOKEN}`);
    },
    warn: (message) => logs.push(message),
  });
  await assert.rejects(() => service.mint({ show_id: SHOW_ID }), (error: unknown) => {
    const failure = serviceError(error);
    assert.equal(failure.code, "audio_tokens_unavailable");
    assert.equal(failure.httpStatus, 503);
    assert.equal(failure.message.includes(TOKEN), false);
    return true;
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.includes(TOKEN), false);
  assert.equal(logs[0]?.includes("au1."), false);
  assert.match(logs[0] ?? "", /token=\[redacted\]/);
});

test("default key path uses the account home, not the runtime HOME override", async () => {
  const { userInfo } = await import("node:os");
  const { DEFAULT_HOUSE_SERVICE_KEY_PATH, accountHomeDirectory } = await import("../../../src/coordination/music/jerry-stream.js");
  assert.equal(accountHomeDirectory(), userInfo().homedir);
  assert.equal(DEFAULT_HOUSE_SERVICE_KEY_PATH, join(userInfo().homedir, ".config/shakedown/house-service.key"));
});
