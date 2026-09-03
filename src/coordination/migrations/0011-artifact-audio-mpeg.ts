/** Adds canonical MP3 artifacts without changing immutable historical migration bytes. */
export const ARTIFACT_AUDIO_MPEG_MIGRATION_SQL = `
PRAGMA defer_foreign_keys = ON;

CREATE TABLE artifacts_v11 (
  id TEXT PRIMARY KEY CHECK (id LIKE 'art_%'),
  owner_principal_id TEXT NOT NULL REFERENCES principals(id) CHECK (
    owner_principal_id = 'user_owner' OR owner_principal_id LIKE 'bot_%'
  ),
  state TEXT NOT NULL CHECK (
    state IN ('staging', 'ready', 'failed', 'expired', 'deleted')
  ),
  original_name TEXT NOT NULL CHECK (
    length(original_name) BETWEEN 1 AND 255 AND
    original_name NOT IN ('.', '..') AND
    instr(original_name, '/') = 0 AND instr(original_name, char(92)) = 0 AND
    NOT (
      substr(original_name, 2, 1) = ':' AND
      substr(original_name, 1, 1) GLOB '[A-Za-z]'
    )
  ),
  declared_content_type TEXT CHECK (
    declared_content_type IS NULL OR declared_content_type IN (
      'application/pdf', 'audio/mpeg', 'image/gif', 'image/jpeg', 'image/png', 'text/plain'
    )
  ),
  detected_content_type TEXT CHECK (
    detected_content_type IS NULL OR detected_content_type IN (
      'application/pdf', 'audio/mpeg', 'image/gif', 'image/jpeg', 'image/png', 'text/plain'
    )
  ),
  byte_count INTEGER CHECK (
    byte_count IS NULL OR byte_count BETWEEN 0 AND 26214400
  ),
  sha256 TEXT CHECK (
    sha256 IS NULL OR (
      length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'
    )
  ),
  storage_kind TEXT NOT NULL CHECK (storage_kind = 'content_addressed'),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  expires_at TEXT CHECK (expires_at IS NULL OR length(expires_at) = 24),
  failed_at TEXT CHECK (failed_at IS NULL OR length(failed_at) = 24),
  deleted_at TEXT CHECK (deleted_at IS NULL OR length(deleted_at) = 24),
  version INTEGER NOT NULL CHECK (version >= 1),
  CHECK (
    (state = 'staging' AND detected_content_type IS NULL AND sha256 IS NULL AND
      byte_count = 0 AND failed_at IS NULL AND deleted_at IS NULL AND
      expires_at IS NOT NULL) OR
    (state = 'ready' AND detected_content_type IS NOT NULL AND sha256 IS NOT NULL AND
      byte_count IS NOT NULL AND failed_at IS NULL AND deleted_at IS NULL) OR
    (state = 'failed' AND failed_at IS NOT NULL AND deleted_at IS NULL) OR
    (state = 'expired' AND detected_content_type IS NOT NULL AND sha256 IS NOT NULL AND
      byte_count IS NOT NULL AND failed_at IS NULL AND deleted_at IS NULL) OR
    (state = 'deleted' AND deleted_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE message_artifacts_v11 (
  message_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts_v11(id),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9),
  linked_at TEXT NOT NULL CHECK (length(linked_at) = 24),
  PRIMARY KEY (message_id, ordinal),
  UNIQUE (message_id, artifact_id),
  FOREIGN KEY (message_id, channel_id) REFERENCES messages(id, channel_id)
) STRICT;

CREATE TABLE attachment_create_idempotency_v11 (
  principal_id TEXT NOT NULL REFERENCES principals(id),
  key_digest TEXT NOT NULL CHECK (length(key_digest) = 64),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts_v11(id),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  PRIMARY KEY (principal_id, key_digest)
) STRICT;

INSERT INTO artifacts_v11 (
  id, owner_principal_id, state, original_name, declared_content_type,
  detected_content_type, byte_count, sha256, storage_kind, created_at,
  expires_at, failed_at, deleted_at, version
)
SELECT id, owner_principal_id, state, original_name, declared_content_type,
       detected_content_type, byte_count, sha256, storage_kind, created_at,
       expires_at, failed_at, deleted_at, version
FROM artifacts;

INSERT INTO message_artifacts_v11 (
  message_id, channel_id, artifact_id, ordinal, linked_at
)
SELECT message_id, channel_id, artifact_id, ordinal, linked_at
FROM message_artifacts;

INSERT INTO attachment_create_idempotency_v11 (
  principal_id, key_digest, request_digest, artifact_id, created_at
)
SELECT principal_id, key_digest, request_digest, artifact_id, created_at
FROM attachment_create_idempotency;

DROP TRIGGER artifacts_state_transition_guard;
DROP TRIGGER artifacts_ready_content_immutable;
DROP TRIGGER artifacts_digest_metadata_consistent_insert;
DROP TRIGGER artifacts_digest_metadata_consistent_update;
DROP TRIGGER artifacts_linked_state_immutable;
DROP TRIGGER artifacts_linked_expiry_immutable;
DROP TRIGGER artifacts_no_delete;
DROP TRIGGER artifacts_deleted_immutable;
DROP TABLE message_artifacts;
DROP TABLE attachment_create_idempotency;
DROP INDEX artifacts_digest_state;
DROP INDEX artifacts_owner_state_expiry;
DROP TABLE artifacts;
ALTER TABLE artifacts_v11 RENAME TO artifacts;
ALTER TABLE message_artifacts_v11 RENAME TO message_artifacts;
ALTER TABLE attachment_create_idempotency_v11 RENAME TO attachment_create_idempotency;

CREATE INDEX artifacts_digest_state ON artifacts (sha256, state);
CREATE INDEX artifacts_owner_state_expiry
  ON artifacts (owner_principal_id, state, expires_at, id);
CREATE INDEX message_artifacts_channel
  ON message_artifacts (channel_id, message_id, ordinal);
CREATE INDEX message_artifacts_artifact
  ON message_artifacts (artifact_id, channel_id);
CREATE INDEX attachment_create_idempotency_created_at
  ON attachment_create_idempotency (created_at);

CREATE TRIGGER artifacts_state_transition_guard
BEFORE UPDATE OF state ON artifacts
WHEN NOT (
  (OLD.state = 'staging' AND NEW.state IN ('ready', 'failed')) OR
  (OLD.state = 'ready' AND NEW.state IN ('expired', 'deleted')) OR
  (OLD.state = 'failed' AND NEW.state = 'deleted') OR
  (OLD.state = 'expired' AND NEW.state = 'deleted')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid artifact state transition');
END;

CREATE TRIGGER artifacts_ready_content_immutable
BEFORE UPDATE ON artifacts
WHEN OLD.state IN ('ready', 'failed', 'expired', 'deleted') AND (
  NEW.id <> OLD.id OR
  NEW.owner_principal_id <> OLD.owner_principal_id OR
  NEW.original_name <> OLD.original_name OR
  NEW.declared_content_type IS NOT OLD.declared_content_type OR
  NEW.detected_content_type IS NOT OLD.detected_content_type OR
  NEW.byte_count IS NOT OLD.byte_count OR
  NEW.sha256 IS NOT OLD.sha256 OR
  NEW.storage_kind <> OLD.storage_kind OR
  NEW.created_at <> OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'referenced artifact content metadata is immutable');
END;

CREATE TRIGGER artifacts_digest_metadata_consistent_insert
BEFORE INSERT ON artifacts
WHEN NEW.sha256 IS NOT NULL AND EXISTS (
  SELECT 1 FROM artifacts existing
  WHERE existing.sha256 = NEW.sha256
    AND (
      existing.byte_count IS NOT NEW.byte_count OR
      existing.detected_content_type IS NOT NEW.detected_content_type OR
      existing.storage_kind IS NOT NEW.storage_kind
    )
)
BEGIN
  SELECT RAISE(ABORT, 'artifact digest metadata mismatch');
END;

CREATE TRIGGER artifacts_digest_metadata_consistent_update
BEFORE UPDATE OF sha256, byte_count, detected_content_type, storage_kind ON artifacts
WHEN NEW.sha256 IS NOT NULL AND EXISTS (
  SELECT 1 FROM artifacts existing
  WHERE existing.id <> OLD.id
    AND existing.sha256 = NEW.sha256
    AND (
      existing.byte_count IS NOT NEW.byte_count OR
      existing.detected_content_type IS NOT NEW.detected_content_type OR
      existing.storage_kind IS NOT NEW.storage_kind
    )
)
BEGIN
  SELECT RAISE(ABORT, 'artifact digest metadata mismatch');
END;

CREATE TRIGGER artifacts_linked_state_immutable
BEFORE UPDATE OF state ON artifacts
WHEN NEW.state <> OLD.state AND EXISTS (
  SELECT 1 FROM message_artifacts link WHERE link.artifact_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'linked artifacts cannot change state');
END;

CREATE TRIGGER artifacts_linked_expiry_immutable
BEFORE UPDATE OF expires_at ON artifacts
WHEN NEW.expires_at IS NOT NULL AND EXISTS (
  SELECT 1 FROM message_artifacts link WHERE link.artifact_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'linked artifact expiry is immutable');
END;

CREATE TRIGGER artifacts_no_delete
BEFORE DELETE ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifact records cannot be deleted');
END;

CREATE TRIGGER artifacts_deleted_immutable
BEFORE UPDATE ON artifacts
WHEN OLD.state = 'deleted'
BEGIN
  SELECT RAISE(ABORT, 'deleted artifacts are immutable');
END;

CREATE TRIGGER message_artifacts_require_ready_owner
BEFORE INSERT ON message_artifacts
WHEN NOT EXISTS (
  SELECT 1
  FROM artifacts artifact
  JOIN messages message
    ON message.id = NEW.message_id AND message.channel_id = NEW.channel_id
  WHERE artifact.id = NEW.artifact_id
    AND artifact.state = 'ready'
    AND artifact.owner_principal_id = message.author_principal_id
    AND (artifact.expires_at IS NULL OR artifact.expires_at > NEW.linked_at)
    AND NOT EXISTS (
      SELECT 1 FROM events event
      WHERE event.type = 'message.appended'
        AND event.aggregate_kind = 'message'
        AND event.aggregate_id = NEW.message_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'message attachments require a ready author-owned artifact');
END;

CREATE TRIGGER message_artifacts_clear_draft_expiry
AFTER INSERT ON message_artifacts
BEGIN
  UPDATE artifacts SET expires_at = NULL WHERE id = NEW.artifact_id;
END;

CREATE TRIGGER message_artifacts_no_update
BEFORE UPDATE ON message_artifacts
BEGIN
  SELECT RAISE(ABORT, 'message attachment links are immutable');
END;

CREATE TRIGGER message_artifacts_no_delete
BEFORE DELETE ON message_artifacts
BEGIN
  SELECT RAISE(ABORT, 'message attachment links cannot be deleted');
END;
`;
