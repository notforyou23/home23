/** Bound notification recovery to bot results in stable creation order. */
export const NOTIFICATION_RECOVERY_ORDER_MIGRATION_SQL = `
CREATE INDEX IF NOT EXISTS messages_notification_recovery_order ON messages (created_at, id)
WHERE author_kind = 'bot' AND kind = 'result';
`;
