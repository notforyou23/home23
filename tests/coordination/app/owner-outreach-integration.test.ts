import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHelperOwnerOutreach, createResidentNotifications } from '../../../src/coordination/app/resident-notifications.js';
import { Home23Adapter } from '../../../src/channels/home23.js';
import { createOwnerOutreachSender, type OwnerOutreachInput } from '../../../src/channels/owner-outreach.js';
import { createCanonicalMessageRecorder } from '../../../src/coordination/app/direct-message.js';
import { createResidentContactProjection } from '../../../src/coordination/app/resident-contact.js';
import { createBotDirectory, digestBotAlias, SqliteBotDirectoryRepository } from '../../../src/coordination/bots/index.js';
import { createChannelService, SqliteMessagingRepository, SqliteBotConversationBindingAdapter } from '../../../src/coordination/channels/index.js';
import { createMessageService } from '../../../src/coordination/messages/index.js';
import { createWorkService, M11MessageProvenanceAuthority } from '../../../src/coordination/work/index.js';
import { SqliteCommunicationEventRepository } from '../../../src/coordination/communications/index.js';
import { createConversationShipper } from '../../../substrate/src/conversation-shipper.js';
import { EventLedgerTailAdapter } from '../../../substrate/src/adapters/event-ledger-tail.js';
import { ApnsPusher } from '../../../src/push/apns-pusher.js';
import { DeviceRegistry } from '../../../src/push/device-registry.js';
import { ConnectedAgentsNotificationService } from '../../../src/push/connected-agents.js';
import { ConnectedAgentsDeliveryStore } from '../../../src/push/connected-agents-delivery-store.js';
import { ownerContext, residentContext } from '../messaging/test-fixture.js';
import { AT, BOT_ID, CHANNEL_ID, OWNER_ID, M11TestDatabase, createFixtureIdGenerator, fixtureId, manifestInput } from '../work/test-fixture.js';

