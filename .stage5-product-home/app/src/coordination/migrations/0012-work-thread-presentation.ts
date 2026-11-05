/**
 * A durable Working Thread needs its own owner-safe assignment label.  The
 * originating Message remains provenance, but one Message may launch more
 * than one independent assignment.
 */
export const WORK_THREAD_PRESENTATION_MIGRATION_SQL = `
CREATE TABLE work_thread_presentations (
  work_id TEXT PRIMARY KEY REFERENCES works(id),
  title TEXT NOT NULL CHECK (
    length(title) BETWEEN 1 AND 88 AND
    instr(title, char(0)) = 0 AND
    instr(title, char(10)) = 0 AND
    instr(title, char(13)) = 0
  ),
  summary TEXT NOT NULL CHECK (
    length(summary) BETWEEN 1 AND 280 AND
    instr(summary, char(0)) = 0
  )
) STRICT;

CREATE TRIGGER work_thread_presentations_no_update
BEFORE UPDATE ON work_thread_presentations
BEGIN
  SELECT RAISE(ABORT, 'work thread presentation is immutable');
END;

CREATE TRIGGER work_thread_presentations_no_delete
BEFORE DELETE ON work_thread_presentations
BEGIN
  SELECT RAISE(ABORT, 'work thread presentation is immutable');
END;
`;
