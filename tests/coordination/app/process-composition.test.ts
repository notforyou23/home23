import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCoordinationProcess,
  disabledCoordinationFeatureFlags,
  type CoordinationActivityPort,
} from "../../../src/coordination/app/index.js";
import { openCoordinationDatabase } from "../../../src/coordination/db/index.js";

test("shadow composition advertises no unfinished product capability and closes cleanly", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-coordination-process-"));
  const runtime = join(root, "instances", ".house", "coordination");
  mkdirSync(runtime, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(runtime, "home23-coordination.sqlite3");
  const process = createCoordinationProcess({
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    databasePath,
    socketPath: join(runtime, "coord.sock"),
    capabilityToken: "c".repeat(64),
    flags: {
      ...disabledCoordinationFeatureFlags(),
      "coordination.process.enabled": true,
    },
  });

  const capabilities = process.capabilities().capabilities;
  assert.equal(capabilities.bootstrap, true);
  assert.equal(capabilities.eventReplay, true);
  for (const key of ["messageSubmission", "readCursorMutation", "workMutation", "attachments", "botLifecycle"] as const) {
    assert.equal(capabilities[key], false);
  }
  const address = await process.start();
  assert.equal(address.host, "127.0.0.1");
  const response = await fetch(`${address.origin}/api/v1/capabilities`);
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json() as { pairingAvailable: boolean }).pairingAvailable,
    false,
  );

  await process.drain();
  await assert.rejects(fetch(`${address.origin}/api/v1/capabilities`));
  const reopened = openCoordinationDatabase({ path: databasePath });
  reopened.close();
});

test("M16 and M18 process dependencies stay feature-off and unreachable over HTTP", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-coordination-projections-off-"));
  const runtime = join(root, "instances", ".house", "coordination");
  mkdirSync(runtime, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let coordinatorCalls = 0;
  let projectorCalls = 0;
  const channelCoordinator = {
    start: () => { coordinatorCalls += 1; throw new Error("must remain unreachable"); },
    recover: () => { coordinatorCalls += 1; throw new Error("must remain unreachable"); },
    reconcile: () => { coordinatorCalls += 1; throw new Error("must remain unreachable"); },
    cancel: () => { coordinatorCalls += 1; throw new Error("must remain unreachable"); },
  };
  const activity: CoordinationActivityPort = () => {
    projectorCalls += 1;
    throw new Error("must remain unreachable");
  };
  const process = createCoordinationProcess({
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    databasePath: join(runtime, "home23-coordination.sqlite3"),
    socketPath: join(runtime, "coord.sock"),
    capabilityToken: "d".repeat(64),
    flags: {
      ...disabledCoordinationFeatureFlags(),
      "coordination.process.enabled": true,
    },
  }, {
    channelCoordinator,
    activity,
  });

  assert.equal(process.capabilities().capabilities.activity, false);
  assert.equal(process.capabilities().capabilities.channelsRead, true);
  assert.equal(process.capabilities().capabilities.messageSubmission, false);
  const address = await process.start();
  t.after(() => process.drain());
  for (const path of ["/api/v1/activity", "/api/v1/channels"]) {
    const response = await fetch(`${address.origin}${path}`);
    assert.equal(response.status, 401);
  }
  assert.equal(coordinatorCalls, 0);
  assert.equal(projectorCalls, 0);
});
