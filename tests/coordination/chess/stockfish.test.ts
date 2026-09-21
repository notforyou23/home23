import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Chess, DEFAULT_POSITION } from 'chess.js';
import { StockfishEngine, StockfishError } from '../../../src/coordination/chess/stockfish.js';

function fixture(t: test.TestContext, mode = 'normal') {
  const directory = mkdtempSync(join(process.env.HOME23_STOCKFISH_TEST_TMPDIR ?? tmpdir(), 'stockfish test '));
  const path = join(directory, 'stockfish');
  const log = join(directory, 'commands');
  const previous = process.env.HOME23_STOCKFISH_PATH;
  const previousPath = process.env.PATH;
  writeFileSync(path, `#!${process.execPath}
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const mode = ${JSON.stringify(mode)};
const log = ${JSON.stringify(log)};
appendFileSync(log, 'pid ' + process.pid + '\\n');
createInterface({input: process.stdin}).on('line', line => {
  appendFileSync(log, line + '\\n');
  if (line === 'uci') {
    process.stdout.write('id name fixture\\r\\nuci');
    setTimeout(() => process.stdout.write('ok\\r\\n'), 5);
  } else if (line === 'isready') process.stdout.write('readyok\\n');
  else if (line.startsWith('go ')) {
    if (mode === 'hang') return;
    if (mode === 'malformed') return process.stdout.write('bestmove banana\\n');
    if (mode === 'illegal-pv') return process.stdout.write('info depth 3 score cp 2 pv e7e4\\nbestmove e7e5\\n');
    if (mode === 'overflow') return process.stdout.write('x'.repeat(20000));
    if (mode === 'none') return process.stdout.write('bestmove (none)\\n');
    process.stdout.write('info depth bad score cp nope pv junk\\ninfo string depth 9 score cp 99 pv a7a5\\ninfo depth 12 multipv 2 score mate -3 pv c7c5\\ninfo depth 12 multipv 1 sco');
    setTimeout(() => {
      process.stdout.write('re cp 24 nodes 150 pv e7e5 g1f3\\r');
      setTimeout(() => process.stdout.write('\\ninfo depth 11 multipv 1 score cp 9 pv e7e6\\nbestmove e7e5 ponder g1f3\\n'), 5);
    }, 5);
  } else if (line === 'quit') process.exit(0);
});
`);
  chmodSync(path, 0o755);
  process.env.HOME23_STOCKFISH_PATH = path;
  t.after(() => {
    if (previous === undefined) delete process.env.HOME23_STOCKFISH_PATH;
    else process.env.HOME23_STOCKFISH_PATH = previous;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, path, log, engine: new StockfishEngine() };
}
const code = (expected: StockfishError['code']) => (error: unknown) => error instanceof StockfishError && error.code === expected;
async function started(log: string) {
  for (let i = 0; i < 200; i++) {
    if (existsSync(log) && readFileSync(log, 'utf8').includes('go movetime')) return;
    await delay(5);
  }
  assert.fail('Fixture did not start searching');
}
function reaped(log: string) {
  const pid = Number(readFileSync(log, 'utf8').match(/^pid (\d+)/)?.[1]);
  assert.throws(() => process.kill(pid, 0), (error: any) => error.code === 'ESRCH');
}

test('fragmented UCI, bounded settings, ordered cp/mate PVs, resulting FEN and immutable command', async t => {
  const f = fixture(t);
  const input = { fen: DEFAULT_POSITION, moves: ['e2e4'], skillLevel: -4, moveTimeMs: 2000, multiPV: 8 };
  const pending = f.engine.analyze(input);
  input.moves.push('injected\nquit');
  const result = await pending;
  const chess = new Chess(); chess.move('e4');
  assert.equal(result.fen, chess.fen());
  assert.equal(result.bestMove, 'e7e5');
  assert.deepEqual(result.lines, [
    { depth: 12, scoreCp: 24, moves: ['e7e5', 'g1f3'] },
    { depth: 12, mate: -3, moves: ['c7c5'] },
  ]);
  const commands = readFileSync(f.log, 'utf8');
  for (const command of ['Threads value 1', 'Hash value 32', 'Skill Level value 0', 'MultiPV value 3', 'go movetime 1500', `position fen ${DEFAULT_POSITION} moves e2e4\n`]) assert.ok(commands.includes(command), command);
  assert.ok(!commands.includes('injected'));
  reaped(f.log);
});

test('availability is only executable lookup; override is authoritative; reject illegal input before launch', async t => {
  const f = fixture(t);
  assert.equal(f.engine.available(), true);
  assert.equal(existsSync(f.log), false);
  delete process.env.HOME23_STOCKFISH_PATH;
  process.env.PATH = f.directory;
  assert.equal(f.engine.available(), true);
  process.env.HOME23_STOCKFISH_PATH = join(f.directory, 'missing');
  assert.equal(f.engine.available(), false);
  await assert.rejects(f.engine.analyze({ fen: DEFAULT_POSITION }), code('engine_unavailable'));
  process.env.HOME23_STOCKFISH_PATH = f.path;
  for (const input of [
    { fen: 'invalid' }, { fen: DEFAULT_POSITION + '\nquit' },
    { fen: '8/8/8/8/8/8/4k3/4K3 w - - 0 1' },
    { fen: DEFAULT_POSITION, moves: ['e2e5'] },
    { fen: DEFAULT_POSITION, moves: ['e2e4\nquit'] },
    { fen: DEFAULT_POSITION, moveTimeMs: NaN },
  ]) await assert.rejects(f.engine.analyze(input), code('invalid_input'));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.engine.analyze({ fen: DEFAULT_POSITION }, abort.signal), code('engine_cancelled'));
  assert.equal(existsSync(f.log), false);
});

