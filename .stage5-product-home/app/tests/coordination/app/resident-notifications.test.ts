import test from 'node:test';
import assert from 'node:assert/strict';
import { createResidentNotifications } from '../../../src/coordination/app/resident-notifications.js';
import { createChannelService } from '../../../src/coordination/channels/index.js';
import { createMessageService } from '../../../src/coordination/messages/index.js';
import { createMessagingFixture, ownerContext, residentContext, fixtureId } from '../messaging/test-fixture.js';

for (const slug of ['jerry', 'forrest'] as const) test(`${slug} notification commits once into its own canonical owner conversation`, async t => {
  const f = await createMessagingFixture(); t.after(f.close);
  const channels = createChannelService({ repository: f.repository, participantDirectory: f.directory, cursorSigningKey: Buffer.alloc(32, 1) });
  const messages = createMessageService({ repository: f.repository, participantDirectory: f.directory });
  const dm = await channels.createDirectConversation({ context: ownerContext(600), memberBotIds: [f.bots[slug].principalId], pinned: false, idempotencyKey: 'notification-direct-message' });
  const recorded: string[] = [];
  const notify = createResidentNotifications({ database: f.database as never, messages,
    resolveResident: name => name === slug ? { clientInstanceId: `${slug}-client`, serverInstanceId: `${slug}-instance-1`, keyVersion: 1,
      context: input => { const c = residentContext(f.bots[slug], slug, 601); if(c.identity.kind === 'resident') { c.identity.resident.requestId = input.requestId; c.identity.resident.correlationId = input.correlationId; } return { ...c, ...input }; } } : undefined,
    recordMessage: async ({ message }) => { recorded.push(message.id); },
  });
  const credential = { residentSlug: slug, instanceId: `${slug}-client`, keyVersion: 1 };
  const input = { messageId: fixtureId('message', 602), text: `${slug} morning report` };
  const first = await notify(credential, input); const replay = await notify(credential, input);
  assert.deepEqual(replay, first); assert.equal(first.channelId, dm.channel.id);
  const page = await messages.listMessages({ context: ownerContext(603), channelId: dm.channel.id, limit: 20 });
  assert.equal(page.messages.length, 1); assert.equal(page.messages[0]!.author.principalId, f.bots[slug].principalId);
  assert.equal(page.messages[0]!.text, input.text); assert.equal(recorded.length, 2);
  await assert.rejects(notify({ ...credential, keyVersion: 2 }, input));
  await assert.rejects(notify(credential, { ...input, channelId: fixtureId('channel', 999) }));
  await assert.rejects(notify(credential, { ...input, text: 'changed' }));
});
