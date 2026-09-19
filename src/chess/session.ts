import { randomUUID } from 'node:crypto';
import { type Binding, type Sample, hash, replay, uniqueTransition } from './board.js';
import type { ScheduledChannelTurn } from '../coordination/app/scheduled-turns.js';
export interface Session {
  version: 1; id: string; binding: Binding; pid: number; mode: 'running' | 'paused' | 'stopped';
  reason?: string; fen: string; moves: string[]; positionHash: string;
  observationError?: string; initialBotTurnPending?: boolean; pending?: ScheduledChannelTurn; receipts: { runId: string; workIds: string[] }[];
}
export function validateBinding(binding: Binding) {
  if (!['w', 'b'].includes(binding.ownerColor) || typeof binding.botId !== 'string' || !binding.botId.trim() || !/^chn_[a-f0-9-]{36}$/.test(binding.channelId) || !binding.windowMarker || !binding.documentPath.startsWith('/') || !binding.documentMarker) throw new Error('Invalid session binding');
}
export function bootstrap(binding: Binding, sample: Sample): Session {
  validateBinding(binding);
  if (sample.windowMarker !== binding.windowMarker || sample.documentMarker !== binding.documentMarker || hash(sample.moves) !== hash(binding.moves) || replay(binding.moves).fen() !== sample.fen || sample.placement !== sample.fen.split(' ')[0]) throw new Error('Live board does not match exact initial game binding');
  if (replay(binding.moves).isGameOver()) throw new Error('Game is over');
  return { version: 1, id: randomUUID(), binding, pid: sample.pid, mode: 'running', fen: sample.fen, moves: [...sample.moves], positionHash: hash(sample.placement), initialBotTurnPending: binding.initialBotTurn === true && replay(binding.moves).turn() !== binding.ownerColor, receipts: [] };
}
export class ChessSession {
  private stable = ''; private samples = 0;
  constructor(public state: Session, private save: (state: Session) => Promise<void>, private wake: (input: ScheduledChannelTurn) => Promise<{ state: string; workIds?: string[]; error?: string }>, private report: (reason: string) => void) {}
  async pause(reason: string) {
    if (this.state.mode !== 'running') return;
    this.state.mode = 'paused'; this.state.reason = reason; this.stable = ''; this.samples = 0;
    await this.save(this.state); this.report(reason);
  }
  async observationFailed(reason: string) {
    this.stable = ''; this.samples = 0;
    if (this.state.observationError !== reason) { this.state.observationError = reason; await this.save(this.state); }
  }
  async resume() {
    if (this.state.mode !== 'paused') throw new Error('Only a paused session can resume');
    this.state.mode = 'running'; delete this.state.reason; this.stable = ''; this.samples = 0; await this.save(this.state);
  }
  async stop() { this.state.mode = 'stopped'; await this.save(this.state); }
  async observe(sample: Sample) {
    if (this.state.mode !== 'running') return;
    try {
      const s = this.state;
      if (sample.pid !== s.pid || sample.windowMarker !== s.binding.windowMarker || sample.documentMarker !== s.binding.documentMarker) throw new Error('Bound process/window/document changed');
      const key = hash(sample);
      this.samples = key === this.stable ? this.samples + 1 : 1; this.stable = key;
      if (this.samples < 2) return;
      if (s.observationError) { delete s.observationError; await this.save(s); }
      if (sample.placement === s.fen.split(' ')[0]) {
        if (hash(sample.moves) !== hash(s.moves) || sample.fen !== s.fen) throw new Error('History changed without a matching board transition');
        if (s.initialBotTurnPending && !s.pending) { s.pending = this.turnRequest('Explicitly configured initial bot turn'); delete s.initialBotTurnPending; await this.save(s); }
        if (s.pending) await this.deliver();
        return;
      }
      const move = uniqueTransition(s.fen, sample.placement);
      if (sample.fen !== move.after || hash(sample.moves) !== hash([...s.moves, move.lan])) throw new Error('AX transition and exact document history disagree');
      // Do not admit another owner move before the previous canonical Work finishes.
      if (s.pending) { await this.deliver(); if (s.pending || s.mode !== 'running') return; }
      delete s.initialBotTurnPending;
      s.fen = move.after; s.moves.push(move.lan); s.positionHash = hash(sample.placement);
      if (replay(s.moves).isGameOver()) { await this.pause('Game over'); return; }
      if (move.color === s.binding.ownerColor) {
        s.pending = this.turnRequest(`Owner ${s.binding.ownerColor === 'w' ? 'White' : 'Black'} played ${move.san} (${move.lan})`);
      }
      await this.save(s); // Durable position and outbox before any network activity.
      if (s.pending) await this.deliver();
    } catch (error) { await this.pause(error instanceof Error ? error.message : String(error)); }
  }
  private turnRequest(trigger: string): ScheduledChannelTurn {
    const s = this.state, color = s.binding.ownerColor === 'w' ? 'Black' : 'White';
    return { runId: `sched-run-${randomUUID()}`, jobId: `chess-session:${s.id}`, channelId: s.binding.channelId, targetBotId: s.binding.botId,
      prompt: `Native Chess session ${s.id}: ${trigger}. Target bot ${s.binding.botName ?? s.binding.botId} plays ${color}. Bound window: ${s.binding.windowMarker}; document: ${s.binding.documentPath}; document marker: ${s.binding.documentMarker}; Chess PID: ${s.pid}. Expected FEN: ${s.fen}. Move history: ${s.moves.join(' ')}. Read the bound live AX board before acting. Respond with exactly one legal ${color} move only if this exact position is still current; verify the result. If changed or ambiguous, pause rather than guess. This event is already deduplicated; do not respond to it twice. Keep banter in this channel.` };
  }
  private async deliver() {
    const input = this.state.pending!;
    try {
      const result = await this.wake(input);
      if (result.state === 'succeeded' && result.workIds?.length) {
        this.state.receipts.push({ runId: input.runId, workIds: result.workIds }); delete this.state.pending; await this.save(this.state);
      } else if (result.state !== 'running') await this.pause(result.error ?? 'Canonical Chess Work did not succeed');
    } catch { await this.pause('Wake acknowledgement uncertain; resume replays the same durable run ID'); }
  }
}
