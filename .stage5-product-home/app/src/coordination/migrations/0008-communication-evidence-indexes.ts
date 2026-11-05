/**
 * The canonical event row remains the single durable ordering authority.
 * These indexes make stable communication identity replay-idempotent and keep
 * conversation/turn evidence history bounded without duplicating event bytes.
 */
export const COMMUNICATION_EVIDENCE_INDEX_MIGRATION_SQL = `
CREATE UNIQUE INDEX communication_events_event_id_unique
  ON events (json_extract(payload_json, '$.communication.eventId'))
  WHERE type = 'communication.recorded';

CREATE INDEX communication_events_conversation_sequence
  ON events (
    json_extract(payload_json, '$.communication.conversationId'),
    sequence
  )
  WHERE type = 'communication.recorded';

CREATE INDEX communication_events_turn_sequence
  ON events (
    json_extract(payload_json, '$.communication.turnId'),
    sequence
  )
  WHERE type = 'communication.recorded';
`;
