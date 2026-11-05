/** Exact, transactionally maintained cardinality for cursor gap detection.
 * Counting the entire ledger on every stream poll blocks all Core HTTP work.
 * The initial scan runs once at migration; inserts, pruning, and rollbacks
 * thereafter keep the count in the same SQLite transaction as the event row.
 */
export const EVENT_RETENTION_COUNT_MIGRATION_SQL = `
CREATE TABLE event_retention_count (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  retained_count INTEGER NOT NULL CHECK (retained_count >= 0)
) STRICT;
INSERT INTO event_retention_count SELECT 1, count(*) FROM events;
CREATE TRIGGER event_retention_count_insert AFTER INSERT ON events BEGIN
  UPDATE event_retention_count SET retained_count = retained_count + 1 WHERE singleton = 1;
END;
CREATE TRIGGER event_retention_count_delete AFTER DELETE ON events BEGIN
  UPDATE event_retention_count SET retained_count = retained_count - 1 WHERE singleton = 1;
END;
`;
