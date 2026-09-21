import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { Chess } from 'chess.js';

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

// Shared across instances: Core never accumulates an unbounded subprocess queue.
let busy = false;
const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const DEADLINE_MS = 10_000;
const EXIT_GRACE_MS = 100;
const MAX_OUTPUT = 1_048_576;
const MAX_LINE = 16_384;

function executable(): string | undefined {
  const override = process.env.HOME23_STOCKFISH_PATH;
  const candidates = override !== undefined
    ? (override.trim() ? [resolve(override)] : [])
    : (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)
      .map(directory => join(directory, process.platform === 'win32' ? 'stockfish.exe' : 'stockfish'));
  return candidates.find(candidate => {
    try { accessSync(candidate, constants.X_OK); return statSync(candidate).isFile(); }
    catch { return false; }
  });
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

export class StockfishEngine {
  /** Cheap executable lookup only; this does not launch or probe the engine. */
  available(): boolean { return executable() !== undefined; }

  async analyze(input: StockfishAnalysisInput, signal?: AbortSignal): Promise<StockfishAnalysis> {
    const chess = position(input);
    const fen = chess.fen();
    const skill = bounded(input.skillLevel, 20, 0, 20);
    const moveTime = bounded(input.moveTimeMs, 500, 1, 1500);
    const multiPV = bounded(input.multiPV, 1, 1, 3);
    const positionCommand = `position fen ${new Chess(input.fen).fen()}${input.moves?.length ? ` moves ${input.moves.join(' ')}` : ''}`;
    if (signal?.aborted) throw new StockfishError('engine_cancelled', 'Engine analysis cancelled');
    if (busy) throw new StockfishError('engine_busy', 'The chess engine is busy');
    const path = executable();
    if (!path) throw new StockfishError('engine_unavailable', 'Stockfish is not installed or executable');
    busy = true;

    return new Promise<StockfishAnalysis>((resolveResult, reject) => {
      let child: ReturnType<typeof spawn>;
      try { child = spawn(path, [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
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
      }, DEADLINE_MS);

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
