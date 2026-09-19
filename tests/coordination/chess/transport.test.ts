import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeChessTool } from '../../../src/agent/tools/channels.js';
import { createChannelOperationConsumer } from '../../../src/coordination/app/channel-operations.js';
import { createCoordinationApplication, disabledCoordinationFeatureFlags } from '../../../src/coordination/app/application.js';
import { createCoordinationHttpServer } from '../../../src/coordination/http/index.js';
import { openCoordinationDatabase } from '../../../src/coordination/db/index.js';
import { resolveChessMoveTurnId } from '../../../src/coordination/chess/operations.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('native chess tool sends a fenced operation and rejects an unfenced turn', async () => {
  const input = { operation: 'move', gameId: 'chess_1', from: 'e2', to: 'e4', expectedVersion: 1 };
  const unavailable = await nativeChessTool.execute(input, {} as never);
  assert.equal(unavailable.is_error, true);
  const origin = { workId: 'wrk_1', attemptId: 'att_1', holderPrincipalId: 'bot_1', holderInstanceId: 'resident_1' };
  const calls: unknown[] = [];
  const result = await nativeChessTool.execute(input, {
    turnRuntime: { coordinationOrigin: origin }, parentToolCallId: 'tool_1',
    coordinationChannelOperation: async call => { calls.push(call); return { game: { id: 'chess_1', version: 2 } }; },
  } as never);
  assert.equal(result.is_error, undefined);
  assert.deepEqual(calls, [{ origin, invocationId: 'tool_1', args: { ...input, operation: 'chess_move' } }]);
});

test('chess mutation requires current direction while chess read uses read authorization', async () => {
  const checks: string[] = [];
  const origin = { workId: 'wrk_1', attemptId: 'att_1', holderPrincipalId: 'bot_1', holderInstanceId: 'resident_1' };
  const consumer = createChannelOperationConsumer({
    authorize: () => checks.push('write'), authorizeRead: () => checks.push('read'),
    assertCurrentDirection: () => checks.push('direction'),
    context: () => ({ principalId: 'bot_1' } as never),
    channels: {} as never, listBots: async () => [], botOperation: async () => ({}),
    chess: (context, _origin, args, key) => ({ actor: context.principalId, operation: args.operation, key }),
  });
  const read = await consumer({} as never, { origin, invocationId: 'get', args: { operation: 'chess_get', gameId: 'chess_1' } });
  assert.deepEqual(read, { actor: 'bot_1', operation: 'chess_get', key: 'wrk_1:att_1:get' });
  assert.deepEqual(checks, ['read']);
  checks.length = 0;
  const moved = await consumer({} as never, { origin, invocationId: 'move', args: { operation: 'chess_move', gameId: 'chess_1' } });
  assert.deepEqual(moved, { actor: 'bot_1', operation: 'chess_move', key: 'wrk_1:att_1:move' });
  assert.deepEqual(checks, ['write', 'direction']);
});

test('Chess HTTP requires owner auth and a key before mutation reaches storage', async t => {
  let storageCalls = 0;
  const application = createCoordinationApplication({
    flags: { ...disabledCoordinationFeatureFlags(), 'coordination.process.enabled': true, 'coordination.public_api.enabled': true },
    services: {
      auth: { validateAccessToken: async () => ({ principalId: 'user_owner', deviceId: 'dev_1', sessionId: 'ses_1', scopes: ['product:read', 'message:send'] }) },
      chess: { get: () => { storageCalls += 1; throw new Error('should not reach storage'); } } as never,
    },
  });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const { origin } = await server.start();
  const denied = await fetch(`${origin}/api/v1/chess/games/chess_1`);
  assert.equal(denied.status, 401);
  const missingKey = await fetch(`${origin}/api/v1/chess/games`, { method: 'POST', headers: { authorization: 'Bearer token', 'content-type': 'application/json' }, body: JSON.stringify({ channelId: 'channel_1', players: { white: 'user_owner', black: 'bot_1' } }) });
  assert.equal(missingKey.status, 400);
  assert.equal((await missingKey.json() as { error: { code: string } }).error.code, 'idempotency_key_required');
  assert.equal(storageCalls, 0);
});

