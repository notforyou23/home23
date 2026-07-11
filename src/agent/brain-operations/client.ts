import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { isEventGap, parseOperationEvents, validateEventGap } from './sse.js';
import {
  assertExactKeys,
  exactProviderModelPair,
  hasOwn,
  optionalBoolean,
  optionalEnum,
  optionalFiniteInteger,
  optionalFiniteNumber,
  requiredBoundedText,
} from './input-validation.js';
import type {
  BrainCatalog,
  BrainCatalogEntry,
  BrainOperationEvent,
  BrainOperationEventGap,
  BrainOperationNotification,
  BrainNonterminalOperation,
  BrainOperationRecord,
  BrainOperationResult,
  BrainOperationResultEnvelope,
  BrainOperationState,
  BrainQueryRequest,
  BrainTargetSelector,
  OperationActivity,
  ResolvedBrainTarget,
  SynthesisStateResponse,
} from './types.js';

const TERMINAL = new Set<BrainOperationState>([
  'complete', 'partial', 'failed', 'cancelled', 'interrupted',
]);

const DURABLE_OPERATION_TYPES = new Set([
  'query', 'pgs', 'synthesis', 'research_compile', 'research_stop',
  'research_launch', 'research_continue', 'graph_export', 'ad_hoc_export',
]);

const OWNED_RUN_OPERATION_TYPES = new Set([
  'research_continue', 'research_stop', 'research_watch',
]);

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const requireCjs = createRequire(import.meta.url);
const { OPERATION_ID_PATTERN: OPERATION_ID } = requireCjs(
  '../../../engine/src/dashboard/brain-operations/operation-contract.js',
) as { OPERATION_ID_PATTERN: RegExp };

function operationEventIsGap(event: BrainOperationEvent): event is BrainOperationEventGap {
  return isEventGap(event);
}

const PARAMETER_FIELDS: Record<string, readonly string[]> = {
  query: ['requestId', 'target', 'query', 'mode', 'modelSelection', 'enablePGS',
    'enableSynthesis', 'includeOutputs', 'includeThoughts', 'includeCoordinatorInsights',
    'allowActions', 'priorContext', 'topK'],
  pgs: ['requestId', 'target', 'query', 'mode', 'pgsMode', 'pgsConfig', 'pgsSweep',
    'pgsSynth', 'priorContext'],
  search: ['requestId', 'target', 'query', 'topK', 'tag'],
  graph: ['requestId', 'target', 'nodeLimit', 'edgeLimit', 'tag', 'clusterId', 'minWeight'],
  status: ['requestId', 'target', 'view', 'generationMarker'],
  graph_export: ['requestId', 'target', 'format'],
  synthesis: ['requestId', 'trigger', 'reason'],
  research_compile: ['requestId', 'target', 'kind', 'section', 'sectionId', 'focus'],
  research_launch: ['requestId', 'topic', 'context', 'cycles', 'explorationMode',
    'analysisDepth', 'maxConcurrent', 'primaryModel', 'primaryProvider', 'fastModel',
    'fastProvider', 'strategicModel', 'strategicProvider'],
  research_continue: ['requestId', 'target', 'context', 'cycles', 'primaryModel', 'primaryProvider'],
  research_stop: ['requestId', 'target'],
  research_watch: ['requestId', 'target', 'after', 'limit', 'filter'],
  research_intelligence: ['requestId', 'target', 'include'],
  ad_hoc_export: ['requestId', 'query', 'answer', 'format', 'metadata'],
};

function invalid(message = 'invalid_request'): Error {
  return Object.assign(new Error(message), { code: 'invalid_request' });
}

function validateTargetSelector(value: unknown): BrainTargetSelector {
  assertExactKeys(value, ['agent', 'brainId'], 'target', { requireAny: true });
  if (hasOwn(value, 'agent')
      && (typeof value.agent !== 'string' || !IDENTIFIER.test(value.agent))) {
    throw invalid('target_invalid');
  }
  if (hasOwn(value, 'brainId')
      && (typeof value.brainId !== 'string' || !IDENTIFIER.test(value.brainId))) {
    throw invalid('target_invalid');
  }
  return value as BrainTargetSelector;
}

function validatePresent<T>(
  parameters: Record<string, unknown>,
  field: string,
  parse: (value: unknown) => T | undefined,
): T | undefined {
  if (!hasOwn(parameters, field)) return undefined;
  const parsed = parse(parameters[field]);
  if (parsed === undefined) throw invalid(`${field}_invalid`);
  return parsed;
}

