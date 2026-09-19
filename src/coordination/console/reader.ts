import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { decodeConsoleCursor, encodeConsoleCursor, isByteOffset } from './cursor.js';
import { ConsoleReadError, type ConsoleFileStream, type ConsoleGap, type ConsoleRecord, type ResolvedConsoleSource } from './types.js';

const CHUNK = 256 * 1024;
const INLINE = 48 * 1024;
const PREFIX = 64 * 1024;

interface Position { i: string; g: string; p: number; s?: number; e?: number; skip?: boolean; partial?: boolean }
interface Cursor { v: 1; t: 'after' | 'before'; s: string; f: Position[]; resume?: Position[]; r?: number }
export interface ConsoleReadLimits { limit?: number; maxScanBytes?: number; maxResponseBytes?: number; maxInlineBytes?: number }
export interface ConsoleHistoryPage { records: ConsoleRecord[]; beforeCursor: string | null; resumeCursor: string; hasMore: boolean; gaps: ConsoleGap[] }
export interface ConsoleAfterPage { records: ConsoleRecord[]; cursor: string; gaps: ConsoleGap[]; drained: boolean }

function limits(options: ConsoleReadLimits) {
  return {
    limit: Math.max(1, Math.min(options.limit ?? 200, 200)),
    scan: Math.max(1, Math.min(options.maxScanBytes ?? 1024 * 1024, 1024 * 1024)),
    response: Math.max(1024, Math.min(options.maxResponseBytes ?? 1024 * 1024, 1024 * 1024)),
    inline: Math.max(512, Math.min(options.maxInlineBytes ?? INLINE, INLINE)),
  };
}

/** Open only an existing regular file within the configured root, without following a final symlink. */
export async function openConsoleFile(stream: ConsoleFileStream): Promise<FileHandle> {
  try {
    const [root, file] = await Promise.all([realpath(stream.allowedRoot), realpath(stream.path)]);
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new ConsoleReadError('source_path_invalid', 403);
    }
    const handle = await open(stream.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) { await handle.close(); throw new ConsoleReadError('source_path_invalid', 403); }
    return handle;
  } catch (error) {
    if (error instanceof ConsoleReadError) throw error;
    throw new ConsoleReadError('output_unavailable', 410);
  }
}

export async function consoleFileInfo(stream: ConsoleFileStream): Promise<{ generation: string; size: number; modifiedAt: string }> {
  const handle = await openConsoleFile(stream);
  try { return await info(handle); } finally { await handle.close(); }
}

