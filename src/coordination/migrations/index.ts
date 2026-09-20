import { ARTIFACT_GENERAL_FILES_MIGRATION_SQL } from "./0016-artifact-general-files.js";
import { NATIVE_CHESS_MIGRATION_SQL } from "./0017-native-chess.js";
import { WORK_OUTCOME_INDEXES_MIGRATION_SQL } from "./0018-work-outcome-indexes.js";
import { INBOX_RECONCILIATION_INDEXES_MIGRATION_SQL } from "./0019-inbox-and-reconciliation-indexes.js";
import { EVENT_RETENTION_COUNT_MIGRATION_SQL } from './0015-event-retention-count.js';
import { RESIDENT_OUTCOMES_MIGRATION_SQL } from './0014-resident-outcomes.js';
import { PLANNED_INVOCATIONS_MIGRATION_SQL } from './0013-planned-invocations.js';
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
import { COMMUNICATION_EVIDENCE_INDEX_MIGRATION_SQL } from "./0008-communication-evidence-indexes.js";
import { WORK_TURN_SELECTION_MIGRATION_SQL } from "./0009-work-turn-selection.js";
import { BOT_LIFECYCLE_RECEIPTS_MIGRATION_SQL } from "./0010-bot-lifecycle-receipts.js";
import { ARTIFACT_AUDIO_MPEG_MIGRATION_SQL } from "./0011-artifact-audio-mpeg.js";
import { WORK_THREAD_PRESENTATION_MIGRATION_SQL } from "./0012-work-thread-presentation.js";

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
export const COORDINATION_COMMUNICATION_EVIDENCE_MIGRATION_CHECKSUM =
  "74f89ae90cfb730d0b0ca3ee8cff8a87d994cb566f7f8285d7f501a4d5ccd068";
export const COORDINATION_WORK_TURN_SELECTION_MIGRATION_CHECKSUM =
  "ff938ea71ba5fbfd131586817a218f7ee14e735cac97ab49f36dbedb40ea963b";
export const COORDINATION_BOT_LIFECYCLE_RECEIPTS_MIGRATION_CHECKSUM =
  "9c379eaaee0f77abec1a58eeea6b9aaf5b1253cc97da9f477dbe40222c1d5caf";
export const COORDINATION_ARTIFACT_AUDIO_MPEG_MIGRATION_CHECKSUM =
  "006ce2f43d7ba2248d11ce2494753ffa430cb7e277b6c246a4aadd8c37fb8849";
export const COORDINATION_WORK_THREAD_PRESENTATION_MIGRATION_CHECKSUM =
  "53e51e284a48e8f8563cfcab602905652c134ad5d517a90ca8b3b91600e045f3";

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
  defineMigration(
    8,
    "communication-evidence-indexes",
    COMMUNICATION_EVIDENCE_INDEX_MIGRATION_SQL,
    COORDINATION_COMMUNICATION_EVIDENCE_MIGRATION_CHECKSUM,
    "2219d7ac48779fc2d80895c13d17b01eac218a90eb2db1a0b6be86eac2c65a03",
  ),
  defineMigration(
    9,
    "work-turn-selection",
    WORK_TURN_SELECTION_MIGRATION_SQL,
    COORDINATION_WORK_TURN_SELECTION_MIGRATION_CHECKSUM,
    "35949780e04192606ef8615198e3462e4a3d3f8e0a016749e827be4d13e6cdfc",
  ),
  defineMigration(
    10,
    "bot-lifecycle-receipts",
    BOT_LIFECYCLE_RECEIPTS_MIGRATION_SQL,
    COORDINATION_BOT_LIFECYCLE_RECEIPTS_MIGRATION_CHECKSUM,
    "748f660e3ccc8b9a13ebd2c0be9ff4bc8f4add027335a355d776e25784969c04",
  ),
  defineMigration(
    11,
    "artifact-audio-mpeg",
    ARTIFACT_AUDIO_MPEG_MIGRATION_SQL,
    COORDINATION_ARTIFACT_AUDIO_MPEG_MIGRATION_CHECKSUM,
    "e594c19ea7b748ef47e3654ffdbfc2809819f269dc6429a429696e46eba43f7b",
  ),
  defineMigration(
    12,
    "work-thread-presentation",
    WORK_THREAD_PRESENTATION_MIGRATION_SQL,
    COORDINATION_WORK_THREAD_PRESENTATION_MIGRATION_CHECKSUM,
    "54e726056cadfb273477f7925b8d94969f42ff40839495e24c811ebb1537b475",
  ),
  defineMigration(13, 'planned-invocations', PLANNED_INVOCATIONS_MIGRATION_SQL, '415a67e278c9e42503293ec32bfedb5c9e5a6c1f942489fdd212ef09e9a334c1', '06f23d074a6a7937b8daef6f544154d4d1cb2148d36ee92ef131fde86b22d972'),
  defineMigration(14, 'resident-outcomes', RESIDENT_OUTCOMES_MIGRATION_SQL, '726089aaa4cf18a3d8285e54e52df5ce6b4ffddf1d8aac3fe13d95a7fe222c42', '6ed74df1e2f0f29e8b707905b6d863469f23b49966ebe7587b47856814638e89'),
  defineMigration(15, 'event-retention-count', EVENT_RETENTION_COUNT_MIGRATION_SQL, 'ad7ee2e588c159d64df0f955a03c221fc85cc598603a03b4c6f459aa2eff0123', '31ecd08c0414e273df1e4a80232fef7928e0ebb305d0e9635e90c833a3baf763'),
  defineMigration(16, 'artifact-general-files', ARTIFACT_GENERAL_FILES_MIGRATION_SQL, '5e8a2aa8840efb060a0f630c8dc4cf5a7ea5a2e1536fc2610053d5ef29494752', 'dd8cddcd3bb1883499a6f03723de3113d3f27f0d297fa2b4a11cd1e3254fd6e0'),
  defineMigration(17, 'native-chess', NATIVE_CHESS_MIGRATION_SQL, 'a80592694cac6e666e866bbf2c32518b0dcc0a2bf1e301611e59cee8b997046b', 'f233967dee0435a0685bc6a2d1bc206eeec96fc9aedd872ef322b23c9a99dab9'),
  defineMigration(18, 'work-outcome-indexes', WORK_OUTCOME_INDEXES_MIGRATION_SQL, 'bb32ab88f8aea9728cd96a0e091560358a0579d888c2c9c1a88823ee7dddb2e9', 'd6d6e15d61b86093e7b993e2de76dd7d99dff47f49d0644cb51c3b72020a12a8'),
  defineMigration(19, 'inbox-and-reconciliation-indexes', INBOX_RECONCILIATION_INDEXES_MIGRATION_SQL, 'df58e0a3beedf3a7aec735f0e9a5d9f1c2caa2b1c027a00bea4071411ca64275', 'bd0798cf6439403133937130f2efc2eabc586552ebc0cfd545c742fc057d02d1'),
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
  "2a232f392025fd4d1851ef8bdb45a39bd72698b20d45e4857ec214dbe973c493";

if (computeCoordinationMigrationPlanChecksum() !== COORDINATION_MIGRATION_PLAN_CHECKSUM) {
  throw new Error("coordination migration bytes differ from the reviewed migration checksum");
}

export const COORDINATION_SCHEMA_CHECKSUM =
  COORDINATION_MIGRATIONS[COORDINATION_MIGRATIONS.length - 1]?.schemaChecksum ?? "";
