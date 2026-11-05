import { generateCoordinationId, assertCoordinationId } from '../ids/index.js';
import { ResidentProtocolError } from '../resident-protocol/index.js';
import type { M11Database } from '../work/types.js';
import type { createMessageService } from '../messages/service.js';
import type { SpecialistCompletionResidentTarget } from './specialist-completion.js';
import type { createCanonicalMessageRecorder } from './direct-message.js';
import type { DetachmentCredential } from './foreground-detachments.js';

/** Signed residents may deliver only as themselves to their existing owner DM. */
export function createResidentNotifications(options: {
  database: M11Database; messages: ReturnType<typeof createMessageService>;
  resolveResident(slug: string): SpecialistCompletionResidentTarget | undefined;
  recordMessage: ReturnType<typeof createCanonicalMessageRecorder>;
}) {
  return async (credential: DetachmentCredential, raw: unknown) => {
    const resident = options.resolveResident(credential.residentSlug);
    if (!resident || resident.clientInstanceId !== credential.instanceId || resident.keyVersion !== credential.keyVersion) {
      throw new ResidentProtocolError('authentication_failed', 'Resident notification credential is not current');
    }
    const input = raw as { messageId: string; text: string };
    if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'messageId,text' || typeof input.text !== 'string') {
      throw new ResidentProtocolError('request_invalid', 'Invalid resident notification');
    }
    assertCoordinationId('message', input.messageId);
    const targets = options.database.readAll<{ channelId: string; principalId: string }>(
      `SELECT c.id AS channelId,b.principal_id AS principalId FROM channels c
       JOIN channel_members m ON m.channel_id=c.id AND m.active=1 AND m.kind='bot'
       JOIN bots b ON b.principal_id=m.principal_id
       JOIN channel_members owner ON owner.channel_id=c.id AND owner.principal_id=c.owner_principal_id AND owner.active=1
       WHERE c.kind='direct' AND c.lifecycle='active' AND b.lifecycle='active'
         AND b.resident_binding=? AND b.active_instance_id=? AND b.active_key_version=?`,
      credential.residentSlug, resident.serverInstanceId, credential.keyVersion);
    if (targets.length !== 1) throw new ResidentProtocolError('request_invalid', 'Resident owner conversation is unavailable or ambiguous');
    const target = targets[0]!;
    const requestId = generateCoordinationId('request'); const correlationId = generateCoordinationId('correlation');
    const result = await options.messages.sendMessage({
      context: resident.context({ principalId: target.principalId, requestId, correlationId }),
      channelId: target.channelId, messageId: input.messageId, authorPrincipalId: target.principalId,
      idempotencyKey: `resident-notification:${input.messageId}`, kind: 'result', text: input.text,
      mentions: [], clientMessageId: input.messageId, replyToMessageId: null, tombstonesMessageId: null,
      provenance: { roundId: null, workId: null },
    });
    await options.recordMessage({ message: result.message, kind: 'assistant_message_committed', requestId, correlationId });
    return { accepted: true, messageId: result.message.id, channelId: target.channelId };
  };
}
