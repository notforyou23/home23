import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { open, readFile, readdir, rename } from 'node:fs/promises';
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
  private sends = new Map<string, { text: string; operation: Promise<{ status: 'delivered' | 'queued' }> }>();
  private flushPromise?: Promise<void>;
  constructor(private root: string, private deliver: (input: Home23Notification) => Promise<void>) {
    mkdirSync(root, { recursive: true });
  }
  async start() {
    this.timer = setInterval(() => { void this.flush(); }, 15_000);
    this.timer.unref();
    void this.flush();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([this.flushPromise, ...this.pending.values(), ...Array.from(this.sends.values(), value => value.operation)]);
  }
  private async save(file: string, entry: SavedDelivery): Promise<void> {
    const temp = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(entry));
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temp, file);
    const dir = await open(this.root, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
  private attempt(file: string): Promise<boolean> {
    const prior = this.pending.get(file); if (prior) return prior;
    const operation = (async () => {
      const entry: SavedDelivery = JSON.parse(await readFile(file, 'utf8'));
      while (entry.delivered < entry.messages.length) {
        await this.deliver(entry.messages[entry.delivered]!);
        entry.delivered++;
        await this.save(file, entry);
      }
      return true;
    })().catch(() => false).finally(() => this.pending.delete(file));
    this.pending.set(file, operation); return operation;
  }
  flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    const operation = (async () => {
      for (const name of (await readdir(this.root)).filter(name => name.endsWith('.json'))) {
        const file = join(this.root, name);
        try {
          const entry: SavedDelivery = JSON.parse(await readFile(file, 'utf8'));
          if (entry.delivered < entry.messages.length) await this.attempt(file);
        } catch (error) { console.warn('[home23-delivery] Cannot read saved delivery:', name, String(error)); }
      }
    })();
    this.flushPromise = operation.finally(() => { this.flushPromise = undefined; });
    return this.flushPromise;
  }
  async send(response: OutgoingResponse): Promise<{ status: 'delivered' | 'queued' }> {
    if (!['owner', 'scheduler', ''].includes(response.chatId)) throw new Error('Home23 notifications target the resident owner conversation');
    if (!response.text.trim() || response.text.includes('\0')) throw new Error('Invalid Home23 notification text');
    const key = createHash('sha256').update(response.deliveryId ?? randomUUID()).digest('hex');
    const file = join(this.root, `${key}.json`);
    const current = this.sends.get(file);
    if (current) {
      if (current.text !== response.text) return Promise.reject(new Error('Home23 delivery identity changed'));
      return current.operation;
    }
    const operation = this.sendUnlocked(file, response).finally(() => { this.sends.delete(file); });
    this.sends.set(file, { text: response.text, operation });
    return operation;
  }
  private async sendUnlocked(file: string, response: OutgoingResponse): Promise<{ status: 'delivered' | 'queued' }> {
    let entry: SavedDelivery | undefined;
    try { entry = JSON.parse(await readFile(file, 'utf8')); }
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
      await this.save(file, entry);
    }
    return { status: await this.attempt(file) ? 'delivered' : 'queued' };
  }
}
