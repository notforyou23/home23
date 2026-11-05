import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  COORDINATION_SCHEMA_CHECKSUM,
  COORDINATION_SCHEMA_VERSION,
  openCoordinationDatabase,
  restoreVerifiedBackup,
} from "../../../src/coordination/db/index.js";
import { generateCoordinationId } from "../../../src/coordination/ids/index.js";

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("online backup restores exact rows and the captured event sequence", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "home23-coordination-backup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "source.sqlite3");
  const backupPath = join(directory, "backup.sqlite3");
  const restoredPath = join(directory, "restored.sqlite3");
  const database = openCoordinationDatabase({
    path: sourcePath,
    applicationVersion: "m04-backup-test",
  });
  const aggregateId = generateCoordinationId("home");
  const correlationId = generateCoordinationId("correlation");

  database.mutateWithEvent((transaction) => {
    transaction.run(
      "INSERT INTO kernel_meta (key, value, updated_at) VALUES (?, ?, ?)",
      "test.backup-counter",
      "1",
      "2026-08-24T12:00:00.000Z",
    );
    return {
      value: undefined,
      event: {
        type: "kernel.backup_tested",
        aggregateKind: "home",
        aggregateId,
        aggregateVersion: 1,
        channelId: null,
        actorPrincipalId: "user_owner",
        requestId: generateCoordinationId("request"),
        correlationId,
        payload: { counter: 1 },
        createdAt: "2026-08-24T12:00:00.000Z",
      },
    };
  });
  const expectedEvents = database.readAll<Record<string, unknown>>(
    "SELECT * FROM events ORDER BY sequence",
  );

  const backup = await database.createVerifiedBackup({ path: backupPath });
  assert.equal(backup.schemaVersion, COORDINATION_SCHEMA_VERSION);
  assert.equal(backup.schemaChecksum, COORDINATION_SCHEMA_CHECKSUM);
  assert.equal(backup.eventSequence, 1);
  assert.equal(backup.integrityCheck, "quick_check");
  assert.equal(backup.sha256, sha256File(backupPath));
  assert.ok(backup.byteLength > 0);
  const manifest = JSON.parse(readFileSync(backup.manifestPath, "utf8")) as {
    database: { sha256: string; byteLength: number };
    schema: { version: number; checksum: string };
    eventSequence: number;
  };
  assert.deepEqual(manifest, {
    database: { sha256: backup.sha256, byteLength: backup.byteLength },
    schema: {
      version: COORDINATION_SCHEMA_VERSION,
      checksum: COORDINATION_SCHEMA_CHECKSUM,
    },
    eventSequence: 1,
  });

  database.mutateWithEvent((transaction) => {
    transaction.run(
      "UPDATE kernel_meta SET value = ?, updated_at = ? WHERE key = ?",
      "2",
      "2026-08-24T12:01:00.000Z",
      "test.backup-counter",
    );
    return {
      value: undefined,
      event: {
        type: "kernel.backup_tested",
        aggregateKind: "home",
        aggregateId,
        aggregateVersion: 2,
        channelId: null,
        actorPrincipalId: "user_owner",
        requestId: generateCoordinationId("request"),
        correlationId,
        payload: { counter: 2 },
        createdAt: "2026-08-24T12:01:00.000Z",
      },
    };
  });
  database.close();

  const restored = await restoreVerifiedBackup({
    backupPath,
    destinationPath: restoredPath,
    expectedSha256: backup.sha256,
  });
  assert.equal(restored.sourceSha256, backup.sha256);
  assert.equal(restored.destinationSha256, backup.sha256);
  assert.equal(restored.destinationSha256, sha256File(restoredPath));
  assert.equal(restored.eventSequence, 1);
  assert.equal(restored.integrityCheck, "integrity_check");

  const reopened = openCoordinationDatabase({ path: restoredPath });
  assert.equal(
    reopened.readOne<{ value: string }>(
      "SELECT value FROM kernel_meta WHERE key = ?",
      "test.backup-counter",
    )?.value,
    "1",
  );
  assert.deepEqual(
    reopened.readAll<Record<string, unknown>>("SELECT * FROM events ORDER BY sequence"),
    expectedEvents,
  );
  reopened.close();
});

test("restore refuses a digest mismatch before creating a destination", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "home23-coordination-restore-refusal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "source.sqlite3");
  const backupPath = join(directory, "backup.sqlite3");
  const destinationPath = join(directory, "must-not-exist.sqlite3");
  const database = openCoordinationDatabase({ path: sourcePath });
  await database.createVerifiedBackup({ path: backupPath });
  database.close();

  await assert.rejects(
    restoreVerifiedBackup({
      backupPath,
      destinationPath,
      expectedSha256: "0".repeat(64),
    }),
    /backup digest mismatch/,
  );
  assert.throws(() => readFileSync(destinationPath), /ENOENT/);
});
