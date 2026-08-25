import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import Database from "better-sqlite3";

import { computeContractPackDigest } from "../../../src/coordination/contracts/contract-pack.js";
import {
  COORDINATION_CONTRACT_PACK_SHA256,
  COORDINATION_MIGRATION_PLAN_CHECKSUM,
  COORDINATION_SCHEMA_CHECKSUM,
  COORDINATION_SCHEMA_VERSION,
  CoordinationWriterBusyError,
  SchemaCompatibilityError,
  openCoordinationDatabase,
  type CoordinationTransaction,
} from "../../../src/coordination/db/index.js";
import { generateCoordinationId } from "../../../src/coordination/ids/index.js";

function temporaryDatabase(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "home23-coordination-db-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "coordination.sqlite3");
}

test("a zero-byte database migrates to the current checksummed schema and reopens", (t) => {
  const path = temporaryDatabase(t);
  writeFileSync(path, "");

  const first = openCoordinationDatabase({ path, applicationVersion: "m04-test" });
  assert.equal(computeContractPackDigest(), COORDINATION_CONTRACT_PACK_SHA256);
  assert.equal(first.openReceipt.startupCheck, "integrity_check");
  assert.equal(first.openReceipt.migratedFrom, 0);
  assert.equal(first.openReceipt.schemaVersion, COORDINATION_SCHEMA_VERSION);
  assert.equal(first.openReceipt.schemaChecksum, COORDINATION_SCHEMA_CHECKSUM);
  assert.deepEqual(first.pragmaEvidence(), {
    journalMode: "wal",
    synchronous: 2,
    foreignKeys: 1,
    busyTimeoutMs: 5_000,
    trustedSchema: 0,
    walAutoCheckpointPages: 1_000,
    lockingMode: "exclusive",
  });
  assert.deepEqual(
    first
      .readAll<{ name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .map((row) => row.name),
    ["authority_epochs", "events", "kernel_meta", "schema_migrations"],
  );
  assert.deepEqual(first.readAll("PRAGMA foreign_key_check"), []);
  assert.deepEqual(first.readAll("PRAGMA integrity_check"), [{ integrity_check: "ok" }]);
  first.close();

  const reopened = openCoordinationDatabase({ path, applicationVersion: "m04-test" });
  assert.equal(reopened.openReceipt.startupCheck, "quick_check");
  assert.equal(reopened.openReceipt.migratedFrom, COORDINATION_SCHEMA_VERSION);
  assert.deepEqual(
    reopened.readAll<{ version: number; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    ),
    [{ version: 1, checksum: COORDINATION_MIGRATION_PLAN_CHECKSUM }],
  );
  assert.deepEqual(
    reopened.readAll<{ key: string; value: string }>(
      "SELECT key, value FROM kernel_meta WHERE key LIKE 'schema.%' OR key LIKE 'contract.%' ORDER BY key",
    ),
    [
      {
        key: "contract.pack_sha256",
        value: COORDINATION_CONTRACT_PACK_SHA256,
      },
      { key: "contract.version", value: "1" },
      { key: "schema.checksum", value: COORDINATION_SCHEMA_CHECKSUM },
      { key: "schema.version", value: String(COORDINATION_SCHEMA_VERSION) },
    ],
  );
  reopened.close();
});

test("a second product writer is rejected until the owner closes", (t) => {
  const path = temporaryDatabase(t);
  const owner = openCoordinationDatabase({ path });
  const databaseModule = new URL("../../../src/coordination/db/index.ts", import.meta.url).href;
  const childScript = `
    const { openCoordinationDatabase } = await import(${JSON.stringify(databaseModule)});
    try {
      const database = openCoordinationDatabase({ path: ${JSON.stringify(path)} });
      database.close();
      console.log("opened");
      process.exit(0);
    } catch (error) {
      console.log(error?.constructor?.name ?? "unknown");
      process.exit(error?.constructor?.name === "CoordinationWriterBusyError" ? 23 : 24);
    }
  `;

  const startedAt = Date.now();
  assert.throws(
    () => openCoordinationDatabase({ path }),
    (error: unknown) =>
      error instanceof CoordinationWriterBusyError && error.databasePath === path,
  );
  assert.ok(Date.now() - startedAt < 1_000, "writer rejection must fail promptly");
  const blockedProcess = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", childScript],
    { encoding: "utf8" },
  );
  assert.equal(blockedProcess.status, 23, blockedProcess.stderr);
  assert.equal(blockedProcess.stdout.trim(), "CoordinationWriterBusyError");

  owner.close();
  const successor = openCoordinationDatabase({ path });
  successor.close();
  const successorProcess = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", childScript],
    { encoding: "utf8" },
  );
  assert.equal(successorProcess.status, 0, successorProcess.stderr);
  assert.equal(successorProcess.stdout.trim(), "opened");
});

