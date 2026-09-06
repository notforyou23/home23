import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelOperationConsumer } from '../../../src/coordination/app/channel-operations.js';
import { createChannelService } from '../../../src/coordination/channels/service.js';
import { createMessagingFixture, residentContext } from '../messaging/test-fixture.js';

test('signed channel operations derive Jerry identity and retry the same canonical mutation', async (t) => {
  const fixture = await createMessagingFixture(); t.after(fixture.close);
  const channels = createChannelService({ repository: fixture.repository, participantDirectory: fixture.directory,
    cursorSigningKey: Buffer.alloc(32, 0x23), now: () => fixture.clock.value });
  const origin = { workId: 'work', attemptId: 'attempt', fencingToken: 1 } as never;
  let valid = true;
  const consume = createChannelOperationConsumer({ channels,
    authorize: (_credential, received) => { assert.equal(received, origin); if (!valid) throw new Error('stale fence'); },
    context: () => residentContext(fixture.bots.jerry, 'jerry', 990),
    listBots: () => fixture.directory.listVisibleBots(),
    botOperation: async () => { throw new Error('unused'); },
  });
  const credential = { residentSlug: 'jerry', instanceId: 'client', keyVersion: 1 };
  const input = { origin, invocationId: 'call-create', args: { operation: 'create', title: 'Editorial',
    purpose: 'Subject work', memberBotIds: [], principalId: 'forged-owner' } };
  const first: any = await consume(credential, input);
  const replay: any = await consume(credential, input);
  assert.equal(first.channel.id, replay.channel.id);
  assert.ok(first.channel.members.some((member: any) => member.principalId === fixture.bots.jerry.id));
  assert.equal(first.channel.responderPolicy.coordinatorBotId, fixture.bots.jerry.id);
  await assert.rejects(consume({ ...credential, residentSlug: 'forrest' }, input), /executive/);
  valid = false;
  await assert.rejects(consume(credential, { ...input, invocationId: 'new' }), /stale fence/);
});

test('resident diagnostics bind the principal to the authenticated origin and retain fence validation', async () => {
 let valid = true; let observed: unknown;
 const consume = createChannelOperationConsumer({ channels: {} as any,
 authorize: () => { if (!valid) throw new Error('stale fence'); },
 context: () => { throw new Error('No channel mutation context needed'); },
 listBots: async () => [], botOperation: async () => { throw new Error('unused'); },
 workDiagnostics: (principal,args) => { observed = principal; return {registry:'canonical',work:[]}; },
 });
 const request={origin:{holderPrincipalId:'forrest-principal'},invocationId:'read-work',args:{operation:'work_list',principalId:'forged'}};
 assert.deepEqual(await consume({residentSlug:'forrest',instanceId:'instance',keyVersion:1},request),{registry:'canonical',work:[]});
 assert.equal(observed,'forrest-principal');valid=false;
 await assert.rejects(consume({residentSlug:'forrest',instanceId:'instance',keyVersion:1},request),/stale fence/);
});