function validateCallerParameters(operationType: string, parameters: Record<string, unknown>): void {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw invalid();
  const allowed = PARAMETER_FIELDS[operationType];
  if (!allowed) throw invalid();
  assertExactKeys(parameters, allowed, 'parameters');
  for (const key of Reflect.ownKeys(parameters)) {
    if (typeof key !== 'string' || parameters[key] === undefined) throw invalid(`${String(key)}_invalid`);
  }
  for (const forbidden of ['model', 'provider', 'pgsSweepModel', 'pgsSweepProvider',
    'pgsSynthModel', 'pgsSynthProvider']) {
    if (hasOwn(parameters, forbidden)) throw invalid(`${forbidden}_invalid`);
  }
  const modelSelection = validatePresent(parameters, 'modelSelection', (value) =>
    exactProviderModelPair(value, 'modelSelection'));
  const pgsSweep = validatePresent(parameters, 'pgsSweep', (value) =>
    exactProviderModelPair(value, 'pgsSweep'));
  const pgsSynth = validatePresent(parameters, 'pgsSynth', (value) =>
    exactProviderModelPair(value, 'pgsSynth'));
  if (operationType === 'query' && (pgsSweep || pgsSynth)) throw invalid();
  if (operationType === 'pgs' && modelSelection) throw invalid();
  if (operationType === 'synthesis' && (modelSelection || pgsSweep || pgsSynth)) throw invalid();

  if (['query', 'pgs', 'search'].includes(operationType)) {
    if (!hasOwn(parameters, 'query')) throw invalid('query_invalid');
    requiredBoundedText(parameters.query, 'query', 12_000);
  } else if (hasOwn(parameters, 'query')) {
    requiredBoundedText(parameters.query, 'query', 12_000);
  }
  validatePresent(parameters, 'topK', (value) => optionalFiniteInteger(value, 'topK', 1, 100));
  validatePresent(parameters, 'nodeLimit', (value) =>
    optionalFiniteInteger(value, 'nodeLimit', 1, 2_000));
  validatePresent(parameters, 'edgeLimit', (value) =>
    optionalFiniteInteger(value, 'edgeLimit', 1, 8_000));
  validatePresent(parameters, 'minWeight', (value) =>
    optionalFiniteNumber(value, 'minWeight', 0, 1));
  validatePresent(parameters, 'after', (value) =>
    optionalFiniteInteger(value, 'after', 0, Number.MAX_SAFE_INTEGER));
  validatePresent(parameters, 'limit', (value) => optionalFiniteInteger(value, 'limit', 1, 500));
  validatePresent(parameters, 'cycles', (value) =>
    optionalFiniteInteger(value, 'cycles', 1, 10_000));
  validatePresent(parameters, 'maxConcurrent', (value) =>
    optionalFiniteInteger(value, 'maxConcurrent', 1, 128));
  validatePresent(parameters, 'mode', (value) => optionalEnum(value, 'mode', [
    'quick', 'full', 'expert', 'dive', 'fast', 'normal', 'deep', 'executive',
    'raw', 'report', 'innovation', 'consulting', 'grounded',
  ] as const));
  validatePresent(parameters, 'pgsMode', (value) =>
    optionalEnum(value, 'pgsMode', ['full'] as const));
  for (const field of ['enablePGS', 'enableSynthesis', 'includeOutputs', 'includeThoughts',
    'includeCoordinatorInsights', 'allowActions']) {
    validatePresent(parameters, field, (value) => optionalBoolean(value, field));
  }

  if (hasOwn(parameters, 'priorContext')) {
    assertExactKeys(parameters.priorContext, ['query', 'answer'], 'priorContext', { requireAll: true });
    if (typeof parameters.priorContext.query !== 'string'
        || typeof parameters.priorContext.answer !== 'string'
        || parameters.priorContext.query.length + parameters.priorContext.answer.length > 20_000) {
      throw invalid('priorContext_invalid');
    }
  }
  if (hasOwn(parameters, 'pgsConfig')) {
    assertExactKeys(parameters.pgsConfig, ['sweepFraction'], 'pgsConfig');
    validatePresent(parameters.pgsConfig, 'sweepFraction', (value) =>
      optionalFiniteNumber(value, 'sweepFraction', 0, 1, { exclusiveMin: true }));
  }
  if (hasOwn(parameters, 'requestId')
      && (typeof parameters.requestId !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/.test(parameters.requestId))) {
    throw invalid('requestId_invalid');
  }
}

export interface BrainOperationsClientOptions {
  baseUrl: string;
  callerAgent: string;
  fetchImpl?: typeof fetch;
  inactivityMs?: number;
  connectMs?: number;
  statusReadMs?: number;
  resultReadMs?: number;
  shortWaitMs?: number;
  catalogTtlMs?: number;
  queryWaitMs?: number;
  pgsWaitMs?: number;
  reconnectDelayMs?: number;
  maxErrorBodyBytes?: number;
  attachmentIdFactory?: () => string;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  onActivity?: (activity: OperationActivity) => void;
}

export class BrainOperationsClient {
  private catalogCache: BrainCatalog | null = null;
  private catalogCachedAt = 0;

  constructor(private readonly options: BrainOperationsClientOptions) {}

  private get fetchImpl(): typeof fetch { return this.options.fetchImpl ?? fetch; }
  private get now(): () => number { return this.options.now ?? Date.now; }

