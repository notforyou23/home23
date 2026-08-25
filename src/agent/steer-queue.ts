/**
 * In-memory operator-steer queue. Notes wait until the next AgentLoop
 * tool-round (before the next model call). Dies on harness restart.
 */
export const STEER_QUEUE_CAP = 8;
export const STEER_PREFIX = '[Operator steer]';

export type SteerEnqueueResult =
  | { ok: true }
  | { ok: false; error: 'empty' | 'overflow' };

export class SteerQueue {
  private readonly notes = new Map<string, string[]>();

  enqueue(chatId: string, text: string): SteerEnqueueResult {
    const trimmed = String(text || '').trim();
    if (!trimmed) return { ok: false, error: 'empty' };
    const current = this.notes.get(chatId) ?? [];
    if (current.length >= STEER_QUEUE_CAP) return { ok: false, error: 'overflow' };
    current.push(trimmed);
    this.notes.set(chatId, current);
    return { ok: true };
  }

  drain(chatId: string): string[] {
    const current = this.notes.get(chatId) ?? [];
    this.notes.delete(chatId);
    return current;
  }

  pendingCount(chatId: string): number {
    return this.notes.get(chatId)?.length ?? 0;
  }
}

export const steerQueue = new SteerQueue();

export function formatSteerNotes(notes: string[]): string {
  return notes.map((note) => `${STEER_PREFIX} ${note}`).join('\n\n');
}

export function takeOperatorSteer(chatId: string, queue: SteerQueue = steerQueue): string | null {
  const notes = queue.drain(chatId);
  if (notes.length === 0) return null;
  return formatSteerNotes(notes);
}
