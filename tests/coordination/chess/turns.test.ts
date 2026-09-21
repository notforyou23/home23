import assert from 'node:assert/strict';
import test from 'node:test';
import { M11TestDatabase, CHANNEL_ID, BOT_ID } from '../work/test-fixture.js';
import { CHESS_ENGINES_MIGRATION_SQL } from '../../../src/coordination/migrations/0020-chess-engines.js';
import { NATIVE_CHESS_MIGRATION_SQL } from '../../../src/coordination/migrations/0017-native-chess.js';
import { NativeChessService } from '../../../src/coordination/chess/service.js';
import { createChessTurnDispatcher } from '../../../src/coordination/chess/turns.js';
import { executeChessOperation } from '../../../src/coordination/chess/operations.js';

test('durable turn survives restart, moves through the bot tool, and never treats prose as a move', async t => {
  const db = M11TestDatabase.temporary(); t.after(() => db.close()); db.raw.exec(NATIVE_CHESS_MIGRATION_SQL); db.raw.exec(CHESS_ENGINES_MIGRATION_SQL);
  let chess = new NativeChessService({ database: db });
  const owner = {principalId:'user_owner'}, bot = {principalId:BOT_ID};
  let game = chess.create({channelId:CHANNEL_ID,players:{white:'user_owner',black:BOT_ID}},owner,'create-game');
  game = chess.move(game.id,{expectedVersion:game.version,from:'e2',to:'e4'},owner,'first-move');
  const original = chess.dueTurns()[0]!;
  db.reopen(); chess = new NativeChessService({database:db});
  assert.equal(chess.dueTurns()[0]!.runId, original.runId);
  let calls = 0;
  const dispatch = createChessTurnDispatcher({chess,accepting:()=>true,run:async (input, botId) => {
    calls++; assert.equal(botId,BOT_ID); assert.equal(input.runId,original.runId); assert.match(input.runId,/^sched-run-/);
    const result = executeChessOperation(chess, { ...bot, turnId: original.id }, {operation:'chess_move',gameId:game.id,expectedVersion:game.version,from:'e7',to:'e5'},'bot-move') as {game:{ply:number}};
    assert.equal(result.game.ply,2); return {state:'succeeded',workIds:['wrk_fixture']};
  }});
  await dispatch(); await dispatch();
  assert.equal(calls,1); assert.equal(chess.dueTurns().length,0); assert.equal(chess.get(game.id,owner).turnDelivery,undefined);
  game = chess.get(game.id,owner);
  game = chess.move(game.id,{expectedVersion:game.version,from:'g1',to:'f3'},owner,'second-move');
  const noMove = createChessTurnDispatcher({chess,accepting:()=>true,run:async()=>({state:'succeeded',workIds:['wrk_no_move']})});
  await noMove(); await noMove();
  assert.equal(chess.get(game.id,owner).turnDelivery?.status,'failed');
  assert.equal(chess.get(game.id,owner).ply,3); assert.equal(chess.dueTurns().length,0);
  const retry = chess.control(game.id,{expectedVersion:game.version,action:'retry_turn'},owner,'retry');
  assert.notEqual(chess.dueTurns()[0]!.runId,original.runId); assert.equal(retry.turnDelivery?.status,'queued');
});

test('engine migration preserves populated games, positions, turns and idempotency', t => {
  const db=M11TestDatabase.temporary();t.after(()=>db.close());db.raw.exec(NATIVE_CHESS_MIGRATION_SQL);
  const at='2026-09-20T12:00:00.000Z';
  db.raw.prepare(`INSERT INTO chess_games VALUES ('chess_old',?,'user_owner',?,'Existing game','start','after e4','1. e4','[{"uci":"e2e4"}]','active','*','b',1,2,?,?)`).run(CHANNEL_ID,BOT_ID,at,at);
  db.raw.prepare(`INSERT INTO chess_positions VALUES ('chesspos_old',?,'Saved','after e4','{}','chess_old',1,'user_owner',?)`).run(CHANNEL_ID,at);
  db.raw.prepare(`INSERT INTO chess_turn_intents VALUES ('chessturn_old','chess_old',2,?,?,'run_old','Play','dispatched','["work_old"]',NULL,?,?)`).run(CHANNEL_ID,BOT_ID,at,at);
  db.raw.prepare(`INSERT INTO chess_idempotency VALUES ('user_owner',?,?,'move','chess_old','{"version":2}',?)`).run('a'.repeat(64),'b'.repeat(64),at);
  const tables=['chess_games','chess_positions','chess_turn_intents','chess_idempotency'];
  const before=tables.map(table=>db.raw.prepare(`SELECT * FROM ${table}`).get() as Record<string,unknown>);
  db.raw.transaction(()=>db.raw.exec(CHESS_ENGINES_MIGRATION_SQL))();
  tables.forEach((table,i)=>{
    const after=db.raw.prepare(`SELECT * FROM ${table}`).get() as Record<string,unknown>;
    for(const [key,value] of Object.entries(before[i]!))assert.deepEqual(after[key],value,`${table}.${key}`);
  });
  assert.deepEqual(db.raw.pragma('foreign_key_check'),[]);
  assert.throws(()=>db.raw.prepare("UPDATE chess_games SET white_principal_id='engine_stockfish_99'").run(),/supported engine/);
  db.raw.prepare("UPDATE chess_games SET white_principal_id='engine_stockfish_20'").run();
  assert.equal(db.raw.prepare('SELECT automatic_remaining FROM chess_games').pluck().get(),80);
});