  async getCatalog(options: { forceRefresh?: boolean; signal?: AbortSignal } = {}): Promise<BrainCatalog> {
    const ttl = this.options.catalogTtlMs ?? 30_000;
    if (this.catalogCache && !options.forceRefresh && this.now() - this.catalogCachedAt < ttl) {
      return this.catalogCache;
    }
    const value = await this.requestJson<BrainCatalog>('/home23/api/brain-operations/catalog', {}, {
      code: 'catalog_timeout', timeoutMs: this.options.statusReadMs ?? 10_000,
      signal: options.signal,
    });
    if (!value.catalogRevision || !Array.isArray(value.brains)) throw new Error('catalog_invalid');
    if (value.brains.length > 0) {
      this.catalogCache = value;
      this.catalogCachedAt = this.now();
    } else {
      this.invalidateCatalog();
    }
    return value;
  }

  private invalidateCatalog(): void {
    this.catalogCache = null;
    this.catalogCachedAt = 0;
  }

  async listNonterminal(signal?: AbortSignal): Promise<BrainNonterminalOperation[]> {
    const value = await this.requestJson<{ operations: BrainNonterminalOperation[] }>(
      '/home23/api/brain-operations?state=nonterminal', {},
      { code: 'status_timeout', timeoutMs: this.options.statusReadMs ?? 10_000, signal },
    );
    return Array.isArray(value.operations) ? value.operations : [];
  }

  async resolveTarget(target?: BrainTargetSelector): Promise<ResolvedBrainTarget> {
    if (target !== undefined) validateTargetSelector(target);
    const resolveFrom = (catalog: BrainCatalog): ResolvedBrainTarget => {
      const byAgent = (target?.agent || !target) ? catalog.brains.filter((brain) =>
        brain.kind === 'resident' && brain.ownerAgent === (target?.agent || this.options.callerAgent)) : [];
      const byId = target?.brainId ? catalog.brains.filter((brain) => brain.id === target.brainId) : [];
      const unique = (matches: BrainCatalogEntry[], missing: boolean): BrainCatalogEntry | null => {
        if (matches.length > 1) throw Object.assign(new Error('target_ambiguous'), { code: 'target_ambiguous' });
        if (missing && matches.length === 0) {
          throw Object.assign(new Error('target_not_found'), { code: 'target_not_found' });
        }
        return matches[0] || null;
      };
      const agentBrain = unique(byAgent, Boolean(target?.agent) || !target);
      const idBrain = unique(byId, Boolean(target?.brainId));
      if (agentBrain && idBrain && agentBrain.id !== idBrain.id) {
        throw Object.assign(new Error('target_mismatch'), { code: 'target_mismatch' });
      }
      const brain = idBrain || agentBrain;
      if (!brain) throw Object.assign(new Error('target_not_found'), { code: 'target_not_found' });
      const eligible = (brain.kind === 'resident' && brain.lifecycle === 'resident')
        || (brain.kind === 'research' && brain.lifecycle === 'completed');
      if (!eligible) {
        throw Object.assign(new Error('target_not_available'), { code: 'target_not_available' });
      }
      return {
        ...brain,
        accessMode: brain.kind === 'resident' && brain.ownerAgent === this.options.callerAgent
          ? 'own' : 'read-only',
        catalogRevision: catalog.catalogRevision,
      };
    };
    try {
      return resolveFrom(await this.getCatalog());
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (!['target_not_found', 'target_not_available', 'target_mismatch', 'target_ambiguous']
        .includes(code || '')) throw error;
      this.invalidateCatalog();
      return resolveFrom(await this.getCatalog({ forceRefresh: true }));
    }
  }

  withActivityHandler(onActivity: (activity: OperationActivity) => void): BrainOperationsClient {
    return new BrainOperationsClient({ ...this.options, onActivity });
  }

  async query(request: BrainQueryRequest, signal?: AbortSignal): Promise<BrainOperationResult> {
    const operationType = request.enablePGS === true ? 'pgs' : 'query';
    const { enablePGS: _routingOnly, ...parameters } = request;
    const waitMs = operationType === 'pgs'
      ? (this.options.pgsWaitMs ?? 6 * 60 * 60_000)
      : (this.options.queryWaitMs ?? 90 * 60_000);
    return this.runDurable(operationType, parameters, waitMs, signal);
  }

  async search(request: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.runShort('search', request, signal);
  }

  async graph(request: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.runShort('graph', request, signal);
  }

  async status(request: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.runShort('status', request, signal);
  }

  async watchResearch(request: {
    target: { runId: string }; after: number; limit?: number; filter?: string;
  }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.runShort('research_watch', request, signal);
  }

  async readIntelligence(
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.runShort('research_intelligence', request, signal);
  }

  async graphExport(request: Record<string, unknown>, signal?: AbortSignal): Promise<BrainOperationResult> {
    return this.runDurable('graph_export', request, this.options.queryWaitMs ?? 90 * 60_000, signal);
  }

