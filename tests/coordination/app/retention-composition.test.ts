import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCoordinationProcess,
  disabledCoordinationFeatureFlags,
} from "../../../src/coordination/app/index.js";
import { AS_OF, Fixture } from "../retention/fixture.js";

function processConfig(root: string, retentionEnabled = false) {
  const runtime = join(root, "instances", ".house", "coordination");
  mkdirSync(runtime, { recursive: true });
  return {
    enabled: true as const,
    host: "127.0.0.1",
    port: 0,
    databasePath: join(runtime, "home23-coordination.sqlite3"),
    socketPath: join(runtime, "coord.sock"),
    capabilityToken: "r".repeat(64),
    flags: {
      ...disabledCoordinationFeatureFlags(),
      "coordination.process.enabled": true,
      "coordination.compaction.enabled": retentionEnabled,
    },
  };
}

test("M30 is absent and default-off at the M12 composition boundary", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-retention-absent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const process = createCoordinationProcess(processConfig(root));
  t.after(() => process.drain());

  await assert.rejects(
    process.invokeRetention({ enabled: true, asOf: AS_OF }),
    /retention compaction is disabled/,
  );
  assert.equal("retention" in process.capabilities().capabilities, false);
});

test("M30 injection is inert and has no public HTTP or schedule capability", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-retention-inert-"));
  const fixture = new Fixture();
  let backupCalls = 0;
  t.after(() => { fixture.close(); rmSync(root, { recursive: true, force: true }); });
  const process = createCoordinationProcess(processConfig(root), {
    retention: {
      enabled: true,
      store: fixture,
      backupProvider: {
        createPrecompactBackup: async () => {
          backupCalls += 1;
          return fixture.backup();
        },
      },
    },
  });

  assert.equal(backupCalls, 0);
  assert.equal(fixture.readAll("SELECT * FROM work_observations").length, 4);
  assert.equal("retention" in process.capabilities().capabilities, false);
  const address = await process.start();
  t.after(() => process.drain());
  const response = await fetch(`${address.origin}/api/v1/retention`);
  assert.equal(response.status, 404);
  assert.equal(backupCalls, 0);
  assert.equal(fixture.readAll("SELECT * FROM work_observations").length, 4);
});

test("M30 explicit invocation rejects missing or invalid verified backup receipts", async (t) => {
  const invalidReceipts = [
    undefined,
    { sha256: "x".repeat(64), byteLength: 1, eventSequence: 1 },
    { sha256: "a".repeat(64), byteLength: 0, eventSequence: 1 },
    { sha256: "a".repeat(64), byteLength: 1, eventSequence: -1 },
  ];
  for (const [index, receipt] of invalidReceipts.entries()) {
    const root = mkdtempSync(join(tmpdir(), `home23-retention-receipt-${index}-`));
    const fixture = new Fixture();
    t.after(() => { fixture.close(); rmSync(root, { recursive: true, force: true }); });
    const process = createCoordinationProcess(processConfig(root, true), {
      retention: {
        enabled: true,
        store: fixture,
        backupProvider: {
          createPrecompactBackup: async () => receipt as never,
        },
      },
    });
    t.after(() => process.drain());
    await assert.rejects(
      process.invokeRetention({ enabled: true, asOf: AS_OF }),
      /verified precompact backup receipt is required/,
    );
    assert.equal(fixture.readAll("SELECT * FROM work_observations").length, 4);
  }
});

test("M30 requires explicit invocation enable and preserves executor idempotency", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "home23-retention-explicit-"));
  const fixture = new Fixture();
  let backupCalls = 0;
  t.after(() => { fixture.close(); rmSync(root, { recursive: true, force: true }); });
  const process = createCoordinationProcess(processConfig(root, true), {
    retention: {
      enabled: true,
      store: fixture,
      backupProvider: {
        createPrecompactBackup: async () => {
          backupCalls += 1;
          return fixture.backup();
        },
      },
    },
  });
  t.after(() => process.drain());

  await assert.rejects(
    process.invokeRetention({ enabled: false, asOf: AS_OF } as never),
    /retention compaction is disabled/,
  );
  assert.equal(backupCalls, 0);
  const first = await process.invokeRetention({ enabled: true, asOf: AS_OF });
  const second = await process.invokeRetention({ enabled: true, asOf: AS_OF });
  assert.equal(first.compacted.sourceRows, 4);
  assert.deepEqual(second.compacted, { summaries: 0, sourceRows: 0, sourceBytes: 0 });
  assert.equal(backupCalls, 2);
});
