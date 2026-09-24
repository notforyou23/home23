import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotInvocationService, botInvocationMessageId } from '../../../src/coordination/app/bot-invocations.js';
import { createWorkService } from '../../../src/coordination/work/index.js';
import { createLeaseService } from '../../../src/coordination/leases/index.js';
import { M11TestDatabase, AT, BOT_ID, CHANNEL_ID, MESSAGE_ID, OWNER_ID, createFixtureIdGenerator, fixtureId, manifestInput } from '../work/test-fixture.js';

function fixture(t: any, childState = 'queued') {
  const database = M11TestDatabase.temporary(); t.after(() => database.close());
  const generateId = createFixtureIdGenerator();
  const work = createWorkService({ database, generateId, now: () => new Date(AT) });
  const leases = createLeaseService({ database, generateId, now: () => new Date(AT), leaseTtlMs: 60000 });
  const origin = { workId: fixtureId('work', 99), attemptId: fixtureId('attempt', 99), fencingToken: 1,
    holderPrincipalId: OWNER_ID, channelId: CHANNEL_ID } as any;
  let parentState = 'running'; let submissions = 0; let stops = 0;
  let release: (() => void) | undefined;
  let admissionGate = Promise.resolve();
  const options = { database, work: { ...work, get: (id: string) => id === origin.workId ? { state: parentState } : work.get(id) } as any,
    leases, channels: { getChannel: async () => ({ kind: 'group', lifecycle: 'active', members: [{ principalId: BOT_ID }] }) } as any,
    authorize: () => { if (parentState !== 'running') throw new Error('stale parent'); }, currentCredential: () => true,
    context: () => ({}) as any, stopChild: async () => { stops++; },
    submit: { submitMessage: async (input: any) => {
      submissions++; await admissionGate;
      database.mutateWithEvent(transaction => { transaction.run(`INSERT INTO messages (id,channel_id,channel_sequence,author_principal_id,author_kind,author_display_name,kind,body_text,stored_visibility,created_at)
        VALUES (?, ?, 2, 'user_owner','owner','Jerry','text','assignment','visible',?)`,input.body.messageId,CHANNEL_ID,AT);
        return { value: undefined, event: { type: 'message.appended', aggregateKind: 'message', aggregateId: input.body.messageId, aggregateVersion: 1, channelId: CHANNEL_ID, actorPrincipalId: OWNER_ID, requestId: fixtureId('request',88), correlationId: fixtureId('correlation',88), payload: {}, createdAt: AT } }; });
      const child = work.create({ principalId: OWNER_ID, targetPrincipalId: BOT_ID, channelId: CHANNEL_ID,
        originMessageId: input.body.messageId, roundId: null, kind: 'channel.bot_turn', idempotencyKey: input.idempotencyKey,
        manifest: manifestInput({messageIds:[input.body.messageId],watermarks:{channelSequence:2,eventSequence:100}}), maxAutomaticOffers: 2, requestId: fixtureId('request',90), correlationId: fixtureId('correlation',90) }).work;
      if (childState !== 'queued') {
        const offered = leases.offer({ workId: child.id, holderPrincipalId: BOT_ID, holderInstanceId: 'resident-1', authorityReference: 'resident:jerry',
          automatic: true, requestId: fixtureId('request',91), correlationId: fixtureId('correlation',91) });
        const binding = { workId: child.id, attemptId: offered.attempt.id, leaseId: offered.lease.id, holderPrincipalId: BOT_ID,
          holderInstanceId: 'resident-1', fencingToken: offered.fencingToken, requestId: fixtureId('request',92), correlationId: fixtureId('correlation',92) };
        if (childState !== 'offered') leases.accept(binding);
        if (childState === 'running') leases.start(binding);
      }
      return {};
    } },
  };
  const input = (operation = 'bot_invoke') => ({ origin, invocationId: 'tool-17', args: { operation, botId: BOT_ID, prompt: 'Help' } });
  return { database, options, input, work, origin, counts: () => ({ submissions, stops }),
    cancel: () => { parentState = 'cancelled'; }, gate: () => { admissionGate = new Promise<void>(resolve => { release = resolve; }); return () => release!(); } };
}