  async synthesize(request: Record<string, unknown>, signal?: AbortSignal): Promise<BrainOperationResult> {
    return this.runDurable('synthesis', request, this.options.pgsWaitMs ?? 6 * 60 * 60_000, signal);
  }

  async synthesisStatus(
    request: { operationId?: string; generationMarker?: string },
    signal?: AbortSignal,
  ): Promise<SynthesisStateResponse | BrainOperationResult> {
    if (request.operationId) {
      const status = await this.getOperation(request.operationId, signal);
      if (status.operationType !== 'synthesis') {
        throw Object.assign(new Error('operation_type_mismatch'), { code: 'operation_type_mismatch' });
      }
      if (!TERMINAL.has(status.state)) return { ...status, attachmentState: 'detached' };
      return { ...status, ...(await this.getResult(request.operationId, signal)), attachmentState: 'closed' };
    }
    if (request.generationMarker !== undefined
        && (typeof request.generationMarker !== 'string' || !request.generationMarker.trim()
          || request.generationMarker.length > 256)) {
      throw Object.assign(new Error('generationMarker_invalid'), { code: 'invalid_request' });
    }
    const query = request.generationMarker
      ? `?generationMarker=${encodeURIComponent(request.generationMarker)}` : '';
    return this.requestJson<SynthesisStateResponse>(`/api/synthesis/state${query}`, {}, {
      code: 'synthesis_status_timeout', timeoutMs: this.options.statusReadMs ?? 10_000, signal,
    });
  }

  async reattachSynthesis(operationId: string, signal?: AbortSignal): Promise<BrainOperationResult> {
    const status = await this.getOperation(operationId, signal);
    if (status.operationType !== 'synthesis') {
      throw Object.assign(new Error('operation_type_mismatch'), { code: 'operation_type_mismatch' });
    }
    return this.resumeOperation(operationId, signal);
  }

  async compile(request: Record<string, unknown>, signal?: AbortSignal): Promise<BrainOperationResult> {
    return this.runDurable('research_compile', request, this.options.pgsWaitMs ?? 6 * 60 * 60_000, signal);
  }

  async stopResearch(
    request: { target: { runId: string } },
    signal?: AbortSignal,
  ): Promise<BrainOperationResult> {
    return this.runDurable('research_stop', request, this.options.pgsWaitMs ?? 6 * 60 * 60_000, signal);
  }

  async launchResearch(request: Record<string, unknown>, signal?: AbortSignal): Promise<BrainOperationResult> {
    return this.runDurable('research_launch', request, this.options.pgsWaitMs ?? 6 * 60 * 60_000, signal);
  }

  async continueResearch(request: {
    target: { runId: string }; context?: string; cycles?: number;
    primaryModel?: string; primaryProvider?: string;
  }, signal?: AbortSignal): Promise<BrainOperationResult> {
    return this.runDurable('research_continue', request, this.options.pgsWaitMs ?? 6 * 60 * 60_000, signal);
  }

