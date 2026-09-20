/** Keep inbox activity and the recurring resident projections off table scans. */
export const INBOX_RECONCILIATION_INDEXES_MIGRATION_SQL = `
CREATE INDEX works_channel_created ON works (channel_id, created_at DESC, id DESC);
CREATE INDEX works_failed_channel_terminal ON works (channel_id, terminal_at DESC, id DESC)
WHERE state = 'failed';
CREATE INDEX messages_work_channel_kind ON messages (work_id, channel_id, kind);
CREATE INDEX works_target_created ON works (target_principal_id, created_at DESC, id DESC);
CREATE INDEX resident_outcomes_source_created ON resident_outcomes (source_work_id, created_at DESC, outcome_key DESC);
CREATE INDEX works_origin_message ON works (origin_message_id);
CREATE INDEX events_admission_origin_message ON events (json_extract(payload_json, '$.admissionPlan.originMessageId'))
WHERE aggregate_kind = 'round' AND aggregate_version = 1 AND type = 'turn.updated';
`;
