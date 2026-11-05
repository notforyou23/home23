import { createHash } from "node:crypto";

export const CANONICAL_SEARCH_SCHEMA_DELTA_SQL = `
CREATE TABLE search_watermarks (
  source_class TEXT PRIMARY KEY CHECK (source_class = 'coordination.messages'),
  source_event_sequence INTEGER NOT NULL CHECK (source_event_sequence >= 0),
  indexed_through_event_sequence INTEGER NOT NULL CHECK (indexed_through_event_sequence >= 0),
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
SELECT m.rowid, m.id, m.body_text
FROM messages m
WHERE m.body_text IS NOT NULL
  AND m.stored_visibility = 'visible'
  AND m.tombstones_message_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM messages tombstone
    WHERE tombstone.tombstones_message_id = m.id
  );

INSERT INTO search_watermarks (
  source_class, source_event_sequence, indexed_through_event_sequence,
  source_rows, indexed_rows, updated_at
)
SELECT
  'coordination.messages',
  coalesce((SELECT max(sequence) FROM events WHERE type = 'message.appended'), 0),
  coalesce((SELECT max(sequence) FROM events WHERE type = 'message.appended'), 0),
  (SELECT count(*) FROM messages m
   WHERE m.body_text IS NOT NULL
     AND m.stored_visibility = 'visible'
     AND m.tombstones_message_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM messages tombstone
       WHERE tombstone.tombstones_message_id = m.id
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
  INSERT INTO search_watermarks (
    source_class, source_event_sequence, indexed_through_event_sequence,
    source_rows, indexed_rows, updated_at
  ) VALUES (
    'coordination.messages',
    coalesce((SELECT max(sequence) FROM events), 0) + 1,
    coalesce((SELECT max(sequence) FROM events), 0) + 1,
    (SELECT count(*) FROM messages m
     WHERE m.body_text IS NOT NULL
       AND m.stored_visibility = 'visible'
       AND m.tombstones_message_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM messages tombstone
         WHERE tombstone.tombstones_message_id = m.id
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
  INSERT INTO search_watermarks (
    source_class, source_event_sequence, indexed_through_event_sequence,
    source_rows, indexed_rows, updated_at
  ) VALUES (
    'coordination.messages',
    coalesce((SELECT max(sequence) FROM events), 0) + 1,
    coalesce((SELECT max(sequence) FROM events), 0) + 1,
    (SELECT count(*) FROM messages m
     WHERE m.body_text IS NOT NULL
       AND m.stored_visibility = 'visible'
       AND m.tombstones_message_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM messages tombstone
         WHERE tombstone.tombstones_message_id = m.id
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
`;

export const CANONICAL_SEARCH_INDEX_REBUILD_SQL = `
DELETE FROM message_fts;
INSERT INTO message_fts (rowid, message_id, body_text)
SELECT m.rowid, m.id, m.body_text
FROM messages m
WHERE m.body_text IS NOT NULL
  AND m.stored_visibility = 'visible'
  AND m.tombstones_message_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM messages tombstone
    WHERE tombstone.tombstones_message_id = m.id
  );
INSERT INTO search_watermarks (
  source_class, source_event_sequence, indexed_through_event_sequence,
  source_rows, indexed_rows, updated_at
)
VALUES (
  'coordination.messages',
  coalesce((
    SELECT max(sequence) FROM events WHERE type = 'message.appended'
  ), 0),
  coalesce((
    SELECT max(sequence) FROM events WHERE type = 'message.appended'
  ), 0),
  (
    SELECT count(*) FROM messages m
    WHERE m.body_text IS NOT NULL
      AND m.stored_visibility = 'visible'
      AND m.tombstones_message_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM messages tombstone
        WHERE tombstone.tombstones_message_id = m.id
      )
  ),
  (SELECT count(*) FROM message_fts),
  coalesce((SELECT max(created_at) FROM messages), '1970-01-01T00:00:00.000Z')
)
ON CONFLICT(source_class) DO UPDATE SET
  source_event_sequence = excluded.source_event_sequence,
  indexed_through_event_sequence = excluded.indexed_through_event_sequence,
  source_rows = excluded.source_rows,
  indexed_rows = excluded.indexed_rows,
  updated_at = excluded.updated_at;
`;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("M09 schema delta has a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") {
    throw new Error("M09 schema delta has a non-JSON value");
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const CANONICAL_SEARCH_SCHEMA_DELTA_PROPOSAL = deepFreeze({
  proposalVersion: 1,
  packageId: "M09",
  name: "canonical-message-fts-v1",
  landing: {
    owner: "M04",
    status: "proposal_only",
    m09MustNotApply: true,
    gate: "M04 schema-hotspot owner review and next numbered migration integration",
  },
  requires: {
    coordinationSchemaVersion: 2,
    coordinationSchemaChecksum:
      "47c9045f580a020bce91d7ea64f572c7f88dc08532ff29b6f7601fdab23428a4",
    connectedAgentsContractVersion: 1,
    connectedAgentsContractPackSha256:
      "fbc20017304aed66e579a2b95facbda6bbcf8572038f7f1c0c824423c65d6be2",
    m08MessagingSchemaDeltaSha256:
      "85695c952db6d1cfafa19296d48d241dbb7bf335342b534b1c76d51e24f74ae6",
    messageAppendEventCardinality: 1,
  },
  tables: ["search_watermarks"],
  virtualTables: ["message_fts"],
  triggers: [
    "message_fts_after_insert_searchable",
    "message_fts_after_insert_nonsearchable",
  ],
  sourceClasses: ["coordination.messages"],
  sourceBody: "messages.body_text",
  privacyBoundary: "active Channel membership and visible non-tombstoned Messages",
  forbiddenStoredColumns: [
    "query_text",
    "query_digest",
    "cursor",
    "principal_id",
    "channel_id",
    "private_memory",
    "resident_context",
    "workspace_path",
    "credential",
    "secret",
  ],
  rebuild: "execute the reviewed derived-index rebuild transaction through the M04 maintenance gate",
  rebuildRequiresM04ExclusiveTransaction: true,
  rebuildSqlSha256: createHash("sha256")
    .update(CANONICAL_SEARCH_INDEX_REBUILD_SQL, "utf8")
    .digest("hex"),
  sqlSha256: createHash("sha256")
    .update(CANONICAL_SEARCH_SCHEMA_DELTA_SQL, "utf8")
    .digest("hex"),
  rollback: {
    beforeLanding: "remove this unconsumed proposal with M09",
    afterLanding:
      "disable coordination.search.canonical; the M04 owner may rebuild or drop only the derived FTS index and watermark while preserving every canonical message",
  },
});

export const CANONICAL_SEARCH_SCHEMA_DELTA_CANONICAL_JSON = canonicalJson(
  CANONICAL_SEARCH_SCHEMA_DELTA_PROPOSAL,
);

export const CANONICAL_SEARCH_SCHEMA_DELTA_SHA256 =
  "83cbba277cb83667e9412704de922303fb87f3715be4e14dbe430adcdb089965";

export function computeCanonicalSearchSchemaDeltaDigest(): string {
  return createHash("sha256")
    .update(CANONICAL_SEARCH_SCHEMA_DELTA_CANONICAL_JSON, "utf8")
    .digest("hex");
}

if (computeCanonicalSearchSchemaDeltaDigest() !== CANONICAL_SEARCH_SCHEMA_DELTA_SHA256) {
  throw new Error(
    `M09 canonical search schema proposal bytes differ from its checksum: ${computeCanonicalSearchSchemaDeltaDigest()}`,
  );
}
