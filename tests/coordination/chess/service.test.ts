import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openCoordinationDatabase } from '../../../src/coordination/db/index.js';
import { nativeChessTool } from '../../../src/agent/tools/channels.js';
import { executeChessOperation } from '../../../src/coordination/chess/operations.js';
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
test('due turns page past superseded intents using the status and time index',t=>{
  const f=fixture(t);
  const game=f.service.create({channelId:CHANNEL,players:{white:BOT,black:'user_owner'}},owner,'paged-turn');
  const current=f.service.dueTurns()[0]!;
  f.database.mutateWithEvent(tx=>{
    for(let n=0;n<45;n++) tx.run(`INSERT INTO chess_turn_intents
      (id,game_id,game_version,channel_id,target_bot_id,run_id,prompt,status,work_ids_json,error,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'queued',NULL,NULL,?,?)`,
      `chessturn_stale_${String(n).padStart(3,'0')}`,game.id,n+100,CHANNEL,BOT,`stale-${n}`,'old turn',
      '2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z');
    return {value:undefined,event:{type:'test.seed',aggregateKind:'test',aggregateId:'chess-old-turns',aggregateVersion:1,channelId:CHANNEL,actorPrincipalId:'user_owner',requestId:'req_0198d95f-6c00-7000-8000-000000000371',correlationId:'cor_0198d95f-6c00-7000-8000-000000000372',payload:{},createdAt:NOW}};
  });
  const plan=f.database.readAll<{detail:string}>(`EXPLAIN QUERY PLAN SELECT * FROM chess_turn_intents INDEXED BY chess_turn_intents_due
    WHERE status=? AND (created_at,id) > (?,?) ORDER BY created_at,id LIMIT ?`,'queued','','',20);
  assert.ok(plan.some(row=>row.detail.includes('chess_turn_intents_due')));
  assert.ok(plan.every(row=>!row.detail.includes('USE TEMP B-TREE')));
  let found=false;
  for(let n=0;n<3;n++) if(f.service.dueTurns().some(turn=>turn.id===current.id)) found=true;
  assert.equal(found,true,'the valid intent follows bounded pages of stale history');
  assert.ok(f.service.dueTurns().every(turn=>turn.id===current.id));
  f.database.close();
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

async function moveThroughTool(service: NativeChessService, actor: {principalId: string; turnId: string}, input: Record<string, unknown>, key: string) {
  return nativeChessTool.execute(input, {
    turnRuntime: { coordinationOrigin: { workId: 'offline-chess-regression' } }, parentToolCallId: key,
    coordinationChannelOperation: async ({ args }: {args: Record<string, unknown>}) => executeChessOperation(service, actor, args, key),
  } as never);
}

test('recorded ordinary-move promotion placeholders succeed through tool, operation and durable service', async t => {
  const f = fixture(t);
  try {
    for (const [i, promotion] of [undefined, null, '', ' ', 'none', 'q'].entries()) {
      const game = f.service.create({channelId: CHANNEL, players: {white: 'user_owner', black: BOT}}, owner, `create-${i}`);
      const afterOwner = f.service.move(game.id, {expectedVersion: 1, from: 'e2', to: 'e4'}, owner, `owner-${i}`);
      const actor = {...bot, turnId: f.service.dueTurns().find(turn => turn.gameId === game.id)!.id};
      const input = {operation: 'move', gameId: game.id, expectedVersion: afterOwner.version, from: 'e7', to: 'e5', ...(promotion === undefined ? {} : {promotion}), positionId: '', players: {white: '', black: ''}, initialPgn: '', action: 'pause', cursor: ''};
      const result = await moveThroughTool(f.service, actor, input, `move-${i}`);
      assert.equal(JSON.parse(result.content).game.moves.at(-1).uci, 'e7e5');
      assert.equal(f.service.get(game.id, owner).ply, 2);
      const replay = await moveThroughTool(f.service, actor, input, `move-${i}`);
      assert.equal(replay.content, result.content);
      assert.equal(f.service.get(game.id, owner).ply, 2);
    }
  } finally { f.database.close(); }
});

test('tool preserves explicit underpromotion and rejects missing or invalid promotion without moving', async t => {
  const f = fixture(t);
  try {
    const game = f.service.create({channelId: CHANNEL, players: {white: BOT, black: 'user_owner'}, initialPgn: '1. a4 h5 2. a5 h4 3. a6 h3 4. axb7 hxg2'}, owner, 'promotion-game');
    const actor = {...bot, turnId: f.service.dueTurns()[0]!.id};
    const input = {operation: 'move', gameId: game.id, expectedVersion: game.version, from: 'b7', to: 'a8'};
    await assert.rejects(moveThroughTool(f.service, actor, {...input, promotion: null}, 'missing'), /illegal chess move/);
    await assert.rejects(moveThroughTool(f.service, actor, {...input, promotion: 'king'}, 'invalid'), /promotion must be/);
    await assert.rejects(moveThroughTool(f.service, actor, {...input, from: ''}, 'bad-from'), /from must be a nonempty string/);
    assert.equal(f.service.get(game.id, owner).version, game.version);
    const result = await moveThroughTool(f.service, actor, {...input, promotion: 'n'}, 'underpromotion');
    assert.equal(JSON.parse(result.content).game.moves.at(-1).uci, 'b7a8n');
  } finally { f.database.close(); }
});

test('engine seats stay outside House principals, step once, resume to limit and survive restart', async t => {
  const f=fixture(t); t.after(()=>f.database.close());
  const {Chess}=await import('chess.js');
  const engine={available:()=>true, analyze:async (input:{fen:string;moves?:string[]})=>{
    const board=new Chess(input.fen); for(const uci of input.moves??[]) board.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]});
    const m=board.moves({verbose:true})[0]!;
    return {fen:board.fen(),bestMove:m.from+m.to+(m.promotion??''),lines:[]};
  }};
  let service=new NativeChessService({database:f.database,engine});
  let game=service.create({channelId:CHANNEL,players:{white:'engine_stockfish_3',black:'engine_stockfish_3'},startPaused:true,automation:{maxPlies:2}},owner,'engine-game');
  assert.equal(game.status,'paused'); assert.equal(service.dueTurns().length,0);
  assert.equal(f.database.readOne("SELECT id FROM principals WHERE id LIKE 'engine_%'"),undefined);
  game=service.control(game.id,{expectedVersion:game.version,action:'step'},owner,'engine-step');
  const first=service.dueTurns()[0]!; await service.runEngineTurn(first);
  game=service.get(game.id,owner); assert.equal(game.ply,1);assert.equal(game.status,'paused');assert.equal(game.pauseReason,'Single turn complete');
  await service.runEngineTurn(first); assert.equal(service.get(game.id,owner).ply,1);
  game=service.control(game.id,{expectedVersion:game.version,action:'resume'},owner,'engine-run');
  service=new NativeChessService({database:f.database,engine});
  await service.runEngineTurn(service.dueTurns()[0]!); await service.runEngineTurn(service.dueTurns()[0]!);
  game=service.get(game.id,owner); assert.equal(game.ply,3);assert.equal(game.status,'paused');assert.equal(game.automation?.remainingPlies,0);
  assert.equal(service.dueTurns().length,0);
  assert.deepEqual(f.database.readAll('PRAGMA foreign_key_check'),[]);
});