test("read helpers cannot bypass the mutation and event transaction boundary", (t) => {
  const path = temporaryDatabase(t);
  const database = openCoordinationDatabase({ path });

  assert.throws(
    () =>
      database.readOne(
        "INSERT INTO kernel_meta (key, value, updated_at) VALUES (?, ?, ?) RETURNING value",
        "test.bypass",
        "unsafe",
        "2026-08-24T12:00:00.000Z",
      ),
    /read helper refused a mutating statement/,
  );
  assert.equal(
    database.readOne<{ value: string }>(
      "SELECT value FROM kernel_meta WHERE key = ?",
      "test.bypass",
    ),
    undefined,
  );
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM events")?.count, 0);
  database.close();
});

test("state mutation and event append commit or roll back as one immediate transaction", (t) => {
  const path = temporaryDatabase(t);
  const database = openCoordinationDatabase({ path });
  const requestId = generateCoordinationId("request");
  const correlationId = generateCoordinationId("correlation");
  const aggregateId = generateCoordinationId("home");
  const createdAt = "2026-08-24T12:00:00.000Z";

  const first = database.mutateWithEvent((transaction) => {
    transaction.run(
      "INSERT INTO kernel_meta (key, value, updated_at) VALUES (?, ?, ?)",
      "test.counter",
      "1",
      createdAt,
    );
    return {
      value: "committed",
      event: {
        type: "kernel.test_mutated",
        aggregateKind: "home",
        aggregateId,
        aggregateVersion: 1,
        channelId: null,
        actorPrincipalId: "user_owner",
        requestId,
        correlationId,
        payload: { counter: 1 },
        createdAt,
      },
    };
  });
  assert.equal(first.value, "committed");
  assert.equal(first.event.sequence, 1);
  assert.match(first.event.id, /^evt_/);
  assert.equal(first.event.payloadJson, '{"counter":1}');
  assert.equal(
    first.event.payloadDigest,
    "55459e863d1c8fcdaff7ac18549f96db4495ea3a74c4d659e410cd554d65ff43",
  );

  assert.throws(
    () =>
      database.mutateWithEvent((transaction) => {
        transaction.run(
          "UPDATE kernel_meta SET value = ?, updated_at = ? WHERE key = ?",
          "2",
          createdAt,
          "test.counter",
        );
        return {
          value: "must-roll-back",
          event: {
            type: "kernel.test_mutated",
            aggregateKind: "home",
            aggregateId,
            aggregateVersion: 1,
            channelId: null,
            actorPrincipalId: "user_owner",
            requestId: generateCoordinationId("request"),
            correlationId,
            payload: { counter: 2 },
            createdAt,
          },
        };
      }),
    /UNIQUE constraint failed/,
  );
  assert.deepEqual(
    database.readOne<{ value: string }>(
      "SELECT value FROM kernel_meta WHERE key = ?",
      "test.counter",
    ),
    { value: "1" },
  );
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM events")?.count, 1);

  assert.throws(
    () =>
      database.mutateWithEvent((transaction) => {
        transaction.run(
          "UPDATE kernel_meta SET value = ?, updated_at = ? WHERE key = ?",
          "3",
          createdAt,
          "test.counter",
        );
        throw new Error("injected crash before event append");
      }),
    /injected crash before event append/,
  );
  assert.equal(
    database.readOne<{ value: string }>(
      "SELECT value FROM kernel_meta WHERE key = ?",
      "test.counter",
    )?.value,
    "1",
  );
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM events")?.count, 1);
  database.close();
});

test("mutation callbacks cannot commit around the required event append", (t) => {
  const path = temporaryDatabase(t);
  const database = openCoordinationDatabase({ path });

  assert.throws(
    () =>
      database.mutateWithEvent((transaction) => {
        transaction.run(
          "INSERT INTO kernel_meta (key, value, updated_at) VALUES (?, ?, ?)",
          "test.early-commit",
          "must-roll-back",
          "2026-08-24T12:00:00.000Z",
        );
        transaction.run("COMMIT");
        throw new Error("injected crash after forbidden commit");
      }),
    /transaction-control statement/,
  );
  assert.throws(
    () =>
      database.mutateWithEvent((transaction) => {
        transaction.run(
          "INSERT INTO kernel_meta (key, value, updated_at) VALUES (?, ?, ?)",
          "test.early-commit",
          "must-also-roll-back",
          "2026-08-24T12:00:00.000Z",
        );
        transaction.readOne("COMMIT");
        throw new Error("injected crash after read-helper commit");
      }),
    /read helper refused a mutating statement/,
  );
  assert.equal(
    database.readOne<{ value: string }>(
      "SELECT value FROM kernel_meta WHERE key = ?",
      "test.early-commit",
    ),
    undefined,
  );
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM events")?.count, 0);
  database.close();
});