  async exportAdHocResult(
    request: { query: string; answer: string; format: string; metadata?: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const operation = await this.runDurable(
      'ad_hoc_export', request, this.options.queryWaitMs ?? 90 * 60_000, signal,
    );
    return this.unwrap(operation);
  }

  private async runShort(
    operationType: string,
    parameters: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const started = await this.start(operationType, parameters, signal);
    return this.unwrap(await this.wait(started.operationId, {
      operationType, initial: started, signal,
      waitMs: this.options.shortWaitMs ?? 5 * 60_000,
    }));
  }

  private async runDurable(
    operationType: string,
    parameters: Record<string, unknown>,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<BrainOperationResult> {
    const started = await this.start(operationType, parameters, signal);
    return this.wait(started.operationId, { operationType, initial: started, signal, waitMs });
  }

  private unwrap(operation: BrainOperationResult): Record<string, unknown> {
    if (['failed', 'cancelled', 'interrupted'].includes(operation.state)) {
      throw Object.assign(new Error(operation.error?.message || operation.state), {
        code: operation.error?.code || 'brain_operation_failed', operation,
      });
    }
    return {
      ...(operation.result || {}),
      operationId: operation.operationId,
      state: operation.state,
      attachmentState: operation.attachmentState,
      resultHandle: operation.resultHandle,
      resultArtifact: operation.resultArtifact,
      sourceEvidence: operation.sourceEvidence,
    };
  }

  async start(
    operationType: string,
    parameters: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<BrainOperationRecord> {
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw invalid();
    if ('requesterAgent' in parameters || 'idempotencyKey' in parameters
        || 'canonicalRoot' in parameters || 'accessMode' in parameters) {
      throw new Error('authoritative_fields_forbidden');
    }
    validateCallerParameters(operationType, parameters);
    const requestId = hasOwn(parameters, 'requestId')
      ? parameters.requestId as string
      : randomUUID();
    const targetPresent = hasOwn(parameters, 'target');
    const target = targetPresent
      ? parameters.target as BrainTargetSelector | { runId: string }
      : undefined;
    const ownedRun = OWNED_RUN_OPERATION_TYPES.has(operationType);
    if (ownedRun) {
      const keys = target && typeof target === 'object' && !Array.isArray(target)
        ? Object.keys(target).sort() : [];
      const runId = (target as { runId?: unknown } | undefined)?.runId;
      if (keys.length !== 1 || keys[0] !== 'runId'
          || typeof runId !== 'string' || !IDENTIFIER.test(runId)) {
        throw Object.assign(new Error('owned_run_target_requires_exact_run_id'), { code: 'invalid_request' });
      }
    } else if (targetPresent) {
      await this.resolveTarget(validateTargetSelector(target));
    }
    const operationParameters = { ...parameters };
    delete operationParameters.requestId;
    delete operationParameters.target;
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationType,
        requestId,
        ...(target ? { target } : {}),
        parameters: operationParameters,
      }),
    };
    const deadline = {
      code: 'operation_start_timeout', timeoutMs: this.options.statusReadMs ?? 10_000, signal,
    };
    try {
      return await this.requestJson<BrainOperationRecord>('/home23/api/brain-operations', init, deadline);
    } catch (error) {
      const typed = error as { code?: string; httpStatus?: number };
      const code = typed.code;
      const lostResponse = error instanceof TypeError
        || ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'operation_start_timeout'].includes(code || '');
      if (lostResponse && !typed.httpStatus && !signal?.aborted) {
        return this.requestJson<BrainOperationRecord>('/home23/api/brain-operations', init, deadline);
      }
      const refreshable = ['target_not_found', 'target_not_available', 'target_mismatch',
        'target_ambiguous'].includes(code || '') || code === 'route_not_found';
      if (refreshable && !ownedRun) {
        this.invalidateCatalog();
        await this.resolveTarget(target as BrainTargetSelector | undefined);
        return this.requestJson<BrainOperationRecord>('/home23/api/brain-operations', init, deadline);
      }
      throw error;
    }
  }

  async wait(
    operationId: string,
    options: {
      operationType: string;
      initial: BrainOperationRecord;
      signal?: AbortSignal;
      waitMs: number;
    },
  ): Promise<BrainOperationResult> {
    const attachmentId = this.options.attachmentIdFactory?.() ?? randomUUID();
    const setTimer = this.options.setTimeout ?? setTimeout;
    const clearTimer = this.options.clearTimeout
      ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
    const deadlineController = new AbortController();
    const deadlineTimer = setTimer(() => deadlineController.abort(
      Object.assign(new Error('wait_deadline'), { code: 'wait_deadline' }),
    ), options.waitMs);
    const attachmentSignal = options.signal
      ? AbortSignal.any([options.signal, deadlineController.signal])
      : deadlineController.signal;
    let after = options.initial.eventSequence || 0;
    let last = options.initial;

    const detachLast = async (reason: string): Promise<BrainOperationResult> => {
      await this.detach(operationId, attachmentId, reason).catch(() => undefined);
      return { ...last, attachmentState: 'detached' };
    };
    const canonicalTerminal = async (status: BrainOperationRecord): Promise<BrainOperationResult> => {
      const payload = await this.getResult(operationId, options.signal?.aborted ? undefined : options.signal);
      return { ...status, ...payload, attachmentState: 'closed' };
    };
    const emitActivity = (
      event: BrainOperationNotification,
      status: BrainOperationRecord = last,
    ): void => {
      const eventPhase = event.phase !== undefined ? event.phase : status.phase;
      const eventUpdatedAt = event.updatedAt ?? event.at ?? status.updatedAt;
      const providerActivity = event.lastProviderActivityAt !== undefined
        ? event.lastProviderActivityAt
        : event.type === 'provider_activity' && event.at
          ? event.at
          : status.lastProviderActivityAt;
      this.options.onActivity?.({
        source: 'brain_operation',
        operationId,
        type: event.type,
        eventSequence: event.eventSequence,
        sequence: event.eventSequence,
        state: event.state ?? status.state,
        phase: eventPhase,
        updatedAt: eventUpdatedAt,
        lastProviderActivityAt: providerActivity,
      });
    };
    const pauseBeforeReconnect = (): Promise<void> => new Promise((resolve, reject) => {
      const delayMs = Math.max(1, this.options.reconnectDelayMs ?? 250);
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        attachmentSignal.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => finish(() => reject(attachmentSignal.reason));
      const timer = setTimer(() => finish(resolve), delayMs);
      if (attachmentSignal.aborted) { onAbort(); return; }
      attachmentSignal.addEventListener('abort', onAbort, { once: true });
    });
    const handleAbort = async (): Promise<BrainOperationResult> => {
      let status: BrainOperationRecord | null = null;
      try {
        status = await this.getOperation(operationId);
        last = status;
      } catch {
        // Detach/cancel endpoints perform their own authoritative compare-and-swap.
      }
      if (status && TERMINAL.has(status.state)) return canonicalTerminal(status);
      const reason = attachmentSignal.reason as { code?: string; message?: string } | undefined;
      const code = reason?.code || reason?.message || 'transport_disconnect';
      if (code === 'operator_stop' || !DURABLE_OPERATION_TYPES.has(options.operationType)) {
        const cancelled = await this.cancel(operationId);
        if (TERMINAL.has(cancelled.state)) return canonicalTerminal(cancelled);
        last = cancelled;
        return detachLast('cancel_not_terminal');
      }
      return detachLast(code === 'wait_deadline' ? 'wait_deadline' : 'transport_disconnect');
    };
    const statusOrDetach = async (
      reason: string,
      retainedAtLeast = after,
      activityEvent?: BrainOperationNotification,
    ): Promise<BrainOperationResult | null> => {
      const priorCursor = after;
      let status: BrainOperationRecord;
      try {
        status = await this.getOperation(operationId, attachmentSignal);
      } catch {
        if (attachmentSignal.aborted) return handleAbort();
        return detachLast(reason);
      }
      if (!Number.isSafeInteger(status.eventSequence)
          || status.eventSequence < retainedAtLeast
          || status.eventSequence < priorCursor) {
        return detachLast(reason === 'event_gap'
          ? 'operation_event_gap_invalid' : 'operation_status_regressed');
      }
      last = status;
      after = status.eventSequence;
      if (activityEvent) emitActivity(activityEvent, status);
      if (TERMINAL.has(status.state)) return canonicalTerminal(status);
      if (after === priorCursor) {
        try {
          await pauseBeforeReconnect();
        } catch {
          if (attachmentSignal.aborted) return handleAbort();
          throw new Error('operation_reconnect_pause_failed');
        }
      }
      return null;
    };

    try {
      if (TERMINAL.has(last.state)) return canonicalTerminal(last);
      while (true) {
        if (attachmentSignal.aborted) return handleAbort();
        let response: Response;
        try {
          response = await this.requestResponse(
            `/home23/api/brain-operations/${encodeURIComponent(operationId)}/events?after=${after}&attachmentId=${encodeURIComponent(attachmentId)}`,
            {}, {
              code: 'operation_connect_timeout',
              timeoutMs: this.options.connectMs ?? 10_000,
              signal: attachmentSignal,
            },
          );
          if (!response.ok) {
            await this.throwHttpError(response, {
              code: 'operation_connect_timeout',
              timeoutMs: this.options.connectMs ?? 10_000,
              signal: attachmentSignal,
            });
          }
        } catch (error) {
          if (attachmentSignal.aborted) return handleAbort();
          if ((error as { code?: string }).code === 'event_gap') {
            let gap: BrainOperationEventGap;
            try { gap = validateEventGap(operationId, after, error as { details?: unknown }); }
            catch { return detachLast('operation_event_gap_invalid'); }
            const terminalOrDetached = await statusOrDetach('event_gap', gap.latestSequence);
            if (terminalOrDetached) return terminalOrDetached;
            continue;
          }
          const typed = error as { code?: string; httpStatus?: number };
          const recoverable = !typed.httpStatus || typed.httpStatus >= 500
            || ['operation_connect_timeout', 'source_unavailable'].includes(typed.code || '');
          if (!recoverable) return detachLast(typed.code || 'event_transport_error');
          const terminalOrDetached = await statusOrDetach('connect_or_header_timeout');
          if (terminalOrDetached) return terminalOrDetached;
          continue;
        }

        let recoveryEvent: BrainOperationEventGap | BrainOperationNotification | null = null;
        let streamError: unknown = null;
        try {
          if (!response.body) throw new Error('operation_event_body_missing');
          for await (const event of parseOperationEvents(response.body, operationId, after, {
            signal: attachmentSignal,
            inactivityMs: this.options.inactivityMs ?? 60_000,
            setTimeout: this.options.setTimeout,
            clearTimeout: this.options.clearTimeout,
          })) {
            if (operationEventIsGap(event)) {
              recoveryEvent = event;
              break;
            }
            after = event.eventSequence;
            if (event.type === 'terminal' || (event.state !== undefined && TERMINAL.has(event.state))) {
              recoveryEvent = event;
              break;
            }
            emitActivity(event);
          }
        } catch (error) {
          streamError = error;
        }

        if (recoveryEvent) {
          let bodyCloseFailed = false;
          try {
            await response.body?.cancel(
              operationEventIsGap(recoveryEvent) ? 'event_gap_reconnect' : 'terminal_status_refresh',
            );
          } catch {
            bodyCloseFailed = true;
          }
          if (bodyCloseFailed && operationEventIsGap(recoveryEvent)) {
            return detachLast('event_body_close_failed');
          }
          if (operationEventIsGap(recoveryEvent)) {
            try {
              await this.detach(operationId, attachmentId, 'event_gap_reconnect');
            } catch (error) {
              if ((error as { code?: string }).code !== 'attachment_closed') throw error;
            }
          }
          const terminalOrDetached = operationEventIsGap(recoveryEvent)
            ? await statusOrDetach('event_gap', recoveryEvent.latestSequence)
            : await statusOrDetach('terminal_notification', after, recoveryEvent);
          if (terminalOrDetached) return terminalOrDetached;
          continue;
        }

        if (streamError) {
          if (attachmentSignal.aborted) return handleAbort();
          const code = (streamError as { code?: string }).code;
          const message = streamError instanceof Error ? streamError.message : String(streamError);
          if (['operation_event_gap_invalid', 'operation_event_mismatch',
            'operation_event_out_of_order', 'operation_event_invalid'].includes(code || message)) {
            return detachLast(code || message);
          }
          const terminalOrDetached = await statusOrDetach(
            code === 'operation_event_inactive' ? 'status_read_timeout' : 'event_transport_error',
          );
          if (terminalOrDetached) return terminalOrDetached;
          continue;
        }

        const terminalOrDetached = await statusOrDetach('event_eof');
        if (terminalOrDetached) return terminalOrDetached;
      }
    } finally {
      clearTimer(deadlineTimer);
    }
  }

  async getOperation(operationId: string, signal?: AbortSignal): Promise<BrainOperationRecord> {
    return this.requestJson<BrainOperationRecord>(
      `/home23/api/brain-operations/${encodeURIComponent(operationId)}`, {},
      { code: 'status_timeout', timeoutMs: this.options.statusReadMs ?? 10_000, signal },
    );
  }

  async getResult(operationId: string, signal?: AbortSignal): Promise<BrainOperationResultEnvelope> {
    return this.requestJson<BrainOperationResultEnvelope>(
      `/home23/api/brain-operations/${encodeURIComponent(operationId)}/result`, {},
      { code: 'result_timeout', timeoutMs: this.options.resultReadMs ?? 10_000, signal },
    );
  }

  async resumeOperation(operationId: string, signal?: AbortSignal): Promise<BrainOperationResult> {
    const initial = await this.getOperation(operationId, signal);
    if (TERMINAL.has(initial.state)) {
      const payload = await this.getResult(operationId, signal);
      return { ...initial, ...payload, attachmentState: 'closed' };
    }
    const sixHour = new Set([
      'pgs', 'synthesis', 'research_compile', 'research_stop',
      'research_launch', 'research_continue', 'research_watch',
    ]).has(initial.operationType);
    const ninetyMinute = new Set(['query', 'graph_export', 'ad_hoc_export'])
      .has(initial.operationType);
    const waitMs = sixHour
      ? (this.options.pgsWaitMs ?? 6 * 60 * 60_000)
      : ninetyMinute
        ? (this.options.queryWaitMs ?? 90 * 60_000)
        : (this.options.shortWaitMs ?? 5 * 60_000);
    return this.wait(operationId, { operationType: initial.operationType, waitMs, initial, signal });
  }

  async inspectOperation(
    operationId: string,
    action: 'status' | 'result' | 'cancel',
    signal?: AbortSignal,
  ): Promise<BrainOperationRecord | BrainOperationResult> {
    if (!OPERATION_ID.test(operationId)) throw new Error('operation_id_invalid');
    if (action === 'status') return this.getOperation(operationId, signal);
    if (action === 'result') {
      const status = await this.getOperation(operationId, signal);
      const payload = await this.getResult(operationId, signal);
      return { ...status, ...payload, attachmentState: 'closed' };
    }
    const cancelled = await this.cancel(operationId, signal);
    if (!TERMINAL.has(cancelled.state)) return cancelled;
    const payload = await this.getResult(operationId, signal);
    return { ...cancelled, ...payload, attachmentState: 'closed' };
  }

  async detach(
    operationId: string,
    attachmentId: string,
    reason: string,
    signal?: AbortSignal,
  ): Promise<BrainOperationRecord> {
    return this.requestJson<BrainOperationRecord>(
      `/home23/api/brain-operations/${encodeURIComponent(operationId)}/detach`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attachmentId, reason }),
      }, { code: 'detach_timeout', timeoutMs: this.options.statusReadMs ?? 10_000, signal },
    );
  }

  async cancel(operationId: string, signal?: AbortSignal): Promise<BrainOperationRecord> {
    return this.requestJson<BrainOperationRecord>(
      `/home23/api/brain-operations/${encodeURIComponent(operationId)}/cancel`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
      { code: 'cancel_timeout', timeoutMs: this.options.statusReadMs ?? 10_000, signal },
    );
  }

  async exportResult(
    request: {
      operationId: string;
      resultHandle?: string;
      format: string;
      fileName?: string;
    },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if ('answer' in request || !request.operationId) {
      throw new Error('canonical_export_requires_operation_id');
    }
    const keys = Reflect.ownKeys(request);
    if (keys.some((key) => typeof key !== 'string'
        || !['operationId', 'resultHandle', 'format', 'fileName'].includes(key))) {
      throw invalid();
    }
    if (typeof request.format !== 'string' || !request.format
        || (request.fileName !== undefined
          && (typeof request.fileName !== 'string' || !request.fileName))) {
      throw invalid();
    }
    const { operationId, resultHandle: _descriptiveOnly, format, fileName } = request;
    return this.requestJson<Record<string, unknown>>(
      `/home23/api/brain-operations/${encodeURIComponent(operationId)}/export`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ format, ...(fileName !== undefined ? { fileName } : {}) }),
      }, { code: 'export_timeout', timeoutMs: this.options.resultReadMs ?? 10_000, signal },
    );
  }

  private async requestResponse(
    pathname: string,
    init: RequestInit,
    deadline: { code: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<Response> {
    return this.withDeadline(deadline, (signal) => this.fetchImpl(
      `${this.options.baseUrl}${pathname}`, { ...init, signal },
    ));
  }

  private async requestJson<T>(
    pathname: string,
    init: RequestInit,
    deadline: { code: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<T> {
    const response = await this.requestResponse(pathname, init, deadline);
    if (!response.ok) await this.throwHttpError(response, deadline);
    let text: string;
    try {
      text = await this.withDeadline(deadline, () => response.text());
    } catch (error) {
      await response.body?.cancel(error).catch(() => undefined);
      throw error;
    }
    let body: (T & { success?: boolean;
      error?: { code?: string; message?: string; retryable?: boolean } }) | null;
    try {
      body = text ? JSON.parse(text) as typeof body : null;
    } catch (error) {
      throw Object.assign(new Error('brain_operation_error'), {
        code: 'brain_operation_error', cause: error,
      });
    }
    const operationId = (body as unknown as { operationId?: unknown } | null)?.operationId;
    if (!body || body.success === false
        || ('error' in body && body.error && !operationId)) {
      throw Object.assign(new Error(body?.error?.message || 'brain_operation_error'), {
        code: body?.error?.code || 'brain_operation_error',
        retryable: body?.error?.retryable === true,
      });
    }
    return body;
  }

  private async throwHttpError(
    response: Response,
    deadline: { code: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<never> {
    let text: string;
    try {
      text = await this.withDeadline({ ...deadline, code: 'error_body_timeout' }, async (signal) => {
        if (!response.body) return '';
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        const cancelBlockedRead = () => { void reader.cancel(signal.reason).catch(() => undefined); };
        signal.addEventListener('abort', cancelBlockedRead, { once: true });
        try {
          while (true) {
            if (signal.aborted) throw signal.reason;
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > (this.options.maxErrorBodyBytes ?? MAX_ERROR_BODY_BYTES)) {
              await reader.cancel('error_body_too_large').catch(() => undefined);
              throw Object.assign(new Error('error_body_too_large'), {
                code: 'error_body_too_large', httpStatus: response.status,
              });
            }
            chunks.push(value);
          }
          return new TextDecoder().decode(Buffer.concat(
            chunks.map((chunk) => Buffer.from(chunk)),
          ));
        } finally {
          signal.removeEventListener('abort', cancelBlockedRead);
          reader.releaseLock();
        }
      });
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        code: (error as { code?: string }).code || 'error_body_timeout',
        httpStatus: response.status,
        retryable: response.status >= 500,
      });
    }
    let envelope: {
      error?: { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown };
    } = {};
    try { envelope = text ? JSON.parse(text) : {}; } catch { /* bounded fallback */ }
    const error = envelope.error;
    const code = typeof error?.code === 'string' && error.code
      ? error.code : response.status === 404 ? 'route_not_found' : 'source_unavailable';
    const message = typeof error?.message === 'string' && error.message
      ? error.message : `HTTP ${response.status}${text ? `: ${text.slice(0, 512)}` : ''}`;
    throw Object.assign(new Error(message), {
      code,
      httpStatus: response.status,
      retryable: typeof error?.retryable === 'boolean' ? error.retryable : response.status >= 500,
      details: error?.details,
    });
  }

  private withDeadline<T>(
    deadline: { code: string; timeoutMs: number; signal?: AbortSignal },
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const setTimer = this.options.setTimeout ?? setTimeout;
    const clearTimer = this.options.clearTimeout
      ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
    const controller = new AbortController();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        deadline.signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => {
        const reason = deadline.signal?.reason
          ?? Object.assign(new Error('aborted'), { code: 'aborted' });
        controller.abort(reason);
        finish(() => reject(reason));
      };
      const timer = setTimer(() => {
        const error = Object.assign(new Error(deadline.code), { code: deadline.code });
        controller.abort(error);
        finish(() => reject(error));
      }, deadline.timeoutMs);
      if (deadline.signal?.aborted) { onAbort(); return; }
      deadline.signal?.addEventListener('abort', onAbort, { once: true });
      run(controller.signal).then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  }
}