test('engine results cannot move after pause or draining; public owner cannot impersonate engine', async t => {
  const f=fixture(t); t.after(()=>f.database.close());
  let finish!: (value:{fen:string;bestMove:string;lines:never[]})=>void;
  const service=new NativeChessService({database:f.database,engine:{available:()=>true,analyze:()=>new Promise(resolve=>{finish=resolve;})}});
  let game=service.create({channelId:CHANNEL,players:{white:'engine_stockfish_0',black:BOT}},owner,'race-game');
  assert.throws(()=>service.move(game.id,{expectedVersion:1,from:'e2',to:'e4'},owner,'impersonate'),/not this side/);
  const turn=service.dueTurns()[0]!;const work=service.runEngineTurn(turn);
  service.control(game.id,{expectedVersion:1,action:'pause'},owner,'pause-race');
  finish({fen:game.fen,bestMove:'e2e4',lines:[]}); await assert.rejects(work,/stale game version/);
  assert.equal(service.get(game.id,owner).ply,0);
  game=service.get(game.id,owner); game=service.control(game.id,{expectedVersion:game.version,action:'resume'},owner,'resume-race');
  let accepting=true; const drain=service.runEngineTurn(service.dueTurns()[0]!,undefined,()=>accepting); accepting=false;
  finish({fen:game.fen,bestMove:'e2e4',lines:[]}); await drain;assert.equal(service.get(game.id,owner).ply,0);
});