test('invocation identity is stable and distinct for each parent and tool call', () => {
  assert.match(botInvocationMessageId(fixtureId('work', 3), 'call'), /^msg_[0-9a-f-]{36}$/);
  assert.notEqual(botInvocationMessageId(fixtureId('work', 3), 'call'),botInvocationMessageId(fixtureId('work', 3), 'other'));
  assert.notEqual(botInvocationMessageId(fixtureId('work', 3), 'call'),botInvocationMessageId(fixtureId('work', 4), 'call'));
});
for (const state of ['queued','offered','accepted','running']) test(`restart preserves invocation and cancellation handles ${state} child`, async t => {
  const f = fixture(t, state); let service = createBotInvocationService(f.options);
  await service.call({} as any,f.input());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await service.call({} as any,f.input('bot_result'))).state,'running', JSON.stringify(f.database.readAll("SELECT payload_json FROM events WHERE aggregate_kind = 'bot_invocation'")));
  f.database.reopen(); service = createBotInvocationService(f.options);
  await service.call({} as any,f.input());
  assert.equal(f.counts().submissions,1);
  await assert.rejects(service.call({} as any,{...f.input(),args:{...f.input().args,prompt:'changed'}}),/replay changed/);
  f.cancel();
  const result = await service.call({} as any,f.input('bot_stop'));
  const child = f.database.readOne<{ state: string }>('SELECT state FROM works')!;
  assert.equal(child.state,state === 'running' ? 'cancelling' : 'cancelled');
  assert.equal(result.state,state === 'running' ? 'running' : 'cancelled');
  if (state === 'running') assert.equal(f.counts().stops,1,'do not claim cancelled before runtime confirms');
});

test('stop waits for in-flight admission then cancels the admitted child',async t => {
  const f = fixture(t); const release = f.gate(); const service = createBotInvocationService(f.options);
  await service.call({} as any,f.input()); f.cancel();
  let settled = false;
  const stopping = service.call({} as any,f.input('bot_stop')).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled,false);
  release(); assert.equal((await stopping).state,'cancelled');
  assert.equal(f.database.readOne<{state:string}>('SELECT state FROM works')!.state,'cancelled');
});

for (const wrongAuthor of [false, true]) test(`canonical helper provenance survives reopen; wrong author=${wrongAuthor}`, async t => {
  const f = fixture(t, 'running'); let service = createBotInvocationService(f.options);
  await service.call({} as any, f.input()); await new Promise(resolve => setImmediate(resolve));
  const child = f.database.readOne<{id:string}>('SELECT id FROM works')!;
  const current = f.options.leases.current(child.id);
  f.options.leases.terminalize({ workId: child.id, attemptId: current.attempt.id, leaseId: current.lease.id,
    holderPrincipalId: current.attempt.holderPrincipalId, holderInstanceId: current.attempt.holderInstanceId,
    fencingToken: current.attempt.fencingToken, requestId: fixtureId('request', 700), correlationId: fixtureId('correlation',700),
    receipt: { status:'succeeded', sourceReference:'resident:jerry', resultDigest:'a'.repeat(64), artifactIds:[], timestamp:AT } });
  assert.equal((await service.call({} as any,f.input('bot_result'))).state,'running','wait for committed delivery');
  const commit = () => f.database.raw.prepare(`INSERT INTO messages (id,channel_id,channel_sequence,author_principal_id,author_kind,author_display_name,kind,body_text,stored_visibility,created_at,work_id)
    VALUES (?, ?, 3, ?, 'bot','Editorial Reader','result','The actual helper answer','visible',?,?)`).run(fixtureId('message',700),CHANNEL_ID,wrongAuthor?OWNER_ID:BOT_ID,AT,child.id);
  if(wrongAuthor) { assert.throws(commit); assert.equal((await service.call({} as any,f.input('bot_result'))).state,'running'); return; }
  commit();
  f.database.reopen(); service=createBotInvocationService(f.options);
  const result=await service.call({} as any,f.input('bot_result'));
  assert.equal(result.state,wrongAuthor?'failed':'succeeded');
  assert.equal(result.deliveries?.[0]?.verifiedDelivery,!wrongAuthor);
  assert.equal(result.deliveries?.[0]?.authorDisplayName,'Editorial Reader');
  assert.equal(result.deliveries?.[0]?.messageId,fixtureId('message',700));
  assert.equal(result.deliveries?.[0]?.channelId,CHANNEL_ID);
});


