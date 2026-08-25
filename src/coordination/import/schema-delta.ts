import { canonicalJson, deepFreeze, sha256 } from "./canonical.js";
import { COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES } from "../migrations/index.js";

interface ImportSchemaColumnProposal {
  readonly name: string;
  readonly affinity: "TEXT" | "INTEGER";
  readonly nullable: boolean;
  readonly primaryKey?: true;
  readonly unique?: true;
  readonly check?: string;
  readonly references?: string;
}

interface ImportSchemaTableProposal {
  readonly name: string;
  readonly strict: true;
  readonly columns: readonly ImportSchemaColumnProposal[];
  readonly tableChecks?: readonly string[];
  readonly uniqueConstraints?: readonly (readonly string[])[];
}

const tables: readonly ImportSchemaTableProposal[] = [
  {
    name: "legacy_sources",
    strict: true,
    columns: [
      { name: "id", affinity: "TEXT", nullable: false, primaryKey: true, check: "id LIKE 'legacy_%'" },
      { name: "registry_digest", affinity: "TEXT", nullable: false, check: "length(registry_digest) = 64" },
      { name: "locator_digest", affinity: "TEXT", nullable: false, unique: true, check: "length(locator_digest) = 64" },
      { name: "owner_bot_id", affinity: "TEXT", nullable: false, check: "owner_bot_id LIKE 'bot_%'" },
      { name: "owner_domain", affinity: "TEXT", nullable: false },
      { name: "source_type", affinity: "TEXT", nullable: false },
      { name: "source_version", affinity: "TEXT", nullable: false },
      { name: "parser_version", affinity: "TEXT", nullable: false },
      { name: "privacy_class", affinity: "TEXT", nullable: false, check: "privacy_class IN ('resident_private', 'owner_private', 'house_shared')" },
      { name: "allowed_cohorts_json", affinity: "TEXT", nullable: false, check: "json_valid(allowed_cohorts_json) AND json_type(allowed_cohorts_json) = 'array'" },
      { name: "reviewer_principal_id", affinity: "TEXT", nullable: false },
      { name: "receipt_json", affinity: "TEXT", nullable: false, check: "json_valid(receipt_json) AND json_type(receipt_json) = 'object'" },
      { name: "created_at", affinity: "TEXT", nullable: false, check: "length(created_at) = 24" },
    ],
  },
  {
    name: "legacy_source_segments",
    strict: true,
    columns: [
      { name: "source_id", affinity: "TEXT", nullable: false, references: "legacy_sources(id)" },
      { name: "segment_identity", affinity: "TEXT", nullable: false, check: "length(segment_identity) = 64" },
      { name: "physical_identity_digest", affinity: "TEXT", nullable: false, unique: true, check: "length(physical_identity_digest) = 64" },
      { name: "state", affinity: "TEXT", nullable: false, check: "state IN ('open', 'closed', 'rotated', 'quarantined')" },
      { name: "byte_length", affinity: "INTEGER", nullable: false, check: "byte_length >= 0" },
      { name: "record_count", affinity: "INTEGER", nullable: false, check: "record_count >= 0" },
      { name: "tail_digest", affinity: "TEXT", nullable: false, check: "length(tail_digest) = 64" },
      { name: "full_digest", affinity: "TEXT", nullable: true, check: "full_digest IS NULL OR length(full_digest) = 64" },
      { name: "fingerprint_json", affinity: "TEXT", nullable: false, check: "json_valid(fingerprint_json) AND json_type(fingerprint_json) = 'object'" },
      { name: "discovered_at", affinity: "TEXT", nullable: false, check: "length(discovered_at) = 24" },
    ],
    uniqueConstraints: [["source_id", "segment_identity"]],
  },
  {
    name: "import_cohorts",
    strict: true,
    columns: [
      { name: "id", affinity: "TEXT", nullable: false, primaryKey: true, check: "id LIKE 'imp_%'" },
      { name: "manifest_digest", affinity: "TEXT", nullable: false, unique: true, check: "length(manifest_digest) = 64" },
      { name: "source_registry_digest", affinity: "TEXT", nullable: false, check: "length(source_registry_digest) = 64" },
      { name: "snapshot_at", affinity: "TEXT", nullable: false, check: "length(snapshot_at) = 24" },
      { name: "selector_version", affinity: "TEXT", nullable: false },
      { name: "reviewer_principal_id", affinity: "TEXT", nullable: false },
      { name: "state", affinity: "TEXT", nullable: false, check: "state IN ('reviewed', 'active', 'inactive')" },
      { name: "manifest_json", affinity: "TEXT", nullable: false, check: "json_valid(manifest_json) AND json_type(manifest_json) = 'object'" },
      { name: "created_at", affinity: "TEXT", nullable: false, check: "length(created_at) = 24" },
    ],
  },
  {
    name: "import_batches",
    strict: true,
    columns: [
      { name: "id", affinity: "TEXT", nullable: false, primaryKey: true, check: "length(id) BETWEEN 1 AND 128" },
      { name: "cohort_id", affinity: "TEXT", nullable: false, references: "import_cohorts(id)" },
      { name: "manifest_digest", affinity: "TEXT", nullable: false, check: "length(manifest_digest) = 64" },
      { name: "state", affinity: "TEXT", nullable: false, check: "state IN ('staging', 'active', 'inactive', 'failed')" },
      { name: "selected_count", affinity: "INTEGER", nullable: false, check: "selected_count >= 0" },
      { name: "body_bytes", affinity: "INTEGER", nullable: false, check: "body_bytes >= 0" },
      { name: "canonical_digest", affinity: "TEXT", nullable: false, check: "length(canonical_digest) = 64" },
      { name: "request_id", affinity: "TEXT", nullable: false, check: "request_id LIKE 'req_%'" },
      { name: "correlation_id", affinity: "TEXT", nullable: false, check: "correlation_id LIKE 'cor_%'" },
      { name: "created_at", affinity: "TEXT", nullable: false, check: "length(created_at) = 24" },
      { name: "committed_at", affinity: "TEXT", nullable: true, check: "committed_at IS NULL OR length(committed_at) = 24" },
    ],
  },
  {
    name: "import_items",
    strict: true,
    columns: [
      { name: "id", affinity: "TEXT", nullable: false, primaryKey: true, check: "id LIKE 'imi_%'" },
      { name: "batch_id", affinity: "TEXT", nullable: false, references: "import_batches(id)" },
      { name: "cohort_id", affinity: "TEXT", nullable: false, references: "import_cohorts(id)" },
      { name: "source_id", affinity: "TEXT", nullable: false, references: "legacy_sources(id)" },
      { name: "segment_identity", affinity: "TEXT", nullable: false, check: "length(segment_identity) = 64" },
      { name: "record_key", affinity: "TEXT", nullable: false },
      { name: "raw_digest", affinity: "TEXT", nullable: false, check: "length(raw_digest) = 64" },
      { name: "parser_version", affinity: "TEXT", nullable: false },
      { name: "import_key_digest", affinity: "TEXT", nullable: false, unique: true, check: "length(import_key_digest) = 64" },
      { name: "state", affinity: "TEXT", nullable: false, check: "state IN ('discovered', 'selected', 'imported', 'verified', 'quarantined', 'rolled_back', 'skipped_with_reason')" },
      { name: "canonical_digest", affinity: "TEXT", nullable: false, check: "length(canonical_digest) = 64" },
      { name: "target_type", affinity: "TEXT", nullable: true, check: "target_type IS NULL OR target_type IN ('conversation', 'message', 'artifact')" },
      { name: "target_id", affinity: "TEXT", nullable: true },
      { name: "reason", affinity: "TEXT", nullable: true },
      { name: "created_at", affinity: "TEXT", nullable: false, check: "length(created_at) = 24" },
      { name: "updated_at", affinity: "TEXT", nullable: false, check: "length(updated_at) = 24" },
    ],
    tableChecks: ["(target_type IS NULL) = (target_id IS NULL)"],
    uniqueConstraints: [["source_id", "segment_identity", "record_key"]],
  },
  {
    name: "import_cursors",
    strict: true,
    columns: [
      { name: "source_id", affinity: "TEXT", nullable: false, references: "legacy_sources(id)" },
      { name: "segment_identity", affinity: "TEXT", nullable: false, check: "length(segment_identity) = 64" },
      { name: "next_record_index", affinity: "INTEGER", nullable: false, check: "next_record_index >= 0" },
      { name: "next_byte_offset", affinity: "INTEGER", nullable: false, check: "next_byte_offset >= 0" },
      { name: "committed_tail_digest", affinity: "TEXT", nullable: false, check: "length(committed_tail_digest) = 64" },
      { name: "version", affinity: "INTEGER", nullable: false, check: "version >= 1" },
      { name: "updated_at", affinity: "TEXT", nullable: false, check: "length(updated_at) = 24" },
    ],
    uniqueConstraints: [["source_id", "segment_identity"]],
  },
  {
    name: "shadow_compare_receipts",
    strict: true,
    columns: [
      { name: "receipt_digest", affinity: "TEXT", nullable: false, primaryKey: true, check: "length(receipt_digest) = 64" },
      { name: "source_id", affinity: "TEXT", nullable: false, references: "legacy_sources(id)" },
      { name: "capability", affinity: "TEXT", nullable: false },
      { name: "authority_epoch", affinity: "INTEGER", nullable: false, check: "authority_epoch >= 1" },
      { name: "range_start", affinity: "INTEGER", nullable: false, check: "range_start >= 0" },
      { name: "range_end_exclusive", affinity: "INTEGER", nullable: false, check: "range_end_exclusive >= range_start" },
      { name: "drift_count", affinity: "INTEGER", nullable: false, check: "drift_count >= 0" },
      { name: "verdict", affinity: "TEXT", nullable: false, check: "verdict IN ('match', 'blocked')" },
      { name: "receipt_json", affinity: "TEXT", nullable: false, check: "json_valid(receipt_json) AND json_type(receipt_json) = 'object'" },
      { name: "created_at", affinity: "TEXT", nullable: false, check: "length(created_at) = 24" },
    ],
  },
];

