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

test('engine options carry an optional setup: absent from older Houses, otherwise one of four states', () => {
  const options = loadCanonicalFixture('chess-options') as {engine: Record<string, unknown>};
  assert.deepEqual(options.engine.setup, {state: 'found', path: '/opt/homebrew/bin/stockfish', source: 'homebrew'});
  const {setup: _setup, ...older} = options.engine;
  const variant = (engine: Record<string, unknown>) => validateCanonicalFixture('chess-options', {...options, engine});
  assert.deepEqual(variant(older), {valid: true, errors: []});
  for (const setup of [
    {state: 'not_installed', detail: 'Stockfish is not installed on this House.', guidance: 'Install Stockfish with Homebrew: brew install stockfish'},
    {state: 'not_executable', path: '/usr/local/bin/stockfish', source: 'homebrew', detail: '/usr/local/bin/stockfish is not an executable file.',
      guidance: 'Reinstall Stockfish with Homebrew: brew reinstall stockfish'},
    {state: 'probe_failed', path: '/Users/owner/Tools/stockfish', source: 'configured',
      detail: 'Stockfish at /Users/owner/Tools/stockfish failed a startup check: Stockfish could not start.',
      guidance: 'Correct or remove the configured Stockfish path (chess.engine.path in config/home.yaml, or HOME23_STOCKFISH_PATH), then restart Home23'},
  ]) assert.deepEqual(variant({...older, available: false, reason: `${setup.detail} ${setup.guidance}`, setup}), {valid: true, errors: []}, setup.state);
  assert.equal(variant({...older, setup: {state: 'downloading'}}).valid, false);
  assert.equal(variant({...older, setup: {path: '/opt/homebrew/bin/stockfish'}}).valid, false);
  assert.equal(variant({...older, setup: {state: 'found', source: 'path'}}).valid, false);
});
