import type { AsyncWorkRecord } from './types.js';

type Subscriber = (record: AsyncWorkRecord, reason: string) => void;

/**
 * Per-origin pub/sub for durable async work. Stream subscribers get live
 * create/progress/terminal events without polling.
 */
export class WorkBus {
  private channels = new Map<string, Set<Subscriber>>();

  subscribe(originChatId: string, cb: Subscriber): () => void {
    const key = originChatId || '*';
    let set = this.channels.get(key);
    if (!set) {
      set = new Set();
      this.channels.set(key, set);
    }
    set.add(cb);
    return () => {
      const s = this.channels.get(key);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.channels.delete(key);
    };
  }

  emit(record: AsyncWorkRecord, reason: string): void {
    const targets = [
      this.channels.get(record.originChatId),
      this.channels.get('*'),
    ];
    for (const set of targets) {
      if (!set) continue;
      for (const cb of set) {
        try { cb(record, reason); } catch { /* swallow subscriber errors */ }
      }
    }
  }
}

export const workBus = new WorkBus();
