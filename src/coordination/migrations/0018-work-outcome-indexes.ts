/** Bound resident outcome discovery and pending-work checks to relevant Work rows. */
export const WORK_OUTCOME_INDEXES_MIGRATION_SQL = `
CREATE INDEX works_busy_channel ON works (channel_id)
WHERE kind <> 'resident_work_thread'
  AND state IN ('queued', 'leased', 'running', 'cancelling');

CREATE INDEX works_scheduled_origin ON works (origin_message_id)
WHERE kind = 'channel.bot_turn'
  AND state IN ('succeeded', 'failed', 'cancelled');
`;