test('only the Work admitted for the current Chess intent resolves a turn fence', t => {
  const root = mkdtempSync(join(tmpdir(), 'home23-chess-origin-'));
  const database = openCoordinationDatabase({ path: join(root, 'db.sqlite') });
  t.after(() => { database.close(); rmSync(root, { recursive: true, force: true }); });
  const at = '2026-09-19T12:00:00.000Z', bot = 'bot_0198d95f-6c00-7000-8000-000000000301';
  const channel = 'chn_0198d95f-6c00-7000-8000-000000000302';
  const game = 'chess_0198d95f-6c00-7000-8000-000000000303';
  const intent = 'chessturn_0198d95f-6c00-7000-8000-000000000304';
  const run = 'sched-run-0198d95f-6c00-7000-8000-000000000305';
  const message = 'msg_0198d95f-6c00-7000-8000-000000000306';
  const work = 'wrk_0198d95f-6c00-7000-8000-000000000307';
  try { database.mutateWithEvent(tx => {
    tx.run("INSERT INTO principals (id,kind,created_at) VALUES ('user_owner','owner',?)", at);
    tx.run("INSERT INTO principals (id,kind,created_at) VALUES (?,'bot',?)", bot, at);
    tx.run("INSERT INTO bots (id,principal_id,name,purpose,lifecycle,conversation_id,resident_binding,continuing_identity,durable_mailbox,required_capabilities_json,active_instance_id,active_key_version,resident_protocol_version,resident_capabilities_json,resident_registered_at,last_heartbeat_at,reported_availability,version,created_at,updated_at) VALUES (?,?,'Chess bot','Chess bot','active',NULL,?,1,1,'[]',NULL,NULL,NULL,'[]',NULL,NULL,NULL,1,?,?)", bot, bot, bot, at, at);
    tx.run("INSERT INTO channels (id,kind,title,purpose,owner_principal_id,responder_mode,coordinator_bot_id,response_order,max_bot_turns,lifecycle,pinned,version,next_message_sequence,created_at,updated_at) VALUES (?,'group','Chess','Chess','user_owner','mentions_only',NULL,'parallel',2,'active',0,1,2,?,?)", channel, at, at);
    for (const principal of ['user_owner', bot]) tx.run("INSERT INTO channel_members (channel_id,principal_id,kind,role,active,joined_at,left_at) VALUES (?,?,?,?,1,?,NULL)", channel, principal, principal === 'user_owner' ? 'owner' : 'bot', principal === 'user_owner' ? 'owner' : 'member', at);
    tx.run("INSERT INTO messages (id,channel_id,channel_sequence,author_principal_id,author_kind,author_display_name,kind,body_text,stored_visibility,created_at) VALUES (?,?,1,'user_owner','owner','Owner','text','Play','visible',?)", message, channel, at);
    tx.run("INSERT INTO context_manifests (id,privacy,channel_id,message_refs_json,artifact_refs_json,message_count,artifact_count,channel_watermark,event_watermark,context_digest,source_digest,created_at) VALUES ('ctx_1','channel_only',?,'[]','[]',0,0,0,0,?,?,?)", channel, 'a'.repeat(64), 'b'.repeat(64), at);
    tx.run("INSERT INTO works (id,principal_id,target_principal_id,channel_id,origin_message_id,context_manifest_id,kind,idempotency_key_digest,request_digest,state,next_fencing_token,automatic_offer_count,max_automatic_offers,version,created_at,updated_at) VALUES (?,'user_owner',?,?,?,'ctx_1','channel.bot_turn',?,?,'queued',1,0,1,1,?,?)", work, bot, channel, message, 'c'.repeat(64), 'd'.repeat(64), at, at);
    tx.run("INSERT INTO chess_games (id,channel_id,white_principal_id,black_principal_id,title,initial_fen,fen,pgn,moves_json,status,result,turn,ply,version,created_at,updated_at) VALUES (?,?,'user_owner',?,'Chess',? ,?,'','[]','active','*','b',1,2,?,?)", game, channel, bot, 'start', 'current', at, at);
    tx.run("INSERT INTO chess_turn_intents (id,game_id,game_version,channel_id,target_bot_id,run_id,prompt,status,created_at,updated_at) VALUES (?,?,2,?,?,?,'Play','dispatched',?,?)", intent, game, channel, bot, run, at, at);
    return { value: undefined, event: { type: 'message.appended', aggregateKind: 'message', aggregateId: message, aggregateVersion: 1, channelId: channel, actorPrincipalId: 'user_owner', requestId: 'req_0198d95f-6c00-7000-8000-000000000308', correlationId: 'cor_0198d95f-6c00-7000-8000-000000000309', payload: { messageId: message }, createdAt: at } };
  }); } catch (error) { throw new Error(`seed failed: ${String(error)}`); }
  database.mutateWithEvent(() => ({ value: undefined, event: { type: 'activity.updated', aggregateKind: 'scheduled_channel_run', aggregateId: run, aggregateVersion: 1, channelId: channel, actorPrincipalId: bot, requestId: 'req_0198d95f-6c00-7000-8000-000000000312', correlationId: 'cor_0198d95f-6c00-7000-8000-000000000313', payload: { messageId: message }, createdAt: at } }));
  const origin = { workId: work } as never;
  assert.equal(resolveChessMoveTurnId(database, origin, bot, game), intent);
  assert.equal(resolveChessMoveTurnId(database, origin, 'bot_other', game), undefined);
  database.mutateWithEvent(tx => {
    tx.run('UPDATE chess_games SET version=3 WHERE id=?', game);
    return { value: undefined, event: { type: 'test.stale', aggregateKind: 'test', aggregateId: 'stale', aggregateVersion: 1, channelId: channel, actorPrincipalId: bot, requestId: 'req_0198d95f-6c00-7000-8000-000000000310', correlationId: 'cor_0198d95f-6c00-7000-8000-000000000311', payload: {}, createdAt: at } };
  });
  assert.equal(resolveChessMoveTurnId(database, origin, bot, game), undefined);
});
