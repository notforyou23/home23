import { Chess } from 'chess.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface Binding { windowMarker: string; documentPath: string; documentMarker: string; moves: string[]; ownerColor: 'w'; channelId: string }
export interface Sample { pid: number; windowMarker: string; placement: string; documentMarker: string; moves: string[]; fen: string }
export function replay(moves: string[]) {
  const chess = new Chess();
  for (const move of moves) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) throw new Error('Invalid coordinate move');
    chess.move({ from: move.slice(0, 2), to: move.slice(2, 4), ...(move[4] ? { promotion: move[4] } : {}) });
  }
  return chess;
}
export function placement(names: string[]): string {
  if (names.length !== 64) throw new Error('AX board must contain exactly 64 squares');
  const board = new Map<string, string>();
  const pieces: Record<string, string> = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };
  for (const name of names) {
    const match = /^(?:(white|black) (pawn|knight|bishop|rook|queen|king), )?([a-h][1-8])$/.exec(name);
    if (!match || board.has(match[3]!)) throw new Error('Unknown or duplicate AX square');
    const piece = match[2] ? pieces[match[2]]! : '';
    board.set(match[3]!, match[1] === 'white' ? piece.toUpperCase() : piece);
  }
  return Array.from({ length: 8 }, (_, i) => {
    let rank = '', empty = 0;
    for (const file of 'abcdefgh') {
      const piece = board.get(`${file}${8 - i}`)!;
      if (!piece) empty++; else { if (empty) rank += empty; empty = 0; rank += piece; }
    }
    return rank + (empty || '');
  }).join('/');
}
export function uniqueTransition(fen: string, next: string) {
  const matches = new Chess(fen).moves({ verbose: true }).filter(move => move.after.split(' ')[0] === next);
  if (matches.length !== 1) throw new Error(`Expected one legal transition; found ${matches.length}`);
  return matches[0]!;
}
// Fixed JXA program; arguments are data. No activation, screenshots, clicks, or front-window access.
export const AX_SCRIPT = `function run(args) {
  const se = Application('System Events');
  const ps = se.applicationProcesses.whose({bundleIdentifier:'com.apple.Chess'})();
  if (ps.length !== 1) throw Error('Chess process unavailable or ambiguous');
  const p = ps[0];
  const wins = p.windows().filter(w => w.name().replace(/\\s+\\([^)]*\\)$/, '') === args[0]);
  if (wins.length !== 1) throw Error('Bound Chess window unavailable or ambiguous');
  return JSON.stringify({pid:p.unixId(),windowMarker:args[0],names:wins[0].groups[0].buttons.name()});
}`;
export async function readBoard(binding: Pick<Binding, 'windowMarker' | 'documentPath'>): Promise<Sample> {
  if (process.platform !== 'darwin') throw new Error('Native Chess watcher requires macOS');
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', AX_SCRIPT, binding.windowMarker], { timeout: 4000, maxBuffer: 32768 });
  const ax = JSON.parse(stdout);
  const { stdout: document } = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', binding.documentPath], { timeout: 2000, maxBuffer: 262144 });
  const doc = JSON.parse(document);
  if (doc.Variant !== 'normal' || doc.Result !== '*' || typeof doc.Moves !== 'string' || typeof doc.Position !== 'string' || !doc.StartDate || !doc.StartTime || !doc.White) throw new Error('Unsupported or finished Chess document');
  const moves = doc.Moves.trim() ? doc.Moves.trim().split(/\s+/) : [];
  const chess = replay(moves);
  // chess.js normalizes unusable en-passant fields; compare normalized FENs.
  if (chess.fen() !== new Chess(doc.Position).fen()) throw new Error('Document move history and FEN disagree');
  return { pid: ax.pid, windowMarker: ax.windowMarker, placement: placement(ax.names), documentMarker: hash([doc.StartDate, doc.StartTime, doc.White, doc.Variant]), moves, fen: chess.fen() };
}
