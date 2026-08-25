import { createHash } from "node:crypto";

export const WORK_SCHEMA_DELTA_SQL = `
CREATE TABLE context_manifests (
  id TEXT PRIMARY KEY CHECK (id LIKE 'ctx_%'),
  privacy TEXT NOT NULL CHECK (privacy = 'channel_only'),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  message_refs_json TEXT NOT NULL CHECK (
    json_valid(message_refs_json) AND json_type(message_refs_json) = 'array'
  ),
  artifact_refs_json TEXT NOT NULL CHECK (
    json_valid(artifact_refs_json) AND json_type(artifact_refs_json) = 'array'
  ),
  message_count INTEGER NOT NULL CHECK (message_count >= 0),
  artifact_count INTEGER NOT NULL CHECK (artifact_count >= 0),
  channel_watermark INTEGER NOT NULL CHECK (channel_watermark >= 0),
  event_watermark INTEGER NOT NULL CHECK (event_watermark >= 0),
  context_digest TEXT NOT NULL CHECK (length(context_digest) = 64),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  CHECK (json_array_length(message_refs_json) = message_count),
  CHECK (json_array_length(artifact_refs_json) = artifact_count)
) STRICT;

CREATE TABLE rounds (
  id TEXT PRIMARY KEY CHECK (id LIKE 'rnd_%'),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  coordinator_bot_id TEXT NOT NULL REFERENCES bots(id) CHECK (coordinator_bot_id LIKE 'bot_%'),
  state TEXT NOT NULL CHECK (state IN (
    'open', 'coordinating', 'waiting', 'completed', 'failed', 'cancelled'
  )),
  max_bot_turns INTEGER NOT NULL CHECK (max_bot_turns BETWEEN 1 AND 8),
  pass_count INTEGER NOT NULL CHECK (pass_count >= 0 AND pass_count <= max_bot_turns),
  deadline_at TEXT NOT NULL CHECK (length(deadline_at) = 24),
  terminal_reason TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
  terminal_at TEXT CHECK (terminal_at IS NULL OR length(terminal_at) = 24),
  CHECK (
    (state IN ('completed', 'failed', 'cancelled') AND terminal_reason IS NOT NULL AND terminal_at IS NOT NULL) OR
    (state NOT IN ('completed', 'failed', 'cancelled') AND terminal_reason IS NULL AND terminal_at IS NULL)
  )
) STRICT;

CREATE TABLE works (
  id TEXT PRIMARY KEY CHECK (id LIKE 'wrk_%'),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  target_principal_id TEXT NOT NULL REFERENCES principals(id) CHECK (target_principal_id LIKE 'bot_%'),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  origin_message_id TEXT REFERENCES messages(id),
  round_id TEXT REFERENCES rounds(id),
  context_manifest_id TEXT NOT NULL UNIQUE REFERENCES context_manifests(id),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
  idempotency_key_digest TEXT NOT NULL CHECK (length(idempotency_key_digest) = 64),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'leased', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled'
  )),
  current_attempt_id TEXT REFERENCES attempts(id),
  next_fencing_token INTEGER NOT NULL CHECK (next_fencing_token >= 1),
  automatic_offer_count INTEGER NOT NULL CHECK (automatic_offer_count >= 0),
  max_automatic_offers INTEGER NOT NULL CHECK (max_automatic_offers BETWEEN 1 AND 16),
  terminal_reason TEXT,
  terminal_receipt_digest TEXT CHECK (
    terminal_receipt_digest IS NULL OR length(terminal_receipt_digest) = 64
  ),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
  terminal_at TEXT CHECK (terminal_at IS NULL OR length(terminal_at) = 24),
  UNIQUE (principal_id, idempotency_key_digest),
  CHECK (
    (state IN ('succeeded', 'failed', 'cancelled') AND terminal_reason IS NOT NULL AND terminal_at IS NOT NULL) OR
    (state NOT IN ('succeeded', 'failed', 'cancelled') AND terminal_reason IS NULL AND terminal_at IS NULL)
  )
) STRICT;

CREATE TABLE attempts (
  id TEXT PRIMARY KEY CHECK (id LIKE 'att_%'),
  work_id TEXT NOT NULL REFERENCES works(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  holder_principal_id TEXT NOT NULL REFERENCES principals(id) CHECK (holder_principal_id LIKE 'bot_%'),
  holder_instance_id TEXT NOT NULL CHECK (length(holder_instance_id) BETWEEN 1 AND 128),
  authority_reference TEXT NOT NULL CHECK (length(authority_reference) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK (state IN (
    'created', 'offered', 'accepted', 'running', 'cancel_requested',
    'succeeded', 'failed', 'cancelled', 'expired', 'rejected', 'abandoned'
  )),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  rejected_evidence_count INTEGER NOT NULL CHECK (rejected_evidence_count BETWEEN 0 AND 32),
  version INTEGER NOT NULL CHECK (version >= 1),
  offered_at TEXT NOT NULL CHECK (length(offered_at) = 24),
  accepted_at TEXT CHECK (accepted_at IS NULL OR length(accepted_at) = 24),
  started_at TEXT CHECK (started_at IS NULL OR length(started_at) = 24),
  ended_at TEXT CHECK (ended_at IS NULL OR length(ended_at) = 24),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
  UNIQUE (work_id, ordinal),
  UNIQUE (work_id, fencing_token)
) STRICT;

CREATE UNIQUE INDEX attempts_one_live_per_work
ON attempts (work_id)
WHERE state IN ('created', 'offered', 'accepted', 'running', 'cancel_requested');
CREATE INDEX attempts_work_history ON attempts (work_id, ordinal);

CREATE TABLE leases (
  id TEXT PRIMARY KEY CHECK (id LIKE 'lse_%'),
  work_id TEXT NOT NULL REFERENCES works(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
  holder_principal_id TEXT NOT NULL REFERENCES principals(id) CHECK (holder_principal_id LIKE 'bot_%'),
  holder_instance_id TEXT NOT NULL CHECK (length(holder_instance_id) BETWEEN 1 AND 128),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  state TEXT NOT NULL CHECK (state IN ('offered', 'active', 'released', 'expired', 'revoked')),
  issued_at TEXT NOT NULL CHECK (length(issued_at) = 24),
  heartbeat_at TEXT NOT NULL CHECK (length(heartbeat_at) = 24),
  expires_at TEXT NOT NULL CHECK (length(expires_at) = 24),
  ended_at TEXT CHECK (ended_at IS NULL OR length(ended_at) = 24),
  reason_code TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  UNIQUE (work_id, fencing_token)
) STRICT;

CREATE UNIQUE INDEX leases_one_live_per_work
ON leases (work_id)
WHERE state IN ('offered', 'active');
CREATE INDEX leases_expiry ON leases (state, expires_at);

CREATE TABLE terminal_receipts (
  work_id TEXT PRIMARY KEY REFERENCES works(id),
  attempt_id TEXT UNIQUE REFERENCES attempts(id),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
  terminal_status TEXT NOT NULL CHECK (terminal_status IN ('succeeded', 'failed', 'cancelled')),
  source_reference TEXT NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 256),
  result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64),
  artifact_refs_json TEXT NOT NULL CHECK (
    json_valid(artifact_refs_json) AND json_type(artifact_refs_json) = 'array'
  ),
  receipt_digest TEXT NOT NULL UNIQUE CHECK (length(receipt_digest) = 64),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  CHECK (
    (attempt_id IS NULL AND fencing_token = 0 AND terminal_status = 'cancelled') OR
    (attempt_id IS NOT NULL AND fencing_token >= 1)
  )
) STRICT;

CREATE TABLE work_observations (
  id TEXT PRIMARY KEY CHECK (id LIKE 'obs_%'),
  work_id TEXT NOT NULL REFERENCES works(id),
  attempt_id TEXT REFERENCES attempts(id),
  authority_reference TEXT NOT NULL CHECK (length(authority_reference) BETWEEN 1 AND 256),
  holder_instance_id TEXT NOT NULL CHECK (length(holder_instance_id) BETWEEN 1 AND 128),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
  observation_kind TEXT NOT NULL CHECK (observation_kind IN (
    'terminal', 'not_started', 'running', 'rejected_fence'
  )),
  outcome_code TEXT NOT NULL CHECK (length(outcome_code) BETWEEN 1 AND 64),
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24)
) STRICT;
CREATE INDEX work_observations_bounded_history ON work_observations (work_id, created_at, id);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY CHECK (id LIKE 'obx_%'),
  kind TEXT NOT NULL CHECK (kind IN ('work.wake', 'work.terminal')),
  aggregate_kind TEXT NOT NULL CHECK (aggregate_kind = 'work'),
  aggregate_id TEXT NOT NULL REFERENCES works(id),
  destination_reference TEXT NOT NULL CHECK (length(destination_reference) BETWEEN 1 AND 256),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
  endpoint_idempotency_key TEXT NOT NULL UNIQUE CHECK (length(endpoint_idempotency_key) = 64),
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'retry', 'delivered', 'dead_letter')),
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 16),
  not_before TEXT NOT NULL CHECK (length(not_before) = 24),
  claimed_by TEXT CHECK (claimed_by IS NULL OR length(claimed_by) BETWEEN 1 AND 128),
  claim_expires_at TEXT CHECK (claim_expires_at IS NULL OR length(claim_expires_at) = 24),
  claim_epoch INTEGER NOT NULL DEFAULT 0 CHECK (claim_epoch >= 0),
  active_claim_kind TEXT CHECK (active_claim_kind IS NULL OR active_claim_kind IN ('ordinary', 'duplicate_probe')),
  recovery_probe_count INTEGER NOT NULL DEFAULT 0 CHECK (recovery_probe_count BETWEEN 0 AND 1),
  last_error_code TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
  delivered_at TEXT CHECK (delivered_at IS NULL OR length(delivered_at) = 24),
  UNIQUE (kind, aggregate_id)
) STRICT;
CREATE INDEX outbox_claimable ON outbox (state, not_before, id);
CREATE INDEX outbox_stale_claims ON outbox (state, claim_expires_at);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY CHECK (id LIKE 'dlv_%'),
  outbox_id TEXT NOT NULL UNIQUE REFERENCES outbox(id),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'sending', 'delivered', 'retry_wait', 'permanent_failure', 'cancelled'
  )),
  endpoint_idempotency_key TEXT NOT NULL CHECK (length(endpoint_idempotency_key) = 64),
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  active_claim_epoch INTEGER CHECK (active_claim_epoch IS NULL OR active_claim_epoch >= 1),
  final_disposition TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
  terminal_at TEXT CHECK (terminal_at IS NULL OR length(terminal_at) = 24)
) STRICT;

CREATE TABLE delivery_attempts (
  delivery_id TEXT NOT NULL REFERENCES deliveries(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  claim_epoch INTEGER NOT NULL CHECK (claim_epoch >= 1),
  claim_kind TEXT NOT NULL CHECK (claim_kind IN ('ordinary', 'duplicate_probe')),
  endpoint_idempotency_key TEXT NOT NULL CHECK (length(endpoint_idempotency_key) = 64),
  claimant TEXT NOT NULL CHECK (length(claimant) BETWEEN 1 AND 128),
  started_at TEXT NOT NULL CHECK (length(started_at) = 24),
  settled_at TEXT CHECK (settled_at IS NULL OR length(settled_at) = 24),
  disposition TEXT CHECK (disposition IS NULL OR disposition IN (
    'accepted', 'duplicate_accepted', 'retryable_failure', 'permanent_failure', 'claim_expired'
  )),
  error_code TEXT,
  PRIMARY KEY (delivery_id, ordinal),
  UNIQUE (delivery_id, claim_epoch)
) STRICT;

CREATE TRIGGER context_manifests_no_update
BEFORE UPDATE ON context_manifests BEGIN SELECT RAISE(ABORT, 'context manifest is immutable'); END;
CREATE TRIGGER context_manifests_no_delete
BEFORE DELETE ON context_manifests BEGIN SELECT RAISE(ABORT, 'context manifest is retained'); END;
CREATE TRIGGER rounds_terminal_immutable
BEFORE UPDATE ON rounds WHEN OLD.state IN ('completed', 'failed', 'cancelled')
BEGIN SELECT RAISE(ABORT, 'terminal Round is immutable'); END;
CREATE TRIGGER works_terminal_immutable
BEFORE UPDATE ON works WHEN OLD.state IN ('succeeded', 'failed', 'cancelled')
BEGIN SELECT RAISE(ABORT, 'terminal Work is immutable'); END;
CREATE TRIGGER attempts_terminal_immutable
BEFORE UPDATE ON attempts WHEN OLD.state IN ('succeeded', 'failed', 'cancelled', 'expired', 'rejected', 'abandoned')
BEGIN SELECT RAISE(ABORT, 'terminal Attempt is immutable'); END;
CREATE TRIGGER leases_terminal_immutable
BEFORE UPDATE ON leases WHEN OLD.state IN ('released', 'expired', 'revoked')
BEGIN SELECT RAISE(ABORT, 'terminal Lease is immutable'); END;
CREATE TRIGGER terminal_receipts_no_update
BEFORE UPDATE ON terminal_receipts BEGIN SELECT RAISE(ABORT, 'terminal receipt is immutable'); END;
CREATE TRIGGER terminal_receipts_no_delete
BEFORE DELETE ON terminal_receipts BEGIN SELECT RAISE(ABORT, 'terminal receipt is retained'); END;
CREATE TRIGGER work_observations_no_update
BEFORE UPDATE ON work_observations BEGIN SELECT RAISE(ABORT, 'work observation is immutable'); END;
CREATE TRIGGER outbox_terminal_immutable
BEFORE UPDATE ON outbox WHEN OLD.state IN ('delivered', 'dead_letter')
BEGIN SELECT RAISE(ABORT, 'terminal Outbox is immutable'); END;
CREATE TRIGGER deliveries_terminal_immutable
BEFORE UPDATE ON deliveries WHEN OLD.state IN ('delivered', 'permanent_failure', 'cancelled')
BEGIN SELECT RAISE(ABORT, 'terminal Delivery is immutable'); END;
CREATE TRIGGER delivery_attempt_final_immutable
BEFORE UPDATE ON delivery_attempts WHEN OLD.disposition IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'settled delivery attempt is immutable'); END;

CREATE TRIGGER attempts_fields_insert
BEFORE INSERT ON attempts WHEN NOT (
  (NEW.state IN ('created', 'offered') AND NEW.accepted_at IS NULL AND NEW.started_at IS NULL AND NEW.ended_at IS NULL) OR
  (NEW.state = 'accepted' AND NEW.accepted_at IS NOT NULL AND NEW.started_at IS NULL AND NEW.ended_at IS NULL) OR
  (NEW.state IN ('running', 'cancel_requested') AND NEW.accepted_at IS NOT NULL AND NEW.started_at IS NOT NULL AND NEW.ended_at IS NULL) OR
  (NEW.state IN ('succeeded', 'failed', 'cancelled') AND NEW.accepted_at IS NOT NULL AND NEW.started_at IS NOT NULL AND NEW.ended_at IS NOT NULL) OR
  (NEW.state = 'expired' AND NEW.accepted_at IS NOT NULL AND NEW.started_at IS NULL AND NEW.ended_at IS NOT NULL) OR
  (NEW.state IN ('rejected', 'abandoned') AND NEW.accepted_at IS NULL AND NEW.started_at IS NULL AND NEW.ended_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT, 'Attempt fields are incoherent'); END;
CREATE TRIGGER attempts_fields_update
BEFORE UPDATE ON attempts WHEN NOT (
  (NEW.state IN ('created', 'offered') AND NEW.accepted_at IS NULL AND NEW.started_at IS NULL AND NEW.ended_at IS NULL) OR
  (NEW.state = 'accepted' AND NEW.accepted_at IS NOT NULL AND NEW.started_at IS NULL AND NEW.ended_at IS NULL) OR
  (NEW.state IN ('running', 'cancel_requested') AND NEW.accepted_at IS NOT NULL AND NEW.started_at IS NOT NULL AND NEW.ended_at IS NULL) OR
  (NEW.state IN ('succeeded', 'failed', 'cancelled') AND NEW.accepted_at IS NOT NULL AND NEW.started_at IS NOT NULL AND NEW.ended_at IS NOT NULL) OR
  (NEW.state = 'expired' AND NEW.accepted_at IS NOT NULL AND NEW.started_at IS NULL AND NEW.ended_at IS NOT NULL) OR
  (NEW.state IN ('rejected', 'abandoned') AND NEW.accepted_at IS NULL AND NEW.started_at IS NULL AND NEW.ended_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT, 'Attempt fields are incoherent'); END;

CREATE TRIGGER leases_fields_insert
BEFORE INSERT ON leases WHEN NOT (
  (NEW.state IN ('offered', 'active') AND NEW.ended_at IS NULL AND NEW.reason_code IS NULL) OR
  (NEW.state IN ('released', 'expired', 'revoked') AND NEW.ended_at IS NOT NULL AND NEW.reason_code IS NOT NULL)
) BEGIN SELECT RAISE(ABORT, 'Lease fields are incoherent'); END;
CREATE TRIGGER leases_fields_update
BEFORE UPDATE ON leases WHEN NOT (
  (NEW.state IN ('offered', 'active') AND NEW.ended_at IS NULL AND NEW.reason_code IS NULL) OR
  (NEW.state IN ('released', 'expired', 'revoked') AND NEW.ended_at IS NOT NULL AND NEW.reason_code IS NOT NULL)
) BEGIN SELECT RAISE(ABORT, 'Lease fields are incoherent'); END;

CREATE TRIGGER outbox_fields_insert
BEFORE INSERT ON outbox WHEN NOT (
  NEW.claim_epoch = NEW.attempt_count + NEW.recovery_probe_count AND
  ((NEW.state = 'claimed' AND NEW.claimed_by IS NOT NULL AND NEW.claim_expires_at IS NOT NULL AND NEW.active_claim_kind IS NOT NULL) OR
   (NEW.state <> 'claimed' AND NEW.claimed_by IS NULL AND NEW.claim_expires_at IS NULL AND NEW.active_claim_kind IS NULL)) AND
  ((NEW.state = 'delivered' AND NEW.delivered_at IS NOT NULL) OR
   (NEW.state <> 'delivered' AND NEW.delivered_at IS NULL)) AND
  (NEW.active_claim_kind <> 'duplicate_probe' OR
   (NEW.recovery_probe_count = 1 AND NEW.attempt_count >= NEW.max_attempts))
) BEGIN SELECT RAISE(ABORT, 'Outbox fields are incoherent'); END;
CREATE TRIGGER outbox_fields_update
BEFORE UPDATE ON outbox WHEN NOT (
  NEW.claim_epoch = NEW.attempt_count + NEW.recovery_probe_count AND
  ((NEW.state = 'claimed' AND NEW.claimed_by IS NOT NULL AND NEW.claim_expires_at IS NOT NULL AND NEW.active_claim_kind IS NOT NULL) OR
   (NEW.state <> 'claimed' AND NEW.claimed_by IS NULL AND NEW.claim_expires_at IS NULL AND NEW.active_claim_kind IS NULL)) AND
  ((NEW.state = 'delivered' AND NEW.delivered_at IS NOT NULL) OR
   (NEW.state <> 'delivered' AND NEW.delivered_at IS NULL)) AND
  (NEW.active_claim_kind <> 'duplicate_probe' OR
   (NEW.recovery_probe_count = 1 AND NEW.attempt_count >= NEW.max_attempts))
) BEGIN SELECT RAISE(ABORT, 'Outbox fields are incoherent'); END;

CREATE TRIGGER deliveries_fields_insert
BEFORE INSERT ON deliveries WHEN NOT (
  (NEW.state IN ('pending', 'retry_wait') AND NEW.active_claim_epoch IS NULL AND NEW.final_disposition IS NULL AND NEW.terminal_at IS NULL) OR
  (NEW.state = 'sending' AND NEW.active_claim_epoch IS NOT NULL AND NEW.final_disposition IS NULL AND NEW.terminal_at IS NULL) OR
  (NEW.state = 'delivered' AND NEW.active_claim_epoch IS NULL AND NEW.final_disposition IN ('accepted', 'duplicate_accepted') AND NEW.terminal_at IS NOT NULL) OR
  (NEW.state IN ('permanent_failure', 'cancelled') AND NEW.active_claim_epoch IS NULL AND NEW.final_disposition IS NOT NULL AND NEW.terminal_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT, 'Delivery fields are incoherent'); END;
CREATE TRIGGER deliveries_fields_update
BEFORE UPDATE ON deliveries WHEN NOT (
  (NEW.state IN ('pending', 'retry_wait') AND NEW.active_claim_epoch IS NULL AND NEW.final_disposition IS NULL AND NEW.terminal_at IS NULL) OR
  (NEW.state = 'sending' AND NEW.active_claim_epoch IS NOT NULL AND NEW.final_disposition IS NULL AND NEW.terminal_at IS NULL) OR
  (NEW.state = 'delivered' AND NEW.active_claim_epoch IS NULL AND NEW.final_disposition IN ('accepted', 'duplicate_accepted') AND NEW.terminal_at IS NOT NULL) OR
  (NEW.state IN ('permanent_failure', 'cancelled') AND NEW.active_claim_epoch IS NULL AND NEW.final_disposition IS NOT NULL AND NEW.terminal_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT, 'Delivery fields are incoherent'); END;

CREATE TRIGGER delivery_attempts_fields_insert
BEFORE INSERT ON delivery_attempts WHEN NOT (
  (NEW.disposition IS NULL AND NEW.settled_at IS NULL AND NEW.error_code IS NULL) OR
  (NEW.disposition IN ('accepted', 'duplicate_accepted') AND NEW.settled_at IS NOT NULL AND NEW.error_code IS NULL) OR
  (NEW.disposition IN ('retryable_failure', 'permanent_failure', 'claim_expired') AND NEW.settled_at IS NOT NULL AND NEW.error_code IS NOT NULL)
) BEGIN SELECT RAISE(ABORT, 'Delivery attempt fields are incoherent'); END;
CREATE TRIGGER delivery_attempts_fields_update
BEFORE UPDATE ON delivery_attempts WHEN NOT (
  (NEW.disposition IS NULL AND NEW.settled_at IS NULL AND NEW.error_code IS NULL) OR
  (NEW.disposition IN ('accepted', 'duplicate_accepted') AND NEW.settled_at IS NOT NULL AND NEW.error_code IS NULL) OR
  (NEW.disposition IN ('retryable_failure', 'permanent_failure', 'claim_expired') AND NEW.settled_at IS NOT NULL AND NEW.error_code IS NOT NULL)
) BEGIN SELECT RAISE(ABORT, 'Delivery attempt fields are incoherent'); END;

CREATE TRIGGER works_current_attempt_insert
BEFORE INSERT ON works WHEN NOT (
  (NEW.state = 'queued' AND NEW.current_attempt_id IS NULL) OR
  (NEW.state IN ('leased', 'running', 'cancelling') AND NEW.current_attempt_id IS NOT NULL AND
   EXISTS (SELECT 1 FROM attempts a WHERE a.id = NEW.current_attempt_id AND a.work_id = NEW.id)) OR
  (NEW.state IN ('succeeded', 'failed') AND NEW.current_attempt_id IS NOT NULL AND
   EXISTS (SELECT 1 FROM attempts a WHERE a.id = NEW.current_attempt_id AND a.work_id = NEW.id)) OR
  (NEW.state = 'cancelled' AND (NEW.current_attempt_id IS NULL OR
   EXISTS (SELECT 1 FROM attempts a WHERE a.id = NEW.current_attempt_id AND a.work_id = NEW.id)))
) BEGIN SELECT RAISE(ABORT, 'Work current Attempt is inconsistent'); END;
CREATE TRIGGER works_current_attempt_update
BEFORE UPDATE ON works WHEN NOT (
  (NEW.state = 'queued' AND NEW.current_attempt_id IS NULL) OR
  (NEW.state IN ('leased', 'running', 'cancelling') AND NEW.current_attempt_id IS NOT NULL AND
   EXISTS (SELECT 1 FROM attempts a WHERE a.id = NEW.current_attempt_id AND a.work_id = NEW.id)) OR
  (NEW.state IN ('succeeded', 'failed') AND NEW.current_attempt_id IS NOT NULL AND
   EXISTS (SELECT 1 FROM attempts a WHERE a.id = NEW.current_attempt_id AND a.work_id = NEW.id)) OR
  (NEW.state = 'cancelled' AND (NEW.current_attempt_id IS NULL OR
   EXISTS (SELECT 1 FROM attempts a WHERE a.id = NEW.current_attempt_id AND a.work_id = NEW.id)))
) BEGIN SELECT RAISE(ABORT, 'Work current Attempt is inconsistent'); END;

CREATE TRIGGER leases_binding_insert
BEFORE INSERT ON leases WHEN NOT EXISTS (
  SELECT 1 FROM attempts a WHERE a.id = NEW.attempt_id AND a.work_id = NEW.work_id
    AND a.holder_principal_id = NEW.holder_principal_id
    AND a.holder_instance_id = NEW.holder_instance_id
    AND a.fencing_token = NEW.fencing_token
) BEGIN SELECT RAISE(ABORT, 'Lease binding is inconsistent'); END;
CREATE TRIGGER leases_binding_update
BEFORE UPDATE ON leases WHEN NOT EXISTS (
  SELECT 1 FROM attempts a WHERE a.id = NEW.attempt_id AND a.work_id = NEW.work_id
    AND a.holder_principal_id = NEW.holder_principal_id
    AND a.holder_instance_id = NEW.holder_instance_id
    AND a.fencing_token = NEW.fencing_token
) BEGIN SELECT RAISE(ABORT, 'Lease binding is inconsistent'); END;

CREATE TRIGGER terminal_receipts_binding_insert
BEFORE INSERT ON terminal_receipts WHEN NOT (
  (NEW.attempt_id IS NULL AND NEW.fencing_token = 0 AND NEW.terminal_status = 'cancelled') OR
  EXISTS (SELECT 1 FROM attempts a WHERE a.id = NEW.attempt_id AND a.work_id = NEW.work_id
    AND a.fencing_token = NEW.fencing_token)
) BEGIN SELECT RAISE(ABORT, 'terminal receipt binding is inconsistent'); END;

CREATE TRIGGER deliveries_binding_insert
BEFORE INSERT ON deliveries WHEN NOT EXISTS (
  SELECT 1 FROM outbox o WHERE o.id = NEW.outbox_id
    AND o.endpoint_idempotency_key = NEW.endpoint_idempotency_key
    AND ((NEW.state = 'sending' AND NEW.active_claim_epoch = o.claim_epoch AND o.state = 'claimed') OR
         (NEW.state <> 'sending' AND NEW.active_claim_epoch IS NULL))
) BEGIN SELECT RAISE(ABORT, 'Delivery binding is inconsistent'); END;
CREATE TRIGGER deliveries_binding_update
BEFORE UPDATE ON deliveries WHEN NOT EXISTS (
  SELECT 1 FROM outbox o WHERE o.id = NEW.outbox_id
    AND o.endpoint_idempotency_key = NEW.endpoint_idempotency_key
    AND ((NEW.state = 'sending' AND NEW.active_claim_epoch = o.claim_epoch AND o.state = 'claimed') OR
         (NEW.state <> 'sending' AND NEW.active_claim_epoch IS NULL))
) BEGIN SELECT RAISE(ABORT, 'Delivery binding is inconsistent'); END;

CREATE TRIGGER delivery_attempts_binding_insert
BEFORE INSERT ON delivery_attempts WHEN NOT EXISTS (
  SELECT 1 FROM deliveries d JOIN outbox o ON o.id = d.outbox_id
  WHERE d.id = NEW.delivery_id
    AND d.endpoint_idempotency_key = NEW.endpoint_idempotency_key
    AND o.endpoint_idempotency_key = NEW.endpoint_idempotency_key
    AND ((NEW.disposition IS NULL AND d.active_claim_epoch = NEW.claim_epoch
          AND o.state = 'claimed' AND o.claim_epoch = NEW.claim_epoch) OR
         (NEW.disposition IS NOT NULL AND NEW.ordinal <= d.attempt_count
          AND NEW.claim_epoch <= o.claim_epoch))
) BEGIN SELECT RAISE(ABORT, 'Delivery attempt binding is inconsistent'); END;
CREATE TRIGGER delivery_attempts_binding_update
BEFORE UPDATE ON delivery_attempts WHEN NOT EXISTS (
  SELECT 1 FROM deliveries d JOIN outbox o ON o.id = d.outbox_id
  WHERE d.id = NEW.delivery_id
    AND d.endpoint_idempotency_key = NEW.endpoint_idempotency_key
    AND o.endpoint_idempotency_key = NEW.endpoint_idempotency_key
    AND ((NEW.disposition IS NULL AND d.active_claim_epoch = NEW.claim_epoch
          AND o.state = 'claimed' AND o.claim_epoch = NEW.claim_epoch) OR
         (NEW.disposition IS NOT NULL AND NEW.ordinal <= d.attempt_count
          AND NEW.claim_epoch <= o.claim_epoch))
) BEGIN SELECT RAISE(ABORT, 'Delivery attempt binding is inconsistent'); END;

CREATE TRIGGER rounds_transition_guard
BEFORE UPDATE OF state ON rounds WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state = 'open' AND NEW.state IN ('coordinating', 'cancelled')) OR
  (OLD.state = 'coordinating' AND NEW.state IN ('waiting', 'completed', 'failed', 'cancelled')) OR
  (OLD.state = 'waiting' AND NEW.state IN ('coordinating', 'failed', 'cancelled'))
) BEGIN SELECT RAISE(ABORT, 'illegal Round transition'); END;
CREATE TRIGGER works_transition_guard
BEFORE UPDATE OF state ON works WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state = 'queued' AND NEW.state IN ('leased', 'cancelled')) OR
  (OLD.state = 'leased' AND NEW.state IN ('running', 'queued')) OR
  (OLD.state = 'running' AND NEW.state IN ('succeeded', 'failed', 'cancelling')) OR
  (OLD.state = 'cancelling' AND NEW.state = 'cancelled')
) BEGIN SELECT RAISE(ABORT, 'illegal Work transition'); END;
CREATE TRIGGER attempts_transition_guard
BEFORE UPDATE OF state ON attempts WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state = 'created' AND NEW.state IN ('offered', 'abandoned')) OR
  (OLD.state = 'offered' AND NEW.state IN ('accepted', 'rejected')) OR
  (OLD.state = 'accepted' AND NEW.state IN ('running', 'expired')) OR
  (OLD.state = 'running' AND NEW.state IN ('succeeded', 'failed', 'cancel_requested')) OR
  (OLD.state = 'cancel_requested' AND NEW.state = 'cancelled')
) BEGIN SELECT RAISE(ABORT, 'illegal Attempt transition'); END;
CREATE TRIGGER leases_transition_guard
BEFORE UPDATE OF state ON leases WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state = 'offered' AND NEW.state = 'active') OR
  (OLD.state = 'active' AND NEW.state IN ('released', 'expired', 'revoked'))
) BEGIN SELECT RAISE(ABORT, 'illegal Lease transition'); END;
CREATE TRIGGER outbox_transition_guard
BEFORE UPDATE OF state ON outbox WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state = 'pending' AND NEW.state = 'claimed') OR
  (OLD.state = 'claimed' AND NEW.state IN ('delivered', 'retry', 'dead_letter')) OR
  (OLD.state = 'retry' AND NEW.state IN ('claimed', 'dead_letter'))
) BEGIN SELECT RAISE(ABORT, 'illegal Outbox transition'); END;
CREATE TRIGGER deliveries_transition_guard
BEFORE UPDATE OF state ON deliveries WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state = 'pending' AND NEW.state IN ('sending', 'cancelled')) OR
  (OLD.state = 'sending' AND NEW.state IN ('delivered', 'retry_wait', 'permanent_failure', 'cancelled')) OR
  (OLD.state = 'retry_wait' AND NEW.state IN ('sending', 'permanent_failure', 'cancelled'))
) BEGIN SELECT RAISE(ABORT, 'illegal Delivery transition'); END;

CREATE TRIGGER rounds_no_delete
BEFORE DELETE ON rounds BEGIN SELECT RAISE(ABORT, 'Round is retained'); END;
CREATE TRIGGER works_no_delete
BEFORE DELETE ON works BEGIN SELECT RAISE(ABORT, 'Work is retained'); END;
CREATE TRIGGER attempts_no_delete
BEFORE DELETE ON attempts BEGIN SELECT RAISE(ABORT, 'Attempt is retained'); END;
CREATE TRIGGER leases_no_delete
BEFORE DELETE ON leases BEGIN SELECT RAISE(ABORT, 'Lease is retained'); END;
CREATE TRIGGER work_observations_no_delete
BEFORE DELETE ON work_observations BEGIN SELECT RAISE(ABORT, 'work observation is retained'); END;
CREATE TRIGGER outbox_no_delete
BEFORE DELETE ON outbox BEGIN SELECT RAISE(ABORT, 'Outbox is retained'); END;
CREATE TRIGGER deliveries_no_delete
BEFORE DELETE ON deliveries BEGIN SELECT RAISE(ABORT, 'Delivery is retained'); END;
CREATE TRIGGER delivery_attempts_no_delete
BEFORE DELETE ON delivery_attempts BEGIN SELECT RAISE(ABORT, 'Delivery attempt is retained'); END;
`;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("M11 schema delta has a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") {
    throw new Error("M11 schema delta has a non-JSON value");
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

export const WORK_SCHEMA_DELTA_PROPOSAL = deepFreeze({
  proposalVersion: 1,
  packageId: "M11",
  name: "durable-work-recovery-v1",
  landing: { owner: "M04", status: "proposal_only", m11MustNotApply: true },
  requires: {
    exactBaseGitSha: "de1e911e3769b7d61fe6779b1650997f3991c8a6",
    coordinationSchemaVersion: 2,
    coordinationSchemaChecksum: "47c9045f580a020bce91d7ea64f572c7f88dc08532ff29b6f7601fdab23428a4",
    connectedAgentsContractVersion: 1,
    connectedAgentsContractPackSha256: "fbc20017304aed66e579a2b95facbda6bbcf8572038f7f1c0c824423c65d6be2",
    m08MessagingSchemaDeltaSha256: "85695c952db6d1cfafa19296d48d241dbb7bf335342b534b1c76d51e24f74ae6",
    m09CanonicalSearchSchemaDeltaSha256: "83cbba277cb83667e9412704de922303fb87f3715be4e14dbe430adcdb089965",
  },
  sqlSha256: createHash("sha256").update(WORK_SCHEMA_DELTA_SQL, "utf8").digest("hex"),
  tables: [
    "context_manifests", "rounds", "works", "attempts", "leases",
    "terminal_receipts", "work_observations", "outbox", "deliveries",
    "delivery_attempts",
  ],
  invariants: [
    "Work and one wake intent commit durably before an offer",
    "one live Attempt and Lease exist per Work and every offer consumes a larger integer fence",
    "every Outbox claim consumes a monotonic claim epoch bound to one Delivery attempt",
    "an unknown final ordinary send may use exactly one stable-key duplicate probe outside the ordinary retry budget",
    "registry-exact lifecycle transitions and state-field coherence are enforced by the database",
    "terminal Work, Attempt, Round, Lease, Outbox, Delivery, and receipt history is immutable",
    "context manifests retain channel, message, artifact, count, watermark, and digest references only",
    "temporary execution hands are Attempt and Lease identifiers and never Bot or Channel members",
    "queued Work cancellation has no Attempt and uses the reserved non-execution fence zero",
  ],
  transactionRequirements: [
    "every lifecycle mutation uses the accepted M04 mutateWithEvent transaction port",
    "success failure or cancellation commits its exact receipt and terminal outbox intent atomically",
    "only turn.updated and activity.updated events are emitted with privacy-safe facts",
  ],
  integrationRequirements: [
    "M04 must land this SQL in the next reviewed numbered migration before M11 production composition",
    "M12 must compose the services without applying this proposal at runtime",
    "M13 resident truth must bind Attempt authority holder and fence exactly",
  ],
  retentionRequirements: [
    "terminal provenance and final delivery disposition are retained",
    "Round Work Attempt Lease Outbox Delivery and Delivery attempt rows reject deletion",
    "rejected fence evidence is bounded to 32 observations per Work",
    "detailed delivery attempts are retained by this proposal and require a later reviewed compaction contract",
  ],
  rollback: {
    beforeLanding: "remove this unconsumed proposal with M11",
    afterLanding: "stop new leasing, revoke active leases, drain receipts and outbox, and retain terminal history",
  },
});

export const WORK_SCHEMA_DELTA_CANONICAL_JSON = canonicalJson(WORK_SCHEMA_DELTA_PROPOSAL);

export const WORK_SCHEMA_DELTA_SHA256 =
  "5d4eb611b79a4f449cdd6c937488b5337d3fa308364c416b7801a74179315d4a" as const;

export function computeWorkSchemaDeltaDigest(): string {
  return createHash("sha256")
    .update(WORK_SCHEMA_DELTA_CANONICAL_JSON, "utf8")
    .digest("hex");
}
