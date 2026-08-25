import { createHash } from "node:crypto";

export const ARTIFACT_SCHEMA_DELTA_SQL = `
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY CHECK (id LIKE 'art_%'),
  owner_principal_id TEXT NOT NULL REFERENCES principals(id) CHECK (
    owner_principal_id = 'user_owner' OR owner_principal_id LIKE 'bot_%'
  ),
  state TEXT NOT NULL CHECK (state IN ('staging', 'ready', 'failed', 'expired', 'deleted')),
  original_name TEXT NOT NULL CHECK (
    length(original_name) BETWEEN 1 AND 255 AND
    original_name NOT IN ('.', '..') AND
    instr(original_name, '/') = 0 AND instr(original_name, char(92)) = 0 AND
    NOT (substr(original_name, 2, 1) = ':' AND substr(original_name, 1, 1) GLOB '[A-Za-z]')
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
  byte_count INTEGER CHECK (byte_count IS NULL OR byte_count BETWEEN 0 AND 26214400),
  sha256 TEXT CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*')),
  storage_kind TEXT NOT NULL CHECK (storage_kind = 'content_addressed'),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  expires_at TEXT CHECK (expires_at IS NULL OR length(expires_at) = 24),
  failed_at TEXT CHECK (failed_at IS NULL OR length(failed_at) = 24),
  deleted_at TEXT CHECK (deleted_at IS NULL OR length(deleted_at) = 24),
  version INTEGER NOT NULL CHECK (version >= 1),
  CHECK (
    (state = 'staging' AND detected_content_type IS NULL AND sha256 IS NULL AND
      byte_count = 0 AND failed_at IS NULL AND deleted_at IS NULL AND expires_at IS NOT NULL) OR
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

CREATE TRIGGER artifacts_linked_state_immutable
BEFORE UPDATE OF state ON artifacts
WHEN NEW.state <> OLD.state AND EXISTS (
  SELECT 1 FROM message_artifacts link WHERE link.artifact_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'linked artifacts cannot change state');
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("M10 schema delta contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") {
    throw new Error("M10 schema delta contains a non-JSON value");
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

export const ARTIFACT_SCHEMA_DELTA_PROPOSAL = deepFreeze({
  proposalVersion: 1,
  packageId: "M10",
  name: "content-addressed-attachments-v1",
  landing: { owner: "M04", status: "proposal_only", m10MustNotApply: true },
  requires: {
    coordinationSchemaVersion: 2,
    coordinationSchemaChecksum: "47c9045f580a020bce91d7ea64f572c7f88dc08532ff29b6f7601fdab23428a4",
    connectedAgentsContractVersion: 1,
    connectedAgentsContractPackSha256: "fbc20017304aed66e579a2b95facbda6bbcf8572038f7f1c0c824423c65d6be2",
    m08MessagingSchemaDeltaSha256: "85695c952db6d1cfafa19296d48d241dbb7bf335342b534b1c76d51e24f74ae6",
  },
  sqlSha256: createHash("sha256").update(ARTIFACT_SCHEMA_DELTA_SQL, "utf8").digest("hex"),
  tables: ["artifacts", "message_artifacts"],
  invariants: [
    "SQLite stores only attachment metadata and immutable Message links; content bytes never enter SQLite",
    "sha256 is intentionally non-unique in metadata so an unauthorized caller cannot observe cross-draft or cross-Channel deduplication",
    "canonical object location is derived internally from sha256 and no database or public projection stores a filesystem path",
    "a Message link admits at most ten ready artifacts owned by that immutable Message author",
    "ready content metadata and Message links are immutable; linked artifacts cannot expire or delete",
    "staging, ready, failed, expired, and deleted transitions follow the accepted M02 attachment state machine",
  ],
  transactionRequirements: [
    "staging creation and every terminal metadata transition append one attachment.updated event in the same M04 transaction",
    "ready author-owned artifacts link through the M08 Message transaction port so Message insert, links, idempotency result, and event commit atomically",
    "an event or link failure rolls back metadata and links; the byte store removes a newly published unreferenced canonical object",
  ],
  integrationRequirements: [
    "M04 must land this SQL, preserve its checksum, retain one product-writer lifecycle, and extend idempotency operation and result domains for attachment.create and attachment.delete before public activation",
    "M08 must invoke the non-empty artifact link port inside the Message insert, idempotency, and event transaction and project returned attachment summaries",
    "M12 or M23 must register one authorized public attachment route owner with bounded upload concurrency, range policy, and safe download disposition; M10 does not compose or activate routes",
    "the runtime must schedule draft expiry and abandoned-upload recovery and must not run upload or garbage-collection writers for one store root in multiple processes",
    "the release CI owner must register the scoped coordination artifact suite because the current package test script does not discover tests under tests/coordination",
  ],
  retentionRequirements: [
    "unlinked ready drafts expire after 24 hours by default",
    "linked bytes remain immutable until a future explicit transcript-retention action",
    "garbage collection quarantines only digests absent from every active metadata row and reports a dry run before mutation",
    "standalone quarantine files remain deferred for at least one hour and reports distinguish deferred recent bytes from eligible candidates",
  ],
  forbiddenStoredColumns: [
    "blob",
    "bytes",
    "storage_path",
    "absolute_path",
    "source_path",
    "workspace_path",
    "private_memory",
    "resident_context",
  ],
  rollback: {
    beforeLanding: "remove this unconsumed proposal with M10",
    afterLanding: "disable attachment admission; preserve referenced bytes, metadata, and immutable Message links; quarantine only proven unreferenced objects",
  },
});

export const ARTIFACT_SCHEMA_DELTA_CANONICAL_JSON = canonicalJson(
  ARTIFACT_SCHEMA_DELTA_PROPOSAL,
);

export const ARTIFACT_SCHEMA_DELTA_SHA256 =
  "9ce2f8e6e841f1ebb91b23f6cfca23dacf640086bc65ab6126cd66f35ee570b1" as const;

export function computeArtifactSchemaDeltaDigest(): string {
  return createHash("sha256")
    .update(ARTIFACT_SCHEMA_DELTA_CANONICAL_JSON, "utf8")
    .digest("hex");
}
