/** Keep durable selection syntax aligned with isReasoningEffort. The exact
 * provider/model catalog remains the admission authority for supported values. */
export const WORK_TURN_SELECTION_EFFORT_SYNTAX_MIGRATION_SQL = `
CREATE TABLE work_turn_selections_next (
  work_id TEXT PRIMARY KEY REFERENCES works(id),
  requested_model_alias TEXT CHECK (
    requested_model_alias IS NULL OR
    (length(requested_model_alias) BETWEEN 1 AND 256 AND
     instr(requested_model_alias, char(0)) = 0 AND
     instr(requested_model_alias, char(10)) = 0 AND
     instr(requested_model_alias, char(13)) = 0)
  ),
  requested_reasoning_effort TEXT CHECK (
    requested_reasoning_effort IS NULL OR
    (length(requested_reasoning_effort) BETWEEN 1 AND 32 AND
     substr(requested_reasoning_effort, 1, 1) GLOB '[a-z]' AND
     requested_reasoning_effort NOT GLOB '*[^a-z0-9_-]*' AND
     instr(requested_reasoning_effort, char(0)) = 0)
  )
) STRICT;

INSERT INTO work_turn_selections_next (
  work_id, requested_model_alias, requested_reasoning_effort
)
SELECT work_id, requested_model_alias, requested_reasoning_effort
FROM work_turn_selections;

DROP TRIGGER work_turn_selections_no_update;
DROP TRIGGER work_turn_selections_no_delete;
DROP TABLE work_turn_selections;
ALTER TABLE work_turn_selections_next RENAME TO work_turn_selections;

CREATE TRIGGER work_turn_selections_no_update
BEFORE UPDATE ON work_turn_selections
BEGIN
  SELECT RAISE(ABORT, 'work turn selection is immutable');
END;

CREATE TRIGGER work_turn_selections_no_delete
BEFORE DELETE ON work_turn_selections
BEGIN
  SELECT RAISE(ABORT, 'work turn selection is immutable');
END;
`;
