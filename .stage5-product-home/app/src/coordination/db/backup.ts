import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync,
} from "node:fs";

import Database from "better-sqlite3";

import {
  COORDINATION_SCHEMA_CHECKSUM,
  COORDINATION_SCHEMA_VERSION,
} from "../migrations/index.js";

import { assertDatabaseIntegrity, assertForeignKeys } from "./integrity.js";
import { inspectCoordinationSchema } from "./migration-engine.js";

export interface CreateVerifiedBackupOptions {
  path: string;
  manifestPath?: string;
}

export interface VerifiedBackupReceipt {
  path: string;
  manifestPath: string;
  sha256: string;
  byteLength: number;
  schemaVersion: number;
  schemaChecksum: string;
  eventSequence: number;
  integrityCheck: "quick_check";
}

export interface RestoreVerifiedBackupOptions {
  backupPath: string;
  destinationPath: string;
  manifestPath?: string;
  expectedSha256?: string;
}

export interface VerifiedRestoreReceipt {
  backupPath: string;
  destinationPath: string;
  sourceSha256: string;
  destinationSha256: string;
  schemaVersion: number;
  schemaChecksum: string;
  eventSequence: number;
  integrityCheck: "integrity_check";
}

interface BackupManifest {
  database: {
    sha256: string;
    byteLength: number;
  };
  schema: {
    version: number;
    checksum: string;
  };
  eventSequence: number;
}

interface SnapshotInspection {
  eventSequence: number;
}

interface StagedSnapshot {
  path: string;
  sha256: string;
  byteLength: number;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function reserveFile(path: string): void {
  const descriptor = openSync(path, "wx", 0o600);
  closeSync(descriptor);
}

function inspectOpenSnapshot(
  database: Database.Database,
  check: "quick_check" | "integrity_check",
): SnapshotInspection {
  database.pragma("trusted_schema = OFF");
  database.pragma("foreign_keys = ON");
  const schema = inspectCoordinationSchema(database);
  if (schema.needsMigration || schema.version !== COORDINATION_SCHEMA_VERSION) {
    throw new Error(
      `snapshot schema ${schema.version} is not current version ${COORDINATION_SCHEMA_VERSION}`,
    );
  }
  assertDatabaseIntegrity(database, check);
  assertForeignKeys(database);
  const row = database
    .prepare<[], { sequence: number }>(
      "SELECT coalesce(max(sequence), 0) AS sequence FROM events",
    )
    .get();
  const eventSequence = Number(row?.sequence ?? 0);
  if (!Number.isSafeInteger(eventSequence) || eventSequence < 0) {
    throw new Error("snapshot event sequence is outside the safe integer range");
  }
  return { eventSequence };
}

function inspectSnapshot(
  path: string,
  check: "quick_check" | "integrity_check",
): SnapshotInspection {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return inspectOpenSnapshot(database, check);
  } finally {
    database.close();
  }
}

function stageSnapshotFromStableHandle(
  sourcePath: string,
  destinationPath: string,
): StagedSnapshot {
  const stagePath = `${destinationPath}.restore-source-${randomBytes(8).toString("hex")}`;
  let sourceDescriptor: number | undefined;
  let stageDescriptor: number | undefined;
  try {
    sourceDescriptor = openSync(
      sourcePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const sourceStat = fstatSync(sourceDescriptor);
    if (!sourceStat.isFile()) throw new Error("backup source is not a regular file");
    stageDescriptor = openSync(stagePath, "wx", 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let byteLength = 0;
    while (true) {
      const bytesRead = readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        written += writeSync(
          stageDescriptor,
          buffer,
          written,
          bytesRead - written,
          null,
        );
      }
      byteLength += bytesRead;
    }
    fsyncSync(stageDescriptor);
    return { path: stagePath, sha256: hash.digest("hex"), byteLength };
  } catch (error) {
    rmSync(stagePath, { force: true });
    throw error;
  } finally {
    if (stageDescriptor !== undefined) closeSync(stageDescriptor);
    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);
  }
}

function parseManifest(path: string): BackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`backup manifest is unreadable: ${(error as Error).message}`);
  }
  if (!value || typeof value !== "object") throw new Error("backup manifest is invalid");
  const manifest = value as Partial<BackupManifest>;
  if (
    !manifest.database ||
    !/^[0-9a-f]{64}$/.test(manifest.database.sha256 ?? "") ||
    !Number.isSafeInteger(manifest.database.byteLength) ||
    !manifest.schema ||
    manifest.schema.version !== COORDINATION_SCHEMA_VERSION ||
    manifest.schema.checksum !== COORDINATION_SCHEMA_CHECKSUM ||
    !Number.isSafeInteger(manifest.eventSequence) ||
    (manifest.eventSequence ?? -1) < 0
  ) {
    throw new Error("backup manifest is invalid or incompatible");
  }
  return manifest as BackupManifest;
}