export const IMPORT_SCHEMA_DELTA_PROPOSAL = deepFreeze({
  proposalVersion: 2,
  packageId: "M17",
  name: "legacy-import-ledger-shadow-v2",
  landing: {
    owner: "M04",
    status: "proposal_only",
    m17MustNotApply: true,
  },
  requires: {
    coordinationSchemaVersion: 3,
    coordinationSchemaChecksum: "ddac2fb83bf73837f5200725697eff7d55a685f18a6c144fc33df17b75f113c2",
    connectedAgentsContractVersion: 1,
    connectedAgentsContractPackSha256:
      "fbc20017304aed66e579a2b95facbda6bbcf8572038f7f1c0c824423c65d6be2",
  },
  canonicalBindings: {
    aliases: {
      table: "aliases",
      identityColumns: ["namespace", "alias_digest"],
      targetColumns: ["target_type", "target_id", "active"],
      provenanceOwner: "import_items",
    },
    messages: {
      table: "messages",
      idempotencyTable: "idempotency_records",
    },
    events: {
      table: "events",
      orderedTypes: ["message.appended", "import.updated"],
    },
    search: {
      indexTable: "message_fts",
      watermarkTable: "search_watermarks",
      sourceClass: "coordination.messages",
      rebuildSqlSha256:
        COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.m09SearchRebuildSql,
    },
  },
  tables,
  indexes: [
    { name: "legacy_segments_source_state", table: "legacy_source_segments", columns: ["source_id", "state"] },
    { name: "import_batches_cohort_state", table: "import_batches", columns: ["cohort_id", "state"] },
    { name: "import_items_batch_state", table: "import_items", columns: ["batch_id", "state"] },
    { name: "import_items_source_position", table: "import_items", columns: ["source_id", "segment_identity", "record_key"] },
    { name: "shadow_receipts_source_epoch", table: "shadow_compare_receipts", columns: ["source_id", "authority_epoch"] },
  ],
  transactionRequirements: [
    "staging rows are not canonically visible until import items, aliases, approved M08/M09 projections, cursor compare-and-swap, and import.updated commit in one M04 transaction",
    "natural import key and source position conflicts fail closed; terminal import-item states follow the M02 state machine and never silently re-enter imported",
    "cohort rollback appends import.updated, marks the batch inactive, preserves ledger aliases provenance event boundaries and cursors, and removes only unreferenced derived bodies or FTS",
    "authority epoch changes continue to use the existing M04 authority_epochs table and commit authority.epoch_changed in the same transaction",
  ],
  storageRequirements: [
    "legacy source locators persist only as reviewed digests; raw absolute paths remain local registry configuration",
    "manifest and receipt JSON are canonical body-free evidence; product bodies and attachment bytes require reviewed cohorts plus M08/M09-owned projections",
    "physical_identity_digest is globally unique so hard-link or path-alias registration cannot duplicate a corpus",
  ],
  forbiddenStoredColumns: [
    "absolute_path",
    "raw_path",
    "resident_memory",
    "workspace_body",
    "visible_body",
    "attachment_bytes",
    "fts_body",
  ],
  rollback: {
    beforeLanding: "remove this unconsumed proposal with the M17 package",
    afterLanding:
      "disable import and shadow flags; preserve sources, ledger, aliases, provenance, cursors, receipts, and epoch history; use an M04-owned corrective migration",
  },
});

export const IMPORT_SCHEMA_DELTA_CANONICAL_JSON = canonicalJson(
  IMPORT_SCHEMA_DELTA_PROPOSAL,
);

export const IMPORT_SCHEMA_DELTA_SHA256 =
  "75471d65e66f8f70708493078cb5e139e099d686fb8df04f93d9bdd29371cfe4" as const;

export function computeImportSchemaDeltaDigest(): string {
  return sha256(IMPORT_SCHEMA_DELTA_CANONICAL_JSON);
}
