/** Bounded observation-only shell capture; neither readers nor disk pressure stop execution. */
import { isUtf8 } from 'node:buffer';
import { mkdir, open, readdir, stat, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

export interface ExecutionOutputRecord {
  type: 'event'; turn_id: string; seq: number; ts: string;
  kind: 'capture_start' | 'tool_output' | 'capture_gap' | 'capture_end';
  data: Record<string, unknown>;
}
export interface ExecutionOutputCapture {
  status(): 'pending' | 'open' | 'closed' | 'unavailable';
  toolStart(toolCallId: string): void;
  write(toolCallId: string, channel: 'stdout' | 'stderr', bytes: Buffer): void;
  toolEnd(toolCallId: string): void;
  close(): Promise<void>;
}
export interface ExecutionOutputOptions {
  instanceDir: string;
  turnId: string;
  maxPendingBytes?: number;
  maxTurnBytes?: number;
  maxStorageBytes?: number;
  retentionMs?: number;
  flushMs?: number;
  onUnavailable?: (reason: string) => void;
}
const MiB = 1024 * 1024;
const active = new Map<string, number>();
const admissionLocks = new Map<string, Promise<void>>();
const TURN_ID = /^t_[A-Za-z0-9_-]+$/;

/** Cleanup touches only closed Console sidecars; live and incomplete captures are protected. */
async function admit(dir: string, path: string, maxTurnBytes: number, maxStorageBytes: number, retentionMs: number): Promise<boolean> {
  const predecessor = admissionLocks.get(dir) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const current = predecessor.then(() => gate);
  admissionLocks.set(dir, current);
  await predecessor;
  try {
    if (active.has(path)) return false;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let used = 0;
    const removable: Array<{ path: string; bytes: number; modified: number }> = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^t_[A-Za-z0-9_-]+\.jsonl$/.test(entry.name)) continue;
      const file = join(dir, entry.name);
      const info = await stat(file);
      if (active.has(file)) { used += active.get(file)!; continue; }
      used += info.size;
      const handle = await open(file, 'r');
      let closed = false;
      try {
        const buffer = Buffer.alloc(Math.min(info.size, 4096));
        await handle.read(buffer, 0, buffer.length, Math.max(0, info.size - buffer.length));
        const last = buffer.toString('utf8').trimEnd().split('\n').at(-1);
        if (last) { try { closed = JSON.parse(last).kind === 'capture_end'; } catch { /* incomplete */ } }
      } finally { await handle.close(); }
      if (closed) removable.push({ path: file, bytes: info.size, modified: info.mtimeMs });
    }
    removable.sort((a, b) => a.modified - b.modified);
    for (const file of removable) {
      if (Date.now() - file.modified <= retentionMs && used + maxTurnBytes <= maxStorageBytes) continue;
      await unlink(file.path);
      used -= file.bytes;
    }
    // Reserve each active capture's maximum, including ones admitted before their file opens.
    for (const [file, reserved] of active) {
      if (file.startsWith(`${dir}/`)) {
        try { await stat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') used += reserved; else throw error; }
      }
    }
    if (used + maxTurnBytes > maxStorageBytes) return false;
    active.set(path, maxTurnBytes);
    return true;
  } finally {
    release();
    if (admissionLocks.get(dir) === current) admissionLocks.delete(dir);
  }
}

