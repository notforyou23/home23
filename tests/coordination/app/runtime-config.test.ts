import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadCoordinationRuntimeConfig } from "../../../src/coordination/app/index.js";

function fixture(enabled = false) {
  const root = mkdtempSync(join(tmpdir(), "home23-coordination-config-"));
  const runtime = join(root, "instances", ".house", "coordination");
  if (enabled) mkdirSync(runtime, { recursive: true });
  return {
    root,
    environment: {
      HOME23_ROOT: root,
      HOME23_COORDINATION_ENABLED: String(enabled),
      HOME23_COORDINATION_PUBLIC_API_ENABLED: "false",
      HOME23_COORDINATION_HOST: "127.0.0.1",
      HOME23_COORDINATION_PORT: "7346",
      HOME23_COORDINATION_DB_PATH: join(runtime, "home23-coordination.sqlite3"),
      HOME23_COORDINATION_SOCKET_PATH: join(runtime, "coord.sock"),
      HOME23_COORDINATION_CAPABILITY_TOKEN: enabled ? "a".repeat(64) : "",
    },
  };
}

test("disabled defaults retain loopback-only paths without requiring runtime state", (t) => {
  const input = fixture();
  t.after(() => rmSync(input.root, { recursive: true, force: true }));
  const config = loadCoordinationRuntimeConfig(input.environment);

  assert.equal(config.enabled, false);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(Object.values(config.flags).some(Boolean), false);
  assert.match(config.databasePath, /instances\/.house\/coordination\/home23-coordination\.sqlite3$/);
  assert.match(config.socketPath, /instances\/.house\/coordination\/coord\.sock$/);
});

test("enabled startup fails closed for missing secrets and runtime parents", (t) => {
  const missingSecret = fixture(true);
  t.after(() => rmSync(missingSecret.root, { recursive: true, force: true }));
  assert.throws(
    () => loadCoordinationRuntimeConfig({
      ...missingSecret.environment,
      HOME23_COORDINATION_CAPABILITY_TOKEN: "",
    }),
    /must contain exactly 32 bytes of hex/,
  );

  const missingPath = fixture(false);
  t.after(() => rmSync(missingPath.root, { recursive: true, force: true }));
  assert.throws(
    () => loadCoordinationRuntimeConfig({
      ...missingPath.environment,
      HOME23_COORDINATION_ENABLED: "true",
      HOME23_COORDINATION_CAPABILITY_TOKEN: "b".repeat(64),
    }),
    /parent directory is missing/,
  );
});

test("unsafe binds, malformed flags, and escaped paths are refused", (t) => {
  const input = fixture();
  t.after(() => rmSync(input.root, { recursive: true, force: true }));
  assert.throws(
    () => loadCoordinationRuntimeConfig({
      ...input.environment,
      HOME23_COORDINATION_HOST: "0.0.0.0",
    }),
    /explicit loopback literal/,
  );
  assert.throws(
    () => loadCoordinationRuntimeConfig({
      ...input.environment,
      HOME23_COORDINATION_ENABLED: "yes",
    }),
    /must be exactly true or false/,
  );
  assert.throws(
    () => loadCoordinationRuntimeConfig({
      ...input.environment,
      HOME23_COORDINATION_DB_PATH: join(input.root, "outside.sqlite3"),
    }),
    /must remain inside/,
  );
});
