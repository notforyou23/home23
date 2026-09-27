import { generateCoordinationId, assertCoordinationId } from '../ids/index.js';
import { ResidentProtocolError } from '../resident-protocol/index.js';
import type { M11Database } from '../work/types.js';
import type { createMessageService } from '../messages/service.js';
import type { SpecialistCompletionResidentTarget } from './specialist-completion.js';
import type { createCanonicalMessageRecorder } from './direct-message.js';
import type { DetachmentCredential } from './foreground-detachments.js';
import { createHash } from 'node:crypto';
import type { createChannelService } from '../channels/service.js';
import type { MessagingActorContext } from '../channels/types.js';
import type { BotDirectoryRecord } from '../bots/types.js';
import { validateOwnerOutreach, type OwnerOutreachInput, type OwnerOutreachReceipt } from '../../channels/owner-outreach.js';

interface PublisherOptions {
  database: M11Database;
  messages: ReturnType<typeof createMessageService>;
  channels?: Pick<ReturnType<typeof createChannelService>, 'createDirectConversation'>;
  recordMessage: ReturnType<typeof createCanonicalMessageRecorder>;
}

/** Reuse the canonical owner pair. Identity is supplied by the authenticated
 * runtime, never by message/tool arguments. No target channel is accepted. */
function createOwnerMessagePublisher(options: PublisherOptions) {
  return async (context: MessagingActorContext, input: { messageId: string; text: string }) => {
    assertCoordinationId('message', input.messageId);
    if (!input.text.trim() || input.text.includes('\0') || Buffer.byteLength(input.text, 'utf8') > 65_536) {
      throw new ResidentProtocolError('request_invalid', 'Invalid owner message');
    }
    const find = () => options.database.readAll<{ channelId: string }>(`SELECT c.id AS channelId FROM bots b
      JOIN conversation_handles h ON h.id=b.conversation_id JOIN channels c ON c.id=h.channel_id
      JOIN channel_members m ON m.channel_id=c.id AND m.principal_id=b.principal_id AND m.active=1 AND m.kind='bot'
      JOIN channel_members owner ON owner.channel_id=c.id AND owner.principal_id='user_owner' AND owner.active=1 AND owner.kind='owner'
      WHERE b.principal_id=? AND b.lifecycle='active' AND c.kind='direct' AND c.lifecycle='active' AND c.owner_principal_id='user_owner'`, context.principalId);
    let targets = find();
    if (targets.length === 0 && options.channels) {
      // The channel service and repository both constrain a bot to its own
      // owner pair and revalidate the live credential in the transaction.
      await options.channels.createDirectConversation({ context, memberBotIds: [context.principalId], pinned: false,
        idempotencyKey: `owner-outreach-mailbox:${context.principalId}` });
      targets = find();
    }
    if (targets.length !== 1) throw new ResidentProtocolError('request_invalid', 'Agent owner conversation is unavailable or ambiguous');
    const target = targets[0]!;
    const result = await options.messages.sendMessage({ context,
      channelId: target.channelId, messageId: input.messageId, authorPrincipalId: context.principalId,
      idempotencyKey: `resident-notification:${input.messageId}`, kind: 'result', text: input.text,
      mentions: [], clientMessageId: input.messageId, replyToMessageId: null, tombstonesMessageId: null,
      provenance: { roundId: null, workId: null },
    });
    await options.recordMessage({ message: result.message, kind: 'assistant_message_committed',
      requestId: context.requestId, correlationId: context.correlationId });
    return { accepted: true, messageId: result.message.id, channelId: target.channelId };
  };
}

/** Core binds this callback to the helper runtime, not to a public bot ID. */
export function createHelperOwnerOutreach(options: PublisherOptions) {
  const publish = createOwnerMessagePublisher(options);
  return async (bot: Pick<BotDirectoryRecord, 'id' | 'residentBinding'>, raw: OwnerOutreachInput): Promise<OwnerOutreachReceipt> => {
    const input = validateOwnerOutreach(raw);
    const current = options.database.readOne<{ id: string }>(`SELECT id FROM bots WHERE id=? AND principal_id=?
      AND resident_binding=? AND resident_binding LIKE 'bot-%' AND lifecycle='active'
      AND continuing_identity=1 AND durable_mailbox=1 AND conversation_id IS NOT NULL
      AND active_instance_id IS NULL AND active_key_version IS NULL
      AND resident_protocol_version IS NULL AND resident_registered_at IS NULL
      AND json_array_length(resident_capabilities_json)=0`, bot.id, bot.id, bot.residentBinding);
    if (!current) throw new ResidentProtocolError('authentication_failed', 'Helper owner outreach identity is not current');
    // Namespace by immutable bot identity and delivery identity, so concurrent
    // retries/restarts converge in the canonical Message idempotency ledger.
    // The timestamp prefix belongs to the bot; Message.createdAt is its time.
    const digest = createHash('sha256').update(`home23-helper-owner-outreach:v1\0${bot.id}\0${input.deliveryId}`).digest('hex');
    const messageId = `msg_${bot.id.slice(4, 17)}-7${digest.slice(0, 3)}-8${digest.slice(3, 6)}-${digest.slice(6, 18)}`;
    const context: MessagingActorContext = { principalId: bot.id, requestId: generateCoordinationId('request'), correlationId: generateCoordinationId('correlation'),
      identity: { kind: 'on_demand_bot', bot: { botId: bot.id, residentBinding: bot.residentBinding } } };
    const result = await publish(context, { messageId, text: input.text });
    return { status: 'committed', notification: 'not_confirmed', messageIds: [result.messageId], channelId: result.channelId };
  };
}

/** Signed residents may deliver only as themselves to their own owner DM. */
export function createResidentNotifications(options: PublisherOptions & {
  resolveResident(slug: string): SpecialistCompletionResidentTarget | undefined;
}) {
  const publish = createOwnerMessagePublisher(options);
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
    const target = options.database.readOne<{ principalId: string }>(
      `SELECT principal_id AS principalId FROM bots WHERE lifecycle='active'
         AND resident_binding=? AND active_instance_id=? AND active_key_version=?`,
      credential.residentSlug, resident.serverInstanceId, credential.keyVersion);
    if (!target) throw new ResidentProtocolError('authentication_failed', 'Resident notification identity is not current');
    const requestId = generateCoordinationId('request'); const correlationId = generateCoordinationId('correlation');
    return publish(resident.context({ principalId: target.principalId, requestId, correlationId }), input);
  };
}
