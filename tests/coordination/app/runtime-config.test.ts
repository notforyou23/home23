import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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
  assert.equal(config.botRootDirectory, join(input.root, "instances", ".house", "bots"));
  assert.match(config.socketPath, /instances\/.house\/coordination\/coord\.sock$/);
  assert.equal(config.attachments?.enabled, false);
  assert.equal(config.activity?.enabled, false);
  assert.equal(config.residentOutcomes?.replay, true);
  assert.match(config.attachments?.rootDirectory ?? "", /instances\/.house\/coordination\/attachments$/);
});

test("resident outcome replay is on unless a home pauses it exactly", (t) => {
  const input = fixture(true);
  t.after(() => rmSync(input.root, { recursive: true, force: true }));
  assert.equal(loadCoordinationRuntimeConfig(input.environment).residentOutcomes?.replay, true);
  assert.equal(loadCoordinationRuntimeConfig({
    ...input.environment, HOME23_COORDINATION_RESIDENT_OUTCOMES_REPLAY: "true",
  }).residentOutcomes?.replay, true);
  assert.equal(loadCoordinationRuntimeConfig({
    ...input.environment, HOME23_COORDINATION_RESIDENT_OUTCOMES_REPLAY: "false",
  }).residentOutcomes?.replay, false);
  assert.throws(() => loadCoordinationRuntimeConfig({
    ...input.environment, HOME23_COORDINATION_RESIDENT_OUTCOMES_REPLAY: "paused",
  }), /must be exactly true or false/);
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
  assert.throws(
    () => loadCoordinationRuntimeConfig({
      ...input.environment,
      HOME23_COORDINATION_ATTACHMENTS_ROOT: join(input.root, "outside-attachments"),
    }),
    /must remain inside/,
  );
});

test("all eleven rollout flags default off and every projected boolean is strict", (t) => {
  const input = fixture();
  t.after(() => rmSync(input.root, { recursive: true, force: true }));
  const config = loadCoordinationRuntimeConfig(input.environment);
  assert.equal(Object.keys(config.flags).length, 11);
  assert.ok(Object.values(config.flags).every((value) => value === false));
  for (const variable of [
    "HOME23_COORDINATION_PUBLIC_API_ENABLED", "HOME23_COORDINATION_RESIDENT_JERRY_ENABLED",
    "HOME23_COORDINATION_RESIDENT_FORREST_ENABLED", "HOME23_COORDINATION_CHANNELS_ENABLED",
    "HOME23_COORDINATION_SEARCH_CANONICAL", "HOME23_COORDINATION_IMPORT_SHADOW_ENABLED",
    "HOME23_COORDINATION_APPLE_MAC_CUTOVER", "HOME23_COORDINATION_APPLE_IPHONE_CUTOVER",
    "HOME23_COORDINATION_BOT_LIFECYCLE_ENABLED", "HOME23_COORDINATION_COMPACTION_ENABLED",
    "HOME23_COORDINATION_ATTACHMENTS_ENABLED", "HOME23_COORDINATION_ACTIVITY_ENABLED",
  ]) assert.throws(() => loadCoordinationRuntimeConfig({ ...input.environment, [variable]: "1" }), /must be exactly true or false/);
});

test("Activity admission is an independent strict runtime switch", (t) => {
  const input = fixture(true);
  t.after(() => rmSync(input.root, { recursive: true, force: true }));
  const config = loadCoordinationRuntimeConfig({
    ...input.environment,
    HOME23_COORDINATION_ACTIVITY_ENABLED: "true",
  });
  assert.equal(config.activity?.enabled, true);
});

test("attachment admission is an independent confined runtime switch", (t) => {
  const input = fixture(true);
  t.after(() => rmSync(input.root, { recursive: true, force: true }));
  const config = loadCoordinationRuntimeConfig({
    ...input.environment,
    HOME23_COORDINATION_ATTACHMENTS_ENABLED: "true",
  });
  assert.equal(config.attachments?.enabled, true);
  assert.equal(config.attachments?.maximumBytes, 25 * 1024 * 1024);
  assert.equal(config.attachments?.maximumCountPerMessage, 10);
  assert.match(config.attachments?.rootDirectory ?? "", /coordination\/attachments$/);
});

