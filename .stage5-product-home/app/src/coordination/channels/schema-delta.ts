import { createHash } from "node:crypto";

export const MESSAGING_SCHEMA_DELTA_SQL = `
ALTER TABLE idempotency_records RENAME TO idempotency_records_m06;
DROP INDEX IF EXISTS idempotency_records_created_at;

CREATE TABLE idempotency_records (
  principal_id TEXT NOT NULL REFERENCES principals(id) CHECK (
    principal_id = 'user_owner' OR principal_id LIKE 'bot_%'
  ),
  operation TEXT NOT NULL CHECK (operation IN (
    'pairing.issue', 'pairing.redeem', 'session.refresh', 'session.revoke',
    'device.revoke', 'channel.create', 'channel.update', 'message.append',
    'read_cursor.update'
  )),
  idempotency_key_digest TEXT NOT NULL CHECK (length(idempotency_key_digest) = 64),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  result_kind TEXT NOT NULL CHECK (result_kind IN (
    'pairing', 'pairing_failure', 'redemption', 'refresh', 'refresh_failure',
    'revoke', 'channel', 'message', 'read_cursor'
  )),
  result_ref_json TEXT NOT NULL CHECK (
    json_valid(result_ref_json) AND json_type(result_ref_json) = 'object'
  ),
  request_id TEXT NOT NULL CHECK (request_id LIKE 'req_%'),
  correlation_id TEXT NOT NULL CHECK (correlation_id LIKE 'cor_%'),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  UNIQUE (principal_id, operation, idempotency_key_digest)
) STRICT;

INSERT INTO idempotency_records (
  principal_id, operation, idempotency_key_digest, request_digest, result_kind,
  result_ref_json, request_id, correlation_id, created_at
)
SELECT principal_id, operation, idempotency_key_digest, request_digest, result_kind,
       result_ref_json, request_id, correlation_id, created_at
FROM idempotency_records_m06;

DROP TABLE idempotency_records_m06;
CREATE INDEX idempotency_records_created_at ON idempotency_records (created_at);

CREATE TABLE channels (
  id TEXT PRIMARY KEY CHECK (id LIKE 'chn_%'),
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  purpose TEXT NOT NULL CHECK (length(purpose) <= 4000),
  owner_principal_id TEXT NOT NULL REFERENCES principals(id) CHECK (owner_principal_id = 'user_owner'),
  responder_mode TEXT NOT NULL CHECK (responder_mode IN ('mentions_only', 'mention_or_coordinator')),
  coordinator_bot_id TEXT CHECK (coordinator_bot_id IS NULL OR coordinator_bot_id LIKE 'bot_%'),
  response_order TEXT NOT NULL CHECK (response_order IN ('parallel', 'sequential')),
  max_bot_turns INTEGER NOT NULL CHECK (max_bot_turns BETWEEN 1 AND 8),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'archived')),
  pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
  version INTEGER NOT NULL CHECK (version >= 1),
  next_message_sequence INTEGER NOT NULL CHECK (next_message_sequence >= 1),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
  CHECK (
    (responder_mode = 'mentions_only' AND coordinator_bot_id IS NULL) OR
    (responder_mode = 'mention_or_coordinator' AND coordinator_bot_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  kind TEXT NOT NULL CHECK (kind IN ('owner', 'bot')),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  joined_at TEXT NOT NULL CHECK (length(joined_at) = 24),
  left_at TEXT CHECK (left_at IS NULL OR length(left_at) = 24),
  PRIMARY KEY (channel_id, principal_id),
  CHECK (
    (principal_id = 'user_owner' AND kind = 'owner' AND role = 'owner' AND
      active = 1 AND left_at IS NULL) OR
    (principal_id LIKE 'bot_%' AND kind = 'bot' AND role = 'member')
  ),
  CHECK (
    (active = 1 AND left_at IS NULL) OR (active = 0 AND left_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE channel_membership_history (
  channel_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('owner', 'bot')),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  joined_channel_version INTEGER NOT NULL CHECK (joined_channel_version >= 1),
  left_channel_version INTEGER CHECK (
    left_channel_version IS NULL OR left_channel_version > joined_channel_version
  ),
  joined_at TEXT NOT NULL CHECK (length(joined_at) = 24),
  left_at TEXT CHECK (left_at IS NULL OR length(left_at) = 24),
  PRIMARY KEY (channel_id, principal_id, joined_channel_version),
  FOREIGN KEY (channel_id, principal_id)
    REFERENCES channel_members(channel_id, principal_id),
  CHECK (
    (principal_id = 'user_owner' AND kind = 'owner' AND role = 'owner') OR
    (principal_id LIKE 'bot_%' AND kind = 'bot' AND role = 'member')
  ),
  CHECK (
    (active = 1 AND left_channel_version IS NULL AND left_at IS NULL) OR
    (active = 0 AND left_channel_version IS NOT NULL AND left_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE direct_channel_pairs (
  first_principal_id TEXT NOT NULL REFERENCES principals(id),
  second_principal_id TEXT NOT NULL REFERENCES principals(id),
  channel_id TEXT NOT NULL UNIQUE REFERENCES channels(id),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  PRIMARY KEY (first_principal_id, second_principal_id),
  CHECK (first_principal_id < second_principal_id)
) STRICT;

CREATE TABLE conversation_handles (
  id TEXT PRIMARY KEY CHECK (id LIKE 'cnv_%'),
  channel_id TEXT NOT NULL UNIQUE REFERENCES channels(id),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24)
) STRICT;

ALTER TABLE bots RENAME TO bots_m07;
DROP INDEX IF EXISTS bots_lifecycle_name;
DROP INDEX IF EXISTS bots_heartbeat;

CREATE TABLE bots (
  id TEXT PRIMARY KEY CHECK (id LIKE 'bot_%'),
  principal_id TEXT NOT NULL UNIQUE REFERENCES principals(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 512),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('provisioning', 'active', 'archived', 'failed')),
  conversation_id TEXT REFERENCES conversation_handles(id) CHECK (
    conversation_id IS NULL OR conversation_id LIKE 'cnv_%'
  ),
  resident_binding TEXT NOT NULL UNIQUE CHECK (length(resident_binding) BETWEEN 1 AND 63),
  continuing_identity INTEGER NOT NULL CHECK (continuing_identity = 1),
  durable_mailbox INTEGER NOT NULL CHECK (durable_mailbox = 1),
  required_capabilities_json TEXT NOT NULL CHECK (
    json_valid(required_capabilities_json) AND
    json_type(required_capabilities_json) = 'array'
  ),
  active_instance_id TEXT CHECK (
    active_instance_id IS NULL OR length(active_instance_id) BETWEEN 1 AND 128
  ),
  active_key_version INTEGER CHECK (
    active_key_version IS NULL OR active_key_version >= 1
  ),
  resident_protocol_version INTEGER CHECK (
    resident_protocol_version IS NULL OR resident_protocol_version = 1
  ),
  resident_capabilities_json TEXT NOT NULL CHECK (
    json_valid(resident_capabilities_json) AND
    json_type(resident_capabilities_json) = 'array'
  ),
  resident_registered_at TEXT CHECK (
    resident_registered_at IS NULL OR length(resident_registered_at) = 24
  ),
  last_heartbeat_at TEXT CHECK (
    last_heartbeat_at IS NULL OR length(last_heartbeat_at) = 24
  ),
  reported_availability TEXT CHECK (
    reported_availability IS NULL OR
    reported_availability IN ('starting', 'available', 'busy', 'degraded')
  ),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
  CHECK (principal_id = id),
  CHECK (
    (
      active_instance_id IS NULL AND active_key_version IS NULL AND
      resident_protocol_version IS NULL AND resident_registered_at IS NULL AND
      last_heartbeat_at IS NULL AND reported_availability IS NULL
    ) OR (
      active_instance_id IS NOT NULL AND active_key_version IS NOT NULL AND
      resident_protocol_version IS NOT NULL AND resident_registered_at IS NOT NULL AND
      last_heartbeat_at IS NOT NULL AND reported_availability IS NOT NULL
    )
  )
) STRICT;

INSERT INTO bots (
  id, principal_id, name, purpose, lifecycle, conversation_id, resident_binding,
  continuing_identity, durable_mailbox, required_capabilities_json,
  active_instance_id, active_key_version, resident_protocol_version,
  resident_capabilities_json, resident_registered_at, last_heartbeat_at,
  reported_availability, version, created_at, updated_at
)
SELECT id, principal_id, name, purpose, lifecycle, conversation_id, resident_binding,
       continuing_identity, durable_mailbox, required_capabilities_json,
       active_instance_id, active_key_version, resident_protocol_version,
       resident_capabilities_json, resident_registered_at, last_heartbeat_at,
       reported_availability, version, created_at, updated_at
FROM bots_m07;

DROP TABLE bots_m07;
CREATE INDEX bots_lifecycle_name ON bots (lifecycle, name, id);
CREATE INDEX bots_heartbeat ON bots (last_heartbeat_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY CHECK (id LIKE 'msg_%'),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  channel_sequence INTEGER NOT NULL CHECK (channel_sequence >= 1),
  author_principal_id TEXT NOT NULL REFERENCES principals(id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('owner', 'bot')),
  author_display_name TEXT NOT NULL CHECK (length(author_display_name) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'system', 'result')),
  body_text TEXT,
  stored_visibility TEXT NOT NULL CHECK (stored_visibility IN ('visible', 'tombstoned')),
  client_message_id TEXT CHECK (client_message_id IS NULL OR length(client_message_id) BETWEEN 1 AND 128),
  reply_to_message_id TEXT REFERENCES messages(id),
  tombstones_message_id TEXT UNIQUE REFERENCES messages(id),
  round_id TEXT CHECK (round_id IS NULL OR round_id LIKE 'rnd_%'),
  work_id TEXT CHECK (work_id IS NULL OR work_id LIKE 'wrk_%'),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  UNIQUE (channel_id, channel_sequence),
  UNIQUE (id, channel_id),
  FOREIGN KEY (channel_id, author_principal_id)
    REFERENCES channel_members(channel_id, principal_id),
  CHECK (
    (author_principal_id = 'user_owner' AND author_kind = 'owner') OR
    (author_principal_id LIKE 'bot_%' AND author_kind = 'bot')
  ),
  CHECK (reply_to_message_id IS NULL OR tombstones_message_id IS NULL),
  CHECK (tombstones_message_id IS NULL OR (kind = 'system' AND body_text IS NULL))
) STRICT;

CREATE TABLE mentions (
  message_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  mentioned_principal_id TEXT NOT NULL CHECK (mentioned_principal_id LIKE 'bot_%'),
  PRIMARY KEY (message_id, mentioned_principal_id),
  FOREIGN KEY (message_id, channel_id) REFERENCES messages(id, channel_id),
  FOREIGN KEY (channel_id, mentioned_principal_id) REFERENCES channel_members(channel_id, principal_id)
) STRICT;

CREATE TABLE read_cursors (
  principal_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  read_through_sequence INTEGER NOT NULL CHECK (read_through_sequence >= 0),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
  PRIMARY KEY (principal_id, channel_id),
  FOREIGN KEY (channel_id, principal_id) REFERENCES channel_members(channel_id, principal_id)
) STRICT;

CREATE INDEX channels_inbox_order ON channels (pinned DESC, updated_at DESC, id);
CREATE INDEX channel_members_principal ON channel_members (principal_id, active, channel_id);
CREATE UNIQUE INDEX channel_membership_history_active
  ON channel_membership_history (channel_id, principal_id) WHERE active = 1;
CREATE INDEX channel_membership_history_principal
  ON channel_membership_history (principal_id, channel_id, joined_channel_version);
CREATE INDEX messages_channel_sequence_desc ON messages (channel_id, channel_sequence DESC);
CREATE INDEX messages_reply ON messages (reply_to_message_id);
CREATE INDEX messages_tombstone ON messages (tombstones_message_id);
CREATE INDEX mentions_principal_message ON mentions (mentioned_principal_id, message_id);

CREATE TRIGGER messages_require_active_author
BEFORE INSERT ON messages
WHEN NOT EXISTS (
  SELECT 1 FROM channel_members member
  WHERE member.channel_id = NEW.channel_id
    AND member.principal_id = NEW.author_principal_id
    AND member.kind = NEW.author_kind
    AND member.active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'message author must be an active Channel member');
END;

CREATE TRIGGER mentions_require_active_visible_bot
BEFORE INSERT ON mentions
WHEN NOT EXISTS (
  SELECT 1 FROM channel_members member
  JOIN bots bot ON bot.id = member.principal_id
  WHERE member.channel_id = NEW.channel_id
    AND member.principal_id = NEW.mentioned_principal_id
    AND member.kind = 'bot'
    AND member.active = 1
    AND bot.lifecycle = 'active'
    AND bot.continuing_identity = 1
    AND bot.durable_mailbox = 1
)
BEGIN
  SELECT RAISE(ABORT, 'mention target must be an active visible Channel Bot');
END;

CREATE TRIGGER read_cursors_require_active_member_insert
BEFORE INSERT ON read_cursors
WHEN NOT EXISTS (
  SELECT 1 FROM channel_members member
  WHERE member.channel_id = NEW.channel_id
    AND member.principal_id = NEW.principal_id
    AND member.active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'read cursor principal must be an active Channel member');
END;

CREATE TRIGGER read_cursors_require_active_member_update
BEFORE UPDATE ON read_cursors
WHEN NOT EXISTS (
  SELECT 1 FROM channel_members member
  WHERE member.channel_id = NEW.channel_id
    AND member.principal_id = NEW.principal_id
    AND member.active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'read cursor principal must be an active Channel member');
END;

CREATE TRIGGER messages_immutable_update
BEFORE UPDATE ON messages
BEGIN
  SELECT RAISE(ABORT, 'messages are immutable');
END;

CREATE TRIGGER messages_immutable_delete
BEFORE DELETE ON messages
BEGIN
  SELECT RAISE(ABORT, 'messages are immutable');
END;

CREATE TRIGGER mentions_immutable_update
BEFORE UPDATE ON mentions
BEGIN
  SELECT RAISE(ABORT, 'mentions are immutable');
END;

CREATE TRIGGER mentions_immutable_delete
BEFORE DELETE ON mentions
BEGIN
  SELECT RAISE(ABORT, 'mentions are immutable');
END;

CREATE TRIGGER channel_members_no_delete
BEFORE DELETE ON channel_members
BEGIN
  SELECT RAISE(ABORT, 'channel membership state cannot be deleted');
END;

CREATE TRIGGER channel_membership_history_close_only
BEFORE UPDATE ON channel_membership_history
WHEN NOT (
  OLD.active = 1 AND OLD.left_channel_version IS NULL AND OLD.left_at IS NULL AND
  NEW.active = 0 AND NEW.left_channel_version IS NOT NULL AND NEW.left_at IS NOT NULL AND
  OLD.channel_id = NEW.channel_id AND OLD.principal_id = NEW.principal_id AND
  OLD.kind = NEW.kind AND OLD.role = NEW.role AND
  OLD.joined_channel_version = NEW.joined_channel_version AND OLD.joined_at = NEW.joined_at
)
BEGIN
  SELECT RAISE(ABORT, 'membership history intervals are immutable after close');
END;

CREATE TRIGGER channel_membership_history_no_delete
BEFORE DELETE ON channel_membership_history
BEGIN
  SELECT RAISE(ABORT, 'membership history intervals cannot be deleted');
END;

CREATE TRIGGER read_cursors_monotonic_update
BEFORE UPDATE ON read_cursors
WHEN NEW.read_through_sequence < OLD.read_through_sequence
BEGIN
  SELECT RAISE(ABORT, 'read cursors cannot regress');
END;

CREATE TRIGGER read_cursors_no_delete
BEFORE DELETE ON read_cursors
BEGIN
  SELECT RAISE(ABORT, 'read cursors cannot be deleted');
END;
`;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("M08 schema delta contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") {
    throw new Error("M08 schema delta contains a non-JSON value");
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

export const MESSAGING_SCHEMA_DELTA_PROPOSAL = deepFreeze({
  proposalVersion: 1,
  packageId: "M08",
  name: "canonical-messaging-v1",
  landing: { owner: "M04", status: "proposal_only", m08MustNotApply: true },
  requires: {
    coordinationSchemaVersion: 1,
    coordinationSchemaChecksum: "0ce5eee85db7fe852a6e5ef970cf81d2bbc90352cd8bf4b5e09d3d02991c7dc9",
    connectedAgentsContractVersion: 1,
    connectedAgentsContractPackSha256: "fbc20017304aed66e579a2b95facbda6bbcf8572038f7f1c0c824423c65d6be2",
    m06AuthSchemaDeltaSha256: "265444e615e74e5a824776da2083b198e283ad19bfa8d58db2b526c85bc9b795",
    m07BotDirectorySchemaDeltaSha256: "2da835b11fca4d1cadb7f98eac6cec30128a84b7f205348f718ffabc3136df6f",
  },
  sqlSha256: createHash("sha256").update(MESSAGING_SCHEMA_DELTA_SQL, "utf8").digest("hex"),
  tables: [
    "channels",
    "channel_members",
    "channel_membership_history",
    "direct_channel_pairs",
    "conversation_handles",
    "messages",
    "mentions",
    "read_cursors",
  ],
  modifiesProposedTables: [
    {
      name: "bots",
      column: "conversation_id",
      addReference: "conversation_handles(id)",
      directConversationBinding: "set once in the direct Channel creation transaction",
      authorityAdapter: "required from the M07/M04 owner; M08 supplies no Bot SQL writer",
      compositeEventContract: "channel.created payload carries botId and botVersion",
    },
    {
      name: "idempotency_records",
      replacesChecksFrom: "M06",
      principalCheck: "principal_id = 'user_owner' OR principal_id LIKE 'bot_%'",
      operations: [
        "pairing.issue",
        "pairing.redeem",
        "session.refresh",
        "session.revoke",
        "device.revoke",
        "channel.create",
        "channel.update",
        "message.append",
        "read_cursor.update",
      ],
      resultKinds: [
        "pairing",
        "pairing_failure",
        "redemption",
        "refresh",
        "refresh_failure",
        "revoke",
        "channel",
        "message",
        "read_cursor",
      ],
      rawIdempotencyKeyStored: false,
    },
  ],
  invariants: [
    "one direct channel per lexically ordered principal pair",
    "an injected M07/M04 authority adapter sets persistent Bot conversation_id exactly once in the direct Channel creation transaction",
    "that composite mutation emits channel.created with botId and botVersion so Bot and Channel projection changes share one authoritative M04 receipt",
    "group membership replacement closes an immutable versioned interval and rejoin appends a new interval so every absence remains attributable",
    "channel sequence allocation, immutable message insert, mentions, idempotency result, and authoritative event commit atomically",
    "message bodies are never updated; tombstoning appends a new immutable relation",
    "read cursors advance monotonically within channel committed sequence",
    "every Channel, Message, and read-cursor mutation records one stable idempotency result and one M04 event receipt in the same transaction",
    "Message authors are Channel members and their principal kind matches the immutable author kind at the database boundary",
    "Inbox and unread are queried from committed channels, members, messages, tombstones, and read cursors rather than a second journal",
  ],
  forbiddenStoredColumns: [
    "idempotency_key",
    "private_memory",
    "resident_context",
    "workspace_path",
    "credential",
    "secret",
  ],
  rollback: {
    beforeLanding: "remove this unconsumed proposal with M08",
    afterLanding: "disable the canonical messages epoch; preserve every channel, message, relation, and read cursor for export or later re-enable",
  },
});

export const MESSAGING_SCHEMA_DELTA_CANONICAL_JSON = canonicalJson(
  MESSAGING_SCHEMA_DELTA_PROPOSAL,
);

export const MESSAGING_SCHEMA_DELTA_SHA256 =
  "85695c952db6d1cfafa19296d48d241dbb7bf335342b534b1c76d51e24f74ae6" as const;

export function computeMessagingSchemaDeltaDigest(): string {
  return createHash("sha256")
    .update(MESSAGING_SCHEMA_DELTA_CANONICAL_JSON, "utf8")
    .digest("hex");
}