import { botInvokeTool } from '../../../src/agent/tools/channels.js';
test('helper observation deadline retries the exact join instead of failing its parent', async () => {
  const calls: string[] = []; let observations = 0;
  const result = await botInvokeTool.execute({botId:BOT_ID,prompt:'bounded'}, {
    turnRuntime:{coordinationOrigin:{workId:fixtureId('work',99)}}, coordinationWorkDestination:{},parentToolCallId:'exact-tool',
    coordinationChannelOperation:async (request:any) => {
      assert.equal(request.invocationId,'exact-tool');calls.push(request.args.operation);
      if(request.args.operation==='bot_invoke')return {state:'running'};
      if(++observations===1)throw Object.assign(new Error('request deadline has elapsed'),{code:'deadline_exceeded'});
      return {state:'succeeded',text:'done',deliveries:[{verifiedDelivery:true}]};
    },
  } as any);
  assert.equal(result.is_error,false);assert.deepEqual(calls,['bot_invoke','bot_result','bot_result']);
  assert.equal(JSON.parse(result.content).deliveries[0].verifiedDelivery,true);
});


test('busy helper admission retains one durable request and retries when available',async t=>{
 const f=fixture(t);const submit=f.options.submit.submitMessage;let busy=true;const ids:string[]=[];
 f.options.submit.submitMessage=async(input:any)=>{ids.push(input.body.messageId);if(busy){busy=false;throw Object.assign(new Error('Bot already has an active turn'),{code:'turn_in_progress'});}return submit(input);};
 const service=createBotInvocationService(f.options);await service.call({} as any,f.input());await new Promise(r=>setImmediate(r));
 assert.equal((await service.call({} as any,f.input('bot_result'))).state,'running');
 await service.call({} as any,f.input());await new Promise(r=>setImmediate(r));assert.equal(f.counts().submissions,1);assert.equal(new Set(ids).size,1);
 assert.equal(f.database.readAll("SELECT sequence FROM events WHERE aggregate_kind='bot_invocation' AND aggregate_version=2").length,0);
});

test('reconciliation pages active invocations and wraps to revisit them', async () => {
  const admissions = Array.from({ length: 70 }, (_, index) => ({ sequence: index + 1,
    payload: JSON.stringify({ origin: { workId: `work-${index}`, channelId: CHANNEL_ID },
      invocationId: `call-${index}`, botId: BOT_ID, prompt: 'Help', channelId: CHANNEL_ID,
      messageId: `message-${index}` }) }));
  const pages: Array<{ after: number; limit: number }> = [];
  const options = {
    database: {
      readAll(sql: string, after?: number, limit?: number) {
        if (!sql.includes('SELECT e.sequence AS sequence')) return [];
        pages.push({ after: after!, limit: limit! });
        return admissions.filter(row => row.sequence > after!).slice(0, limit);
      },
      readOne: () => undefined,
    },
    work: { get: () => ({ state: 'running' }) },
    leases: {}, channels: {}, submit: { submitMessage: async () => ({}) },
    authorize: () => undefined, currentCredential: () => true, context: () => ({}),
    stopChild: async () => undefined,
  } as any;
  const service = createBotInvocationService(options);
  await service.reconcile(); await service.reconcile(); await service.reconcile(); await service.reconcile();
  assert.deepEqual(pages, [
    { after: 0, limit: 32 }, { after: 32, limit: 32 },
    { after: 64, limit: 32 }, { after: 0, limit: 32 },
  ]);
});
