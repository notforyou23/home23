import Database from "better-sqlite3";
import { statSync } from "node:fs";

import {
  COORDINATION_MIGRATIONS,
  COORDINATION_SCHEMA_CHECKSUM,
  COORDINATION_SCHEMA_VERSION,
} from "../migrations/index.js";

import {
  createVerifiedOnlineBackup,
  type CreateVerifiedBackupOptions,
  type VerifiedBackupReceipt,
} from "./backup.js";
import {
  rebuildCanonicalSearchIndex,
  type CanonicalSearchRebuildReceipt,
} from "./derived-projections.js";
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
  startupCheck: IntegrityCheck | "schema_only" | "schema_migration_only";
}

// Pin the one migration whose DDL changes indexes/triggers without rewriting
// existing application rows. A changed v21 migration returns to full data
// checks until its new bytes receive a separate review.
const REVIEWED_SCHEMA_ONLY_V21_CHECKSUM =
  "b231fa7def776d8c69c2ff2d601ad29d2bf4643ed8ea33140a474359ef88c0e8";

// Distinct read SQL texts in Core are static and number well under this;
// the bound only matters for a caller that builds SQL dynamically.
const READ_STATEMENT_CACHE_LIMIT = 256;

function isReviewedSchemaOnlyV21Upgrade(fromVersion: number): boolean {
  const migration = COORDINATION_MIGRATIONS[20];
  return fromVersion === 20 &&
    COORDINATION_SCHEMA_VERSION === 21 &&
    migration?.version === 21 &&
    migration.name === "notification-recovery-order" &&
    migration.checksum === REVIEWED_SCHEMA_ONLY_V21_CHECKSUM;
}

export interface CoordinationPragmaEvidence {
  journalMode: string;
  synchronous: number;
  foreignKeys: number;
  busyTimeoutMs: number;
  cacheSizeKiB: number;
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
  // SQLite's default page cache is about 2 MiB. Keep a modest working set
  // across repeated Core reads without mapping the whole database or changing
  // the WAL/durability contract. Negative cache_size is a KiB limit and is
  // connection-local, so it must be restored on every open.
  database.pragma("cache_size = -16384");
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
  private readonly readStatements = new Map<string, Database.Statement<SqliteValue[], unknown>>();
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
      // A current-schema restart already verifies the migration history, schema
      // catalog and contract metadata above. Scanning every data page here can
      // block the single Core thread for minutes on an established home.
      // A reviewed schema-only v20→v21 DDL change has the same catalog checks
      // before and after its transaction, but does not claim data-page integrity.
      // Other migrations and verified backup/restore retain full data checks.
      const schemaOnlyUpgrade = initial.needsMigration &&
        isReviewedSchemaOnlyV21Upgrade(initial.version);
      const startupCheck = initial.needsMigration
        ? (schemaOnlyUpgrade ? "schema_migration_only" : "integrity_check")
        : "schema_only";
      if (initial.needsMigration && !schemaOnlyUpgrade) {
        assertDatabaseIntegrity(database, "integrity_check");
      }
      if (initial.needsMigration) {
        migrateCoordinationSchema(
          database,
          initial.version,
          options.applicationVersion ?? "home23-coordination-m04",
          options.now ?? (() => new Date()),
        );
        if (!schemaOnlyUpgrade) assertDatabaseIntegrity(database, "integrity_check");
      }
      if (initial.needsMigration && !schemaOnlyUpgrade) assertForeignKeys(database);
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
      cacheSizeKiB: -pragmaNumber(this.database, "cache_size"),
      trustedSchema: pragmaNumber(this.database, "trusted_schema"),
      walAutoCheckpointPages: pragmaNumber(this.database, "wal_autocheckpoint"),
      lockingMode: String(this.database.pragma("locking_mode", { simple: true })),
    };
  }

  readOne<T>(sql: string, ...parameters: SqliteValue[]): T | undefined {
    return this.readStatement<T>(sql).get(...parameters);
  }

  readAll<T = Record<string, unknown>>(sql: string, ...parameters: SqliteValue[]): T[] {
    return this.readStatement<T>(sql).all(...parameters);
  }

  /** Core serves every client from one thread, so re-parsing the same read on
   * each call is measurable latency. Reads fully consume their statement with
   * get/all, which makes reuse safe; Map order doubles as recency so dynamic
   * SQL cannot grow the cache without bound. */
  private readStatement<T>(sql: string): Database.Statement<SqliteValue[], T> {
    this.assertOpen();
    const cached = this.readStatements.get(sql);
    if (cached) {
      this.readStatements.delete(sql);
      this.readStatements.set(sql, cached);
      return cached as Database.Statement<SqliteValue[], T>;
    }
    const statement = this.database.prepare<SqliteValue[], T>(sql);
    if (!statement.readonly) {
      throw new Error("coordination read helper refused a mutating statement");
    }
    this.readStatements.set(sql, statement as Database.Statement<SqliteValue[], unknown>);
    if (this.readStatements.size > READ_STATEMENT_CACHE_LIMIT) {
      this.readStatements.delete(this.readStatements.keys().next().value as string);
    }
    return statement;
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

  rebuildCanonicalSearchIndex(): CanonicalSearchRebuildReceipt {
    this.assertOpen();
    if (this.backupInProgress) {
      throw new Error("coordination search rebuild refused while backup is in progress");
    }
    return rebuildCanonicalSearchIndex(this.database);
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
    this.readStatements.clear();
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
