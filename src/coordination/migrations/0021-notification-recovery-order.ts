/** Bound notification recovery and make message journal/search checks local to each write. */
export const NOTIFICATION_RECOVERY_ORDER_MIGRATION_SQL = `
DROP TRIGGER event_requires_canonical_message_journal;
DROP TRIGGER message_append_event_requires_indexed_source;
DROP TRIGGER search_watermark_after_message_event;

-- New Message rows are journaled before runMutationWithEvent may commit.
CREATE TABLE message_journal_pending (
  message_id TEXT PRIMARY KEY REFERENCES messages(id)
) STRICT;
CREATE TRIGGER message_journal_pending_after_insert AFTER INSERT ON messages BEGIN
  INSERT INTO message_journal_pending (message_id) VALUES (NEW.id);
END;

CREATE TRIGGER event_requires_canonical_message_journal BEFORE INSERT ON events
WHEN NEW.type <> 'message.appended'
 AND EXISTS (SELECT 1 FROM message_journal_pending LIMIT 1)
BEGIN
  SELECT RAISE(ABORT, 'every Message requires one exact canonical journal event');
END;

CREATE TRIGGER message_append_event_requires_indexed_source BEFORE INSERT ON events
WHEN NEW.type = 'message.appended' AND (
  NEW.aggregate_kind <> 'message' OR NEW.aggregate_version <> 1 OR
  NOT EXISTS (
    SELECT 1 FROM messages message
    JOIN message_journal_pending pending ON pending.message_id = message.id
    WHERE message.id = NEW.aggregate_id
      AND message.channel_id IS NEW.channel_id
      AND message.author_principal_id IS NEW.actor_principal_id
      AND (
        (message.body_text IS NOT NULL AND message.stored_visibility = 'visible'
          AND message.tombstones_message_id IS NULL AND EXISTS (
            SELECT 1 FROM message_fts fts_row
            WHERE fts_row.rowid = message.rowid
              AND fts_row.message_id = message.id
              AND fts_row.body_text = message.body_text
          )) OR
        ((message.body_text IS NULL OR message.stored_visibility <> 'visible'
          OR message.tombstones_message_id IS NOT NULL) AND NOT EXISTS (
            SELECT 1 FROM message_fts fts_row WHERE fts_row.rowid = message.rowid
          ))
      )
      AND (message.tombstones_message_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM messages target
        JOIN message_fts fts_row ON fts_row.rowid = target.rowid
        WHERE target.id = message.tombstones_message_id
      ))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'message.appended event requires the exact canonical search projection');
END;

CREATE TRIGGER message_journal_pending_after_event AFTER INSERT ON events
WHEN NEW.type = 'message.appended' BEGIN
  DELETE FROM message_journal_pending WHERE message_id = NEW.aggregate_id;
END;

-- A Message event changes the searchable set by at most one row.
CREATE TRIGGER search_watermark_after_message_event AFTER INSERT ON events
WHEN NEW.type = 'message.appended' BEGIN
  UPDATE search_watermarks SET
    source_event_sequence = NEW.sequence,
    indexed_through_event_sequence = NEW.sequence,
    source_rows = source_rows + (
      SELECT CASE
        WHEN message.tombstones_message_id IS NOT NULL THEN
          CASE WHEN EXISTS (
            SELECT 1 FROM messages target
            WHERE target.id = message.tombstones_message_id
              AND target.body_text IS NOT NULL
              AND target.stored_visibility = 'visible'
          ) THEN -1 ELSE 0 END
        WHEN message.body_text IS NOT NULL AND message.stored_visibility = 'visible' THEN 1
        ELSE 0 END FROM messages message WHERE message.id = NEW.aggregate_id
    ),
    indexed_rows = indexed_rows + (
      SELECT CASE
        WHEN message.tombstones_message_id IS NOT NULL THEN
          CASE WHEN EXISTS (
            SELECT 1 FROM messages target
            WHERE target.id = message.tombstones_message_id
              AND target.body_text IS NOT NULL
              AND target.stored_visibility = 'visible'
          ) THEN -1 ELSE 0 END
        WHEN message.body_text IS NOT NULL AND message.stored_visibility = 'visible' THEN 1
        ELSE 0 END FROM messages message WHERE message.id = NEW.aggregate_id
    ),
    updated_at = NEW.created_at
  WHERE source_class = 'coordination.messages';
END;

CREATE INDEX IF NOT EXISTS messages_notification_recovery_order ON messages (created_at, id)
WHERE author_kind = 'bot' AND kind = 'result';
`;
