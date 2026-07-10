export class ManualClock {
  nowMs = 0;
  tasks = new Map<number, { at: number; fn: () => void }>();
  nextId = 1;
  now = (): number => this.nowMs;
  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.nowMs + ms, fn });
    return id;
  };
  clearTimeout = (id: number): void => { this.tasks.delete(id); };
  advance(ms: number): void {
    this.nowMs += ms;
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= this.nowMs)
        .sort((a, b) => a[1].at - b[1].at);
      if (!due.length) break;
      for (const [id, task] of due) {
        this.tasks.delete(id);
        task.fn();
      }
    }
  }
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