export async function createVerifiedOnlineBackup(
  database: Database.Database,
  options: CreateVerifiedBackupOptions,
): Promise<VerifiedBackupReceipt> {
  const manifestPath = options.manifestPath ?? `${options.path}.manifest.json`;
  if (manifestPath === options.path) {
    throw new Error("backup database and manifest paths must differ");
  }
  let backupReserved = false;
  let manifestReserved = false;
  try {
    reserveFile(options.path);
    backupReserved = true;
    await database.backup(options.path);
    const inspection = inspectSnapshot(options.path, "quick_check");
    const sha256 = await sha256File(options.path);
    const byteLength = statSync(options.path).size;
    const manifest: BackupManifest = {
      database: { sha256, byteLength },
      schema: {
        version: COORDINATION_SCHEMA_VERSION,
        checksum: COORDINATION_SCHEMA_CHECKSUM,
      },
      eventSequence: inspection.eventSequence,
    };
    const manifestDescriptor = openSync(manifestPath, "wx", 0o600);
    manifestReserved = true;
    try {
      writeFileSync(manifestDescriptor, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      fsyncSync(manifestDescriptor);
    } finally {
      closeSync(manifestDescriptor);
    }
    return {
      path: options.path,
      manifestPath,
      sha256,
      byteLength,
      schemaVersion: COORDINATION_SCHEMA_VERSION,
      schemaChecksum: COORDINATION_SCHEMA_CHECKSUM,
      eventSequence: inspection.eventSequence,
      integrityCheck: "quick_check",
    };
  } catch (error) {
    if (manifestReserved) rmSync(manifestPath, { force: true });
    if (backupReserved) rmSync(options.path, { force: true });
    throw error;
  }
}

export async function restoreVerifiedBackup(
  options: RestoreVerifiedBackupOptions,
): Promise<VerifiedRestoreReceipt> {
  if (options.backupPath === options.destinationPath) {
    throw new Error("backup and restore destination paths must differ");
  }
  const manifestPath = options.manifestPath ?? `${options.backupPath}.manifest.json`;
  const manifest = parseManifest(manifestPath);
  const staged = stageSnapshotFromStableHandle(
    options.backupPath,
    options.destinationPath,
  );
  const sourceSha256 = staged.sha256;
  if (sourceSha256 !== manifest.database.sha256) {
    rmSync(staged.path, { force: true });
    throw new Error("backup digest does not match its manifest");
  }
  if (options.expectedSha256 && sourceSha256 !== options.expectedSha256) {
    rmSync(staged.path, { force: true });
    throw new Error("backup digest mismatch");
  }
  if (staged.byteLength !== manifest.database.byteLength) {
    rmSync(staged.path, { force: true });
    throw new Error("backup byte length does not match its manifest");
  }

  let destinationReserved = false;
  let source: Database.Database | undefined;
  try {
    source = new Database(staged.path, {
      readonly: true,
      fileMustExist: true,
    });
    const sourceInspection = inspectOpenSnapshot(source, "integrity_check");
    if (sourceInspection.eventSequence !== manifest.eventSequence) {
      throw new Error("backup event sequence does not match its manifest");
    }
    reserveFile(options.destinationPath);
    destinationReserved = true;
    await source.backup(options.destinationPath);
    const destinationInspection = inspectSnapshot(
      options.destinationPath,
      "integrity_check",
    );
    if (destinationInspection.eventSequence !== sourceInspection.eventSequence) {
      throw new Error("restored event sequence differs from the verified backup");
    }
    const destinationSha256 = await sha256File(options.destinationPath);
    if (destinationSha256 !== sourceSha256) {
      throw new Error("restored database digest differs from the verified backup");
    }
    return {
      backupPath: options.backupPath,
      destinationPath: options.destinationPath,
      sourceSha256,
      destinationSha256,
      schemaVersion: COORDINATION_SCHEMA_VERSION,
      schemaChecksum: COORDINATION_SCHEMA_CHECKSUM,
      eventSequence: destinationInspection.eventSequence,
      integrityCheck: "integrity_check",
    };
  } catch (error) {
    if (destinationReserved) rmSync(options.destinationPath, { force: true });
    throw error;
  } finally {
    if (source?.open) source.close();
    rmSync(staged.path, { force: true });
  }
}