export function createExecutionOutputCapture(options: ExecutionOutputOptions): ExecutionOutputCapture {
  if (!TURN_ID.test(options.turnId)) throw new TypeError('invalid execution-output turn ID');
  const dir = join(options.instanceDir, 'execution-output');
  const path = join(dir, `${options.turnId}.jsonl`);
  const maxPending = options.maxPendingBytes ?? MiB;
  const maxTurn = options.maxTurnBytes ?? 128 * MiB;
  const maxStorage = options.maxStorageBytes ?? 2 * 1024 * MiB;
  const queue: string[] = [];
  let pendingBytes = 0;
  let retainedBytes = 0;
  let droppedBytes = 0;
  let totalBytes = 0;
  let seq = 0;
  let handle: FileHandle | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pumping: Promise<void> | undefined;
  let closing = false;
  let failed = false;
  let limited = false;
  let lastGapBytes = 0;
  let closePromise: Promise<void> | undefined;
  let closed = false;
  let toolCloseTimedOut = false;
  const tools = new Set<string>();
  let allToolsClosed: (() => void) | undefined;
  const unavailable = (reason: string): void => { try { options.onUnavailable?.(reason); } catch { /* observer */ } };
  const line = (kind: ExecutionOutputRecord['kind'], data: Record<string, unknown>): string =>
    JSON.stringify({ type: 'event', turn_id: options.turnId, seq: ++seq, ts: new Date().toISOString(), kind, data }) + '\n';
  const enqueue = (record: string): void => { queue.push(record); pendingBytes += Buffer.byteLength(record); };
  const startRecord = line('capture_start', { maxRetainedBytes: maxTurn, stdout: true, stderr: true });
  const initialized = (async () => {
    try {
      const admitted = await admit(dir, path, maxTurn, maxStorage, options.retentionMs ?? 7 * 24 * 60 * 60 * 1000);
      if (!admitted) { failed = true; unavailable('capture_storage_capacity'); return; }
      handle = await open(path, 'wx', 0o600);
      await handle.writeFile(startRecord);
    } catch { failed = true; unavailable('capture_storage_unavailable'); active.delete(path); }
  })();
  const gap = (): void => {
    if (!droppedBytes || lastGapBytes > 0) return;
    enqueue(line('capture_gap', { reason: limited ? 'retention_limit' : 'pending_limit', droppedBytes: droppedBytes - lastGapBytes, totalDroppedBytes: droppedBytes }));
    lastGapBytes = droppedBytes;
  };
  async function pump(): Promise<void> {
    await initialized;
    if (failed || !handle) { queue.length = 0; pendingBytes = 0; return; }
    try {
      while (queue.length) {
        let batch = '';
        while (queue.length && Buffer.byteLength(batch) < 256 * 1024) {
          const record = queue.shift()!;
          pendingBytes -= Buffer.byteLength(record);
          batch += record;
        }
        await handle.writeFile(batch);
      }
    } catch {
      failed = true;
      queue.length = 0;
      pendingBytes = 0;
      unavailable('capture_write_failed');
      try { await handle.close(); } catch { /* disk failure */ }
      handle = undefined;
      active.delete(path);
    }
  }
  function startPump(): void {
    if (pumping) return;
    pumping = pump().finally(() => {
      pumping = undefined;
      if (queue.length && !failed) startPump();
    });
  }
  function schedule(): void {
    if (timer || closing) return;
    timer = setTimeout(() => { timer = undefined; gap(); startPump(); }, options.flushMs ?? 100);
    timer.unref?.();
  }
  return {
    status() { return failed ? 'unavailable' : closed ? 'closed' : handle ? 'open' : 'pending'; },
    toolStart(toolCallId) { if (!closing) tools.add(toolCallId); },
    write(toolCallId, channel, bytes) {
      if (closing || failed) return;
      totalBytes += bytes.length;
      for (let offset = 0; offset < bytes.length; offset += 16 * 1024) {
        const chunk = bytes.subarray(offset, Math.min(offset + 16 * 1024, bytes.length));
        if (limited || pendingBytes + chunk.length * 6 + 512 > maxPending) {
          droppedBytes += chunk.length;
          schedule();
          continue;
        }
        const utf8 = isUtf8(chunk);
        const record = line('tool_output', { toolCallId, channel, encoding: utf8 ? 'utf8' : 'base64',
          text: chunk.toString(utf8 ? 'utf8' : 'base64'), byteLength: chunk.length });
        const size = Buffer.byteLength(record);
        // Leave space for gap and closure receipts inside the reserved disk budget.
        if (retainedBytes + size > maxTurn - 4096) {
          limited = true;
          droppedBytes += chunk.length;
        } else { enqueue(record); retainedBytes += size; }
      }
      schedule();
    },
    toolEnd(toolCallId) { tools.delete(toolCallId); if (!tools.size) allToolsClosed?.(); gap(); startPump(); },
    close() {
      if (closePromise) return closePromise;
      if (timer) { clearTimeout(timer); timer = undefined; }
      closePromise = (async () => {
        await initialized;
        if (failed || !handle) return;
        if (tools.size) {
          await new Promise<void>(resolve => {
            const timeout = setTimeout(() => { toolCloseTimedOut = true; resolve(); }, 1_000);
            allToolsClosed = () => { clearTimeout(timeout); resolve(); };
          });
        }
        closing = true;
        if (timer) { clearTimeout(timer); timer = undefined; }
        gap();
        if (toolCloseTimedOut) enqueue(line('capture_gap', { reason: 'tool_close_timeout', droppedBytes: null }));
        enqueue(line('capture_end', { complete: droppedBytes === 0 && !toolCloseTimedOut, droppedBytes, totalBytes, retainedBytes }));
        startPump();
        while (pumping) await pumping;
        if (handle) { try { await handle.close(); } catch { unavailable('capture_close_failed'); } handle = undefined; }
        closed = !failed;
        active.delete(path);
      })();
      return closePromise;
    },
  };
}
