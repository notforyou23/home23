import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import {
  COORDINATION_CONTRACT_PACK_SHA256,
  COORDINATION_MIGRATIONS,
  COORDINATION_SCHEMA_CHECKSUM,
  COORDINATION_SCHEMA_VERSION,
  type CoordinationMigration,
} from "../migrations/index.js";
import { CONNECTED_AGENTS_CONTRACT_VERSION } from "../schema/contract-registry.js";

import { SchemaCompatibilityError } from "./errors.js";

interface MigrationRow {
  version: number;
  name: string;
  checksum: string;
}

interface MetaRow {
  key: string;
  value: string;
}

interface SchemaCatalogRow {
  type: string;
  name: string;
  tableName: string;
  sql: string;
}

export interface SchemaInspection {
  version: number;
  needsMigration: boolean;
}

function userVersion(database: Database.Database): number {
  return Number(database.pragma("user_version", { simple: true }));
}

function hasTable(database: Database.Database, name: string): boolean {
  return Boolean(
    database
      .prepare<[string], { present: number }>(
        "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?",
      )
      .get(name),
  );
}

function applicationTables(database: Database.Database): string[] {
  return database
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

function expectedMigration(version: number): CoordinationMigration | undefined {
  return COORDINATION_MIGRATIONS.find((migration) => migration.version === version);
}

function schemaChecksumFor(version: number): string {
  const migration = expectedMigration(version);
  if (!migration) {
    throw new SchemaCompatibilityError(
      `coordination schema version ${version} has no checksum in this binary`,
    );
  }
  return migration.schemaChecksum;
}

function schemaCatalogChecksum(database: Database.Database): string {
  const rows = database
    .prepare<[], SchemaCatalogRow>(
      "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema " +
        "WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name",
    )
    .all();
  return createHash("sha256").update(JSON.stringify(rows), "utf8").digest("hex");
}

function assertSchemaCatalog(database: Database.Database, version: number): void {
  const actual = schemaCatalogChecksum(database);
  const expected = schemaChecksumFor(version);
  if (actual !== expected) {
    throw new SchemaCompatibilityError(
      `coordination schema catalog checksum mismatch for version ${version}`,
    );
  }
}

function assertMigrationRows(database: Database.Database, version: number): void {
  const rows = database
    .prepare<[], MigrationRow>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    )
    .all();
  if (rows.length !== version) {
    throw new SchemaCompatibilityError(
      `coordination schema migration history is not contiguous through version ${version}`,
    );
  }
  rows.forEach((row, index) => {
    const expectedVersion = index + 1;
    const expected = expectedMigration(expectedVersion);
    if (!expected || row.version !== expectedVersion || row.name !== expected.name) {
      throw new SchemaCompatibilityError(
        `coordination schema migration ${row.version} is incompatible with this binary`,
      );
    }
    if (row.checksum !== expected.checksum) {
      throw new SchemaCompatibilityError(
        `coordination schema migration ${row.version} checksum mismatch`,
      );
    }
  });
}

function assertKernelMeta(database: Database.Database, version: number): void {
  if (!hasTable(database, "kernel_meta")) {
    throw new SchemaCompatibilityError("coordination schema is missing kernel_meta");
  }
  const rows = database
    .prepare<[string, string, string, string], MetaRow>(
      "SELECT key, value FROM kernel_meta WHERE key IN (?, ?, ?, ?)",
    )
    .all(
      "schema.version",
      "schema.checksum",
      "contract.version",
      "contract.pack_sha256",
    );
  const meta = new Map(rows.map((row) => [row.key, row.value]));
  const expected = new Map<string, string>([
    ["schema.version", String(version)],
    ["schema.checksum", schemaChecksumFor(version)],
    ["contract.version", String(CONNECTED_AGENTS_CONTRACT_VERSION)],
    ["contract.pack_sha256", COORDINATION_CONTRACT_PACK_SHA256],
  ]);
  for (const [key, value] of expected) {
    if (meta.get(key) !== value) {
      throw new SchemaCompatibilityError(`coordination ${key} mismatch`);
    }
  }
}

