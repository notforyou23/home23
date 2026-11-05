import type Database from "better-sqlite3";

import { DatabaseIntegrityError } from "./errors.js";

export type IntegrityCheck = "quick_check" | "integrity_check";

function checkRows(database: Database.Database, check: IntegrityCheck): string[] {
  const rows = database.pragma(check) as Array<Record<string, unknown>>;
  return rows.map((row) => String(row[check]));
}

export function assertDatabaseIntegrity(
  database: Database.Database,
  check: IntegrityCheck,
): void {
  const results = checkRows(database, check);
  if (results.length !== 1 || results[0] !== "ok") {
    throw new DatabaseIntegrityError(`${check} failed: ${results.join("; ") || "no result"}`);
  }
}

export function assertForeignKeys(database: Database.Database): void {
  const failures = database.pragma("foreign_key_check") as Array<Record<string, unknown>>;
  if (failures.length > 0) {
    throw new DatabaseIntegrityError(
      `foreign_key_check failed with ${failures.length} violation(s)`,
    );
  }
}
