import type { SqliteEventRepository } from "./repository.js";
import type { EventCursorReset, EventEnvelope, SseSink } from "./types.js";
import { validateEventEnvelope } from "./validation.js";

export const EVENT_HEARTBEAT_MS = 15_000;

export function encodeSseEvent(event: EventEnvelope): string {
  const envelope = validateEventEnvelope(event);
  return `id: ${envelope.sequence}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

export interface ResumableSsePumpOptions {
  repository: SqliteEventRepository;
  sink: SseSink;
  now?: () => number;
  batchSize?: number;
  requestId: string;
}

export type SseReplayResult =
  | { kind: "ready"; throughSequence: number; eventsWritten: number }
  | ({ kind: "reset" } & EventCursorReset);

export class ResumableSsePump {
  private readonly repository: SqliteEventRepository;
  private readonly sink: SseSink;
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly requestId: string;
  private lastWriteAt: number;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: ResumableSsePumpOptions) {
    this.repository = options.repository;
    this.sink = options.sink;
    this.now = options.now ?? Date.now;
    this.batchSize = options.batchSize ?? 100;
    this.requestId = options.requestId;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 1_000) {
      throw new TypeError("SSE batch size must be an integer from 1 through 1000");
    }
    this.lastWriteAt = this.now();
  }

  async replay(afterSequence: number): Promise<SseReplayResult> {
    let cursor = afterSequence;
    let eventsWritten = 0;
    for (;;) {
      const batch = this.repository.resumeAfter(
        cursor,
        this.batchSize,
        this.requestId,
      );
      if (batch.kind === "reset") return batch;
      for (const event of batch.events) {
        await this.write(encodeSseEvent(event));
        cursor = event.sequence;
        eventsWritten += 1;
      }
      if (!batch.hasMore) {
        return Object.freeze({
          kind: "ready" as const,
          throughSequence: cursor,
          eventsWritten,
        });
      }
    }
  }

  async heartbeatIfDue(): Promise<boolean> {
    return this.enqueueWrite(async () => {
      if (this.now() - this.lastWriteAt < EVENT_HEARTBEAT_MS) return false;
      await this.writeNow(": heartbeat\n\n");
      return true;
    });
  }

  private async write(chunk: string): Promise<void> {
    await this.enqueueWrite(() => this.writeNow(chunk));
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation);
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async writeNow(chunk: string): Promise<void> {
    const writable = this.sink.write(chunk);
    this.lastWriteAt = this.now();
    if (!writable) await this.sink.waitForDrain();
  }
}
