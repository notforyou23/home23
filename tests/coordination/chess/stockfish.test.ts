import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Chess, DEFAULT_POSITION } from 'chess.js';
import { STOCKFISH_HOMEBREW_PATHS, StockfishEngine, StockfishError } from '../../../src/coordination/chess/stockfish.js';

const NOT_INSTALLED = { state: 'not_installed', detail: 'Stockfish is not installed on this House.', guidance: 'Install Stockfish with Homebrew: brew install stockfish' };
const CONFIGURED_GUIDANCE = 'Correct or remove the configured Stockfish path (chess.engine.path in config/home.yaml, or HOME23_STOCKFISH_PATH), then restart Home23';

/** A UCI stand-in. crash exits on its first command; env records the variable names it
 * inherited. From the start position it plays e2e4; otherwise it answers as Black after 1. e4. */
function script(mode: string, log: string) {
  return `#!${process.execPath}
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const mode = ${JSON.stringify(mode)};
const log = ${JSON.stringify(log)};
let position = '';
appendFileSync(log, 'pid ' + process.pid + '\\n');
if (mode === 'env') appendFileSync(log, 'env ' + JSON.stringify(Object.keys(process.env).sort()) + '\\n');
createInterface({input: process.stdin}).on('line', line => {
  appendFileSync(log, line + '\\n');
  if (mode === 'crash') process.exit(3);
  if (line.startsWith('position ')) position = line;
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
    if (!position.includes(' moves ')) return process.stdout.write('info depth 1 score cp 20 pv e2e4\\nbestmove e2e4\\n');
    process.stdout.write('info depth bad score cp nope pv junk\\ninfo string depth 9 score cp 99 pv a7a5\\ninfo depth 12 multipv 2 score mate -3 pv c7c5\\ninfo depth 12 multipv 1 sco');
    setTimeout(() => {
      process.stdout.write('re cp 24 nodes 150 pv e7e5 g1f3\\r');
      setTimeout(() => process.stdout.write('\\ninfo depth 11 multipv 1 score cp 9 pv e7e6\\nbestmove e7e5 ponder g1f3\\n'), 5);
    }, 5);
  } else if (line === 'quit') process.exit(0);
});
`;
}

