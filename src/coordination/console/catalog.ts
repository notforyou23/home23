import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import type { AsyncWorkRecord } from '../../work/types.js';
import type { CodingJobRecord } from '../../acp/types.js';
import { consoleSourceId, decodeConsoleCursor, encodeConsoleCursor } from './cursor.js';
import { consoleFileInfo, consoleRecordMetadata, openConsoleFile } from './reader.js';
import { CONSOLE_TERMINAL_STATES, ConsoleReadError, type ConsoleFileStream, type ConsoleFormat, type ConsoleRoot, type ConsoleSource, type ConsoleState, type ResolvedConsoleSource } from './types.js';

export interface ConsoleCatalogNotice { runtimeId: string; reason: string }
export interface ConsoleCatalogPage { sources: ConsoleSource[]; nextCursor: string | null; notices: ConsoleCatalogNotice[] }
export type ConsoleRootProvider = readonly ConsoleRoot[] | (() => readonly ConsoleRoot[] | Promise<readonly ConsoleRoot[]>);
interface TurnInfo {
  id: string; chatId?: string; status?: string; startedAt?: string; endedAt?: string;
  provenance?: { harnessWorkId?: string; parentChatId?: string; parentTurnId?: string; parentToolCallId?: string };
  lastOutputAt?: string; captureStarted?: boolean; captureEnded?: boolean; captureGap?: boolean;
  captureStatus?: string;
}
interface JournalIndex { generation: string; offset: number; prefix: Buffer; turns: Map<string, TurnInfo>; caughtUp: boolean; complete: boolean }
const VALID_JOB = /^cj_[A-Za-z0-9_-]+$/;
const VALID_WORK = /^aw_[A-Za-z0-9_-]+$/;
const VALID_TURN = /^t_[A-Za-z0-9_-]+$/;
const STATES = new Set(['queued', 'starting', 'running', 'blocked', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted']);
const TERMINAL_TURNS = new Set(['complete', 'error', 'timeout', 'orphaned', 'stopped']);

export function consoleHistoryPath(root: ConsoleRoot, chatId: string): string {
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(root.historyDir, `${sanitize(root.historyNamespace)}__${sanitize(chatId)}.jsonl`);
}

function state(value: unknown): ConsoleState {
  return value === 'complete' ? 'completed' : typeof value === 'string' && STATES.has(value) ? value as ConsoleState : 'unknown';
}

function iso(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function publicWorkId(work?: AsyncWorkRecord): string | null {
  const id = work?.coordinationDestination?.parentWorkId ?? work?.parentWorkId;
  return id?.startsWith('wrk_') ? id : null;
}

function baseSource(root: ConsoleRoot, id: string, kind: 'coding' | 'subagent', work?: AsyncWorkRecord): ConsoleSource {
  return {
    id, kind, label: work?.label ?? (kind === 'coding' ? 'Coding execution' : 'Subagent execution'),
    actor: { ...root.actor }, backend: null, parentSourceId: null, workId: publicWorkId(work),
    harnessWorkId: work?.workId ?? null, executionId: null,
    conversationId: work?.coordinationDestination?.conversationId ?? null,
    state: state(work?.status), startedAt: iso(work?.startedAt), finishedAt: iso(work?.finishedAt),
    lastOutputAt: null, lastOutputAtBasis: 'unknown', checkedAt: new Date().toISOString(),
    output: { availability: 'pending', reason: null, format: kind === 'coding' ? 'text' : 'home23-turn', shellOutputTiming: 'unknown', historyCompleteness: 'unknown' },
    actions: [{ operation: 'cancel', available: false, reason: 'runtime_unavailable', scope: 'source', targetId: null },
      ...(kind === 'subagent' ? [{ operation: 'steer' as const, available: false, reason: 'runtime_unavailable', scope: 'source' as const, targetId: null }] : [])],
  };
}

/** Metadata reads are cached by file identity. The only scans are the configured flat metadata directories. */
export class ConsoleCatalog {
  private readonly metadata = new Map<string, { stamp: string; value: unknown }>();
  private readonly journals = new Map<string, JournalIndex>();
  private snapshot?: { expires: number; sources: ResolvedConsoleSource[]; notices: ConsoleCatalogNotice[] };
  private remainingIndexBytes = 0;
  private pendingDiscovery?: Promise<{ sources: ResolvedConsoleSource[]; notices: ConsoleCatalogNotice[] }>;

  constructor(private readonly roots: ConsoleRootProvider, private readonly options: { cacheMs?: number; maxEntries?: number; journalScanBytes?: number } = {}) {}

  invalidate(): void { this.snapshot = undefined; }

  async list(options: { state?: 'active' | 'recent'; limit?: number; cursor?: string } = {}): Promise<ConsoleCatalogPage> {
    const mode = options.state ?? 'recent';
    if (mode !== 'active' && mode !== 'recent') throw new ConsoleReadError('invalid_state');
    const snapshot = await this.discover();
    let sources = snapshot.sources.map(r => r.source).filter(s => mode !== 'active' || !CONSOLE_TERMINAL_STATES.has(s.state));
    if (options.cursor) {
      const cursor = decodeConsoleCursor<{ v: number; t: string; state: string; startedAt: string; id: string }>(options.cursor);
      if (!cursor || cursor.v !== 1 || cursor.t !== 'catalog' || cursor.state !== mode || typeof cursor.startedAt !== 'string' || typeof cursor.id !== 'string') throw new ConsoleReadError('invalid_cursor');
      sources = sources.filter(s => (s.startedAt ?? '') < cursor.startedAt || ((s.startedAt ?? '') === cursor.startedAt && s.id < cursor.id));
    }
    const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
    const page = sources.slice(0, limit);
    const last = page.at(-1);
    return {
      sources: page, notices: snapshot.notices,
      nextCursor: sources.length > page.length && last ? encodeConsoleCursor({ v: 1, t: 'catalog', state: mode, startedAt: last.startedAt ?? '', id: last.id }) : null,
    };
  }

  async resolve(sourceId: string): Promise<ResolvedConsoleSource | undefined> {
    if (!/^cs_[A-Za-z0-9_-]{24}$/.test(sourceId)) throw new ConsoleReadError('invalid_source');
    return (await this.discover()).sources.find(s => s.source.id === sourceId);
  }

  private async entries(dir: string, runtimeId: string, notices: ConsoleCatalogNotice[]): Promise<string[]> {
    const result: string[] = [];
    try {
      const directory = await opendir(dir);
      for await (const entry of directory) {
        if (entry.isSymbolicLink()) continue;
        result.push(entry.name);
        if (result.length >= (this.options.maxEntries ?? 10000)) { notices.push({ runtimeId, reason: 'catalog_capacity' }); break; }
      }
    } catch (error) {
      notices.push({ runtimeId, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'storage_not_created' : 'storage_unavailable' });
    }
    return result;
  }

  private async json<T>(file: string, allowedRoot: string): Promise<T | undefined> {
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) return undefined;
      const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      const cached = this.metadata.get(file);
      if (cached?.stamp === stamp) return cached.value as T;
      const handle = await openConsoleFile({ id: 'metadata', path: file, allowedRoot, format: 'text', writerClosed: true });
      let value: T;
      try { value = JSON.parse(await handle.readFile('utf8')) as T; } finally { await handle.close(); }
      this.metadata.set(file, { stamp, value });
      return value;
    } catch { return undefined; }
  }

  private async index(stream: ConsoleFileStream): Promise<JournalIndex | undefined> {
    let handle;
    try {
      const stat = await consoleFileInfo(stream);
      let index = this.journals.get(stream.path);
      if (!index || index.generation !== stat.generation || index.offset > stat.size) {
        index = { generation: stat.generation, offset: 0, prefix: Buffer.alloc(0), turns: new Map(), caughtUp: false, complete: false };
        this.journals.set(stream.path, index);
      }
      handle = await openConsoleFile(stream);
      let budget = Math.min(1024 * 1024, this.remainingIndexBytes);
      while (index.offset < stat.size && budget > 0) {
        const chunk = Buffer.alloc(Math.min(256 * 1024, stat.size - index.offset, budget));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, index.offset);
        if (!bytesRead) break;
        let from = 0;
        while (from < bytesRead) {
          const found = chunk.indexOf(10, from);
          const to = found >= 0 && found < bytesRead ? found : bytesRead;
          const available = 64 * 1024 - index.prefix.length;
          if (available > 0) index.prefix = Buffer.concat([index.prefix, chunk.subarray(from, Math.min(to, from + available))]);
          if (to < bytesRead) { this.indexRecord(index, index.prefix); index.prefix = Buffer.alloc(0); }
          from = to + 1;
        }
        index.offset += bytesRead; budget -= bytesRead; this.remainingIndexBytes -= bytesRead;
      }
      index.caughtUp = index.offset === stat.size;
      index.complete = index.caughtUp && index.prefix.length === 0;
      return index;
    } catch { return undefined; } finally { await handle?.close(); }
  }

  private indexRecord(index: JournalIndex, line: Buffer): void {
    const value = consoleRecordMetadata(line.toString('utf8'));
    if (typeof value.turn_id !== 'string' || !VALID_TURN.test(value.turn_id) || !['turn', 'event'].includes(String(value.type))) return;
    const turn = index.turns.get(value.turn_id) ?? { id: value.turn_id };
    if (value.type === 'turn') {
      if (typeof value.chat_id === 'string') turn.chatId = value.chat_id;
      if (typeof value.status === 'string') turn.status = value.status;
      turn.startedAt = iso(value.started_at) ?? turn.startedAt;
      turn.endedAt = iso(value.ended_at) ?? turn.endedAt;
      const provenance = value.delegation_origin;
      if (provenance && typeof provenance === 'object') turn.provenance = provenance as TurnInfo['provenance'];
      if (typeof value.execution_output_capture === 'string') turn.captureStatus = value.execution_output_capture;
    } else {
      if (!['status', 'cache', 'capture_start', 'capture_end'].includes(String(value.kind))) {
        const ts = iso(value.ts);
        if (ts && (!turn.lastOutputAt || ts > turn.lastOutputAt)) turn.lastOutputAt = ts;
      }
      if (value.kind === 'capture_start') turn.captureStarted = true;
      if (value.kind === 'capture_end') turn.captureEnded = true;
      if (value.kind === 'capture_gap') turn.captureGap = true;
    }
    index.turns.set(turn.id, turn);
  }

  private async discover(): Promise<{ sources: ResolvedConsoleSource[]; notices: ConsoleCatalogNotice[] }> {
    if (this.snapshot && this.snapshot.expires > Date.now()) return this.snapshot;
    this.pendingDiscovery ??= this.scan().finally(() => { this.pendingDiscovery = undefined; });
    return this.pendingDiscovery;
  }

  private async scan(): Promise<{ sources: ResolvedConsoleSource[]; notices: ConsoleCatalogNotice[] }> {
    const roots = typeof this.roots === 'function' ? await this.roots() : this.roots;
    this.remainingIndexBytes = this.options.journalScanBytes ?? 4 * 1024 * 1024;
    const sources: ResolvedConsoleSource[] = [];
    const notices: ConsoleCatalogNotice[] = [];
    const rootsSeen = new Set<string>();
    for (const root of roots) {
      if (rootsSeen.has(root.id)) { notices.push({ runtimeId: root.id, reason: 'duplicate_runtime' }); continue; }
      rootsSeen.add(root.id);
      const work: AsyncWorkRecord[] = [];
      for (const name of await this.entries(root.workDir, root.id, notices)) {
        if (!name.endsWith('.json') || !VALID_WORK.test(name.slice(0, -5))) continue;
        const entry = await this.json<AsyncWorkRecord>(path.join(root.workDir, name), root.workDir);
        if (entry?.schema === 'home23.async-work.v1' && entry.workId === name.slice(0, -5) && entry.resultHandle) work.push(entry);
        else notices.push({ runtimeId: root.id, reason: 'metadata_unavailable' });
      }
      const jobs = new Map<string, CodingJobRecord | undefined>();
      for (const name of await this.entries(root.jobsDir, root.id, notices)) {
        if (!VALID_JOB.test(name)) continue;
        const job = await this.json<CodingJobRecord>(path.join(root.jobsDir, name, 'job.json'), root.jobsDir);
        if (job?.schema === 'home23.coding-job.v1' && job.id === name) jobs.set(name, job);
        else notices.push({ runtimeId: root.id, reason: 'metadata_unavailable' });
      }
      for (const entry of work) if (entry.resultHandle.type === 'coding_job' && VALID_JOB.test(entry.resultHandle.jobId) && !jobs.has(entry.resultHandle.jobId)) jobs.set(entry.resultHandle.jobId, undefined);
      const rootSources: ResolvedConsoleSource[] = [];
      for (const [jobId, job] of jobs) {
        const linked = work.find(w => w.resultHandle.type === 'coding_job' && w.resultHandle.jobId === jobId);
        const source = baseSource(root, consoleSourceId(root.id, 'coding', jobId), 'coding', linked);
        source.executionId = jobId;
        source.backend = job?.backend ?? null;
        source.label = job?.label ?? source.label;
        source.state = state(job?.status ?? linked?.status);
        if (job?.cancelRequestedAt && !CONSOLE_TERMINAL_STATES.has(source.state)) source.state = 'stopping';
        source.startedAt = iso(job?.startedAt) ?? source.startedAt;
        source.finishedAt = iso(job?.finishedAt) ?? source.finishedAt;
        const format: ConsoleFormat = job?.backend === 'codex' ? 'codex-jsonl' : job?.backend === 'cursor' ? 'cursor-jsonl' : 'text';
        source.output.format = format;
        source.output.shellOutputTiming = ['codex', 'cursor'].includes(job?.backend ?? '') ? 'at_completion' : 'unknown';
        const closed = CONSOLE_TERMINAL_STATES.has(source.state) && !!source.finishedAt;
        const closureUnknown = CONSOLE_TERMINAL_STATES.has(source.state) && !closed;
        const streams: ConsoleFileStream[] = [
          { id: 'events', path: path.join(root.jobsDir, jobId, 'events.jsonl'), allowedRoot: root.jobsDir, format, writerClosed: closed, closureUnknown },
          { id: 'stderr', path: path.join(root.jobsDir, jobId, 'stderr.log'), allowedRoot: root.jobsDir, format: 'text', writerClosed: closed, closureUnknown },
        ];
        const present: ConsoleFileStream[] = [];
        for (const stream of streams) {
          try {
            const file = await consoleFileInfo(stream); present.push(stream);
            if (file.size > 0 && (!source.lastOutputAt || file.modifiedAt > source.lastOutputAt)) {
              source.lastOutputAt = file.modifiedAt; source.lastOutputAtBasis = 'file_modified';
            }
          } catch { /* availability is independent from execution outcome */ }
        }
        source.output.availability = present.length ? 'available' : closed ? 'unavailable' : job ? 'pending' : 'unavailable';
        source.output.reason = present.length ? (present.length < streams.length ? 'stream_unavailable' : null) : source.output.availability === 'pending' ? 'output_pending' : 'output_unavailable';
        source.output.historyCompleteness = present.length < streams.length ? 'partial' : 'unknown';
        if (closureUnknown && present.length) { source.output.reason = 'writer_closure_unknown'; source.output.historyCompleteness = 'partial'; }
        for (const action of source.actions) action.targetId = jobId;
        rootSources.push({ source, root, streams, target: { runtimeId: root.id, kind: 'coding', jobId, harnessWorkId: linked?.workId }, channelId: linked?.coordinationDestination?.channelId ?? null });
      }
      const turnParents = new Map<string, string>();
      const provenance = new Map<string, TurnInfo['provenance']>();
      for (const entry of work) {
        if (entry.kind !== 'subagent' || entry.resultHandle.type !== 'subagent_chat' || typeof entry.resultHandle.chatId !== 'string') continue;
        const source = baseSource(root, consoleSourceId(root.id, 'subagent', entry.workId), 'subagent', entry);
        source.backend = 'home23';
        const chatId = entry.resultHandle.chatId;
        const journal: ConsoleFileStream = { id: 'journal', path: consoleHistoryPath(root, chatId), allowedRoot: root.historyDir, format: 'home23-turn', writerClosed: false };
        const index = await this.index(journal);
        const indexedTurnId = (entry.resultHandle as { turnId?: string }).turnId;
        const bound = [...(index?.turns.values() ?? [])].filter(t => t.chatId === chatId && t.provenance?.harnessWorkId === entry.workId);
        const legacy = index?.complete && chatId.startsWith('subagent:') && index.turns.size === 1 ? [...index.turns.values()][0] : undefined;
        // The durable provenance wins over the convenience index; a conflicting binding is never guessed away.
        let turnId = bound.length === 1 && (!indexedTurnId || indexedTurnId === bound[0]!.id) ? bound[0]!.id
          : bound.length === 0 && indexedTurnId && VALID_TURN.test(indexedTurnId) ? indexedTurnId
            : bound.length === 0 && !indexedTurnId && legacy?.chatId === chatId ? legacy.id : undefined;
        const indexed = turnId ? index?.turns.get(turnId) : undefined;
        if (indexed && (indexed.chatId !== chatId || (indexed.provenance?.harnessWorkId && indexed.provenance.harnessWorkId !== entry.workId))) turnId = undefined;
        const turn = turnId ? index?.turns.get(turnId) : undefined;
        source.executionId = turnId ?? null;
        const streams: ConsoleFileStream[] = [];
        if (turnId) {
          journal.turnId = turnId;
          journal.writerClosed = !!(turn?.status && TERMINAL_TURNS.has(turn.status));
          journal.closureUnknown = CONSOLE_TERMINAL_STATES.has(source.state) && !journal.writerClosed && (!index || index.caughtUp);
          if (journal.closureUnknown) { source.output.reason = 'writer_closure_unknown'; source.output.historyCompleteness = 'partial'; }
          streams.push(journal);
          turnParents.set(turnId, source.id); provenance.set(source.id, turn?.provenance);
          if (turn?.lastOutputAt) { source.lastOutputAt = turn.lastOutputAt; source.lastOutputAtBasis = 'source_timestamp'; }
          if (turn?.endedAt) source.finishedAt = turn.endedAt;
          if (turn?.status && TERMINAL_TURNS.has(turn.status)) source.state = ({ complete: 'completed', stopped: 'cancelled', error: 'failed', timeout: 'failed', orphaned: 'interrupted' } as Record<string, ConsoleState>)[turn.status]!;
          if (root.executionOutputDir) {
            const capture: ConsoleFileStream = { id: 'execution-output', path: path.join(root.executionOutputDir, `${turnId}.jsonl`), allowedRoot: root.executionOutputDir, format: 'home23-turn', turnId, writerClosed: false };
            const captureIndex = await this.index(capture);
            const captured = captureIndex?.turns.get(turnId);
            if (captureIndex) {
              capture.writerClosed = !!captured?.captureEnded;
              capture.captureIncomplete = journal.writerClosed && !capture.writerClosed && ['incomplete', 'unavailable'].includes(turn?.captureStatus ?? '');
              capture.closureUnknown = (journal.writerClosed || journal.closureUnknown) && captureIndex.caughtUp && !capture.writerClosed && !capture.captureIncomplete;
              streams.push(capture);
              if (captured?.captureStarted) source.output.shellOutputTiming = 'incremental';
              if (captured?.lastOutputAt && (!source.lastOutputAt || captured.lastOutputAt > source.lastOutputAt)) { source.lastOutputAt = captured.lastOutputAt; source.lastOutputAtBasis = 'source_timestamp'; }
              if (captured?.captureGap) { source.output.reason = 'capture_gap'; source.output.historyCompleteness = 'partial'; }
              if ((journal.writerClosed || journal.closureUnknown) && !captured?.captureEnded) {
                source.output.reason = capture.captureIncomplete ? 'capture_incomplete' : 'capture_closure_unknown';
                source.output.historyCompleteness = 'partial';
              }
            } else if (turn?.captureStatus) {
              capture.writerClosed = turn.captureStatus === 'closed';
              capture.captureIncomplete = !capture.writerClosed;
              streams.push(capture);
              source.output.reason = 'capture_unavailable'; source.output.historyCompleteness = 'partial';
            }
          }
        }
        if (source.output.shellOutputTiming === 'unknown') source.output.shellOutputTiming = 'at_completion';
        source.output.availability = turnId && turn ? 'available' : index && !index.complete ? 'pending' : CONSOLE_TERMINAL_STATES.has(source.state) ? 'unavailable' : index ? 'pending' : 'unavailable';
        if (!turnId) source.output.reason = !index ? 'output_unavailable' : !index.complete ? 'identity_pending' : bound.length > 1 || (index.turns.size > 1) ? 'ambiguous_identity' : 'identity_unavailable';
        else if (!index) source.output.reason = 'output_unavailable';
        else if (!index.complete && !source.output.reason) source.output.reason = 'history_index_pending';
        for (const action of source.actions) { action.targetId = turnId ?? null; if (!turnId) action.reason = source.output.reason; }
        rootSources.push({ source, root, streams, target: { runtimeId: root.id, kind: 'subagent', chatId, turnId, harnessWorkId: entry.workId }, channelId: entry.coordinationDestination?.channelId ?? null });
      }
      for (const resolved of rootSources) {
        const linked = work.find(w => w.workId === resolved.source.harnessWorkId);
        const direct = linked?.parentWorkId?.startsWith('aw_') ? rootSources.find(r => r.source.harnessWorkId === linked.parentWorkId)?.source.id : undefined;
        const parentTurnId = provenance.get(resolved.source.id)?.parentTurnId ?? linked?.originTurnId;
        resolved.source.parentSourceId = direct ?? (parentTurnId ? turnParents.get(parentTurnId) : undefined) ?? null;
      }
      for (const resolved of rootSources) {
        resolved.forwardedSources = Object.fromEntries(rootSources.filter(r => r.source.parentSourceId === resolved.source.id && r.source.harnessWorkId).map(r => [r.source.harnessWorkId!, r.source.id]));
      }
      sources.push(...rootSources);
    }
    sources.sort((a, b) => (b.source.startedAt ?? '').localeCompare(a.source.startedAt ?? '') || b.source.id.localeCompare(a.source.id));
    const uniqueNotices = notices.filter((notice, index) => notices.findIndex(n => n.runtimeId === notice.runtimeId && n.reason === notice.reason) === index);
    this.snapshot = { sources, notices: uniqueNotices, expires: Date.now() + (this.options.cacheMs ?? 500) };
    return this.snapshot;
  }
}
