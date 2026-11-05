/** Coordinator-owned immutable assignment and conservative execution boundary. */
export const PLANNED_INVOCATIONS_MIGRATION_SQL = `
CREATE TABLE work_planned_invocations (
  work_id TEXT PRIMARY KEY REFERENCES works(id),
  parent_work_id TEXT NOT NULL REFERENCES works(id),
  parent_attempt_id TEXT NOT NULL REFERENCES attempts(id),
  parent_lease_id TEXT NOT NULL REFERENCES leases(id),
  parent_fencing_token INTEGER NOT NULL CHECK (parent_fencing_token > 0),
  resident_slug TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  assignment_json TEXT NOT NULL CHECK (json_valid(assignment_json)),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (parent_work_id, parent_attempt_id, parent_fencing_token, resident_slug, invocation_id)
) STRICT;
CREATE INDEX work_planned_invocations_parent ON work_planned_invocations(parent_work_id);
CREATE TRIGGER work_planned_invocations_no_update BEFORE UPDATE ON work_planned_invocations
BEGIN SELECT RAISE(ABORT, 'planned invocation is immutable'); END;
CREATE TRIGGER work_planned_invocations_no_delete BEFORE DELETE ON work_planned_invocations
BEGIN SELECT RAISE(ABORT, 'planned invocation is immutable'); END;
CREATE TABLE work_invocation_starts (
  work_id TEXT PRIMARY KEY REFERENCES work_planned_invocations(work_id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  lease_id TEXT NOT NULL REFERENCES leases(id),
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  invocation_id TEXT NOT NULL,
  started_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER work_invocation_starts_no_update BEFORE UPDATE ON work_invocation_starts
BEGIN SELECT RAISE(ABORT, 'invocation start is immutable'); END;
CREATE TRIGGER work_invocation_starts_no_delete BEFORE DELETE ON work_invocation_starts
BEGIN SELECT RAISE(ABORT, 'invocation start is immutable'); END;
`;
