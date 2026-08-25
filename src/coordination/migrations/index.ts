import { createHash } from "node:crypto";

import { COORDINATION_SPINE_MIGRATION_SQL } from "./0001-coordination-spine.js";
import {
  CONNECTED_AGENTS_PRODUCT_SCHEMA_MIGRATION_SQL,
  COORDINATION_PRODUCT_SCHEMA_DEPENDENCIES,
} from "./0002-connected-agents-product-schema.js";

export { COORDINATION_PRODUCT_SCHEMA_DEPENDENCIES };

export const COORDINATION_CONTRACT_PACK_SHA256 =
  "fbc20017304aed66e579a2b95facbda6bbcf8572038f7f1c0c824423c65d6be2";

export interface CoordinationMigration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
  schemaChecksum: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function defineMigration(
  version: number,
  name: string,
  sql: string,
  checksum: string,
  schemaChecksum: string,
): CoordinationMigration {
  if (sha256(sql) !== checksum) {
    throw new Error(`coordination migration ${version} bytes differ from its checksum`);
  }
  return Object.freeze({ version, name, sql, checksum, schemaChecksum });
}

export const COORDINATION_SPINE_MIGRATION_CHECKSUM =
  "8bf1dc5525c2ea34eca64aa7ff199aa6b9f0f3516f4f3caa285977134db2b4ee";

export const COORDINATION_PRODUCT_SCHEMA_MIGRATION_CHECKSUM =
  "40fd7ba924885a25a1ca28025d9dc907540f908dd72f1ce7e7636b1944628c2f";

export const COORDINATION_MIGRATIONS = Object.freeze([
  defineMigration(
    1,
    "coordination-spine",
    COORDINATION_SPINE_MIGRATION_SQL,
    COORDINATION_SPINE_MIGRATION_CHECKSUM,
    "0ce5eee85db7fe852a6e5ef970cf81d2bbc90352cd8bf4b5e09d3d02991c7dc9",
  ),
  defineMigration(
    2,
    "connected-agents-product-schema",
    CONNECTED_AGENTS_PRODUCT_SCHEMA_MIGRATION_SQL,
    COORDINATION_PRODUCT_SCHEMA_MIGRATION_CHECKSUM,
    "47c9045f580a020bce91d7ea64f572c7f88dc08532ff29b6f7601fdab23428a4",
  ),
]);

export const COORDINATION_SCHEMA_VERSION =
  COORDINATION_MIGRATIONS[COORDINATION_MIGRATIONS.length - 1]?.version ?? 0;

export function computeCoordinationMigrationPlanChecksum(
  migrations: readonly CoordinationMigration[] = COORDINATION_MIGRATIONS,
): string {
  const hash = createHash("sha256");
  migrations.forEach((migration, index) => {
    if (index > 0) hash.update("\n-- home23 coordination migration boundary --\n");
    hash.update(migration.sql, "utf8");
  });
  return hash.digest("hex");
}

// Reviewed with the immutable migration bytes. A historical migration edit
// must fail before any database is opened.
export const COORDINATION_MIGRATION_PLAN_CHECKSUM =
  "cc63f92d1645ec370e344664a1ebda996f47d5a0c16c69bbdce26cdf37c63bac";

if (computeCoordinationMigrationPlanChecksum() !== COORDINATION_MIGRATION_PLAN_CHECKSUM) {
  throw new Error("coordination migration bytes differ from the reviewed migration checksum");
}

export const COORDINATION_SCHEMA_CHECKSUM =
  COORDINATION_MIGRATIONS[COORDINATION_MIGRATIONS.length - 1]?.schemaChecksum ?? "";
