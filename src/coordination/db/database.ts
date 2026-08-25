import Database from "better-sqlite3";
import { statSync } from "node:fs";

import {
  COORDINATION_SCHEMA_CHECKSUM,
  COORDINATION_SCHEMA_VERSION,
} from "../migrations/index.js";

import {
  createVerifiedOnlineBackup,
  type CreateVerifiedBackupOptions,
  type VerifiedBackupReceipt,
} from "./backup.js";
import { CoordinationWriterBusyError } from "./errors.js";
import {
  assertDatabaseIntegrity,
  assertForeignKeys,
  type IntegrityCheck,
} from "./integrity.js";
import {
  inspectCoordinationSchema,
  migrateCoordinationSchema,
} from "./migration-engine.js";
import {
  runMutationWithEvent,
  type CoordinationMutation,
  type CoordinationMutationResult,
  type CoordinationTransaction,
  type SqliteValue,
} from "./transaction.js";

export interface OpenCoordinationDatabaseOptions {
  path: string;
  applicationVersion?: string;
  now?: () => Date;
}

export interface CoordinationDatabaseOpenReceipt {
  schemaVersion: number;
  schemaChecksum: string;
  migratedFrom: number;
  startupCheck: IntegrityCheck;
}

export interface CoordinationPragmaEvidence {
  journalMode: string;
  synchronous: number;
  foreignKeys: number;
  busyTimeoutMs: number;
  trustedSchema: number;
  walAutoCheckpointPages: number;
  lockingMode: string;
}

function isBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")
  );
}

function pragmaNumber(database: Database.Database, name: string): number {
  return Number(database.pragma(name, { simple: true }));
}

function configureAndAcquireWriter(database: Database.Database): void {
  const journalMode = String(database.pragma("journal_mode = WAL", { simple: true }));
  if (journalMode.toLowerCase() !== "wal") {
    throw new Error(`coordination database refused WAL mode: ${journalMode}`);
  }
  const lockingMode = String(database.pragma("locking_mode = EXCLUSIVE", { simple: true }));
  if (lockingMode.toLowerCase() !== "exclusive") {
    throw new Error(`coordination database refused exclusive writer mode: ${lockingMode}`);
  }
  database.exec("BEGIN EXCLUSIVE; COMMIT;");
  database.pragma("synchronous = FULL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("trusted_schema = OFF");
  database.pragma("wal_autocheckpoint = 1000");
}

function preflightExistingSchema(path: string): void {
  try {
    if (statSync(path).size === 0) return;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const preflight = new Database(path, {
    readonly: true,
    fileMustExist: true,
    timeout: 0,
  });
  try {
    preflight.pragma("trusted_schema = OFF");
    preflight.pragma("query_only = ON");
    inspectCoordinationSchema(preflight);
  } finally {
    preflight.close();
  }
}

export class CoordinationDatabase {
  readonly path: string;
  readonly openReceipt: CoordinationDatabaseOpenReceipt;
  private readonly database: Database.Database;
  private backupInProgress = false;

  constructor(options: OpenCoordinationDatabaseOptions) {
    if (!options.path || options.path === ":memory:") {
      throw new Error("coordination database requires a durable filesystem path");
    }
    this.path = options.path;
    let database: Database.Database | undefined;
    try {
      preflightExistingSchema(options.path);
      database = new Database(options.path, { timeout: 0 });
      configureAndAcquireWriter(database);
      const initial = inspectCoordinationSchema(database);
      const startupCheck: IntegrityCheck = initial.needsMigration
        ? "integrity_check"
        : "quick_check";
      assertDatabaseIntegrity(database, startupCheck);
      if (initial.needsMigration) {
        migrateCoordinationSchema(
          database,
          initial.version,
          options.applicationVersion ?? "home23-coordination-m04",
          options.now ?? (() => new Date()),
        );
        assertDatabaseIntegrity(database, "integrity_check");
      }
      assertForeignKeys(database);
      this.database = database;
      this.openReceipt = Object.freeze({
        schemaVersion: COORDINATION_SCHEMA_VERSION,
        schemaChecksum: COORDINATION_SCHEMA_CHECKSUM,
        migratedFrom: initial.version,
        startupCheck,
      });
    } catch (error) {
      if (database?.open) database.close();
      if (isBusy(error)) throw new CoordinationWriterBusyError(options.path);
      throw error;
    }
  }

  pragmaEvidence(): CoordinationPragmaEvidence {
    this.assertOpen();
    return {
      journalMode: String(this.database.pragma("journal_mode", { simple: true })),
      synchronous: pragmaNumber(this.database, "synchronous"),
      foreignKeys: pragmaNumber(this.database, "foreign_keys"),
      busyTimeoutMs: pragmaNumber(this.database, "busy_timeout"),
      trustedSchema: pragmaNumber(this.database, "trusted_schema"),
      walAutoCheckpointPages: pragmaNumber(this.database, "wal_autocheckpoint"),
      lockingMode: String(this.database.pragma("locking_mode", { simple: true })),
    };
  }

  readOne<T>(sql: string, ...parameters: SqliteValue[]): T | undefined {
    this.assertOpen();
    const statement = this.database.prepare<SqliteValue[], T>(sql);
    if (!statement.readonly) {
      throw new Error("coordination read helper refused a mutating statement");
    }
    return statement.get(...parameters);
  }

  readAll<T = Record<string, unknown>>(sql: string, ...parameters: SqliteValue[]): T[] {
    this.assertOpen();
    const statement = this.database.prepare<SqliteValue[], T>(sql);
    if (!statement.readonly) {
      throw new Error("coordination read helper refused a mutating statement");
    }
    return statement.all(...parameters);
  }

  mutateWithEvent<T>(
    mutate: (transaction: CoordinationTransaction) => CoordinationMutation<T>,
  ): CoordinationMutationResult<T> {
    this.assertOpen();
    if (this.backupInProgress) {
      throw new Error("coordination database mutation refused while backup is in progress");
    }
    return runMutationWithEvent(this.database, mutate);
  }

  async createVerifiedBackup(
    options: CreateVerifiedBackupOptions,
  ): Promise<VerifiedBackupReceipt> {
    this.assertOpen();
    if (this.backupInProgress) {
      throw new Error("coordination database backup is already in progress");
    }
    this.backupInProgress = true;
    try {
      return await createVerifiedOnlineBackup(this.database, options);
    } finally {
      this.backupInProgress = false;
    }
  }

  close(): void {
    if (this.backupInProgress) {
      throw new Error("coordination database cannot close while backup is in progress");
    }
    if (this.database.open) this.database.close();
  }

  private assertOpen(): void {
    if (!this.database.open) throw new Error("coordination database is closed");
  }
}

export function openCoordinationDatabase(
  options: OpenCoordinationDatabaseOptions,
): CoordinationDatabase {
  return new CoordinationDatabase(options);
}
