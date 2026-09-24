import type { M11Database } from '../work/types.js';
import type { WorkRecord } from '../work/index.js';

/** Check whether the target can still receive this outcome before rebuilding
 * context. Historical Bot outcomes remain pending if their identity changes. */
export function canRecoverOutcomeTarget(
  database: Pick<M11Database, 'readOne'>,
  source: Pick<WorkRecord, 'channelId' | 'targetPrincipalId'>,
): boolean {
  const target = database.readOne<{ channelKind: string; residentBinding: string | null; lifecycle: string | null; currentConversationId: string | null; sourceConversationId: string | null;
    continuingIdentity: number | null; durableMailbox: number | null; messageCapability: number;
    activeInstanceId: string | null; activeKeyVersion: number | null; residentProtocolVersion: number | null;
    residentRegisteredAt: string | null; residentCapabilityCount: number | null }>(
    `SELECT c.kind AS channelKind, b.resident_binding AS residentBinding,
            b.lifecycle AS lifecycle, b.conversation_id AS currentConversationId,
            h.id AS sourceConversationId, b.continuing_identity AS continuingIdentity,
            b.durable_mailbox AS durableMailbox,
            EXISTS(SELECT 1 FROM json_each(b.required_capabilities_json) WHERE value='messages') AS messageCapability,
            b.active_instance_id AS activeInstanceId, b.active_key_version AS activeKeyVersion,
            b.resident_protocol_version AS residentProtocolVersion,
            b.resident_registered_at AS residentRegisteredAt,
            json_array_length(b.resident_capabilities_json) AS residentCapabilityCount
     FROM channels c LEFT JOIN bots b ON b.principal_id = ?
     LEFT JOIN conversation_handles h ON h.channel_id = c.id
     WHERE c.id = ?`, source.targetPrincipalId, source.channelId);
  if (!target?.residentBinding) return false;
  if (!target.residentBinding.startsWith('bot-')) return true;
  if (target.lifecycle !== 'active' || target.continuingIdentity !== 1 || target.durableMailbox !== 1 ||
    target.messageCapability !== 1 || target.activeInstanceId !== null || target.activeKeyVersion !== null ||
    target.residentProtocolVersion !== null || target.residentRegisteredAt !== null ||
    target.residentCapabilityCount !== 0) return false;
  return target.channelKind !== 'direct' ||
    (target.sourceConversationId !== null && target.currentConversationId === target.sourceConversationId);
}
