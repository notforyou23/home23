export const ATTACHMENT_CREATE_IDEMPOTENCY_MIGRATION_SQL = `
CREATE TABLE attachment_create_idempotency (
  principal_id TEXT NOT NULL REFERENCES principals(id),
  key_digest TEXT NOT NULL CHECK (length(key_digest) = 64),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  PRIMARY KEY (principal_id, key_digest)
) STRICT;
CREATE INDEX attachment_create_idempotency_created_at
  ON attachment_create_idempotency (created_at);
`;