function fixture(t: test.TestContext, mode = 'normal') {
  const directory = mkdtempSync(join(process.env.HOME23_STOCKFISH_TEST_TMPDIR ?? tmpdir(), 'stockfish test '));
  const path = join(directory, 'stockfish');
  const log = join(directory, 'commands');
  const previous = process.env.HOME23_STOCKFISH_PATH;
  const previousPath = process.env.PATH;
  writeFileSync(path, script(mode, log));
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
  assert.equal(new StockfishEngine({ candidates: [] }).available(), false, 'PATH is never searched');
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

test('a configured path is authoritative; otherwise the first usable Homebrew location, never PATH', t => {
  const f = fixture(t);
  const other = join(f.directory, 'other stockfish');
  writeFileSync(other, script('normal', f.log)); chmodSync(other, 0o755);
  const missing = join(f.directory, 'missing');
  assert.deepEqual(new StockfishEngine({ candidates: [other] }).status(), { state: 'found', path: f.path, source: 'configured' });
  process.env.HOME23_STOCKFISH_PATH = missing;
  const configured = new StockfishEngine({ candidates: [other] });
  assert.deepEqual(configured.status(), { state: 'not_installed', path: missing, source: 'configured',
    detail: `There is no Stockfish at ${missing}.`, guidance: CONFIGURED_GUIDANCE });
  assert.equal(configured.available(), false);
  process.env.HOME23_STOCKFISH_PATH = ' ';
  assert.deepEqual(new StockfishEngine({ candidates: [missing, other, f.path] }).status(), { state: 'found', path: other, source: 'homebrew' });
  delete process.env.HOME23_STOCKFISH_PATH;
  assert.deepEqual(new StockfishEngine({ candidates: [f.path, other] }).status(), { state: 'found', path: f.path, source: 'homebrew' });
  process.env.PATH = f.directory;
  assert.deepEqual(new StockfishEngine({ candidates: [missing] }).status(), NOT_INSTALLED);
  assert.equal(existsSync(f.log), false, 'discovery never launches a process');
});

test('without a configured path Core checks /opt/homebrew, then /usr/local, through its file seam', () => {
  const present = new Set<string>(), checked: string[] = [];
  const fs = {
    lstat(path: string) { checked.push(path); if (!present.has(path)) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return {}; },
    stat: (path: string) => ({ isFile: () => true, dev: 1, ino: path.length, size: 1, mtimeMs: 1, ctimeMs: 1 }),
    access() {},
  };
  const engine = new StockfishEngine({ env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin' }, fs });
  assert.deepEqual(engine.status(), NOT_INSTALLED);
  assert.deepEqual(checked, ['/opt/homebrew/bin/stockfish', '/usr/local/bin/stockfish']);
  present.add('/usr/local/bin/stockfish');
  assert.deepEqual(engine.status(), { state: 'found', path: '/usr/local/bin/stockfish', source: 'homebrew' });
  present.add('/opt/homebrew/bin/stockfish');
  assert.deepEqual(engine.status(), { state: 'found', path: '/opt/homebrew/bin/stockfish', source: 'homebrew' });
  assert.deepEqual(STOCKFISH_HOMEBREW_PATHS, ['/opt/homebrew/bin/stockfish', '/usr/local/bin/stockfish']);
});

test('only a regular executable file is found; a link to one counts and anything else is refused', t => {
  const f = fixture(t);
  delete process.env.HOME23_STOCKFISH_PATH;
  const plain = join(f.directory, 'plain');
  writeFileSync(plain, script('normal', f.log)); chmodSync(plain, 0o644);
  const folder = join(f.directory, 'folder'); mkdirSync(folder);
  const broken = join(f.directory, 'broken'); symlinkSync(join(f.directory, 'nowhere'), broken);
  const link = join(f.directory, 'link'); symlinkSync(f.path, link);
  for (const candidate of [plain, folder, broken]) {
    assert.deepEqual(new StockfishEngine({ candidates: [candidate] }).status(), { state: 'not_executable', path: candidate, source: 'homebrew',
      detail: `${candidate} is not an executable file.`, guidance: 'Reinstall Stockfish with Homebrew: brew reinstall stockfish' }, candidate);
  }
  assert.deepEqual(new StockfishEngine({ candidates: [plain, link] }).status(), { state: 'found', path: link, source: 'homebrew' });
  process.env.HOME23_STOCKFISH_PATH = plain;
  assert.deepEqual(new StockfishEngine({ candidates: [link] }).status(), { state: 'not_executable', path: plain, source: 'configured',
    detail: `${plain} is not an executable file.`, guidance: CONFIGURED_GUIDANCE });
});

test('a probe checks a found engine once, reports a failing one without throwing and checks a replaced file again', async t => {
  const f = fixture(t, 'crash');
  const launched: string[] = [];
  const engine = new StockfishEngine({ spawn: ((command: string, args: string[], options: object) => {
    launched.push(command); return spawn(command, args, options);
  }) as typeof spawn });
  assert.equal(engine.available(), true);
  const failed = await engine.setup();
  assert.deepEqual(failed, { state: 'probe_failed', path: f.path, source: 'configured',
    detail: `Stockfish at ${f.path} failed a startup check: Stockfish exited before returning a best move.`, guidance: CONFIGURED_GUIDANCE });
  assert.equal(engine.available(), false);
  assert.deepEqual(engine.status(), failed);
  assert.deepEqual(await engine.setup(), failed);
  assert.deepEqual(launched, [f.path]);
  reaped(f.log);
  writeFileSync(f.path, script('normal', f.log));
  assert.deepEqual(await engine.setup(), { state: 'found', path: f.path, source: 'configured' });
  assert.equal(engine.available(), true);
  assert.deepEqual(await Promise.all([engine.setup(), engine.setup()]), [{ state: 'found', path: f.path, source: 'configured' }, { state: 'found', path: f.path, source: 'configured' }]);
  assert.deepEqual(launched, [f.path, f.path]);
  assert.match(readFileSync(f.log, 'utf8'), /\ngo movetime 10\n/);
});

test('concurrent requests share one probe, and a probe never competes with a running search', async t => {
  const f = fixture(t, 'hang');
  const abort = new AbortController();
  const running = assert.rejects(f.engine.analyze({ fen: DEFAULT_POSITION }, abort.signal), code('engine_cancelled'));
  await started(f.log);
  assert.deepEqual(await new StockfishEngine().setup(), { state: 'found', path: f.path, source: 'configured' });
  assert.equal(readFileSync(f.log, 'utf8').match(/^pid /gm)?.length, 1);
  abort.abort();
  await running;
  writeFileSync(f.path, script('normal', f.log));
  const launched: string[] = [];
  const engine = new StockfishEngine({ spawn: ((command: string, args: string[], options: object) => {
    launched.push(command); return spawn(command, args, options);
  }) as typeof spawn });
  const results = await Promise.all([engine.setup(), engine.setup(), engine.setup()]);
  assert.ok(results.every(result => result.state === 'found'));
  assert.deepEqual(launched, [f.path]);
});

test('Stockfish inherits only basic process variables, never Core settings or credentials', async t => {
  const f = fixture(t, 'env');
  const previous = process.env.HOME23_COORDINATION_CAPABILITY_TOKEN;
  process.env.HOME23_COORDINATION_CAPABILITY_TOKEN = 'fixture-capability';
  t.after(() => {
    if (previous === undefined) delete process.env.HOME23_COORDINATION_CAPABILITY_TOKEN;
    else process.env.HOME23_COORDINATION_CAPABILITY_TOKEN = previous;
  });
  await f.engine.analyze({ fen: DEFAULT_POSITION });
  const inherited = JSON.parse(readFileSync(f.log, 'utf8').match(/^env (.*)$/m)![1]!) as string[];
  // macOS CoreFoundation sets __CF_USER_TEXT_ENCODING inside the child itself.
  assert.deepEqual(inherited.filter(key => key !== '__CF_USER_TEXT_ENCODING'),
    ['HOME', 'LANG', 'PATH', 'TMPDIR'].filter(key => process.env[key] !== undefined));
});