test('owner creates bot-vs-bot; bots cannot start spectator games; next turn alternates with a cap',t=>{
  const f=fixture(t); t.after(()=>f.database.close());
  f.database.mutateWithEvent(tx=>{
    tx.run("INSERT INTO channel_members (channel_id,principal_id,kind,role,active,joined_at,left_at) VALUES (?,?,'bot','member',1,?,NULL)",CHANNEL,OTHER,NOW);
    return {value:undefined,event:{type:'test.member',aggregateKind:'test',aggregateId:'second-member',aggregateVersion:1,channelId:CHANNEL,actorPrincipalId:'user_owner',requestId:'req_0198d95f-6c00-7000-8000-000000000399',correlationId:'cor_0198d95f-6c00-7000-8000-000000000398',payload:{},createdAt:NOW}};
  });
  const input={channelId:CHANNEL,players:{white:BOT,black:OTHER},automation:{maxPlies:2}};
  assert.throws(()=>f.service.create(input,bot,'bot-spectator'),/Only the owner/);
  let game=f.service.create(input,owner,'owner-spectator');
  let turn=f.service.dueTurns()[0]!;assert.equal(turn.targetBotId,BOT);
  game=f.service.move(game.id,{expectedVersion:game.version,from:'e2',to:'e4'},{principalId:BOT,turnId:turn.id},'bot-white');
  turn=f.service.dueTurns()[0]!;assert.equal(turn.targetBotId,OTHER);
  game=f.service.move(game.id,{expectedVersion:game.version,from:'e7',to:'e5'},{principalId:OTHER,turnId:turn.id},'bot-black');
  assert.equal(game.status,'paused');assert.equal(game.ply,2);assert.equal(f.service.dueTurns().length,0);
  assert.throws(()=>f.service.control(game.id,{expectedVersion:game.version,action:'resign'},owner,'spectator-resign'),/only a player/);
});

test('analysis is owner-only and an absent engine reports availability without mutating games',async t=>{
  const f=fixture(t);t.after(()=>f.database.close());
  assert.equal(f.service.engineOptions().engine.available,false);
  await assert.rejects(f.service.analyze({fen:'ignored'},bot),(error:unknown)=>(error as {code:string}).code==='forbidden');
  await assert.rejects(f.service.analyze({fen:'ignored'},owner),(error:unknown)=>(error as {code:string}).code==='engine_unavailable');
  assert.equal(f.service.list({channelId:CHANNEL},owner).items.length,0);
});


test('global study library lists accessible channels and preserves explicit channel filtering', t=>{
  const f=fixture(t);t.after(()=>f.database.close());
  const game=f.service.create({channelId:CHANNEL,players:{white:'user_owner',black:BOT}},owner,'study-game');
  const position=f.service.savePosition({channelId:CHANNEL,title:'Study',fen:game.fen},owner,'global-study');
  assert.equal(f.service.listPositions({},owner).items[0]?.id,position.id);
  assert.equal(f.service.listPositions({},bot).items[0]?.id,position.id);
  assert.deepEqual(f.service.listPositions({},{principalId:OTHER}).items,[]);
  assert.equal(f.service.listPositions({channelId:CHANNEL},owner).items[0]?.id,position.id);
});

test('records count completed outcomes once, distinguish opponents, exclude unfinished games and respect access', t=>{
  const f=fixture(t);t.after(()=>f.database.close());
  const service=new NativeChessService({database:f.database,engine:{available:()=>true,analyze:async()=>{throw Error('unused');}}});
  const pairing={channelId:CHANNEL,players:{white:'user_owner',black:BOT}};
  service.create({...pairing,initialPgn:'1. e4 1-0'},owner,'record-win');
  service.create({...pairing,initialPgn:'1. e4 1-0'},owner,'record-win'); // exact retry is not another game
  service.create({...pairing,initialPgn:'1. e4 1/2-1/2'},owner,'record-draw');
  const engineGame=service.create({channelId:CHANNEL,players:{white:'engine_stockfish_4',black:'user_owner'}},owner,'record-engine');
  service.control(engineGame.id,{expectedVersion:1,action:'resign'},owner,'record-resign');
  service.create({...pairing,startPaused:true},owner,'record-paused');
  service.create(pairing,owner,'record-active');
  const stats=service.statistics(owner);
  assert.equal(stats.finishedGames,3);assert.equal(stats.activeGames,1);assert.equal(stats.pausedGames,1);
  assert.deepEqual(stats.players.find(p=>p.id==='user_owner'),{id:'user_owner',games:3,wins:1,losses:1,draws:1});
  assert.deepEqual(stats.opponents.find(p=>p.id===BOT),{id:BOT,games:2,wins:1,losses:0,draws:1});
  assert.deepEqual(stats.opponents.find(p=>p.id==='engine_stockfish_4'),{id:'engine_stockfish_4',games:1,wins:0,losses:1,draws:0});
  assert.deepEqual(service.statistics({principalId:OTHER}),{finishedGames:0,activeGames:0,pausedGames:0,players:[],opponents:[]});
  service.create({channelId:CHANNEL,players:{white:'engine_stockfish_6',black:'engine_stockfish_6'},initialPgn:'1. e4 1-0'},owner,'same-engine-record');
  assert.deepEqual(service.statistics(owner).players.find(p=>p.id==='engine_stockfish_6'),{id:'engine_stockfish_6',games:2,wins:1,losses:1,draws:0});
});
