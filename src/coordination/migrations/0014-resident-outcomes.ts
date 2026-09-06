/** Durable resident follow-through; no transcript or authority migration. */
export const RESIDENT_OUTCOMES_MIGRATION_SQL = `
CREATE TABLE resident_outcome_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled_at TEXT NOT NULL,
  event_cursor INTEGER NOT NULL CHECK (event_cursor >= 0)
) STRICT;
INSERT INTO resident_outcome_policy VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), (SELECT coalesce(max(sequence),0) FROM events));
CREATE TABLE resident_outcomes (
  outcome_key TEXT PRIMARY KEY,
  source_work_id TEXT NOT NULL REFERENCES works(id),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  review_work_id TEXT UNIQUE REFERENCES works(id),
  prepared_json TEXT CHECK (prepared_json IS NULL OR json_valid(prepared_json)),
  created_at TEXT NOT NULL,
  settled_at TEXT
) STRICT;
CREATE INDEX resident_outcomes_pending ON resident_outcomes(settled_at, created_at);
`;
