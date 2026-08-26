import { createHash } from "node:crypto";

import { COORDINATION_SPINE_MIGRATION_SQL } from "./0001-coordination-spine.js";
import {
  CONNECTED_AGENTS_PRODUCT_SCHEMA_MIGRATION_SQL,
  COORDINATION_PRODUCT_SCHEMA_DEPENDENCIES,
} from "./0002-connected-agents-product-schema.js";
import {
  COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES,
  SEARCH_ATTACHMENT_SCHEMA_MIGRATION_SQL,
} from "./0003-search-and-attachment-schema.js";
import { ATOMIC_IMPORT_LEDGER_MIGRATION_SQL } from "./0004-atomic-import-ledger.js";
import { ATTACHMENT_CREATE_IDEMPOTENCY_MIGRATION_SQL } from "./0005-attachment-create-idempotency.js";
import { WORK_LIFECYCLE_SCHEMA_MIGRATION_SQL } from "./0006-work-lifecycle-schema.js";
import { WORK_PRODUCT_CONTROLS_MIGRATION_SQL } from "./0007-work-product-controls.js";

export {
  COORDINATION_PRODUCT_SCHEMA_DEPENDENCIES,
  COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES,
};

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

export const COORDINATION_SEARCH_ATTACHMENT_MIGRATION_CHECKSUM =
  "7176274402321c6f3e295cc3bfabbc6c9ffa2304304855334f9be31a2356da1e";

export const COORDINATION_ATOMIC_IMPORT_MIGRATION_CHECKSUM =
  "9a39082801195d0eacb60ee9fadd36a85654e5150f035c2989a3a710bb3b80db";

export const COORDINATION_ATTACHMENT_IDEMPOTENCY_MIGRATION_CHECKSUM =
  "0f59653d21c1950164b7a16f3a83c9be0b5b4b3295e77ceb22151a4d651fc536";
export const COORDINATION_WORK_LIFECYCLE_MIGRATION_CHECKSUM =
  "c689c752ef911d9d067a60a02f368a6860a78f37483ff53fc1c0fe43c6afde22";
export const COORDINATION_WORK_PRODUCT_CONTROLS_MIGRATION_CHECKSUM =
  "0e2da9e13c9a7e67c0f3e44a89049a6314e050d9fe530cba3cdb041dc4c67b7a";

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
  defineMigration(
    3,
    "search-and-attachment-schema",
    SEARCH_ATTACHMENT_SCHEMA_MIGRATION_SQL,
    COORDINATION_SEARCH_ATTACHMENT_MIGRATION_CHECKSUM,
    "ddac2fb83bf73837f5200725697eff7d55a685f18a6c144fc33df17b75f113c2",
  ),
  defineMigration(
    4,
    "atomic-import-ledger",
    ATOMIC_IMPORT_LEDGER_MIGRATION_SQL,
    COORDINATION_ATOMIC_IMPORT_MIGRATION_CHECKSUM,
    "616c33ae48234d90acaf18fe49e3c9f6029204b7082d4d9c9dd8dfc5703d7608",
  ),
  defineMigration(
    5,
    "attachment-create-idempotency",
    ATTACHMENT_CREATE_IDEMPOTENCY_MIGRATION_SQL,
    COORDINATION_ATTACHMENT_IDEMPOTENCY_MIGRATION_CHECKSUM,
    "5f2eba4c6abc23f455188c88c3cad352fd31ee708458aa229e2b7da89f65f69d",
  ),
  defineMigration(
    6,
    "work-lifecycle-schema",
    WORK_LIFECYCLE_SCHEMA_MIGRATION_SQL,
    COORDINATION_WORK_LIFECYCLE_MIGRATION_CHECKSUM,
    "d6756d02f03d7bb4b9a3887b9de6e4d969942ecde40f9dc9fb6c128b10d4ea1e",
  ),
  defineMigration(
    7,
    "work-product-controls",
    WORK_PRODUCT_CONTROLS_MIGRATION_SQL,
    COORDINATION_WORK_PRODUCT_CONTROLS_MIGRATION_CHECKSUM,
    "770dfe1f6d418d3958c3158c843050d90724bba4641e0018a6312da51054f9b9",
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
  "33a4ae72fadadfd0af3923998bce799238fb2cc97f611d8ac1790ed9b1be96f5";

if (computeCoordinationMigrationPlanChecksum() !== COORDINATION_MIGRATION_PLAN_CHECKSUM) {
  throw new Error("coordination migration bytes differ from the reviewed migration checksum");
}

export const COORDINATION_SCHEMA_CHECKSUM =
  COORDINATION_MIGRATIONS[COORDINATION_MIGRATIONS.length - 1]?.schemaChecksum ?? "";
