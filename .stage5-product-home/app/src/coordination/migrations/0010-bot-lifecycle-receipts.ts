/**
 * Durable immutable idempotency receipts for lightweight Bot lifecycle
 * operations. Only a domain-separated digest of the caller's key is stored.
 */
export const BOT_LIFECYCLE_RECEIPTS_MIGRATION_SQL = `
CREATE TABLE bot_lifecycle_receipts (
  request_key_digest TEXT PRIMARY KEY CHECK (
    length(request_key_digest) = 64 AND
    request_key_digest NOT GLOB '*[^0-9a-f]*'
  ),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  correlation_id TEXT NOT NULL CHECK (correlation_id LIKE 'cor_%'),
  operation TEXT NOT NULL CHECK (operation IN ('create', 'archive', 'restore')),
  receipt_json TEXT NOT NULL CHECK (
    json_valid(receipt_json) AND json_type(receipt_json) = 'object'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24)
) STRICT;

CREATE INDEX bot_lifecycle_receipts_created_at
  ON bot_lifecycle_receipts (created_at, request_key_digest);

CREATE TRIGGER bot_lifecycle_receipts_no_update
BEFORE UPDATE ON bot_lifecycle_receipts
BEGIN
  SELECT RAISE(ABORT, 'bot lifecycle receipt is immutable');
END;

CREATE TRIGGER bot_lifecycle_receipts_no_delete
BEFORE DELETE ON bot_lifecycle_receipts
BEGIN
  SELECT RAISE(ABORT, 'bot lifecycle receipt is immutable');
END;
`;
