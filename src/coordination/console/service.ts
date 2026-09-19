import type { MessagingActorContext } from '../channels/types.js';
import { CoordinationHttpError } from '../http/errors.js';
import { ConsoleCatalog } from './catalog.js';
import { openConsoleRaw, readConsoleAfter, readConsoleHistory } from './reader.js';
import type { ConsoleSource, ResolvedConsoleSource } from './types.js';
import type { ExecutionControlRequest, ExecutionControlReceipt } from '../../agent/execution-control.js';

export interface ConsoleControlPort {
  available(source: ResolvedConsoleSource): boolean | Promise<boolean>;
  execute(source: ResolvedConsoleSource, request: ExecutionControlRequest, context: MessagingActorContext): Promise<ExecutionControlReceipt>;
}
export interface ConsoleServiceOptions {
  catalog: ConsoleCatalog;
  controls?: ConsoleControlPort;
  authorize?: (source: ResolvedConsoleSource, context: MessagingActorContext) => void | Promise<void>;
  pollMs?: number;
}
export interface ConsoleSelection { sourceIds?: string[]; scope?: 'active'; after?: string }
export interface ConsoleFrame { event: 'source' | 'record' | 'checkpoint' | 'gap' | 'end'; data: unknown; id?: string }
interface Checkpoint { v: 1; mode: 'active' | 'selected'; positions: Record<string, string> }
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const MAX_SOURCES = 32;
function invalid(message: string): never { throw new CoordinationHttpError('request_invalid', 400, false, {}, message); }
function encodeCheckpoint(value: Checkpoint): string {
  const result = Buffer.from(JSON.stringify({v:value.v,mode:value.mode,positions:Object.entries(value.positions).map(([id,cursor])=>{const p=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));return [id,p.f.map((f: {i:string;g:string;p:number;s?:number})=>f.s===undefined||f.s===f.p?[f.i,f.g,f.p]:[f.i,f.g,f.p,f.s]),p.r??0];})})).toString('base64url');
  if (result.length > 8192) throw new CoordinationHttpError('console_capacity', 409, false, {}, 'Resume checkpoint exceeds supported capacity.');
  return result;
}
function decodeCheckpoint(value: string): Checkpoint | undefined {
  if (value.length > 8192) invalid('Console cursor exceeds supported capacity.');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed.v !== 1 || !['active','selected'].includes(parsed.mode)) return undefined;
    if (!Array.isArray(parsed.positions) || parsed.positions.length > MAX_SOURCES) invalid('Invalid console checkpoint.');
    const positions: Record<string,string> = {};
    for(const entry of parsed.positions) {
      if(!Array.isArray(entry)||entry.length!==3||typeof entry[0]!=='string'||!entry[1]||!Array.isArray(entry[1])) invalid('Invalid console checkpoint.');
      positions[entry[0]]=Buffer.from(JSON.stringify({v:1,t:'after',s:entry[0],r:entry[2],f:entry[1].map((f:unknown[])=>({i:f[0],g:f[1],p:f[2],s:f[3]??f[2]}))})).toString('base64url');
    }
    return {v:1,mode:parsed.mode,positions};
  } catch { return undefined; }
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Read-only disk observation. Commands explicitly use the already-owning runtime. */
export class ConsoleService {
  constructor(readonly options: ConsoleServiceOptions) {}
  private owner(context: MessagingActorContext) {
    if (context.identity.kind !== 'owner') throw new CoordinationHttpError('unauthorized', 403, false);
  }
  async resolve(sourceId: string, context: MessagingActorContext): Promise<ResolvedConsoleSource> {
    this.owner(context);
    const resolved = await this.options.catalog.resolve(sourceId);
    if (!resolved) throw new CoordinationHttpError('console_source_not_found', 404, false);
    await this.options.authorize?.(resolved, context);
    return resolved;
  }
  async descriptor(resolved: ResolvedConsoleSource): Promise<ConsoleSource> {
    const available = !TERMINAL.has(resolved.source.state) && Boolean(await this.options.controls?.available(resolved));
    const exact = Boolean(resolved.target.jobId || resolved.target.turnId);
    const action = (operation: 'cancel' | 'steer') => ({ operation, scope: 'source' as const,
      available: available && exact && (operation === 'cancel' || resolved.source.kind === 'subagent'),
      reason: !exact ? 'identity_unresolved' : TERMINAL.has(resolved.source.state) ? 'execution_terminal' : !available ? 'runtime_unavailable' : operation === 'steer' && resolved.source.kind !== 'subagent' ? 'unsupported' : null,
      url: `/api/v1/executions/${encodeURIComponent(resolved.source.id)}/${operation}`,
      targetId: resolved.target.jobId ?? resolved.target.turnId ?? null });
    return { ...resolved.source, actions: [action('cancel'), action('steer')] } as ConsoleSource;
  }
  async list(query: { state?: 'active' | 'recent'; limit?: number; cursor?: string }, context: MessagingActorContext) {
    this.owner(context);
    const page = await this.options.catalog.list(query);
    const sources = await Promise.all(page.sources.map(async source => this.descriptor(await this.resolve(source.id, context))));
    return { ...page, sources };
  }
  async source(sourceId: string, context: MessagingActorContext) { return this.descriptor(await this.resolve(sourceId, context)); }
  async history(sourceId: string, options: { before?: string; limit?: number }, context: MessagingActorContext) {
    return readConsoleHistory(await this.resolve(sourceId, context), options);
  }
  async raw(sourceId: string, recordId: string, context: MessagingActorContext) {
    return openConsoleRaw(await this.resolve(sourceId, context), recordId);
  }
  async control(sourceId: string, operation: 'cancel' | 'steer', input: { expectedExecutionId: string; idempotencyKey: string; text?: string }, context: MessagingActorContext) {
    const source = await this.resolve(sourceId, context);
    if (!this.options.controls || !await this.options.controls.available(source)) throw new CoordinationHttpError('console_control_unavailable', 503, true);
    if (operation === 'steer' && source.source.kind !== 'subagent') invalid('Coding executions cannot be steered.');
    const target = source.target;
    if (!target.jobId && !target.turnId) throw new CoordinationHttpError('console_identity_unresolved', 409, false);
    return this.options.controls.execute(source, {
      operation, idempotencyKey: input.idempotencyKey, text: input.text,
      jobId: target.jobId, chatId: target.chatId, turnId: target.turnId, harnessWorkId: target.harnessWorkId,
      ...(target.jobId ? { expectedJobId: input.expectedExecutionId } : { expectedTurnId: input.expectedExecutionId }),
    }, context);
  }
  async prepare(selection: ConsoleSelection, context: MessagingActorContext) {
    this.owner(context);
    const ids = [...new Set(selection.sourceIds ?? [])].sort();
    if ((selection.scope === 'active') === (ids.length > 0) || ids.length > MAX_SOURCES) invalid('Select one to 32 sources, or scope=active.');
    const mode = selection.scope === 'active' ? 'active' as const : 'selected' as const;
    let checkpoint: Checkpoint = { v: 1, mode, positions: {} };
    if (selection.after) {
      const decoded = decodeCheckpoint(selection.after);
      if (decoded) {
        if (decoded.mode !== mode || (mode === 'selected' && Object.keys(decoded.positions).sort().join('\0') !== ids.join('\0'))) invalid('Console cursor selection mismatch.');
        checkpoint = decoded;
      } else if (mode === 'selected' && ids.length === 1) checkpoint.positions[ids[0]!] = selection.after;
      else invalid('A multi-source stream requires a console checkpoint.');
    }
    for (const id of mode === 'selected' ? ids : Object.keys(checkpoint.positions)) {
      await this.resolve(id, context);
      if (checkpoint.positions[id]) {
        try { const c=JSON.parse(Buffer.from(checkpoint.positions[id]!, 'base64url').toString('utf8')); if(c.v!==1||c.t!=='after'||c.s!==id||!Array.isArray(c.f)||c.f.length>4) invalid('Invalid source cursor.'); } catch { invalid('Invalid source cursor.'); }
      }
    }
    return { ids, checkpoint, resumed: Boolean(selection.after) };
  }
  async *stream(prepared: Awaited<ReturnType<ConsoleService['prepare']>>, context: MessagingActorContext, signal: AbortSignal, reauthorize: () => Promise<void>): AsyncGenerator<ConsoleFrame> {
    const { checkpoint, ids } = prepared;
    const ended = new Set<string>();
    const descriptors = new Map<string, string>();
    if (prepared.resumed && checkpoint.mode === 'active') yield { event: 'gap', data: { reason: 'catalog_coverage_unknown', sourceId: null, discoveryUrl: '/api/v1/console/sources?state=recent' } };
    let round = 0;
    while (!signal.aborted) {
      await reauthorize();
      let selected = ids;
      if (checkpoint.mode === 'active') {
        const active = await this.list({ state: 'active', limit: MAX_SOURCES + 1 }, context);
        selected = [...new Set([...Object.keys(checkpoint.positions).filter(id => !ended.has(id)), ...active.sources.map(s => s.id)])];
        if (selected.length > MAX_SOURCES || active.nextCursor) yield { event: 'gap', data: { reason: 'capacity_limited', sourceId: null, omittedCount: Math.max(1, selected.length - MAX_SOURCES), discoveryUrl: '/api/v1/console/sources?state=active' } };
        selected = selected.slice(0, MAX_SOURCES);
        // Closed active sources no longer consume checkpoint capacity; retained history remains addressable.
        for (const id of ended) delete checkpoint.positions[id];
      }
      for (const id of [...selected.slice(round % Math.max(1, selected.length)), ...selected.slice(0, round % Math.max(1, selected.length))]) {
        if (signal.aborted || ended.has(id)) continue;
        let source: ResolvedConsoleSource;
        try { source = await this.resolve(id, context); }
        catch (error) {
          if (!(error instanceof CoordinationHttpError) || error.httpStatus !== 404) throw error;
          yield { event: 'gap', data: { sourceId: id, reason: 'source_unavailable' } };
          yield { event: 'end', data: { sourceId: id, status: 'unavailable' } };
          ended.add(id); continue;
        }
        const descriptor = await this.descriptor(source);
        const descriptorKey = JSON.stringify({...descriptor, checkedAt:undefined});
        if (descriptors.get(id) !== descriptorKey) {
          yield { event: 'source', data: { source: descriptor } };
          descriptors.set(id, descriptorKey);
        }
        if (!checkpoint.positions[id]) {
          const page = await readConsoleHistory(source, { limit: 200 });
          yield { event: 'source', data: { source: descriptor, beforeCursor: page.beforeCursor, hasMore: page.hasMore } };
          for (const gap of page.gaps) yield { event: 'gap', data: gap };
          for (const record of page.records) yield { event: 'record', data: { record } };
          checkpoint.positions[id] = page.resumeCursor;
        } else {
          const page = await readConsoleAfter(source, checkpoint.positions[id]);
          for (const gap of page.gaps) yield { event: 'gap', data: gap };
          for (const record of page.records) yield { event: 'record', data: { record } };
          checkpoint.positions[id] = page.cursor;
          if (TERMINAL.has(source.source.state) && page.drained) {
            ended.add(id);
            yield { event: 'end', data: { sourceId: id, status: source.source.output.availability === 'unavailable' ? 'unavailable' : source.source.output.historyCompleteness === 'partial' || page.gaps.length > 0 ? 'incomplete' : 'drained' } };
          }
        }
      }
      const cursor = encodeCheckpoint(checkpoint);
      yield { event: 'checkpoint', data: { cursor }, id: cursor };
      if (checkpoint.mode === 'selected' && ids.every(id => ended.has(id))) return;
      round++;
      await pause(this.options.pollMs ?? 1000, signal);
    }
  }
}