test('global busy rejection, event-loop responsiveness, hard deadline and child reap', async t => {
  const f = fixture(t, 'hang');
  const pending = f.engine.analyze({ fen: DEFAULT_POSITION, moveTimeMs: 1 });
  const rejection = assert.rejects(pending, code('engine_timeout'));
  await assert.rejects(new StockfishEngine().analyze({ fen: DEFAULT_POSITION }), code('engine_busy'));
  await started(f.log);
  let ticks = 0;
  const interval = setInterval(() => ticks++, 20);
  await rejection;
  clearInterval(interval);
  assert.ok(ticks > 5);
  reaped(f.log);
});

test('abort sends stop, kills an unresponsive engine, and releases the slot', async t => {
  const f = fixture(t, 'hang');
  const abort = new AbortController();
  const pending = assert.rejects(f.engine.analyze({ fen: DEFAULT_POSITION }, abort.signal), code('engine_cancelled'));
  await started(f.log);
  abort.abort();
  await pending;
  assert.match(readFileSync(f.log, 'utf8'), /\nstop\n/);
  reaped(f.log);
});

test('malformed bestmove, illegal PV and oversized stdout fail closed and release slot', async t => {
  for (const mode of ['malformed', 'illegal-pv', 'overflow']) {
    await t.test(mode, async child => {
      const f = fixture(child, mode);
      await assert.rejects(f.engine.analyze({ fen: DEFAULT_POSITION, moves: ['e2e4'] }), code('engine_protocol'));
      reaped(f.log);
    });
  }
});

test('terminal position accepts null bestmove only when no legal moves remain', async t => {
  const f = fixture(t, 'none');
  const result = await f.engine.analyze({ fen: DEFAULT_POSITION, moves: ['f2f3', 'e7e5', 'g2g4', 'd8h4'] });
  assert.equal(result.bestMove, null);
  assert.deepEqual(result.lines, []);
  await assert.rejects(f.engine.analyze({ fen: DEFAULT_POSITION }), code('engine_protocol'));
});
