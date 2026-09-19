import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openCoordinationDatabase } from '../../../src/coordination/db/index.js';
import { NativeChessService, ChessError } from '../../../src/coordination/chess/service.js';

const BOT='bot_0198d95f-6c00-7000-8000-000000000301';
const OTHER='bot_0198d95f-6c00-7000-8000-000000000302';
const CHANNEL='chn_0198d95f-6c00-7000-8000-000000000303';
const NOW='2026-09-19T12:00:00.000Z';
const owner={principalId:'user_owner'};
const bot={principalId:BOT};
function fixture(t:test.TestContext) {
  const directory=mkdtempSync(join(tmpdir(),'home23-chess-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'db.sqlite');const database=openCoordinationDatabase({path});
  database.mutateWithEvent(tx=>{
    tx.run("INSERT INTO principals (id,kind,created_at) VALUES ('user_owner','owner',?)",NOW);
    for(const b of [BOT,OTHER]) {
      tx.run("INSERT INTO principals (id,kind,created_at) VALUES (?,'bot',?)",b,NOW);
      tx.run(`INSERT INTO bots (id,principal_id,name,purpose,lifecycle,conversation_id,resident_binding,continuing_identity,durable_mailbox,required_capabilities_json,active_instance_id,active_key_version,resident_protocol_version,resident_capabilities_json,resident_registered_at,last_heartbeat_at,reported_availability,version,created_at,updated_at) VALUES (?,?,'Chess bot','Chess bot','active',NULL,?,1,1,'[]',NULL,NULL,NULL,'[]',NULL,NULL,NULL,1,?,?)`,b,b,b,NOW,NOW);
    }
    tx.run(`INSERT INTO channels (id,kind,title,purpose,owner_principal_id,responder_mode,coordinator_bot_id,response_order,max_bot_turns,lifecycle,pinned,version,next_message_sequence,created_at,updated_at) VALUES (?,'group','Chess','Chess','user_owner','mentions_only',NULL,'parallel',2,'active',0,1,1,?,?)`,CHANNEL,NOW,NOW);
    for(const p of ['user_owner',BOT])tx.run("INSERT INTO channel_members (channel_id,principal_id,kind,role,active,joined_at,left_at) VALUES (?,?,?,?,1,?,NULL)",CHANNEL,p,p==='user_owner'?'owner':'bot',p==='user_owner'?'owner':'member',NOW);
    return {value:undefined,event:{type:'test.seed',aggregateKind:'test',aggregateId:'chess-seed',aggregateVersion:1,channelId:CHANNEL,actorPrincipalId:'user_owner',requestId:'req_0198d95f-6c00-7000-8000-000000000304',correlationId:'cor_0198d95f-6c00-7000-8000-000000000305',payload:{},createdAt:NOW}};
  });
  return {path,database,service:new NativeChessService({database})};
}
test('durable legal game, replay, stale writes, access, and bot intent',t=>{
  const f=fixture(t);const request={channelId:CHANNEL,players:{white:'user_owner',black:BOT}};
  const game=f.service.create(request,owner,'create-1');assert.equal(game.version,1);assert.equal(f.service.create(request,owner,'create-1').id,game.id);
  assert.match(game.id,/^chess_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(f.database.readOne<{n:number}>("SELECT count(*) n FROM events WHERE aggregate_kind='chess_game'")?.n,1);
  const moved=f.service.move(game.id,{expectedVersion:1,from:'e2',to:'e4'},owner,'move-1');assert.equal(moved.version,2);assert.equal(moved.moves[0]?.san,'e4');assert.equal(moved.turnDelivery?.status,'queued');
  assert.equal(f.service.move(game.id,{expectedVersion:1,from:'e2',to:'e4'},owner,'move-1').version,2);
  assert.throws(()=>f.service.move(game.id,{expectedVersion:1,from:'d2',to:'d4'},owner,'move-2'),(e:unknown)=>e instanceof ChessError&&e.code==='conflict');
  assert.throws(()=>f.service.move(game.id,{expectedVersion:2,from:'e7',to:'e5'},owner,'move-3'),(e:unknown)=>e instanceof ChessError&&e.code==='forbidden');
  assert.throws(()=>f.service.get(game.id,{principalId:OTHER}),(e:unknown)=>e instanceof ChessError&&e.code==='forbidden');
  const intent=f.service.dueTurns()[0]!;assert.equal(intent.gameId,game.id);assert.match(intent.runId,/^sched-run-/);
  f.service.settleTurn(intent.id,{status:'dispatched',workIds:['work-1']});assert.equal(f.service.get(game.id,owner).turnDelivery?.status,'dispatched');
  const events=f.database.readOne<{n:number}>("SELECT count(*) n FROM events WHERE type='activity.updated'")!.n;
  f.service.settleTurn(intent.id,{status:'dispatched',workIds:['work-1']});
  assert.equal(f.database.readOne<{n:number}>("SELECT count(*) n FROM events WHERE type='activity.updated'")!.n,events);
  f.database.close();const reopened=openCoordinationDatabase({path:f.path});const service=new NativeChessService({database:reopened});
  assert.equal(service.get(game.id,owner).moves[0]?.uci,'e2e4');assert.equal(service.dueTurns()[0]?.status,'dispatched');
  assert.throws(()=>service.move(game.id,{expectedVersion:2,from:'e7',to:'e5'},bot,'unfenced'),(e:unknown)=>e instanceof ChessError&&e.code==='forbidden');
  const next=service.move(game.id,{expectedVersion:2,from:'e7',to:'e5'},{...bot,turnId:intent.id},'bot-1');assert.equal(next.version,3);assert.equal(service.dueTurns().length,0);
  service.settleTurn(intent.id,{status:'failed',error:'late result'});assert.equal(service.get(game.id,owner).version,3);reopened.close();
});
test('saved position is independent of later game moves',t=>{
  const f=fixture(t);const game=f.service.create({channelId:CHANNEL,players:{white:'user_owner',black:BOT}},owner,'create');
  const position=f.service.savePosition({channelId:CHANNEL,title:'Start',fen:game.fen,sourceGameId:game.id,sourcePly:0,annotations:{arrows:[{from:'e2',to:'e4'}],highlights:[{square:'e4'}]}},owner,'position');
  assert.throws(()=>f.service.savePosition({channelId:CHANNEL,title:'Bad',fen:game.fen,annotations:{arrows:[null as never],highlights:[]}},owner,'bad'),(e:unknown)=>e instanceof ChessError&&e.code==='invalid_request');
  f.service.move(game.id,{expectedVersion:1,from:'e2',to:'e4'},owner,'move');assert.equal(f.service.getPosition(position.id,owner).fen,game.fen);assert.equal(f.service.listPositions({channelId:CHANNEL},owner).items.length,1);f.database.close();
});
test('PGN import accepts underpromotion, detects mate, and rejects custom starts',t=>{
  const f=fixture(t);
  const promotion=f.service.create({channelId:CHANNEL,players:{white:'user_owner',black:BOT},initialPgn:'1. a4 h5 2. a5 h4 3. a6 h3 4. axb7 hxg2 5. bxa8=N'},owner,'promotion');
  assert.equal(promotion.moves.at(-1)?.uci,'b7a8n');assert.equal(promotion.moves.at(-1)?.san,'bxa8=N');
  const mate=f.service.create({channelId:CHANNEL,players:{white:'user_owner',black:BOT},initialPgn:'1. f3 e5 2. g4 Qh4#'},owner,'mate');
  assert.equal(mate.result,'0-1');assert.equal(mate.status,'finished');assert.match(f.service.exportPgn(mate.id,owner),/Qh4#/);
  assert.throws(()=>f.service.create({channelId:CHANNEL,players:{white:'user_owner',black:BOT},initialPgn:'[SetUp "1"]\n[FEN "8/8/8/8/8/8/8/K6k w - - 0 1"]\n\n*'},owner,'custom'),(e:unknown)=>e instanceof ChessError&&e.code==='invalid_request');
  const declared=f.service.create({channelId:CHANNEL,players:{white:'user_owner',black:BOT},initialPgn:'1. e4 e5 0-1'},owner,'declared-result');
  assert.equal(declared.result,'0-1');assert.equal(declared.status,'finished');assert.equal(f.service.dueTurns().some(turn=>turn.gameId===declared.id),false);
  assert.throws(()=>f.service.create({channelId:CHANNEL,players:{white:'user_owner',black:BOT},initialPgn:'1. f3 e5 2. g4 Qh4# 1-0'},owner,'contradict-mate'),(e:unknown)=>e instanceof ChessError&&e.code==='invalid_request');
  f.database.close();
});
test('resigned game PGN exports and imports as finished',t=>{
  const f=fixture(t);const original=f.service.create({channelId:CHANNEL,players:{white:'user_owner',black:BOT}},owner,'original');
  const resigned=f.service.control(original.id,{expectedVersion:1,action:'resign'},owner,'resign');
  assert.equal(resigned.result,'0-1');
  const pgn=f.service.exportPgn(original.id,owner);
  const imported=f.service.create({channelId:CHANNEL,players:{white:'user_owner',black:BOT},initialPgn:pgn},owner,'import-resign');
  assert.equal(imported.result,'0-1');assert.equal(imported.status,'finished');assert.equal(f.service.dueTurns().some(turn=>turn.gameId===imported.id),false);
  f.database.close();
});
test('owner can pause, resume, and retry a failed bot turn once',t=>{
  const f=fixture(t);const game=f.service.create({channelId:CHANNEL,players:{white:BOT,black:'user_owner'}},owner,'create');
  const intent=f.service.dueTurns()[0]!;
  assert.throws(()=>f.service.control(game.id,{expectedVersion:1,action:'retry_turn'},owner,'premature'),(e:unknown)=>e instanceof ChessError&&e.code==='illegal_state');
  f.service.settleTurn(intent.id,{status:'dispatched',workIds:['work-1']});
  assert.throws(()=>f.service.control(game.id,{expectedVersion:1,action:'retry_turn'},owner,'still-running'),(e:unknown)=>e instanceof ChessError&&e.code==='illegal_state');
  f.service.settleTurn(intent.id,{status:'failed',error:'provider unavailable'});
  assert.equal(f.service.get(game.id,owner).turnDelivery?.error,'provider unavailable');assert.equal(f.service.dueTurns().length,0);
  const retry=f.service.control(game.id,{expectedVersion:1,action:'retry_turn'},owner,'retry');assert.equal(retry.version,2);assert.equal(f.service.dueTurns().length,1);
  assert.throws(()=>f.service.control(game.id,{expectedVersion:2,action:'resign'},{...bot,turnId:intent.id},'stale-resign'),(e:unknown)=>e instanceof ChessError&&e.code==='forbidden');
  const paused=f.service.control(game.id,{expectedVersion:2,action:'pause'},owner,'pause');assert.equal(paused.status,'paused');assert.equal(f.service.dueTurns().length,0);
  const resumed=f.service.control(game.id,{expectedVersion:3,action:'resume'},owner,'resume');assert.equal(resumed.status,'active');assert.equal(f.service.dueTurns().length,1);
  f.database.close();
});
test('cached create replay still requires current channel access',t=>{
  const f=fixture(t);const input={channelId:CHANNEL,players:{white:BOT,black:'user_owner'}};
  f.service.create(input,bot,'bot-create');
  f.database.mutateWithEvent(tx=>{
    tx.run("UPDATE channel_members SET active=0,left_at=? WHERE channel_id=? AND principal_id=?",NOW,CHANNEL,BOT);
    return {value:undefined,event:{type:'test.membership',aggregateKind:'test',aggregateId:'chess-revocation',aggregateVersion:1,channelId:CHANNEL,actorPrincipalId:'user_owner',requestId:'req_0198d95f-6c00-7000-8000-000000000315',correlationId:'cor_0198d95f-6c00-7000-8000-000000000316',payload:{},createdAt:NOW}};
  });
  assert.throws(()=>f.service.create(input,bot,'bot-create'),(e:unknown)=>e instanceof ChessError&&e.code==='forbidden');
  f.database.close();
});
