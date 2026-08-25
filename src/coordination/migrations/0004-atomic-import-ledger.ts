export const ATOMIC_IMPORT_LEDGER_MIGRATION_SQL = `
-- m17_import_schema_proposal_sha256=75471d65e66f8f70708493078cb5e139e099d686fb8df04f93d9bdd29371cfe4
CREATE TABLE legacy_sources (
  id TEXT PRIMARY KEY CHECK (id LIKE 'legacy_%'),
  registry_digest TEXT NOT NULL CHECK (length(registry_digest) = 64),
  locator_digest TEXT NOT NULL UNIQUE CHECK (length(locator_digest) = 64),
  physical_identity_digest TEXT NOT NULL UNIQUE CHECK (length(physical_identity_digest) = 64),
  owner_bot_id TEXT NOT NULL CHECK (owner_bot_id LIKE 'bot_%'),
  owner_domain TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_version TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  privacy_class TEXT NOT NULL CHECK (privacy_class IN ('resident_private','owner_private','house_shared')),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24)
) STRICT;

CREATE TABLE import_cohorts (
  id TEXT PRIMARY KEY CHECK (id LIKE 'imp_%'),
  manifest_digest TEXT NOT NULL UNIQUE CHECK (length(manifest_digest) = 64),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  reviewed_by TEXT NOT NULL REFERENCES principals(id),
  snapshot_at TEXT NOT NULL CHECK (length(snapshot_at) = 24),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24)
) STRICT;

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  cohort_id TEXT NOT NULL REFERENCES import_cohorts(id),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
  plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 64),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  state TEXT NOT NULL CHECK (state IN ('active','inactive','failed')),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  request_id TEXT NOT NULL CHECK (request_id LIKE 'req_%'),
  correlation_id TEXT NOT NULL CHECK (correlation_id LIKE 'cor_%'),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  committed_at TEXT NOT NULL CHECK (length(committed_at) = 24)
) STRICT;

CREATE TABLE import_items (
  id TEXT PRIMARY KEY CHECK (id LIKE 'imi_%'),
  batch_id TEXT NOT NULL REFERENCES import_batches(id),
  cohort_id TEXT NOT NULL REFERENCES import_cohorts(id),
  source_id TEXT NOT NULL REFERENCES legacy_sources(id),
  segment_identity TEXT NOT NULL,
  record_key TEXT NOT NULL,
  raw_digest TEXT NOT NULL CHECK (length(raw_digest) = 64),
  import_key_digest TEXT NOT NULL UNIQUE CHECK (length(import_key_digest) = 64),
  state TEXT NOT NULL CHECK (state IN ('imported','verified','quarantined','rolled_back','skipped_with_reason')),
  canonical_digest TEXT NOT NULL CHECK (length(canonical_digest) = 64),
  target_type TEXT NOT NULL CHECK (target_type = 'message'),
  target_id TEXT NOT NULL REFERENCES messages(id),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
  UNIQUE (source_id, segment_identity, record_key)
) STRICT;

CREATE TABLE import_cursors (
  source_id TEXT NOT NULL REFERENCES legacy_sources(id),
  segment_identity TEXT NOT NULL,
  next_record_index INTEGER NOT NULL CHECK (next_record_index >= 0),
  next_byte_offset INTEGER NOT NULL CHECK (next_byte_offset >= 0),
  committed_tail_digest TEXT NOT NULL CHECK (length(committed_tail_digest) = 64),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
  PRIMARY KEY (source_id, segment_identity)
) STRICT;

CREATE INDEX import_batches_cohort_state ON import_batches (cohort_id, state);
CREATE INDEX import_items_batch_state ON import_items (batch_id, state);
CREATE INDEX import_items_source_position ON import_items (source_id, segment_identity, record_key);
`;
