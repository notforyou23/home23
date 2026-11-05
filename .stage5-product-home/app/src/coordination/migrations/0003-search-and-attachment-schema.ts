import { createHash } from "node:crypto";

import {
  ARTIFACT_SCHEMA_DELTA_PROPOSAL,
  ARTIFACT_SCHEMA_DELTA_SHA256,
  ARTIFACT_SCHEMA_DELTA_SQL,
  computeArtifactSchemaDeltaDigest,
} from "../artifacts/schema-delta.js";
import {
  CANONICAL_SEARCH_INDEX_REBUILD_SQL,
  CANONICAL_SEARCH_SCHEMA_DELTA_PROPOSAL,
  CANONICAL_SEARCH_SCHEMA_DELTA_SHA256,
  CANONICAL_SEARCH_SCHEMA_DELTA_SQL,
  computeCanonicalSearchSchemaDeltaDigest,
} from "../search/schema-delta.js";

export const COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES = Object.freeze({
  coordinationSchemaV2:
    "47c9045f580a020bce91d7ea64f572c7f88dc08532ff29b6f7601fdab23428a4",
  contractPack:
    "fbc20017304aed66e579a2b95facbda6bbcf8572038f7f1c0c824423c65d6be2",
  m08MessagingProposal:
    "85695c952db6d1cfafa19296d48d241dbb7bf335342b534b1c76d51e24f74ae6",
  m09SearchProposal:
    "83cbba277cb83667e9412704de922303fb87f3715be4e14dbe430adcdb089965",
  m09SearchSql:
    "30c7cedff6b22bce52b628b6cbf614953acba297c555a69c6321343273685179",
  m09SearchRebuildSql:
    "d1cbbc7729e59f36dc0bd1e26d5a92a9ac1f4648a6289ec8319e8090fb4638d7",
  m10ArtifactProposal:
    "9ce2f8e6e841f1ebb91b23f6cfca23dacf640086bc65ab6126cd66f35ee570b1",
  m10ArtifactSql:
    "a74954762fcecffa96632679c89d52dd4f6146d6d1da35248295729b25d890f3",
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertDependency(name: string, actual: unknown, expected: string): void {
  if (actual !== expected) {
    throw new Error(`coordination schema v3 ${name} digest mismatch: ${String(actual)}`);
  }
}

assertDependency(
  "M09 proposal",
  CANONICAL_SEARCH_SCHEMA_DELTA_SHA256,
  COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.m09SearchProposal,
);
assertDependency(
  "M09 canonical proposal",
  computeCanonicalSearchSchemaDeltaDigest(),
  COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.m09SearchProposal,
);
assertDependency(
  "M09 proposal SQL",
  sha256(CANONICAL_SEARCH_SCHEMA_DELTA_SQL),
  COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.m09SearchSql,
);
assertDependency(
  "M09 rebuild SQL",
  sha256(CANONICAL_SEARCH_INDEX_REBUILD_SQL),
  COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.m09SearchRebuildSql,
);
assertDependency(
  "M10 proposal",
  ARTIFACT_SCHEMA_DELTA_SHA256,
  COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.m10ArtifactProposal,
);
assertDependency(
  "M10 canonical proposal",
  computeArtifactSchemaDeltaDigest(),
  COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.m10ArtifactProposal,
);
assertDependency(
  "M10 proposal SQL",
  sha256(ARTIFACT_SCHEMA_DELTA_SQL),
  COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.m10ArtifactSql,
);

for (const [name, proposal] of [
  ["M09", CANONICAL_SEARCH_SCHEMA_DELTA_PROPOSAL],
  ["M10", ARTIFACT_SCHEMA_DELTA_PROPOSAL],
] as const) {
  assertDependency(
    `${name} schema-v2 prerequisite`,
    proposal.requires.coordinationSchemaChecksum,
    COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.coordinationSchemaV2,
  );
  assertDependency(
    `${name} contract prerequisite`,
    proposal.requires.connectedAgentsContractPackSha256,
    COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.contractPack,
  );
  assertDependency(
    `${name} M08 prerequisite`,
    proposal.requires.m08MessagingSchemaDeltaSha256,
    COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.m08MessagingProposal,
  );
}

// This is the reviewed M04 final shape, not concatenated proposal SQL. In
// particular, search watermarks advance from the committed canonical event
// sequence, and attachment digest/link invariants are enforced at the DB edge.
export const SEARCH_ATTACHMENT_SCHEMA_MIGRATION_SQL = `
-- coordination_schema_v2_sha256=${COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.coordinationSchemaV2}
-- connected_agents_contract_sha256=${COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.contractPack}
-- m08_messaging_proposal_sha256=${COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.m08MessagingProposal}
-- m09_search_proposal_sha256=${COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.m09SearchProposal}
-- m09_search_sql_sha256=${COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.m09SearchSql}
-- m09_search_rebuild_sql_sha256=${COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.m09SearchRebuildSql}
-- m10_artifact_proposal_sha256=${COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.m10ArtifactProposal}
-- m10_artifact_sql_sha256=${COORDINATION_SEARCH_ATTACHMENT_SCHEMA_DEPENDENCIES.m10ArtifactSql}
CREATE TEMP TABLE m0003_canonical_message_event_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
) STRICT;

INSERT INTO m0003_canonical_message_event_guard (valid)
SELECT CASE WHEN
  EXISTS (
    SELECT 1 FROM messages message
    WHERE (
      SELECT count(*) FROM events event
      WHERE event.type = 'message.appended'
        AND event.aggregate_kind = 'message'
        AND event.aggregate_id = message.id
        AND event.aggregate_version = 1
        AND event.channel_id IS message.channel_id
        AND event.actor_principal_id IS message.author_principal_id
    ) <> 1
  ) OR EXISTS (
    SELECT 1 FROM events event
    WHERE event.type = 'message.appended'
      AND NOT EXISTS (
        SELECT 1 FROM messages message
        WHERE event.aggregate_kind = 'message'
          AND event.aggregate_id = message.id
          AND event.aggregate_version = 1
          AND event.channel_id IS message.channel_id
          AND event.actor_principal_id IS message.author_principal_id
      )
  )
  THEN 0 ELSE 1 END;

DROP TABLE m0003_canonical_message_event_guard;

CREATE TABLE search_watermarks (
  source_class TEXT PRIMARY KEY CHECK (source_class = 'coordination.messages'),
  source_event_sequence INTEGER NOT NULL CHECK (source_event_sequence >= 0),
  indexed_through_event_sequence INTEGER NOT NULL CHECK (
    indexed_through_event_sequence >= 0
  ),
  source_rows INTEGER NOT NULL CHECK (source_rows >= 0),
  indexed_rows INTEGER NOT NULL CHECK (indexed_rows >= 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
  CHECK (indexed_through_event_sequence <= source_event_sequence)
) STRICT;

CREATE VIRTUAL TABLE message_fts USING fts5(
  message_id UNINDEXED,
  body_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO message_fts (rowid, message_id, body_text)
SELECT message.rowid, message.id, message.body_text
FROM messages message
WHERE message.body_text IS NOT NULL
  AND message.stored_visibility = 'visible'
  AND message.tombstones_message_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM messages tombstone
    WHERE tombstone.tombstones_message_id = message.id
  );

INSERT INTO search_watermarks (
  source_class, source_event_sequence, indexed_through_event_sequence,
  source_rows, indexed_rows, updated_at
)
SELECT
  'coordination.messages',
  coalesce((SELECT max(sequence) FROM events WHERE type = 'message.appended'), 0),
  coalesce((SELECT max(sequence) FROM events WHERE type = 'message.appended'), 0),
  (SELECT count(*) FROM messages message
   WHERE message.body_text IS NOT NULL
     AND message.stored_visibility = 'visible'
     AND message.tombstones_message_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM messages tombstone
       WHERE tombstone.tombstones_message_id = message.id
     )),
  (SELECT count(*) FROM message_fts),
  coalesce((SELECT max(created_at) FROM messages), '1970-01-01T00:00:00.000Z');

CREATE TRIGGER message_fts_after_insert_searchable
AFTER INSERT ON messages
WHEN NEW.body_text IS NOT NULL
  AND NEW.stored_visibility = 'visible'
  AND NEW.tombstones_message_id IS NULL
BEGIN
  INSERT INTO message_fts (rowid, message_id, body_text)
  VALUES (NEW.rowid, NEW.id, NEW.body_text);
END;

CREATE TRIGGER message_fts_after_insert_nonsearchable
AFTER INSERT ON messages
WHEN NEW.body_text IS NULL
  OR NEW.stored_visibility <> 'visible'
  OR NEW.tombstones_message_id IS NOT NULL
BEGIN
  DELETE FROM message_fts
  WHERE rowid = (
    SELECT target.rowid FROM messages target
    WHERE target.id = NEW.tombstones_message_id
  );
END;

CREATE TRIGGER event_requires_canonical_message_journal
BEFORE INSERT ON events
WHEN EXISTS (
  SELECT 1 FROM messages message
  WHERE NOT EXISTS (
    SELECT 1 FROM events event
    WHERE event.type = 'message.appended'
      AND event.aggregate_kind = 'message'
      AND event.aggregate_id = message.id
      AND event.aggregate_version = 1
      AND event.channel_id IS message.channel_id
      AND event.actor_principal_id IS message.author_principal_id
  ) AND NOT (
    NEW.type = 'message.appended'
    AND NEW.aggregate_kind = 'message'
    AND NEW.aggregate_id = message.id
    AND NEW.aggregate_version = 1
    AND NEW.channel_id IS message.channel_id
    AND NEW.actor_principal_id IS message.author_principal_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'every Message requires one exact canonical journal event');
END;

CREATE TRIGGER message_append_event_requires_indexed_source
BEFORE INSERT ON events
WHEN NEW.type = 'message.appended' AND (
  NEW.aggregate_kind <> 'message' OR
  NEW.aggregate_version <> 1 OR
  NOT EXISTS (
    SELECT 1 FROM messages message
    WHERE message.id = NEW.aggregate_id
      AND message.channel_id IS NEW.channel_id
      AND message.author_principal_id IS NEW.actor_principal_id
  ) OR
  EXISTS (
    SELECT 1 FROM messages message
    WHERE message.body_text IS NOT NULL
      AND message.stored_visibility = 'visible'
      AND message.tombstones_message_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM messages tombstone
        WHERE tombstone.tombstones_message_id = message.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM message_fts AS fts_row
        WHERE fts_row.rowid = message.rowid
          AND fts_row.message_id = message.id
          AND fts_row.body_text = message.body_text
      )
  ) OR
  EXISTS (
    SELECT 1 FROM message_fts AS fts_row
    WHERE NOT EXISTS (
      SELECT 1 FROM messages message
      WHERE message.rowid = fts_row.rowid
        AND message.id = fts_row.message_id
        AND message.body_text = fts_row.body_text
        AND message.body_text IS NOT NULL
        AND message.stored_visibility = 'visible'
        AND message.tombstones_message_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM messages tombstone
          WHERE tombstone.tombstones_message_id = message.id
        )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'message.appended event requires the exact canonical search projection');
END;

CREATE TRIGGER search_watermark_after_message_event
AFTER INSERT ON events
WHEN NEW.type = 'message.appended'
BEGIN
  INSERT INTO search_watermarks (
    source_class, source_event_sequence, indexed_through_event_sequence,
    source_rows, indexed_rows, updated_at
  ) VALUES (
    'coordination.messages',
    NEW.sequence,
    NEW.sequence,
    (SELECT count(*) FROM messages message
     WHERE message.body_text IS NOT NULL
       AND message.stored_visibility = 'visible'
       AND message.tombstones_message_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM messages tombstone
         WHERE tombstone.tombstones_message_id = message.id
       )),
    (SELECT count(*) FROM message_fts),
    NEW.created_at
  ) ON CONFLICT(source_class) DO UPDATE SET
    source_event_sequence = excluded.source_event_sequence,
    indexed_through_event_sequence = excluded.indexed_through_event_sequence,
    source_rows = excluded.source_rows,
    indexed_rows = excluded.indexed_rows,
    updated_at = excluded.updated_at;
END;

CREATE TABLE artifacts (
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
      'application/pdf', 'image/gif', 'image/jpeg', 'image/png', 'text/plain'
    )
  ),
  detected_content_type TEXT CHECK (
    detected_content_type IS NULL OR detected_content_type IN (
      'application/pdf', 'image/gif', 'image/jpeg', 'image/png', 'text/plain'
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

CREATE TABLE message_artifacts (
  message_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9),
  linked_at TEXT NOT NULL CHECK (length(linked_at) = 24),
  PRIMARY KEY (message_id, ordinal),
  UNIQUE (message_id, artifact_id),
  FOREIGN KEY (message_id, channel_id) REFERENCES messages(id, channel_id)
) STRICT;

CREATE INDEX artifacts_digest_state ON artifacts (sha256, state);
CREATE INDEX artifacts_owner_state_expiry
  ON artifacts (owner_principal_id, state, expires_at, id);
CREATE INDEX message_artifacts_channel
  ON message_artifacts (channel_id, message_id, ordinal);
CREATE INDEX message_artifacts_artifact
  ON message_artifacts (artifact_id, channel_id);

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
