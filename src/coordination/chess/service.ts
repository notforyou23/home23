import { createHash, randomUUID } from 'node:crypto';
import { Chess, DEFAULT_POSITION, type Square } from 'chess.js';
import type { M11Database } from '../work/types.js';
import { generateCoordinationId, uuidV7 } from '../ids/index.js';
import type { CoordinationTransaction } from '../db/index.js';
import type { ChessActor, ChessGame, ChessMove, ChessPosition, ChessTurnIntent, ChessTurnDelivery } from './types.js';

export type { ChessActor, ChessGame, ChessMove, ChessPosition, ChessTurnIntent, ChessTurnDelivery } from './types.js';
export type ChessErrorCode = 'invalid_request' | 'not_found' | 'forbidden' | 'conflict' | 'illegal_move' | 'illegal_state';
export class ChessError extends Error {
  constructor(public readonly code: ChessErrorCode, message: string) { super(message); this.name = 'ChessError'; }
}

type GameRow = { id:string; channel_id:string; white_principal_id:string; black_principal_id:string; title:string; initial_fen:string; fen:string; pgn:string; moves_json:string; status:ChessGame['status']; result:ChessGame['result']; turn:'w'|'b'; ply:number; version:number; created_at:string; updated_at:string };
type PositionRow = { id:string; channel_id:string; title:string; fen:string; annotations_json:string; source_game_id:string|null; source_ply:number|null; created_by:string; created_at:string };
type IntentRow = { id:string; game_id:string; game_version:number; channel_id:string; target_bot_id:string; run_id:string; prompt:string; status:ChessTurnIntent['status']|'cancelled'; work_ids_json:string|null; error:string|null };
type ReplayRow = { request_digest:string; operation:string; response_json:string };
const digest = (value:string) => createHash('sha256').update(value).digest('hex');
const id = (prefix:string) => `${prefix}_${uuidV7()}`;
const now = () => new Date().toISOString();
const bounded = (value:unknown, name:string, max:number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ChessError('invalid_request', `${name} must be a nonempty string of at most ${max} characters`);
  return value.trim();
};
const square = (value:unknown): Square => {
  if (typeof value !== 'string' || !/^[a-h][1-8]$/.test(value)) throw new ChessError('invalid_request', 'invalid chess square');
  return value as Square;
};
const version = (value:unknown) => { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new ChessError('invalid_request', 'expectedVersion must be positive'); return value as number; };
const hashRequest = (operation:string, data:unknown) => digest(JSON.stringify([operation,data]));

