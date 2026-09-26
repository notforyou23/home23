import { spawn } from 'node:child_process';
import { accessSync, constants, lstatSync, statSync, type Stats } from 'node:fs';
import { resolve } from 'node:path';
import { Chess, DEFAULT_POSITION } from 'chess.js';

export interface StockfishAnalysisInput {
  fen: string;
  moves?: string[];
  skillLevel?: number;
  moveTimeMs?: number;
  multiPV?: number;
}
export interface StockfishAnalysis {
  /** Position after input.moves, before bestMove. Scores are for its side to move. */
  fen: string;
  bestMove: string | null;
  lines: Array<{ moves: string[]; scoreCp?: number; mate?: number; depth: number }>;
}
export class StockfishError extends Error {
  constructor(public readonly code: 'engine_unavailable' | 'engine_busy' | 'engine_timeout' | 'engine_cancelled' | 'engine_protocol' | 'invalid_input', message: string) {
    super(message);
    this.name = 'StockfishError';
  }
}

/** Standard Homebrew locations, Apple silicon first. Without a configured path Core
 * checks these and nothing else: it never searches PATH for an engine. */
export const STOCKFISH_HOMEBREW_PATHS: readonly string[] = Object.freeze(['/opt/homebrew/bin/stockfish', '/usr/local/bin/stockfish']);
const STOCKFISH_INSTALL_GUIDANCE = 'Install Stockfish with Homebrew: brew install stockfish';
const REINSTALL_GUIDANCE = 'Reinstall Stockfish with Homebrew: brew reinstall stockfish';
const CONFIGURED_GUIDANCE = 'Correct or remove the configured Stockfish path (chess.engine.path in config/home.yaml, or HOME23_STOCKFISH_PATH), then restart Home23';
export type StockfishSetupState = 'found' | 'not_installed' | 'not_executable' | 'probe_failed';
/** Where Stockfish is and whether Core can use it. Every state but found carries detail and guidance. */
export interface StockfishSetup {
  state: StockfishSetupState;
  /** The executable Core runs, or the one it cannot use. */
  path?: string;
  /** configured: HOME23_STOCKFISH_PATH, which home.yaml chess.engine.path sets; homebrew: a standard Homebrew location. */
  source?: 'configured' | 'homebrew';
  /** What is wrong. */
  detail?: string;
  /** What the owner can do about it. */
  guidance?: string;
}
export const STOCKFISH_NOT_INSTALLED: Readonly<StockfishSetup> = Object.freeze({
  state: 'not_installed', detail: 'Stockfish is not installed on this House.', guidance: STOCKFISH_INSTALL_GUIDANCE,
});
/** One sentence for clients that show only a reason: what is wrong, then what to do. */
export function stockfishUnavailableReason(setup: StockfishSetup): string | undefined {
  return setup.state === 'found' ? undefined : [setup.detail, setup.guidance].filter(Boolean).join(' ');
}
/** Test seams. Production reads the process environment, the file system and child_process. */
export interface StockfishDiscovery {
  env?: NodeJS.ProcessEnv;
  /** Locations checked, in order, when no path is configured. */
  candidates?: readonly string[];
  fs?: {
    lstat(path: string): unknown;
    stat(path: string): Pick<Stats, 'isFile' | 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>;
    access(path: string, mode: number): void;
  };
  spawn?: typeof spawn;
}
type Located = { setup: StockfishSetup; identity?: string };

// Shared across instances: Core never accumulates an unbounded subprocess queue.
let busy = false;
const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const DEADLINE_MS = 10_000;
const PROBE_DEADLINE_MS = 5_000;
/** How long a failed probe stands before an options request checks the same file again. */
const PROBE_RETRY_MS = 60_000;
const EXIT_GRACE_MS = 100;
const MAX_OUTPUT = 1_048_576;
const MAX_LINE = 16_384;
/** Stockfish needs no Home23 settings or credentials, so it inherits none of Core's. */
const ENGINE_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG'];

function engineEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(ENGINE_ENV_KEYS.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
}
function probeFailed(found: StockfishSetup, detail = `Stockfish at ${found.path} failed a startup check.`): StockfishSetup {
  return { state: 'probe_failed', path: found.path, source: found.source, detail,
    guidance: found.source === 'configured' ? CONFIGURED_GUIDANCE : REINSTALL_GUIDANCE };
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new StockfishError('invalid_input', 'Engine settings must be finite numbers');
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function play(chess: Chess, move: string): void {
  if (typeof move !== 'string' || !UCI_MOVE.test(move)) throw new Error('Expected a UCI move');
  chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
}

function position(input: StockfishAnalysisInput): Chess {
  try {
    if (!input || typeof input.fen !== 'string' || input.fen.length > 256 || /[\r\n]/.test(input.fen)) throw new Error('Invalid FEN');
    const chess = new Chess(input.fen);
    // chess.js validates FEN syntax/kings, but also reject a position where the
    // player who just moved has left their king attacked (including adjacent kings).
    const previousKing = chess.board().flat().find(piece => piece?.type === 'k' && piece.color !== chess.turn());
    if (!previousKing || chess.isAttacked(previousKing.square, chess.turn())) throw new Error('Illegal king position');
    if (input.moves !== undefined && (!Array.isArray(input.moves) || input.moves.length > 1000)) throw new Error('Too many moves');
    for (const move of input.moves ?? []) play(chess, move);
    return chess;
  } catch { throw new StockfishError('invalid_input', 'A legal FEN and up to 1000 legal UCI moves are required'); }
}

type Search = { chess: Chess; fen: string; skill: number; moveTime: number; multiPV: number; positionCommand: string };
function prepare(input: StockfishAnalysisInput): Search {
  const chess = position(input);
  return { chess, fen: chess.fen(), skill: bounded(input.skillLevel, 20, 0, 20), moveTime: bounded(input.moveTimeMs, 500, 1, 1500),
    multiPV: bounded(input.multiPV, 1, 1, 3),
    positionCommand: `position fen ${new Chess(input.fen).fen()}${input.moves?.length ? ` moves ${input.moves.join(' ')}` : ''}` };
}

export class StockfishEngine {
  private readonly env: NodeJS.ProcessEnv;
  private readonly candidates: readonly string[];
  private readonly fs: NonNullable<StockfishDiscovery['fs']>;
  private readonly start: typeof spawn;
  /** The last probe of each location, for the exact file it checked. */
  private readonly probes = new Map<string, { identity: string; ok: boolean; at: number; detail?: string }>();
  private readonly probing = new Map<string, Promise<void>>();

  constructor(discovery: StockfishDiscovery = {}) {
    this.env = discovery.env ?? process.env;
    this.candidates = discovery.candidates ?? STOCKFISH_HOMEBREW_PATHS;
    this.fs = discovery.fs ?? { lstat: path => lstatSync(path), stat: path => statSync(path), access: (path, mode) => accessSync(path, mode) };
    this.start = discovery.spawn ?? spawn;
  }

  /** Cheap lookup only; this never launches the engine. A recent failed probe of the same file counts as unavailable. */
  available(): boolean { return this.status().state === 'found'; }

  /** The setup as the file system and the last probe show it, without launching a process. */
  status(): StockfishSetup {
    const located = this.locate();
    if (located.setup.state !== 'found') return located.setup;
    const probe = this.probes.get(located.setup.path!);
    if (probe && probe.identity === located.identity && !probe.ok && Date.now() - probe.at < PROBE_RETRY_MS) return probeFailed(located.setup, probe.detail);
    return located.setup;
  }

  /** status(), after a short UCI search has checked a newly found executable. A replaced or
   * changed file is checked again, and a failed one after PROBE_RETRY_MS. Never throws. */
  async setup(): Promise<StockfishSetup> {
    const located = this.locate();
    const path = located.setup.path, identity = located.identity;
    if (located.setup.state === 'found' && path && identity) {
      const known = this.probes.get(path);
      if (known?.identity !== identity || (!known.ok && Date.now() - known.at >= PROBE_RETRY_MS)) {
        const key = `${path}\0${identity}`;
        let pending = this.probing.get(key);
        if (!pending) {
          pending = this.probe(path, identity).finally(() => this.probing.delete(key));
          this.probing.set(key, pending);
        }
        await pending;
      }
    }
    return this.status();
  }

  async analyze(input: StockfishAnalysisInput, signal?: AbortSignal): Promise<StockfishAnalysis> {
    const search = prepare(input);
    if (signal?.aborted) throw new StockfishError('engine_cancelled', 'Engine analysis cancelled');
    if (busy) throw new StockfishError('engine_busy', 'The chess engine is busy');
    const { state, path } = this.locate().setup;
    if (state !== 'found' || !path) throw new StockfishError('engine_unavailable', 'Stockfish is not installed or executable');
    return this.session(path, search, DEADLINE_MS, signal);
  }

  /** A configured path is authoritative; otherwise the first usable Homebrew location. */
  private locate(): Located {
    const configured = this.env.HOME23_STOCKFISH_PATH;
    if (configured !== undefined && configured.trim()) return this.inspect(resolve(configured), 'configured');
    let unusable: Located | undefined;
    for (const candidate of this.candidates) {
      const located = this.inspect(candidate, 'homebrew');
      if (located.setup.state === 'found') return located;
      if (located.setup.state === 'not_executable' && !unusable) unusable = located;
    }
    return unusable ?? { setup: STOCKFISH_NOT_INSTALLED };
  }

  /** Found only as a regular executable file, links followed. Its identity changes when the file is replaced or altered. */
  private inspect(path: string, source: 'configured' | 'homebrew'): Located {
    try { this.fs.lstat(path); }
    catch {
      return { setup: { state: 'not_installed', path, source, detail: `There is no Stockfish at ${path}.`,
        guidance: source === 'configured' ? CONFIGURED_GUIDANCE : STOCKFISH_INSTALL_GUIDANCE } };
    }
    try {
      const file = this.fs.stat(path);
      if (file.isFile()) {
        this.fs.access(path, constants.X_OK);
        return { setup: { state: 'found', path, source }, identity: [file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs].join(':') };
      }
    } catch { /* A broken link, or a file that cannot be read or executed. */ }
    return { setup: { state: 'not_executable', path, source, detail: `${path} is not an executable file.`,
      guidance: source === 'configured' ? CONFIGURED_GUIDANCE : REINSTALL_GUIDANCE } };
  }

  /** One short search, never during a chess turn: an engine run already holding the slot defers it. */
  private async probe(path: string, identity: string): Promise<void> {
    if (busy) return;
    try {
      await this.session(path, prepare({ fen: DEFAULT_POSITION, moveTimeMs: 10 }), PROBE_DEADLINE_MS);
      this.probes.set(path, { identity, ok: true, at: Date.now() });
    } catch (error) {
      const reason = error instanceof StockfishError ? error.message : 'the check could not run';
      this.probes.set(path, { identity, ok: false, at: Date.now(), detail: `Stockfish at ${path} failed a startup check: ${reason}.` });
    }
  }

  private session(path: string, search: Search, deadlineMs: number, signal?: AbortSignal): Promise<StockfishAnalysis> {
    const { chess, fen, skill, moveTime, multiPV, positionCommand } = search;
    busy = true;

    return new Promise<StockfishAnalysis>((resolveResult, reject) => {
      let child: ReturnType<typeof spawn>;
      try { child = this.start(path, [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: engineEnvironment(this.env) }); }
      catch { busy = false; reject(new StockfishError('engine_unavailable', 'Stockfish could not start')); return; }
      let phase: 'uci' | 'ready' | 'search' = 'uci';
      let buffer = '';
      let outputBytes = 0;
      let ended = false;
      let result: StockfishAnalysis | undefined;
      let failure: StockfishError | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const lines = new Map<number, StockfishAnalysis['lines'][number]>();
      const write = (command: string) => {
        if (child.stdin?.writable && !child.stdin.destroyed) child.stdin.write(`${command}\n`);
      };
      const finish = (error?: StockfishError, value?: StockfishAnalysis) => {
        if (ended) return;
        ended = true;
        failure = error;
        result = value;
        clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
        write(error ? 'stop' : 'quit');
        // Hold the global slot until close, even if a child ignores stop/quit.
        killTimer = setTimeout(() => child.kill('SIGKILL'), EXIT_GRACE_MS);
      };
      const abort = () => finish(new StockfishError('engine_cancelled', 'Engine analysis cancelled'));
      const deadline = setTimeout(() => {
        finish(new StockfishError('engine_timeout', 'Stockfish exceeded its hard deadline'));
        child.kill('SIGKILL');
      }, deadlineMs);

      const parse = (line: string) => {
        if (ended) return;
        const tokens = line.trim().split(/\s+/);
        if (phase === 'uci' && line.trim() === 'uciok') {
          phase = 'ready';
          write('setoption name Threads value 1');
          write('setoption name Hash value 32');
          write(`setoption name Skill Level value ${skill}`);
          write(`setoption name MultiPV value ${multiPV}`);
          write('ucinewgame');
          write('isready');
        } else if (phase === 'ready' && line.trim() === 'readyok') {
          phase = 'search';
          // Retain supplied history for repetition while returning the resulting FEN.
          write(positionCommand);
          write(`go movetime ${moveTime}`);
        } else if (phase === 'search' && tokens[0] === 'info' && tokens[1] !== 'string') {
          const integer = (name: string): number | undefined => {
            const index = tokens.indexOf(name);
            const raw = index < 0 ? undefined : tokens[index + 1];
            return raw && /^-?\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : undefined;
          };
          const depth = integer('depth');
          const rank = integer('multipv') ?? 1;
          const scoreIndex = tokens.indexOf('score');
          const kind = tokens[scoreIndex + 1];
          const score = scoreIndex >= 0 && (kind === 'cp' || kind === 'mate') ? integer(kind) : undefined;
          const pvIndex = tokens.indexOf('pv');
          if (depth === undefined || depth < 0 || depth > 256 || rank < 1 || rank > multiPV || score === undefined || pvIndex < 0) return;
          if (tokens.includes('lowerbound') || tokens.includes('upperbound')) return;
          const moves = tokens.slice(pvIndex + 1);
          if (!moves.length || moves.length > 256 || !moves.every(move => UCI_MOVE.test(move))) return;
          if ((lines.get(rank)?.depth ?? -1) > depth) return;
          lines.set(rank, { depth, moves, ...(kind === 'cp' ? { scoreCp: score } : { mate: score }) });
        } else if (phase === 'search' && tokens[0] === 'bestmove') {
          try {
            const bestMove = tokens[1] === '(none)' || tokens[1] === '0000' ? null : tokens[1];
            if (bestMove === undefined) throw new Error('Missing bestmove');
            if (bestMove === null) {
              if (chess.moves().length) throw new Error('Unexpected null move');
            } else { play(new Chess(fen), bestMove); }
            const ordered = [...lines.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
            for (const line of ordered) {
              const replay = new Chess(fen);
              for (const move of line.moves) play(replay, move);
            }
            finish(undefined, { fen, bestMove, lines: ordered });
          } catch { finish(new StockfishError('engine_protocol', 'Stockfish returned an invalid move or variation')); }
        }
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (ended) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_OUTPUT) { finish(new StockfishError('engine_protocol', 'Stockfish output limit exceeded')); return; }
        buffer += chunk;
        let newline: number;
        while (!ended && (newline = buffer.indexOf('\n')) >= 0) {
          if (newline > MAX_LINE) { finish(new StockfishError('engine_protocol', 'Stockfish line limit exceeded')); return; }
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          parse(line);
        }
        if (!ended && buffer.length > MAX_LINE) finish(new StockfishError('engine_protocol', 'Stockfish line limit exceeded'));
      });
      child.stdout?.on('end', () => { if (buffer && !ended) parse(buffer); });
      child.stderr?.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT) finish(new StockfishError('engine_protocol', 'Stockfish output limit exceeded'));
      });
      child.stdin?.on('error', () => finish(new StockfishError('engine_protocol', 'Stockfish input pipe failed')));
      child.on('error', () => finish(new StockfishError('engine_unavailable', 'Stockfish could not start')));
      child.on('close', () => {
        clearTimeout(deadline);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        busy = false;
        if (failure) reject(failure);
        else if (result) resolveResult(result);
        else reject(new StockfishError('engine_protocol', 'Stockfish exited before returning a best move'));
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else write('uci');
    });
  }
}