async function info(handle: FileHandle) {
  const stat = await handle.stat();
  const generation = createHash('sha256').update(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`).digest('base64url').slice(0, 16);
  return { generation, size: stat.size, modifiedAt: stat.mtime.toISOString() };
}

function parseCursor(source: ResolvedConsoleSource, value: string | undefined, type: 'after' | 'before'): Cursor | undefined {
  if (!value) return undefined;
  const cursor = decodeConsoleCursor<Cursor>(value);
  if (!cursor || cursor.v !== 1 || cursor.t !== type || cursor.s !== source.source.id || !Array.isArray(cursor.f)
    || cursor.f.length > 4 || cursor.f.some(p => !p || typeof p.i !== 'string' || typeof p.g !== 'string'
      || !isByteOffset(p.p) || (p.s !== undefined && (!isByteOffset(p.s) || p.s > p.p))
      || (p.e !== undefined && (!isByteOffset(p.e) || p.e < p.p))
      || !['events', 'stderr', 'journal', 'execution-output'].includes(p.i)) || new Set(cursor.f.map(p => p.i)).size !== cursor.f.length
    || (cursor.r !== undefined && (!isByteOffset(cursor.r) || cursor.r > 4))) {
    throw new ConsoleReadError('invalid_cursor');
  }
  return cursor;
}

/** Extract only complete top-level primitive fields; a huge nested data value is never parsed/allocated. */
export function consoleRecordMetadata(prefix: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(prefix);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { /* Oversized record: envelope fields precede data in the durable writer. */ }
  const out: Record<string, unknown> = {};
  let remainder = prefix.trimStart();
  if (!remainder.startsWith('{')) return out;
  remainder = remainder.slice(1);
  const scalar = /^\s*("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*([,}])/;
  while (remainder.length) {
    const match = scalar.exec(remainder);
    if (!match) break;
    try { out[JSON.parse(match[1]!)] = JSON.parse(match[2]!); } catch { break; }
    remainder = remainder.slice(match[0].length);
    if (match[3] === '}') break;
  }
  return out;
}

async function bytes(handle: FileHandle, start: number, length: number): Promise<Buffer> {
  const result = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = await handle.read(result, offset, length - offset, start + offset);
    if (!read.bytesRead) throw new ConsoleReadError('source_changed', 410);
    offset += read.bytesRead;
  }
  return result;
}

function timestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    try { return new Date(value).toISOString(); } catch { return null; }
  }
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

async function record(source: ResolvedConsoleSource, stream: ConsoleFileStream, handle: FileHandle,
  generation: string, start: number, end: number, partial: boolean, inlineLimit: number): Promise<ConsoleRecord | null> {
  const length = end - start;
  if (length <= 0) return null;
  const prefix = await bytes(handle, start, Math.min(length, PREFIX));
  const meta = stream.format === 'text' ? {} : consoleRecordMetadata(prefix.toString('utf8'));
  if (stream.turnId && (meta.turn_id !== stream.turnId || !['turn', 'event'].includes(String(meta.type)))) return null;
  let raw: string | null = null;
  // For an oversized body we advertise an exact byte stream; its complete encoding has not been validated.
  let encoding: 'utf8' | 'binary' = length > PREFIX ? 'binary' : 'utf8';
  if (length <= PREFIX) {
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(prefix); } catch { encoding = 'binary'; }
  }
  const id = `cr_${encodeConsoleCursor([source.source.id, stream.id, generation, start, end, partial ? 1 : 0])}`;
  const result: ConsoleRecord = {
    id, sourceId: source.source.id, stream: stream.id, format: stream.format,
    kind: String(meta.kind ?? (meta.type === 'turn' ? 'turn' : meta.type ?? 'text')),
    occurredAt: timestamp(meta.ts ?? meta.timestamp_ms ?? meta.timestamp ?? meta.started_at),
    observedAt: new Date().toISOString(), raw, rawUrl: null, rawEncoding: encoding,
    byteLength: length, partial, sequence: typeof meta.seq === 'number' ? meta.seq : null,
    forwardedFromSourceId: meta.kind === 'subagent_progress' && meta.data && typeof meta.data === 'object'
      ? source.forwardedSources?.[String((meta.data as Record<string, unknown>).subagentId)] ?? null : null,
  };
  if (raw === null || Buffer.byteLength(JSON.stringify({ record: result })) > inlineLimit) {
    result.raw = null;
    result.rawUrl = `/api/v1/console/sources/${source.source.id}/records/${id}/raw`;
  }
  return result;
}

export async function readConsoleAfter(source: ResolvedConsoleSource, after?: string, options: ConsoleReadLimits = {}): Promise<ConsoleAfterPage> {
  const config = limits(options);
  const old = parseCursor(source, after, 'after');
  const positions: Position[] = [];
  const records: ConsoleRecord[] = [];
  const gaps: ConsoleGap[] = [];
  let scanned = 0, response = 0, drained = true;
  const rotation = source.streams.length ? (old?.r ?? 0) % source.streams.length : 0;
  const streams = [...source.streams.slice(rotation), ...source.streams.slice(0, rotation)];
  for (const prior of old?.f ?? []) if (!source.streams.some(s => s.id === prior.i)) gaps.push({ sourceId: source.source.id, stream: prior.i, reason: 'stream_unavailable' });
  for (const stream of streams) {
    let handle: FileHandle | undefined;
    const previous = old?.f.find(p => p.i === stream.id);
    try {
      handle = await openConsoleFile(stream);
      const snapshot = await info(handle);
      let state: Position = previous ? { ...previous } : { i: stream.id, g: snapshot.generation, p: 0, s: 0 };
      if (state.g !== snapshot.generation || state.p > snapshot.size) {
        gaps.push({ sourceId: source.source.id, stream: stream.id, reason: 'source_reset' });
        state = { i: stream.id, g: snapshot.generation, p: 0, s: 0 };
      }
      state.s ??= state.p;
      positions.push(state);
      while (state.p < snapshot.size && scanned < config.scan && records.length < config.limit && response < config.response) {
        const chunk = await bytes(handle, state.p, Math.min(CHUNK, snapshot.size - state.p, config.scan - scanned));
        const chunkStart = state.p;
        let consumed = 0;
        while (consumed < chunk.length) {
          const lf = chunk.indexOf(10, consumed);
          if (lf < 0) { state.p = chunkStart + chunk.length; scanned += chunk.length - consumed; break; }
          const end = chunkStart + lf;
          const item = await record(source, stream, handle, state.g, state.s, end, false, config.inline);
          if (item && records.length > 0 && response + Buffer.byteLength(JSON.stringify(item)) > config.response) break;
          scanned += lf + 1 - consumed;
          state.p = end + 1; state.s = state.p; consumed = lf + 1;
          if (item) { records.push(item); response += Buffer.byteLength(JSON.stringify(item)); }
          if (records.length >= config.limit || response >= config.response) break;
        }
        if (state.p < chunkStart + chunk.length) break;
      }
      if (state.p === snapshot.size && state.s < state.p && stream.writerClosed && records.length < config.limit && response < config.response) {
        const item = await record(source, stream, handle, state.g, state.s, state.p, true, config.inline);
        if (!item || records.length === 0 || response + Buffer.byteLength(JSON.stringify(item)) <= config.response) {
          if (item) { records.push(item); response += Buffer.byteLength(JSON.stringify(item)); }
          state.s = state.p;
        }
      }
      if (stream.captureIncomplete) gaps.push({ sourceId: source.source.id, stream: stream.id, reason: 'capture_incomplete' });
      if (stream.closureUnknown) gaps.push({ sourceId: source.source.id, stream: stream.id, reason: 'writer_closure_unknown' });
      if (state.p < snapshot.size || (!stream.captureIncomplete && !stream.closureUnknown && (state.s < state.p || !stream.writerClosed))) drained = false;
    } catch (error) {
      if (!(error instanceof ConsoleReadError)) throw error;
      gaps.push({ sourceId: source.source.id, stream: stream.id, reason: error.code });
      if (previous && !positions.some(p => p.i === previous.i)) positions.push(previous);
      if (!stream.writerClosed && !stream.captureIncomplete && !stream.closureUnknown) drained = false;
    } finally { await handle?.close(); }
  }
  return { records, cursor: encodeConsoleCursor({ v: 1, t: 'after', s: source.source.id, f: positions, r: source.streams.length ? (rotation + 1) % source.streams.length : 0 }), gaps, drained };
}

export async function readConsoleHistory(source: ResolvedConsoleSource, options: ConsoleReadLimits & { before?: string } = {}): Promise<ConsoleHistoryPage> {
  const config = limits(options);
  const old = parseCursor(source, options.before, 'before');
  const positions: Position[] = [];
  const resume: Position[] = old?.resume ? old.resume.map(p => ({ ...p })) : [];
  const records: ConsoleRecord[] = [];
  const gaps: ConsoleGap[] = [];
  let scanned = 0, response = 0;
  for (const stream of source.streams) {
    let handle: FileHandle | undefined;
    try {
      handle = await openConsoleFile(stream);
      const snapshot = await info(handle);
      const previous = old?.f.find(p => p.i === stream.id);
      let state: Position = previous ? { ...previous } : {
        i: stream.id, g: snapshot.generation, p: snapshot.size, e: snapshot.size,
        skip: !stream.writerClosed, partial: true,
      };
      if (state.g !== snapshot.generation || state.p > snapshot.size || (state.e ?? 0) > snapshot.size) {
        gaps.push({ sourceId: source.source.id, stream: stream.id, reason: 'source_reset' });
        state = { i: stream.id, g: snapshot.generation, p: snapshot.size, e: snapshot.size, skip: !stream.writerClosed, partial: true };
      }
      positions.push(state);
      let live = resume.find(p => p.i === stream.id);
      if (!live || live.g !== snapshot.generation) {
        live = { i: stream.id, g: snapshot.generation, p: 0, s: 0 };
        resume.splice(0, resume.length, ...resume.filter(p => p.i !== stream.id), live);
      }
      if (!previous && snapshot.size === 0) { state.e = 0; state.skip = false; state.partial = false; }
      const reversed: ConsoleRecord[] = [];
      let stopped = false;
      while (state.p > 0 && scanned < config.scan && records.length + reversed.length < config.limit && response < config.response && !stopped) {
        const size = Math.min(CHUNK, state.p, config.scan - scanned);
        const start = state.p - size;
        const chunk = await bytes(handle, start, size);
        let search = chunk.length - 1;
        while (search >= 0) {
          const lf = chunk.lastIndexOf(10, search);
          if (lf < 0) { scanned += search + 1; state.p = start; break; }
          const boundary = start + lf;
          const end = state.e ?? state.p;
          if (!previous && live.p === 0 && live.s === 0) { live.p = snapshot.size; live.s = boundary + 1; }
          const item = !state.skip ? await record(source, stream, handle, state.g, boundary + 1, end, state.partial ?? false, config.inline) : null;
          if (item && records.length + reversed.length > 0 && response + Buffer.byteLength(JSON.stringify(item)) > config.response) { stopped = true; break; }
          scanned += search - lf + 1;
          state.p = boundary; state.e = boundary; state.skip = false; state.partial = false;
          search = lf - 1;
          if (item) { reversed.push(item); response += Buffer.byteLength(JSON.stringify(item)); }
          if (records.length + reversed.length >= config.limit || response >= config.response) { stopped = true; break; }
        }
      }
      if (state.p === 0 && (state.e ?? 0) > 0 && records.length + reversed.length < config.limit && response < config.response) {
        const item = !state.skip ? await record(source, stream, handle, state.g, 0, state.e!, state.partial ?? false, config.inline) : null;
        if (!item || records.length + reversed.length === 0 || response + Buffer.byteLength(JSON.stringify(item)) <= config.response) {
          if (item) { reversed.push(item); response += Buffer.byteLength(JSON.stringify(item)); }
          state.e = 0;
        }
      }
      // A newline-free file has one record beginning at zero. Live readers can resume its scanned bytes.
      if (!previous && state.p === 0 && live.p === 0) { live.p = snapshot.size; live.s = stream.writerClosed ? snapshot.size : 0; }
      records.push(...reversed.reverse());
    } catch (error) {
      if (!(error instanceof ConsoleReadError)) throw error;
      gaps.push({ sourceId: source.source.id, stream: stream.id, reason: error.code });
    } finally { await handle?.close(); }
  }
  const hasMore = positions.some(p => p.p > 0 || (p.e ?? 0) > 0);
  return {
    records, hasMore, gaps,
    beforeCursor: hasMore ? encodeConsoleCursor({ v: 1, t: 'before', s: source.source.id, f: positions, resume }) : null,
    resumeCursor: encodeConsoleCursor({ v: 1, t: 'after', s: source.source.id, f: resume }),
  };
}

export async function openConsoleRaw(source: ResolvedConsoleSource, recordId: string) {
  if (!recordId.startsWith('cr_')) throw new ConsoleReadError('invalid_record');
  const value = decodeConsoleCursor<unknown[]>(recordId.slice(3));
  if (!Array.isArray(value) || value.length !== 6 || value[0] !== source.source.id || typeof value[1] !== 'string'
    || typeof value[2] !== 'string' || !isByteOffset(value[3]) || !isByteOffset(value[4]) || value[4] <= value[3]
    || (value[5] !== 0 && value[5] !== 1)) throw new ConsoleReadError('invalid_record');
  const [, streamId, generation, start, end, partial] = value as [string, string, string, number, number, number];
  const file = source.streams.find(s => s.id === streamId);
  if (!file) throw new ConsoleReadError('invalid_record');
  const handle = await openConsoleFile(file);
  try {
    const snapshot = await info(handle);
    if (snapshot.generation !== generation || end > snapshot.size) throw new ConsoleReadError('record_gone', 410);
    if (start > 0 && (await bytes(handle, start - 1, 1))[0] !== 10) throw new ConsoleReadError('invalid_record');
    if (partial ? (!file.writerClosed || end !== snapshot.size) : (end >= snapshot.size || (await bytes(handle, end, 1))[0] !== 10)) {
      throw new ConsoleReadError('record_gone', 410);
    }
    // Reject forged ranges spanning records, and verify the exact turn before streaming any bytes.
    for (let offset = start; offset < end; offset += CHUNK) {
      if ((await bytes(handle, offset, Math.min(CHUNK, end - offset))).includes(10)) throw new ConsoleReadError('invalid_record');
    }
    if (file.turnId) {
      const meta = consoleRecordMetadata((await bytes(handle, start, Math.min(PREFIX, end - start))).toString('utf8'));
      if (meta.turn_id !== file.turnId || !['turn', 'event'].includes(String(meta.type))) throw new ConsoleReadError('invalid_record', 403);
    }
    return { stream: handle.createReadStream({ start, end: end - 1, autoClose: true }), byteLength: end - start, contentType: 'application/octet-stream' };
  } catch (error) { await handle.close(); throw error; }
}
