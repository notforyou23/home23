/** Keep scheduled card provenance local to the exact admitted origin message. */
export const SCHEDULED_ORIGIN_INDEX_MIGRATION_SQL = `
CREATE INDEX events_scheduled_origin_message ON events (json_extract(payload_json, '$.messageId'))
WHERE aggregate_kind = 'scheduled_channel_run' AND aggregate_version = 1;
`;
