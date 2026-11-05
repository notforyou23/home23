import type { TurnEnvelope, TurnEvent } from './turn-types.js';

type Subscriber = (record: TurnEvent | TurnEnvelope) => void;

/**
 * Per-turn pub/sub. Subscribers get live events as the agent emits them.
 * A closed turn flushes all subscribers and deletes the bus entry.
 */
export class TurnBus {
  private channels = new Map<string, Set<Subscriber>>();

  private key(chatId: string, turnId: string): string {
    return `${chatId}::${turnId}`;
  }

  subscribe(chatId: string, turnId: string, cb: Subscriber): () => void {
    const k = this.key(chatId, turnId);
    let set = this.channels.get(k);
    if (!set) {
      set = new Set();
      this.channels.set(k, set);
    }
    set.add(cb);
    return () => {
      const s = this.channels.get(k);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.channels.delete(k);
    };
  }

  emit(chatId: string, turnId: string, record: TurnEvent | TurnEnvelope): void {
    const k = this.key(chatId, turnId);
    const set = this.channels.get(k);
    if (!set) return;
    for (const cb of set) {
      try { cb(record); } catch { /* swallow subscriber errors */ }
    }
  }

  /** Fired after the final envelope is emitted. Drops all subscribers. */
  close(chatId: string, turnId: string): void {
    this.channels.delete(this.key(chatId, turnId));
  }

  hasSubscribers(chatId: string, turnId: string): boolean {
    const s = this.channels.get(this.key(chatId, turnId));
    return !!s && s.size > 0;
  }
}

/** Singleton — one bus per process. */
export const turnBus = new TurnBus();