export function inspectCoordinationSchema(
  database: Database.Database,
): SchemaInspection {
  const declaredVersion = userVersion(database);
  if (declaredVersion > COORDINATION_SCHEMA_VERSION) {
    throw new SchemaCompatibilityError(
      `coordination database has newer schema version ${declaredVersion}; binary supports ${COORDINATION_SCHEMA_VERSION}`,
    );
  }

  if (!hasTable(database, "schema_migrations")) {
    const tables = applicationTables(database);
    if (declaredVersion !== 0 || tables.length > 0) {
      throw new SchemaCompatibilityError(
        "coordination database has an incompatible unversioned schema",
      );
    }
    return { version: 0, needsMigration: COORDINATION_SCHEMA_VERSION > 0 };
  }

  const row = database
    .prepare<[], { version: number | null }>(
      "SELECT max(version) AS version FROM schema_migrations",
    )
    .get();
  const recordedVersion = Number(row?.version ?? 0);
  if (recordedVersion === 0) {
    throw new SchemaCompatibilityError(
      "coordination schema_migrations exists without an applied migration",
    );
  }
  if (recordedVersion > COORDINATION_SCHEMA_VERSION) {
    throw new SchemaCompatibilityError(
      `coordination database has newer schema version ${recordedVersion}; binary supports ${COORDINATION_SCHEMA_VERSION}`,
    );
  }
  if (recordedVersion !== declaredVersion) {
    throw new SchemaCompatibilityError(
      `coordination user_version ${declaredVersion} differs from migration version ${recordedVersion}`,
    );
  }
  assertMigrationRows(database, recordedVersion);
  assertSchemaCatalog(database, recordedVersion);
  assertKernelMeta(database, recordedVersion);
  return {
    version: recordedVersion,
    needsMigration: recordedVersion < COORDINATION_SCHEMA_VERSION,
  };
}

export function migrateCoordinationSchema(
  database: Database.Database,
  fromVersion: number,
  applicationVersion: string,
  now: () => Date,
): void {
  for (const migration of COORDINATION_MIGRATIONS) {
    if (migration.version <= fromVersion) continue;
    if (migration.version !== fromVersion + 1) {
      throw new SchemaCompatibilityError(
        `coordination migration ${migration.version} does not follow ${fromVersion}`,
      );
    }
    const apply = database.transaction(() => {
      database.exec(migration.sql);
      const appliedAt = now().toISOString();
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at, application_version) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          migration.version,
          migration.name,
          migration.checksum,
          appliedAt,
          applicationVersion,
        );
      const metadata = [
        ["schema.version", String(migration.version)],
        ["schema.checksum", migration.schemaChecksum],
        ["contract.version", String(CONNECTED_AGENTS_CONTRACT_VERSION)],
        ["contract.pack_sha256", COORDINATION_CONTRACT_PACK_SHA256],
      ] as const;
      const writeMeta = database.prepare(
        "INSERT INTO kernel_meta (key, value, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      );
      for (const [key, value] of metadata) writeMeta.run(key, value, appliedAt);
      database.pragma(`user_version = ${migration.version}`);
      assertSchemaCatalog(database, migration.version);
    });
    apply.immediate();
    fromVersion = migration.version;
  }

  const inspection = inspectCoordinationSchema(database);
  if (inspection.version !== COORDINATION_SCHEMA_VERSION || inspection.needsMigration) {
    throw new SchemaCompatibilityError("coordination schema did not reach the current version");
  }
  if (COORDINATION_SCHEMA_CHECKSUM !== schemaChecksumFor(COORDINATION_SCHEMA_VERSION)) {
    throw new SchemaCompatibilityError("coordination binary schema checksum is internally inconsistent");
  }
}
