/**
 * A turn's owner-requested model alias and reasoning effort must survive Core
 * restart and Work retry.  Keep the request on the durable Work boundary rather
 * than inferring it later from mutable resident configuration.
 */
export const WORK_TURN_SELECTION_MIGRATION_SQL = `
CREATE TABLE work_turn_selections (
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
    requested_reasoning_effort IN ('none', 'low', 'medium', 'high', 'xhigh', 'max')
  )
) STRICT;

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

INSERT INTO work_turn_selections (
  work_id, requested_model_alias, requested_reasoning_effort
)
SELECT id, NULL, NULL FROM works;
`;