test("an arbitrary primary resident uses explicit authenticated runtime configuration", t => {
  const input = fixture(true);
  t.after(() => rmSync(input.root, { recursive: true, force: true }));
  const environment = { ...input.environment,
    HOME23_COORDINATION_RESIDENT_SLUGS: '["milo-river"]', HOME23_COORDINATION_PRIMARY_RESIDENT: "milo-river",
    HOME23_COORDINATION_HOME_ID: "home_0198d95f-6c00-7000-8000-000000000001", HOME23_COORDINATION_HOME_NAME: "River Home",
    HOME23_COORDINATION_RESIDENT_MILO_RIVER_ENABLED: "true", HOME23_COORDINATION_RESIDENT_MILO_RIVER_KEY: "a".repeat(64),
  };
  const configured = loadCoordinationRuntimeConfig(environment);
  assert.deepEqual(Object.keys(configured.residents), ["milo-river"]);
  assert.equal(configured.residents["milo-river"]?.enabled, true);
  assert.equal(configured.home?.primaryResident, "milo-river");
  assert.equal(configured.home?.name, "River Home");
  assert.throws(() => loadCoordinationRuntimeConfig({ ...environment, HOME23_COORDINATION_RESIDENT_MILO_RIVER_KEY: "" }), /32 bytes of hex/);
  assert.throws(() => loadCoordinationRuntimeConfig({ ...environment, HOME23_COORDINATION_PRIMARY_RESIDENT: "another" }), /not configured/);
  assert.throws(() => loadCoordinationRuntimeConfig({ ...environment, HOME23_COORDINATION_RESIDENT_SLUGS: '["bot-helper"]' }), /slugs are invalid/);
  assert.equal(loadCoordinationRuntimeConfig({ ...environment, HOME23_COORDINATION_ENABLED: "false" }).residents["milo-river"]?.enabled, false);
});

test("Core uses its private short socket root while retaining durable home state", t => {
  const input = fixture(true);
  const shortRoot = mkdtempSync(join(tmpdir(), "h23-sockets-"));
  t.after(() => { rmSync(input.root, { recursive: true, force: true }); rmSync(shortRoot, { recursive: true, force: true }); });
  const environment = { ...input.environment,
    HOME23_COORDINATION_SOCKET_ROOT: shortRoot,
    HOME23_COORDINATION_SOCKET_PATH: join(shortRoot, "coord.sock"),
  };
  const config = loadCoordinationRuntimeConfig(environment);
  assert.equal(config.socketPath, join(shortRoot, "coord.sock"));
  assert.equal(config.databasePath, input.environment.HOME23_COORDINATION_DB_PATH);
  // A configured resident socket root does not relocate legacy Core sockets.
  assert.equal(loadCoordinationRuntimeConfig({ ...environment, HOME23_COORDINATION_SOCKET_PATH: input.environment.HOME23_COORDINATION_SOCKET_PATH }).socketPath, input.environment.HOME23_COORDINATION_SOCKET_PATH);
  assert.throws(() => loadCoordinationRuntimeConfig({ ...environment, HOME23_COORDINATION_SOCKET_PATH: join(input.root, "escape.sock") }), /must remain inside/);
  assert.throws(() => loadCoordinationRuntimeConfig({ ...environment, HOME23_COORDINATION_DB_PATH: join(shortRoot, "database.sqlite3") }), /must remain inside/);
  assert.throws(() => loadCoordinationRuntimeConfig({ ...environment, HOME23_COORDINATION_SOCKET_ROOT: "relative-sockets" }), /absolute dedicated directory/);
  chmodSync(shortRoot, 0o755);
  assert.throws(() => loadCoordinationRuntimeConfig(environment), /owned private directory/);
  chmodSync(shortRoot, 0o700);
  const link = join(input.root, "linked-sockets"); symlinkSync(shortRoot, link);
  assert.throws(() => loadCoordinationRuntimeConfig({ ...environment, HOME23_COORDINATION_SOCKET_ROOT: link, HOME23_COORDINATION_SOCKET_PATH: join(link, "coord.sock") }), /owned private directory/);
});
