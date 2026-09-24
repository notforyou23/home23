import type { M11Database } from '../work/types.js';
import type { WorkRecord } from '../work/index.js';

/** Avoid rebuilding an old direct-message context after a Bot moves to a new
 * conversation. Group work uses its group channel, not the Bot's direct home. */
export function canRecoverOutcomeTarget(
  database: Pick<M11Database, 'readOne'>,
  source: Pick<WorkRecord, 'channelId' | 'targetPrincipalId'>,
): boolean {
  const target = database.readOne<{ channelKind: string; residentBinding: string | null; currentConversationId: string | null; sourceConversationId: string | null }>(
    `SELECT c.kind AS channelKind, b.resident_binding AS residentBinding,
            b.conversation_id AS currentConversationId, h.id AS sourceConversationId
     FROM channels c LEFT JOIN bots b ON b.principal_id = ?
     LEFT JOIN conversation_handles h ON h.channel_id = c.id
     WHERE c.id = ?`, source.targetPrincipalId, source.channelId);
  return !!target?.residentBinding && (target.channelKind !== 'direct' ||
    !target.residentBinding.startsWith('bot-') ||
    (target.sourceConversationId !== null && target.currentConversationId === target.sourceConversationId));
}
