export const COORDINATION_PRODUCT_SCHEMA_DEPENDENCIES = Object.freeze({
  coordinationSchemaV1:
    "0ce5eee85db7fe852a6e5ef970cf81d2bbc90352cd8bf4b5e09d3d02991c7dc9",
  contractPack:
    "fbc20017304aed66e579a2b95facbda6bbcf8572038f7f1c0c824423c65d6be2",
  m06AuthProposal:
    "265444e615e74e5a824776da2083b198e283ad19bfa8d58db2b526c85bc9b795",
  m07BotDirectoryProposal:
    "2da835b11fca4d1cadb7f98eac6cec30128a84b7f205348f718ffabc3136df6f",
  m08MessagingProposal:
    "85695c952db6d1cfafa19296d48d241dbb7bf335342b534b1c76d51e24f74ae6",
});

// M17 remains parked. Its later import work must target this migration's
// canonical aliases table; no legacy_aliases authority is introduced here.
export const CONNECTED_AGENTS_PRODUCT_SCHEMA_MIGRATION_SQL = `
-- coordination_schema_v1_sha256=${COORDINATION_PRODUCT_SCHEMA_DEPENDENCIES.coordinationSchemaV1}
-- connected_agents_contract_sha256=${COORDINATION_PRODUCT_SCHEMA_DEPENDENCIES.contractPack}
-- m06_auth_proposal_sha256=${COORDINATION_PRODUCT_SCHEMA_DEPENDENCIES.m06AuthProposal}
-- m07_bot_directory_proposal_sha256=${COORDINATION_PRODUCT_SCHEMA_DEPENDENCIES.m07BotDirectoryProposal}
-- m08_messaging_proposal_sha256=${COORDINATION_PRODUCT_SCHEMA_DEPENDENCIES.m08MessagingProposal}
CREATE TEMP TABLE m0002_event_history_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
) STRICT;
INSERT INTO m0002_event_history_guard (valid)
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM events
  GROUP BY aggregate_kind, aggregate_id
  HAVING min(aggregate_version) <> 1 OR max(aggregate_version) <> count(*)
) THEN 0 ELSE 1 END;
DROP TABLE m0002_event_history_guard;

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('owner', 'bot')),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  CHECK (
    (id = 'user_owner' AND kind = 'owner') OR
    (id LIKE 'bot_%' AND kind = 'bot')
  )
) STRICT;

CREATE TABLE pairing_sessions (
  id TEXT PRIMARY KEY,
  requested_device_name TEXT NOT NULL CHECK (
    length(requested_device_name) BETWEEN 1 AND 128
  ),
  code_verifier TEXT NOT NULL CHECK (
    length(code_verifier) = 83 AND code_verifier LIKE 'scrypt$16384$8$1$%'
  ),
  state TEXT NOT NULL CHECK (state IN ('pending', 'redeemed', 'expired', 'locked')),
  failed_attempts INTEGER NOT NULL CHECK (failed_attempts BETWEEN 0 AND 5),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  expires_at TEXT NOT NULL CHECK (length(expires_at) = 24),
  redeemed_at TEXT CHECK (redeemed_at IS NULL OR length(redeemed_at) = 24),
  CHECK (
    (state = 'redeemed' AND redeemed_at IS NOT NULL) OR
    (state <> 'redeemed' AND redeemed_at IS NULL)
  )
) STRICT;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) CHECK (
    principal_id = 'user_owner'
  ),
  platform TEXT NOT NULL CHECK (platform IN ('macos', 'ios')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  app_build TEXT NOT NULL CHECK (length(app_build) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  last_seen_at TEXT NOT NULL CHECK (length(last_seen_at) = 24),
  revoked_at TEXT CHECK (revoked_at IS NULL OR length(revoked_at) = 24),
  CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL) OR
    (status = 'active' AND revoked_at IS NULL)
  )
) STRICT;

CREATE TABLE client_sessions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  principal_id TEXT NOT NULL REFERENCES principals(id) CHECK (
    principal_id = 'user_owner'
  ),
  family_id TEXT NOT NULL CHECK (length(family_id) = 22),
  state TEXT NOT NULL CHECK (state IN (
    'pairing_pending', 'paired', 'active', 'expired', 'revoked', 'rotated'
  )),
  scopes_json TEXT NOT NULL CHECK (
    json_valid(scopes_json) AND json_type(scopes_json) = 'array'
  ),
  access_expires_at TEXT NOT NULL CHECK (length(access_expires_at) = 24),
  refresh_expires_at TEXT NOT NULL CHECK (length(refresh_expires_at) = 24),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  rotated_at TEXT CHECK (rotated_at IS NULL OR length(rotated_at) = 24),
  rotated_to_session_id TEXT REFERENCES client_sessions(id),
  revoked_at TEXT CHECK (revoked_at IS NULL OR length(revoked_at) = 24),
  revoke_reason TEXT CHECK (
    revoke_reason IS NULL OR
    revoke_reason IN ('refresh_replay', 'session_revoke', 'device_revoke')
  ),
  CHECK (
    (state = 'rotated' AND rotated_at IS NOT NULL AND
      rotated_to_session_id IS NOT NULL) OR state <> 'rotated'
  ),
  CHECK (
    (state = 'revoked' AND revoked_at IS NOT NULL AND
      revoke_reason IS NOT NULL) OR state <> 'revoked'
  )
) STRICT;

CREATE TABLE session_refresh_tokens (
  token_id TEXT PRIMARY KEY CHECK (length(token_id) = 22),
  family_id TEXT NOT NULL CHECK (length(family_id) = 22),
  session_id TEXT NOT NULL UNIQUE REFERENCES client_sessions(id),
  token_digest TEXT NOT NULL UNIQUE CHECK (length(token_digest) = 64),
  state TEXT NOT NULL CHECK (state IN ('active', 'expired', 'revoked', 'rotated')),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  expires_at TEXT NOT NULL CHECK (length(expires_at) = 24),
  rotated_at TEXT CHECK (rotated_at IS NULL OR length(rotated_at) = 24),
  rotated_to_token_id TEXT REFERENCES session_refresh_tokens(token_id),
  revoked_at TEXT CHECK (revoked_at IS NULL OR length(revoked_at) = 24),
  revoke_reason TEXT CHECK (
    revoke_reason IS NULL OR
    revoke_reason IN ('refresh_replay', 'session_revoke', 'device_revoke')
  ),
  CHECK (
    (state = 'rotated' AND rotated_at IS NOT NULL AND
      rotated_to_token_id IS NOT NULL) OR state <> 'rotated'
  ),
  CHECK (
    (state = 'revoked' AND revoked_at IS NOT NULL AND
      revoke_reason IS NOT NULL) OR state <> 'revoked'
  )
) STRICT;

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
  UNIQUE (principal_id, operation, idempotency_key_digest),
  CHECK (
    result_kind NOT IN ('channel', 'message', 'read_cursor') OR coalesce((
      json_type(result_ref_json, '$.eventReference') = 'object' AND
      json_type(result_ref_json, '$.eventReference.aggregateKind') = 'text' AND
      json_type(result_ref_json, '$.eventReference.aggregateId') = 'text' AND
      json_type(result_ref_json, '$.eventReference.aggregateVersion') = 'integer' AND
      json_extract(result_ref_json, '$.eventReference.aggregateVersion') >= 1
    ), 0)
  )
) STRICT;

CREATE TABLE channels (
  id TEXT PRIMARY KEY CHECK (id LIKE 'chn_%'),
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  purpose TEXT NOT NULL CHECK (length(purpose) <= 4000),
  owner_principal_id TEXT NOT NULL REFERENCES principals(id) CHECK (
    owner_principal_id = 'user_owner'
  ),
  responder_mode TEXT NOT NULL CHECK (
    responder_mode IN ('mentions_only', 'mention_or_coordinator')
  ),
  coordinator_bot_id TEXT CHECK (
    coordinator_bot_id IS NULL OR coordinator_bot_id LIKE 'bot_%'
  ),
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

CREATE TABLE conversation_handles (
  id TEXT PRIMARY KEY CHECK (id LIKE 'cnv_%'),
  channel_id TEXT NOT NULL UNIQUE REFERENCES channels(id),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24)
) STRICT;

CREATE TABLE bots (
  id TEXT PRIMARY KEY CHECK (id LIKE 'bot_%'),
  principal_id TEXT NOT NULL UNIQUE REFERENCES principals(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 512),
  lifecycle TEXT NOT NULL CHECK (
    lifecycle IN ('provisioning', 'active', 'archived', 'failed')
  ),
  conversation_id TEXT REFERENCES conversation_handles(id) CHECK (
    conversation_id IS NULL OR conversation_id LIKE 'cnv_%'
  ),
  resident_binding TEXT NOT NULL UNIQUE CHECK (
    length(resident_binding) BETWEEN 1 AND 63
  ),
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

CREATE TABLE aliases (
  id TEXT PRIMARY KEY CHECK (id LIKE 'alias_%'),
  namespace TEXT NOT NULL CHECK (length(namespace) BETWEEN 1 AND 64),
  alias_digest TEXT NOT NULL CHECK (length(alias_digest) = 64),
  target_type TEXT NOT NULL CHECK (length(target_type) BETWEEN 1 AND 32),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 64),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
  UNIQUE (namespace, alias_digest)
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
    (active = 1 AND left_at IS NULL) OR
    (active = 0 AND left_at IS NOT NULL)
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

CREATE TABLE messages (
  id TEXT PRIMARY KEY CHECK (id LIKE 'msg_%'),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  channel_sequence INTEGER NOT NULL CHECK (channel_sequence >= 1),
  author_principal_id TEXT NOT NULL REFERENCES principals(id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('owner', 'bot')),
  author_display_name TEXT NOT NULL CHECK (
    length(author_display_name) BETWEEN 1 AND 128
  ),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'system', 'result')),
  body_text TEXT,
  stored_visibility TEXT NOT NULL CHECK (
    stored_visibility IN ('visible', 'tombstoned')
  ),
  client_message_id TEXT CHECK (
    client_message_id IS NULL OR length(client_message_id) BETWEEN 1 AND 128
  ),
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
  CHECK (
    tombstones_message_id IS NULL OR (kind = 'system' AND body_text IS NULL)
  )
) STRICT;

CREATE TABLE mentions (
  message_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  mentioned_principal_id TEXT NOT NULL CHECK (mentioned_principal_id LIKE 'bot_%'),
  PRIMARY KEY (message_id, mentioned_principal_id),
  FOREIGN KEY (message_id, channel_id) REFERENCES messages(id, channel_id),
  FOREIGN KEY (channel_id, mentioned_principal_id)
    REFERENCES channel_members(channel_id, principal_id)
) STRICT;

CREATE TABLE read_cursors (
  principal_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  read_through_sequence INTEGER NOT NULL CHECK (read_through_sequence >= 0),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
  PRIMARY KEY (principal_id, channel_id),
  FOREIGN KEY (channel_id, principal_id)
    REFERENCES channel_members(channel_id, principal_id)
) STRICT;

CREATE INDEX pairing_sessions_state_expiry
  ON pairing_sessions (state, expires_at);
CREATE INDEX devices_principal_status ON devices (principal_id, status);
CREATE INDEX client_sessions_device_state ON client_sessions (device_id, state);
CREATE INDEX client_sessions_family_state ON client_sessions (family_id, state);
CREATE INDEX session_refresh_tokens_family_state
  ON session_refresh_tokens (family_id, state);
CREATE INDEX idempotency_records_created_at ON idempotency_records (created_at);
CREATE INDEX bots_lifecycle_name ON bots (lifecycle, name, id);
CREATE INDEX bots_heartbeat ON bots (last_heartbeat_at);
CREATE INDEX aliases_target ON aliases (target_type, target_id, active);
CREATE INDEX channels_inbox_order ON channels (pinned DESC, updated_at DESC, id);
CREATE INDEX channel_members_principal
  ON channel_members (principal_id, active, channel_id);
CREATE UNIQUE INDEX channel_membership_history_active
  ON channel_membership_history (channel_id, principal_id) WHERE active = 1;
CREATE INDEX channel_membership_history_principal
  ON channel_membership_history (principal_id, channel_id, joined_channel_version);
CREATE INDEX messages_channel_sequence_desc
  ON messages (channel_id, channel_sequence DESC);
CREATE INDEX messages_reply ON messages (reply_to_message_id);
CREATE INDEX messages_tombstone ON messages (tombstones_message_id);
CREATE INDEX mentions_principal_message
  ON mentions (mentioned_principal_id, message_id);

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