export class NativeChessService {
  constructor(private readonly options: { database: M11Database }) {}
  private get db() { return this.options.database; }
  private channel(t:CoordinationTransaction, channelId:string, actor:ChessActor, active=false): void {
    const channel = t.readOne<{lifecycle:string}>('SELECT lifecycle FROM channels WHERE id = ?',channelId);
    if (!channel) throw new ChessError('not_found','channel not found');
    const member = t.readOne<{active:number}>('SELECT active FROM channel_members WHERE channel_id = ? AND principal_id = ?',channelId,actor.principalId);
    if (actor.principalId !== 'user_owner' && member?.active !== 1) throw new ChessError('forbidden','channel access denied');
    if (active && channel.lifecycle !== 'active') throw new ChessError('illegal_state','channel is archived');
  }
  private readChannel(channelId:string, actor:ChessActor): void {
    const channel=this.db.readOne<{lifecycle:string}>('SELECT lifecycle FROM channels WHERE id = ?',channelId);
    if (!channel) throw new ChessError('not_found','channel not found');
    if (actor.principalId !== 'user_owner' && !this.db.readOne('SELECT 1 FROM channel_members WHERE channel_id = ? AND principal_id = ? AND active = 1',channelId,actor.principalId)) throw new ChessError('forbidden','channel access denied');
  }
  private row(id:string,t?:CoordinationTransaction):GameRow {
    const row=(t??this.db).readOne<GameRow>('SELECT * FROM chess_games WHERE id = ?',id);
    if (!row) throw new ChessError('not_found','game not found');
    return row;
  }
  private delivery(gameId:string, gameVersion:number,t?:CoordinationTransaction): ChessTurnDelivery|undefined {
    const row=(t??this.db).readOne<IntentRow>('SELECT * FROM chess_turn_intents WHERE game_id = ? AND game_version = ?',gameId,gameVersion);
    return row && row.status !== 'cancelled' ? {id:row.id,gameVersion:row.game_version,status:row.status,workIds:JSON.parse(row.work_ids_json??'[]'),error:row.error} : undefined;
  }
  private game(row:GameRow,t?:CoordinationTransaction):ChessGame {
    const turnDelivery=this.delivery(row.id,row.version,t);
    return {id:row.id,channelId:row.channel_id,title:row.title,players:{white:row.white_principal_id,black:row.black_principal_id},initialFen:row.initial_fen,fen:row.fen,turn:row.turn,ply:row.ply,moves:JSON.parse(row.moves_json),status:row.status,result:row.result,version:row.version,createdAt:row.created_at,updatedAt:row.updated_at,...(turnDelivery?{turnDelivery}:{})};
  }
  private position(row:PositionRow):ChessPosition { return {id:row.id,channelId:row.channel_id,title:row.title,fen:row.fen,annotations:JSON.parse(row.annotations_json),...(row.source_game_id?{sourceGameId:row.source_game_id,sourcePly:row.source_ply!}:{}),createdBy:row.created_by,createdAt:row.created_at}; }
  private event(kind:'chess_game'|'chess_position'|'chess_turn_delivery',resourceId:string,aggregateVersion:number,channelId:string,actor:string,at:string,payload:Record<string,string|number|null>) {
    return {type:'activity.updated',aggregateKind:kind,aggregateId:resourceId,aggregateVersion,channelId,actorPrincipalId:actor,requestId:generateCoordinationId('request'),correlationId:generateCoordinationId('correlation'),payload,createdAt:at};
  }
  private replay(t:CoordinationTransaction,actor:string,key:string,op:string,request:unknown):{digest:string;existing?:unknown} {
    const keyDigest=digest(bounded(key,'idempotency key',256)); const requestDigest=hashRequest(op,request);
    const row=t.readOne<ReplayRow>('SELECT request_digest, operation, response_json FROM chess_idempotency WHERE actor_principal_id = ? AND key_digest = ?',actor,keyDigest);
    if (row && (row.request_digest !== requestDigest || row.operation !== op)) throw new ChessError('conflict','idempotency key used for a different request');
    return {digest:keyDigest,...(row?{existing:JSON.parse(row.response_json)}:{})};
  }
  private prior<T>(actor:string,key:string,op:string,request:unknown,channelId:string):T|undefined {
    const row=this.db.readOne<ReplayRow>('SELECT request_digest,operation,response_json FROM chess_idempotency WHERE actor_principal_id = ? AND key_digest = ?',actor,digest(bounded(key,'idempotency key',256)));
    if(!row)return undefined;
    if(row.operation!==op||row.request_digest!==hashRequest(op,request))throw new ChessError('conflict','idempotency key used for a different request');
    this.readChannel(channelId,{principalId:actor});
    return JSON.parse(row.response_json) as T;
  }
  private record(t:CoordinationTransaction,actor:string,keyDigest:string,op:string,request:unknown,resourceId:string,response:unknown,at:string) {
    t.run('INSERT INTO chess_idempotency (actor_principal_id,key_digest,request_digest,operation,resource_id,response_json,created_at) VALUES (?,?,?,?,?,?,?)',actor,keyDigest,hashRequest(op,request),op,resourceId,JSON.stringify(response),at);
  }
  private requirePlayer(t:CoordinationTransaction,channelId:string,principalId:string):void {
    const member=t.readOne<{active:number}>('SELECT active FROM channel_members WHERE channel_id = ? AND principal_id = ?',channelId,principalId);
    if (member?.active !== 1) throw new ChessError('invalid_request','each player must be an active channel member');
    if (principalId !== 'user_owner' && !principalId.startsWith('bot_')) throw new ChessError('invalid_request','invalid player');
    if (principalId.startsWith('bot_') && !t.readOne('SELECT 1 FROM bots WHERE id = ? AND lifecycle = ?',principalId,'active')) throw new ChessError('invalid_request','bot player is unavailable');
  }
  private queueTurn(t:CoordinationTransaction,row:GameRow,at:string):void {
    if (row.status !== 'active' || row.result !== '*') return;
    const target=row.turn==='w'?row.white_principal_id:row.black_principal_id;
    if (!target.startsWith('bot_')) return;
    const turnId=id('chessturn'); const runId=`sched-run-${randomUUID()}`;
    const prompt=`Play one legal chess move for game ${row.id} as ${row.turn==='w'?'White':'Black'}. Current FEN: ${row.fen}. Current version: ${row.version}. Use native_chess get if needed, then native_chess move with gameId ${row.id}, expectedVersion ${row.version}, from and to squares. Omit promotion or use null for ordinary moves; use q, r, b, or n only when a pawn reaches its last rank. Do not fill unrelated fields. Do not merely narrate a move.`;
    t.run("INSERT INTO chess_turn_intents (id,game_id,game_version,channel_id,target_bot_id,run_id,prompt,status,work_ids_json,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'queued',NULL,NULL,?,?)",turnId,row.id,row.version,row.channel_id,target,runId,prompt,at,at);
  }
  private cancelTurns(t:CoordinationTransaction,gameId:string,at:string):void { t.run("UPDATE chess_turn_intents SET status = 'cancelled', updated_at = ? WHERE game_id = ? AND status IN ('queued','dispatched','failed')",at,gameId); }
  list(input:{channelId?:string;limit?:number;cursor?:string},actor:ChessActor):{items:ChessGame[];nextCursor?:string} {
    if (input.channelId) this.readChannel(input.channelId,actor);
    const limit=Math.min(Math.max(input.limit??20,1),100);
    const rows=this.db.readAll<GameRow>(`SELECT g.* FROM chess_games g JOIN channel_members m ON m.channel_id=g.channel_id AND m.principal_id=? AND m.active=1 WHERE (? IS NULL OR g.channel_id=?) AND (? IS NULL OR g.id < ?) ORDER BY g.id DESC LIMIT ?`,actor.principalId,input.channelId??null,input.channelId??null,input.cursor??null,input.cursor??null,limit+1);
    const items=rows.slice(0,limit).map(row=>this.game(row));return {items,...(rows.length>limit?{nextCursor:items.at(-1)!.id}:{})};
  }
  get(gameId:string,actor:ChessActor):ChessGame { const row=this.row(gameId);this.readChannel(row.channel_id,actor);return this.game(row); }
  create(input:{channelId:string;title?:string;players:{white:string;black:string};initialPgn?:string},actor:ChessActor,key:string):ChessGame {
    bounded(input.channelId,'channelId',100);if (!input.players || input.players.white===input.players.black) throw new ChessError('invalid_request','distinct players required');
    const white=bounded(input.players.white,'white',100),black=bounded(input.players.black,'black',100),title=bounded(input.title??'Chess game','title',120);
    const chess=new Chess();if (input.initialPgn) {if (input.initialPgn.length>100_000) throw new ChessError('invalid_request','PGN too large');try { chess.loadPgn(input.initialPgn); } catch {throw new ChessError('invalid_request','invalid PGN');}if(chess.header().FEN && chess.header().FEN!==DEFAULT_POSITION)throw new ChessError('invalid_request','PGN must start from standard position');}
    const moves:ChessMove[]=[];const replayChess=new Chess();for(const move of chess.history({verbose:true})){const applied=replayChess.move(move.san);moves.push({ply:moves.length+1,uci:`${applied.from}${applied.to}${applied.promotion??''}`,san:applied.san,fen:replayChess.fen()});}
    const boardResult=chess.isCheckmate()?(chess.turn()==='w'?'0-1':'1-0'):chess.isDraw()?'1/2-1/2':'*';
    const declaredResult=chess.header().Result;
    if(input.initialPgn && boardResult!=='*' && declaredResult && declaredResult!=='*' && declaredResult!==boardResult)throw new ChessError('invalid_request','PGN result conflicts with the final board position');
    const importedResult=boardResult==='*' && ['1-0','0-1','1/2-1/2'].includes(declaredResult??'') ? declaredResult as ChessGame['result'] : boardResult;
    const at=now(); const gameId=id('chess');const request={channelId:input.channelId,title,players:{white,black},initialPgn:input.initialPgn??null};const prior=this.prior<ChessGame>(actor.principalId,key,'create',request,input.channelId);if(prior)return prior;
    return this.db.mutateWithEvent(t=>{this.channel(t,input.channelId,actor,true);this.requirePlayer(t,input.channelId,white);this.requirePlayer(t,input.channelId,black);if((white==='user_owner')===(black==='user_owner'))throw new ChessError('invalid_request','one owner and one bot required');if(actor.principalId!=='user_owner'&&actor.principalId!==white&&actor.principalId!==black) throw new ChessError('forbidden','bot must be a player to create a game');const replay=this.replay(t,actor.principalId,key,'create',request);if(replay.existing)throw new ChessError('conflict','concurrent replay');
      const result=importedResult;const status=result==='*'?'active':'finished';
      t.run('INSERT INTO chess_games (id,channel_id,white_principal_id,black_principal_id,title,initial_fen,fen,pgn,moves_json,status,result,turn,ply,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)',gameId,input.channelId,white,black,title,DEFAULT_POSITION,chess.fen(),chess.pgn(),JSON.stringify(moves),status,result,chess.turn(),moves.length,at,at);
      const row=this.row(gameId,t);this.queueTurn(t,row,at);const game=this.game(row,t);this.record(t,actor.principalId,replay.digest,'create',request,gameId,game,at);return {value:game,event:this.event('chess_game',gameId,1,input.channelId,actor.principalId,at,{gameId,version:1})};
    }).value;
  }
  move(gameId:string,input:{expectedVersion:number;from:string;to:string;promotion?:string},actor:ChessActor,key:string):ChessGame {
    version(input.expectedVersion);const from=square(input.from),to=square(input.to);const promotion=input.promotion;if(promotion!==undefined && !['q','r','b','n'].includes(promotion)) throw new ChessError('invalid_request','promotion must be q, r, b, or n for pawn promotion; omit it otherwise');
    const at=now();const request={gameId,expectedVersion:input.expectedVersion,from,to,promotion:promotion??null};const prior=this.prior<ChessGame>(actor.principalId,key,'move',request,this.row(gameId).channel_id);if(prior)return prior;
    return this.db.mutateWithEvent(t=>{const row=this.row(gameId,t);this.channel(t,row.channel_id,actor,true);const replay=this.replay(t,actor.principalId,key,'move',request);if(replay.existing)throw new ChessError('conflict','concurrent replay');
      if(row.version!==input.expectedVersion)throw new ChessError('conflict','stale game version');if(row.status!=='active')throw new ChessError('illegal_state','game is not active');if((row.turn==='w'?row.white_principal_id:row.black_principal_id)!==actor.principalId)throw new ChessError('forbidden','not this side to move');
      if(actor.principalId.startsWith('bot_')) {
        const intent=t.readOne<IntentRow>("SELECT * FROM chess_turn_intents WHERE game_id = ? AND game_version = ? AND status IN ('queued','dispatched')",gameId,row.version);
        if(!intent||intent.id!==actor.turnId||intent.target_bot_id!==actor.principalId)throw new ChessError('forbidden','bot move requires its current scheduled turn');
      }
      const chess=new Chess();if(row.pgn) chess.loadPgn(row.pgn);let move;try{move=chess.move({from,to,...(promotion?{promotion}:{})});}catch{throw new ChessError('illegal_move','illegal chess move');}if(!move)throw new ChessError('illegal_move','illegal chess move');
      const moves:ChessMove[]=JSON.parse(row.moves_json);moves.push({ply:row.ply+1,uci:`${move.from}${move.to}${move.promotion??''}`,san:move.san,fen:chess.fen()});const result=chess.isCheckmate()?(chess.turn()==='w'?'0-1':'1-0'):chess.isDraw()?'1/2-1/2':'*';this.cancelTurns(t,gameId,at);
      t.run('UPDATE chess_games SET fen=?,pgn=?,moves_json=?,status=?,result=?,turn=?,ply=?,version=version+1,updated_at=? WHERE id=? AND version=?',chess.fen(),chess.pgn(),JSON.stringify(moves),result==='*'?'active':'finished',result,chess.turn(),moves.length,at,gameId,row.version);
      const updated=this.row(gameId,t);this.queueTurn(t,updated,at);const game=this.game(updated,t);this.record(t,actor.principalId,replay.digest,'move',request,gameId,game,at);return {value:game,event:this.event('chess_game',gameId,updated.version,row.channel_id,actor.principalId,at,{gameId,version:updated.version})};
    }).value;
  }
  control(gameId:string,input:{expectedVersion:number;action:'pause'|'resume'|'resign'|'retry_turn'},actor:ChessActor,key:string):ChessGame {
    version(input.expectedVersion);if(!['pause','resume','resign','retry_turn'].includes(input.action))throw new ChessError('invalid_request','invalid action');const at=now();const request={gameId,...input};const prior=this.prior<ChessGame>(actor.principalId,key,'control',request,this.row(gameId).channel_id);if(prior)return prior;
    return this.db.mutateWithEvent(t=>{const row=this.row(gameId,t);this.channel(t,row.channel_id,actor,true);const replay=this.replay(t,actor.principalId,key,'control',request);if(replay.existing)throw new ChessError('conflict','concurrent replay');
      if(row.version!==input.expectedVersion)throw new ChessError('conflict','stale game version');if(row.status==='finished')throw new ChessError('illegal_state','game is finished');let status:ChessGame['status']=row.status,result:ChessGame['result']=row.result;
      if(input.action==='pause'||input.action==='resume'||input.action==='retry_turn') {if(actor.principalId!=='user_owner')throw new ChessError('forbidden','owner control required');if(input.action==='pause'){if(row.status!=='active')throw new ChessError('illegal_state','game is already paused');status='paused';}else if(input.action==='resume'){if(row.status!=='paused')throw new ChessError('illegal_state','game is already active');status='active';}else {if(row.status!=='active'||!(row.turn==='w'?row.white_principal_id:row.black_principal_id).startsWith('bot_')||this.delivery(row.id,row.version,t)?.status!=='failed')throw new ChessError('illegal_state','only a failed bot turn can be retried');}}
      else {if(actor.principalId!==row.white_principal_id&&actor.principalId!==row.black_principal_id)throw new ChessError('forbidden','only a player may resign');if(actor.principalId.startsWith('bot_')){const intent=t.readOne<IntentRow>("SELECT * FROM chess_turn_intents WHERE game_id = ? AND game_version = ? AND status IN ('queued','dispatched')",gameId,row.version);if(!intent||intent.id!==actor.turnId||intent.target_bot_id!==actor.principalId)throw new ChessError('forbidden','bot resignation requires its current scheduled turn');}status='finished';result=actor.principalId===row.white_principal_id?'0-1':'1-0';}
      this.cancelTurns(t,gameId,at);t.run('UPDATE chess_games SET status=?,result=?,version=version+1,updated_at=? WHERE id=? AND version=?',status,result,at,gameId,row.version);const updated=this.row(gameId,t);if(input.action==='resume'||input.action==='retry_turn')this.queueTurn(t,updated,at);const game=this.game(updated,t);this.record(t,actor.principalId,replay.digest,'control',request,gameId,game,at);return {value:game,event:this.event('chess_game',gameId,updated.version,row.channel_id,actor.principalId,at,{gameId,version:updated.version})};
    }).value;
  }
  exportPgn(gameId:string,actor:ChessActor):string {const row=this.row(gameId);this.readChannel(row.channel_id,actor);const chess=new Chess();if(row.pgn)chess.loadPgn(row.pgn);chess.setHeader('White',row.white_principal_id);chess.setHeader('Black',row.black_principal_id);chess.setHeader('Result',row.result);return chess.pgn();}
  savePosition(input:{channelId:string;title:string;fen:string;annotations?:ChessPosition['annotations'];sourceGameId?:string;sourcePly?:number},actor:ChessActor,key:string):ChessPosition {
    const title=bounded(input.title,'title',120),chess=new Chess();try{chess.load(bounded(input.fen,'fen',200));}catch{throw new ChessError('invalid_request','invalid FEN');}const annotations=input.annotations??{arrows:[],highlights:[]};if(!annotations||!Array.isArray(annotations.arrows)||!Array.isArray(annotations.highlights)||annotations.arrows.length>64||annotations.highlights.length>64)throw new ChessError('invalid_request','invalid annotations');for(const a of annotations.arrows){if(!a||typeof a!=='object')throw new ChessError('invalid_request','invalid arrow');square(a.from);square(a.to);if(a.color!==undefined)bounded(a.color,'color',24);}for(const h of annotations.highlights){if(!h||typeof h!=='object')throw new ChessError('invalid_request','invalid highlight');square(h.square);if(h.color!==undefined)bounded(h.color,'color',24);}
    const at=now(),positionId=id('chesspos'),request={channelId:input.channelId,title,fen:chess.fen(),annotations,sourceGameId:input.sourceGameId??null,sourcePly:input.sourcePly??null};const prior=this.prior<ChessPosition>(actor.principalId,key,'savePosition',request,input.channelId);if(prior)return prior;return this.db.mutateWithEvent(t=>{this.channel(t,input.channelId,actor,true);const replay=this.replay(t,actor.principalId,key,'savePosition',request);if(replay.existing)throw new ChessError('conflict','concurrent replay');
      if((input.sourceGameId===undefined)!==(input.sourcePly===undefined))throw new ChessError('invalid_request','source game and ply must be supplied together');if(input.sourceGameId){const game=this.row(input.sourceGameId,t);if(game.channel_id!==input.channelId||!Number.isSafeInteger(input.sourcePly)||input.sourcePly!<0||input.sourcePly!>game.ply)throw new ChessError('invalid_request','invalid source game ply');const expected=input.sourcePly===0?game.initial_fen:(JSON.parse(game.moves_json) as ChessMove[])[input.sourcePly!-1]?.fen;if(expected!==chess.fen())throw new ChessError('invalid_request','source ply FEN mismatch');}
      t.run('INSERT INTO chess_positions (id,channel_id,title,fen,annotations_json,source_game_id,source_ply,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',positionId,input.channelId,title,chess.fen(),JSON.stringify(annotations),input.sourceGameId??null,input.sourcePly??null,actor.principalId,at);const position=this.position(t.readOne<PositionRow>('SELECT * FROM chess_positions WHERE id = ?',positionId)!);this.record(t,actor.principalId,replay.digest,'savePosition',request,positionId,position,at);return {value:position,event:this.event('chess_position',positionId,1,input.channelId,actor.principalId,at,{positionId})};
    }).value;
  }
  getPosition(positionId:string,actor:ChessActor):ChessPosition {const row=this.db.readOne<PositionRow>('SELECT * FROM chess_positions WHERE id = ?',positionId);if(!row)throw new ChessError('not_found','position not found');this.readChannel(row.channel_id,actor);return this.position(row);}
  listPositions(input:{channelId:string;limit?:number;cursor?:string},actor:ChessActor):{items:ChessPosition[];nextCursor?:string} {this.readChannel(input.channelId,actor);const limit=Math.min(Math.max(input.limit??20,1),100);const rows=this.db.readAll<PositionRow>('SELECT * FROM chess_positions WHERE channel_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?',input.channelId,input.cursor??null,input.cursor??null,limit+1);const items=rows.slice(0,limit).map(row=>this.position(row));return {items,...(rows.length>limit?{nextCursor:items.at(-1)!.id}:{})};}
  dueTurns(limit=20):ChessTurnIntent[] {const rows=this.db.readAll<IntentRow>("SELECT i.* FROM chess_turn_intents i JOIN chess_games g ON g.id=i.game_id AND g.version=i.game_version AND g.status='active' WHERE i.status IN ('queued','dispatched') ORDER BY i.created_at,i.id LIMIT ?",Math.min(Math.max(limit,1),100));return rows.map(r=>({id:r.id,gameId:r.game_id,gameVersion:r.game_version,channelId:r.channel_id,targetBotId:r.target_bot_id,runId:r.run_id,prompt:r.prompt,status:r.status as 'queued'|'dispatched',workIds:JSON.parse(r.work_ids_json??'[]'),error:r.error}));}
  settleTurn(intentId:string,input:{status:'dispatched'|'failed';workIds?:string[];error?:string}):void {
    if(!['dispatched','failed'].includes(input.status)||input.workIds?.some(v=>typeof v!=='string'||v.length>120)||(input.error?.length??0)>1000)throw new ChessError('invalid_request','invalid turn receipt');
    const before=this.db.readOne<IntentRow>('SELECT * FROM chess_turn_intents WHERE id = ?',intentId);
    if(!before)throw new ChessError('not_found','turn intent not found');
    const current=this.db.readOne<{version:number;status:string}>('SELECT version,status FROM chess_games WHERE id = ?',before.game_id);
    if(!current||current.version!==before.game_version||current.status!=='active'||before.status==='cancelled')return;
    if(before.status==='dispatched'&&input.status==='dispatched'&&JSON.stringify(input.workIds??[])===before.work_ids_json)return;
    const at=now();
    try {
      this.db.mutateWithEvent(t=>{
        const row=t.readOne<IntentRow>('SELECT * FROM chess_turn_intents WHERE id = ?',intentId)!;
        const game=this.row(row.game_id,t);
        if(game.version!==row.game_version||game.status!=='active'||row.status==='cancelled')throw new SupersededTurn();
        if(row.status==='failed')throw new ChessError('illegal_state','failed turn requires owner retry');
        if(row.status==='dispatched'&&input.status==='dispatched'&&JSON.stringify(input.workIds??[])!==row.work_ids_json)throw new ChessError('conflict','turn already dispatched');
        const revision=row.status==='queued'?1:2;
        t.run('UPDATE chess_turn_intents SET status=?,work_ids_json=?,error=?,updated_at=? WHERE id=?',input.status,JSON.stringify(input.workIds??JSON.parse(row.work_ids_json??'[]')),input.error??null,at,intentId);
        return {value:undefined,event:this.event('chess_turn_delivery',intentId,revision,game.channel_id,row.target_bot_id,at,{gameId:game.id,version:game.version,deliveryStatus:input.status})};
      });
    } catch(error) { if(!(error instanceof SupersededTurn))throw error; }
  }
}

class SupersededTurn extends Error {}
