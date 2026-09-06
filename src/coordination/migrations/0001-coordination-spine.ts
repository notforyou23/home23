export const COORDINATION_SPINE_MIGRATION_SQL = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at TEXT NOT NULL,
  application_version TEXT NOT NULL
) STRICT;

CREATE TABLE kernel_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE authority_epochs (
  capability TEXT NOT NULL CHECK (capability IN (
    'messages', 'roster', 'unread', 'search', 'attachments', 'activity', 'bot_lifecycle'
  )),
  epoch INTEGER NOT NULL CHECK (epoch >= 1),
  mode TEXT NOT NULL CHECK (mode IN ('legacy', 'shadow', 'canonical')),
  writer TEXT NOT NULL CHECK (length(writer) >= 1),
  effective_at_event_sequence INTEGER CHECK (
    effective_at_event_sequence IS NULL OR effective_at_event_sequence >= 0
  ),
  rollback_epoch INTEGER CHECK (rollback_epoch IS NULL OR rollback_epoch >= 1),
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (capability, epoch)
) STRICT;

CREATE INDEX authority_epochs_capability_epoch_desc
  ON authority_epochs (capability, epoch DESC);

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  type TEXT NOT NULL CHECK (length(type) >= 3),
  durability TEXT NOT NULL CHECK (durability = 'durable'),
  aggregate_kind TEXT NOT NULL CHECK (length(aggregate_kind) >= 1),
  aggregate_id TEXT NOT NULL CHECK (length(aggregate_id) >= 1),
  aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 1),
  channel_id TEXT,
  actor_principal_id TEXT,
  request_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json) AND json_type(payload_json) = 'object'
  ),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (aggregate_kind, aggregate_id, aggregate_version)
) STRICT;

CREATE INDEX events_type_sequence ON events (type, sequence);
CREATE INDEX events_correlation_sequence ON events (correlation_id, sequence);
CREATE INDEX events_aggregate_sequence ON events (aggregate_id, sequence);
`;
