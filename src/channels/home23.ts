import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { generateCoordinationId } from '../coordination/ids/index.js';
import type { ChannelAdapter, OutgoingResponse } from './router.js';

export interface Home23Notification { messageId: string; text: string }
interface SavedDelivery { version: 1; text: string; messages: Home23Notification[]; delivered: number; createdAt: string }

/** Resident-owned outbox. Only Core commits canonical conversation messages. */
export class Home23Adapter implements ChannelAdapter {
  readonly name = 'home23';
  private timer?: ReturnType<typeof setInterval>;
  private pending = new Map<string, Promise<boolean>>();
  constructor(private root: string, private deliver: (input: Home23Notification) => Promise<void>) {
    mkdirSync(root, { recursive: true });
  }
  async start() {
    this.timer = setInterval(() => { void this.flush(); }, 15_000);
    this.timer.unref();
    void this.flush();
  }
  async stop() { if (this.timer) clearInterval(this.timer); await Promise.allSettled(this.pending.values()); }
  private save(file: string, entry: SavedDelivery) {
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 });
    const fd = openSync(temp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
    const dir = openSync(this.root, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  private attempt(file: string): Promise<boolean> {
    const prior = this.pending.get(file); if (prior) return prior;
    const operation = (async () => {
      const entry: SavedDelivery = JSON.parse(readFileSync(file, 'utf8'));
      while (entry.delivered < entry.messages.length) {
        await this.deliver(entry.messages[entry.delivered]!);
        entry.delivered++;
        this.save(file, entry);
      }
      return true;
    })().catch(() => false).finally(() => this.pending.delete(file));
    this.pending.set(file, operation); return operation;
  }
  async flush() {
    for (const name of readdirSync(this.root).filter(name => name.endsWith('.json'))) {
      const file = join(this.root, name);
      try {
        const entry: SavedDelivery = JSON.parse(readFileSync(file, 'utf8'));
        if (entry.delivered < entry.messages.length) await this.attempt(file);
      } catch (error) { console.warn('[home23-delivery] Cannot read saved delivery:', name, String(error)); }
    }
  }
  async send(response: OutgoingResponse): Promise<{ status: 'delivered' | 'queued' }> {
    if (!['owner', 'scheduler', ''].includes(response.chatId)) throw new Error('Home23 notifications target the resident owner conversation');
    if (!response.text.trim() || response.text.includes('\0')) throw new Error('Invalid Home23 notification text');
    const key = createHash('sha256').update(response.deliveryId ?? randomUUID()).digest('hex');
    const file = join(this.root, `${key}.json`);
    let entry: SavedDelivery | undefined;
    try { entry = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (entry && entry.text !== response.text) throw new Error('Home23 delivery identity changed');
    if (!entry) {
      const chunks: string[] = []; let chunk = ''; let bytes = 0;
      for (const point of response.text) {
        const size = Buffer.byteLength(point);
        if (bytes + size > 48_000) { chunks.push(chunk); chunk = ''; bytes = 0; }
        chunk += point; bytes += size;
      }
      if (chunk) chunks.push(chunk);
      entry = { version: 1, text: response.text, messages: chunks.map(text => ({ messageId: generateCoordinationId('message'), text })), delivered: 0, createdAt: new Date().toISOString() };
      this.save(file, entry);
    }
    return { status: await this.attempt(file) ? 'delivered' : 'queued' };
  }
}
