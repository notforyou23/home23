import assert from 'node:assert/strict';
import test from 'node:test';
import { Chess } from 'chess.js';
import { loadCanonicalFixture, validateCanonicalFixture } from '../../../src/coordination/contracts/contract-pack.js';
import type { ChessGame, ChessPosition } from '../../../src/coordination/chess/types.js';

test('native Chess fixtures agree on legal history, immutable position and compact Apple stream', () => {
  for (const name of ['chess-game','chess-position','chess-snapshot','chess-engine-game','chess-options']) assert.deepEqual(validateCanonicalFixture(name),{valid:true,errors:[]});
  const {game,boardReference} = loadCanonicalFixture('chess-game') as {game:ChessGame;boardReference:{sharedPly:number;sharedVersion:number}};
  const {position} = loadCanonicalFixture('chess-position') as {position:ChessPosition};
  const board = new Chess(game.initialFen);
  for (const move of game.moves) {board.move(move.san);assert.equal(board.fen(),move.fen);}
  assert.equal(board.fen(),game.fen); assert.equal(boardReference.sharedPly,game.ply); assert.equal(boardReference.sharedVersion,game.version);
  assert.equal(position.sourceGameId,game.id);assert.equal(position.sourcePly,game.ply);assert.equal(position.fen,game.fen);
  const snapshot = loadCanonicalFixture('chess-snapshot') as Record<string,unknown>;
  assert.equal(snapshot.moves,undefined);assert.ok(Buffer.byteLength(JSON.stringify(snapshot))<48_000);assert.deepEqual(snapshot.lastMove,game.moves.at(-1));
});