for (const runtime of ['resident', 'helper'] as const) test(`${runtime} outreach commits, routes canonical push, and receives the owner reply as authentic Seed contact`, async t => {
  const database = M11TestDatabase.temporary();
  const root = mkdtempSync(join(tmpdir(), 'owner-outreach-loop-'));
  t.after(() => { database.close(); rmSync(root, { recursive: true, force: true }); rmSync(dirname(database.path), { recursive: true, force: true }); });
  const slug = runtime === 'helper' ? 'bot-lens-feedback' : 'jerry'; const conversationId = fixtureId('conversation', 90);
  database.raw.prepare('INSERT INTO conversation_handles(id,channel_id,created_at) VALUES(?,?,?)').run(conversationId, CHANNEL_ID, AT);
  if (runtime === 'helper') database.raw.prepare(`UPDATE bots SET conversation_id=?,resident_binding=?,name='Lens',active_instance_id=NULL,active_key_version=NULL,
    resident_protocol_version=NULL,resident_capabilities_json='[]',resident_registered_at=NULL,last_heartbeat_at=NULL,reported_availability=NULL WHERE id=?`)
    .run(conversationId, slug, BOT_ID);
  else database.raw.prepare('UPDATE bots SET conversation_id=? WHERE id=?').run(conversationId, BOT_ID);
  if (runtime === 'resident') database.raw.prepare(`INSERT INTO aliases(id,namespace,alias_digest,target_type,target_id,active,created_at,updated_at)
    VALUES(?,'resident',?,'bot',?,1,?,?)`).run(`alias_${BOT_ID.slice(4)}`, digestBotAlias('resident', slug), BOT_ID, AT, AT);
  const bots = new SqliteBotDirectoryRepository(database);
  const directory = createBotDirectory({ repository: bots, availabilityPolicy: { degradedAfterMs: 30_000, offlineAfterMs: 120_000 } });
  const participantDirectory = { listVisibleBots: directory.listVisibleBots, resolveAlias: directory.resolveAlias,
    getBotByResidentBinding: (binding: string) => bots.getBotByResidentBinding(binding) };
  const repository = new SqliteMessagingRepository(database, { botConversationBinding: new SqliteBotConversationBindingAdapter(),
    messageProvenanceAuthorization: new M11MessageProvenanceAuthority() });
  const channels = createChannelService({ repository, participantDirectory, cursorSigningKey: Buffer.alloc(32, 1) });
  const messages = createMessageService({ repository, participantDirectory });
  const registry = new DeviceRegistry(join(root, 'devices.json'));
  const pushes: any[] = [];
  const pusher = new ApnsPusher({ send: async (_token: string, payload: unknown) => { pushes.push(payload); return { status: 200 }; } } as never,
    registry, 'Home23', { connectedAgentsDeliveryStore: new ConnectedAgentsDeliveryStore(join(root, 'push-receipts')),
      connectedAgentsRegistrationIsCurrent: () => true });
  const notifications = new ConnectedAgentsNotificationService(registry, pusher, 'com.regina6.home23');
  notifications.registerCurrent({ context: ownerContext(800), deviceToken: 'a'.repeat(64), environment: 'sandbox', platform: 'ios', appBuild: 'fixture' });
  const communications = new SqliteCommunicationEventRepository(database as never);
  const recordMessage = createCanonicalMessageRecorder(communications, notifications);
  const publishResident = createResidentNotifications({ database, messages, channels, recordMessage,
    resolveResident: name => name === 'jerry' ? { clientInstanceId: 'jerry-client', serverInstanceId: 'resident-1', keyVersion: 1,
      context: input => { const context = residentContext({ principalId: BOT_ID } as never, 'jerry', 820, { instanceId: 'resident-1' });
        if (context.identity.kind === 'resident') { context.identity.resident.requestId = input.requestId; context.identity.resident.correlationId = input.correlationId; }
        return { ...context, ...input }; } } : undefined });
  let publicationError: unknown;
  const adapter = new Home23Adapter(join(root, 'resident-outbox'), async input => {
    try { await publishResident({ residentSlug: 'jerry', instanceId: 'jerry-client', keyVersion: 1 }, input); }
    catch (error) { publicationError = error; throw error; }
  });
  const sendResident = createOwnerOutreachSender(adapter);
  const notify = runtime === 'helper' ? createHelperOwnerOutreach({ database, messages, channels, recordMessage })
    : async (_bot: { id: string; residentBinding: string }, input: OwnerOutreachInput) => sendResident(input);
  const bot = { id: BOT_ID, residentBinding: slug };
  const input = { text: 'The provider failed after dispatch. Can you confirm which connection to use?',
    reason: 'A recorded failed execution needs an owner decision.', deliveryId: 'execution-feedback-owner-question' };
  const receipt = await notify(bot, input);
  assert.ifError(publicationError);
  assert.equal(receipt.status, 'committed'); assert.equal(receipt.notification, 'not_confirmed');
  if (runtime === 'helper') assert.equal(receipt.channelId, CHANNEL_ID);
  const retryNotify = runtime === 'helper' ? createHelperOwnerOutreach({ database, messages, channels, recordMessage }) : notify;
  assert.deepEqual(await retryNotify(bot, input), receipt, 'retry retains canonical identity');
  await pusher.drainConnectedAgentsDeliveries();
  assert.equal(pushes.length, 1, 'push service deduplicates the canonical committed Message');
  assert.match(JSON.stringify(pushes[0]), new RegExp(conversationId));
  assert.match(JSON.stringify(pushes[0]), new RegExp(CHANNEL_ID));
  assert.match(JSON.stringify(pushes[0]), new RegExp(receipt.messageIds![0]!));
  assert.equal(database.readOne<{ count: number }>('SELECT count(*) AS count FROM works')!.count, 0, 'outreach does not create another task');
  await assert.rejects(notify(bot, { ...input, text: 'changed under same identity' }));
  if (runtime === 'helper') await assert.rejects(notify({ ...bot, residentBinding: 'bot-another-agent' }, input));
  await assert.rejects(notify(bot, { ...input, channelId: fixtureId('channel', 999) } as any));
  await assert.rejects(notify(bot, { ...input, botId: fixtureId('bot', 999) } as any));

  const owner = ownerContext(801);
  const reply = await messages.sendMessage({ context: owner, channelId: CHANNEL_ID, messageId: fixtureId('message', 801),
    authorPrincipalId: OWNER_ID, idempotencyKey: 'owner-outreach-reply-fixture', kind: 'text', text: 'Use my Codex connection and tell me what happens.',
    mentions: [], clientMessageId: 'owner-outreach-reply-fixture', replyToMessageId: receipt.messageIds![0]!, tombstonesMessageId: null,
    provenance: { roundId: null, workId: null } });
  await recordMessage({ message: reply.message, kind: 'user_message_committed', requestId: owner.requestId, correlationId: owner.correlationId });
  assert.equal(reply.message.conversationId, conversationId);
  const work = createWorkService({ database, generateId: createFixtureIdGenerator(), now: () => new Date() });
  work.create({ principalId: OWNER_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID, originMessageId: reply.message.id,
    roundId: null, kind: runtime === 'helper' ? 'bot_turn' : 'resident_turn', idempotencyKey: 'owner-outreach-reply-work', maxAutomaticOffers: 1,
    manifest: manifestInput({ messageIds: [reply.message.id], watermarks: { channelSequence: reply.message.sequence, eventSequence: 0 } }),
    requestId: owner.requestId, correlationId: owner.correlationId });
  const contacts = join(root, 'contacts'); const projection = createResidentContactProjection(database, contacts, [slug]);
  for (let index = 0; index < 8; index++) projection.pump();
  const rows = readFileSync(join(contacts, `${slug}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const contact = rows.find(row => row.messageId === reply.message.id);
  assert.equal(contact.voice, 'jtr'); assert.equal(contact.role, 'user'); assert.equal(contact.channelId, CHANNEL_ID);
  assert.equal(contact.actor.principalId, OWNER_ID);
  const conversationsDir = join(root, 'conversations'); mkdirSync(conversationsDir);
  const streamPath = join(root, 'conversation-stream.jsonl');
  createConversationShipper({ conversationsDir, coordinationSource: join(contacts, `${slug}.jsonl`), streamPath,
    cursorPath: `${streamPath}.cursor`, maxAgeDays: 365, backfillBytes: 1_000_000, embed: () => null }).pass();
  const seed = new EventLedgerTailAdapter({ sourcePath: streamPath, sourceType: 'conversation-stream', cursorDir: join(root, 'seed'), fromEnd: false });
  const events = await seed.pull();
  const replyEvent = events.find(event => event.sourceRef === `conversation.jtr:coordination.message:${reply.message.id}`);
  assert.ok(replyEvent); assert.equal(replyEvent.payload.role, 'user'); assert.equal(replyEvent.payload.head, reply.message.text);
  assert.equal((replyEvent.payload.actor as { principalId: string }).principalId, OWNER_ID);
});
