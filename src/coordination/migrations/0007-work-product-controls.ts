export const WORK_PRODUCT_CONTROLS_MIGRATION_SQL = `
CREATE TABLE work_retry_provenance (
  source_work_id TEXT NOT NULL REFERENCES works(id),
  retry_work_id TEXT PRIMARY KEY REFERENCES works(id),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  CHECK (source_work_id <> retry_work_id)
) STRICT;
CREATE INDEX work_retry_provenance_source ON work_retry_provenance (source_work_id, created_at, retry_work_id);
`;