test("invalid JSON payload shapes roll back both state and event", (t) => {
  const path = temporaryDatabase(t);
  const database = openCoordinationDatabase({ path });

  assert.throws(
    () =>
      database.mutateWithEvent((transaction) => {
        transaction.run(
          "INSERT INTO kernel_meta (key, value, updated_at) VALUES (?, ?, ?)",
          "test.invalid-json",
          "must-roll-back",
          "2026-08-24T12:00:00.000Z",
        );
        return {
          value: undefined,
          event: {
            type: "kernel.invalid_json_tested",
            aggregateKind: "home",
            aggregateId: generateCoordinationId("home"),
            aggregateVersion: 1,
            channelId: null,
            actorPrincipalId: "user_owner",
            requestId: generateCoordinationId("request"),
            correlationId: generateCoordinationId("correlation"),
            payload: { holes: new Array(2) },
            createdAt: "2026-08-24T12:00:00.000Z",
          },
        };
      }),
    /sparse array/,
  );
  assert.equal(
    database.readOne<{ value: string }>(
      "SELECT value FROM kernel_meta WHERE key = ?",
      "test.invalid-json",
    ),
    undefined,
  );
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM events")?.count, 0);
  database.close();
});

test("a retained transaction callback handle cannot mutate after commit", (t) => {
  const path = temporaryDatabase(t);
  const database = openCoordinationDatabase({ path });
  let retained: CoordinationTransaction | undefined;

  database.mutateWithEvent((transaction) => {
    retained = transaction;
    transaction.run(
      "INSERT INTO kernel_meta (key, value, updated_at) VALUES (?, ?, ?)",
      "test.retained-handle",
      "1",
      "2026-08-24T12:00:00.000Z",
    );
    return {
      value: undefined,
      event: {
        type: "kernel.transaction_handle_tested",
        aggregateKind: "home",
        aggregateId: generateCoordinationId("home"),
        aggregateVersion: 1,
        channelId: null,
        actorPrincipalId: "user_owner",
        requestId: generateCoordinationId("request"),
        correlationId: generateCoordinationId("correlation"),
        payload: { value: 1 },
        createdAt: "2026-08-24T12:00:00.000Z",
      },
    };
  });

  assert.throws(
    () =>
      retained?.run(
        "UPDATE kernel_meta SET value = ? WHERE key = ?",
        "2",
        "test.retained-handle",
      ),
    /transaction context is no longer active/,
  );
  assert.equal(
    database.readOne<{ value: string }>(
      "SELECT value FROM kernel_meta WHERE key = ?",
      "test.retained-handle",
    )?.value,
    "1",
  );
  assert.equal(database.readOne<{ count: number }>("SELECT count(*) AS count FROM events")?.count, 1);
  database.close();
});

test("migration checksum drift and newer schema versions fail closed", (t) => {
  const path = temporaryDatabase(t);
  openCoordinationDatabase({ path }).close();

  const tamper = new Database(path);
  tamper.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("0".repeat(64));
  tamper.close();
  assert.throws(
    () => openCoordinationDatabase({ path }),
    (error: unknown) =>
      error instanceof SchemaCompatibilityError && /checksum mismatch/.test(error.message),
  );

  const newerPath = temporaryDatabase(t);
  const newer = new Database(newerPath);
  newer.pragma(`user_version = ${COORDINATION_SCHEMA_VERSION + 1}`);
  newer.close();
  assert.throws(
    () => openCoordinationDatabase({ path: newerPath }),
    (error: unknown) =>
      error instanceof SchemaCompatibilityError && /newer schema version/.test(error.message),
  );
  const refused = new Database(newerPath, { readonly: true, fileMustExist: true });
  assert.equal(refused.pragma("journal_mode", { simple: true }), "delete");
  refused.close();

  const forgedPath = temporaryDatabase(t);
  openCoordinationDatabase({ path: forgedPath }).close();
  const forged = new Database(forgedPath);
  forged.exec("DROP TABLE events");
  forged.close();
  assert.throws(
    () => openCoordinationDatabase({ path: forgedPath }),
    (error: unknown) =>
      error instanceof SchemaCompatibilityError && /catalog checksum mismatch/.test(error.message),
  );
});
