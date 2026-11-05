import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import type { BrainOperationsClient } from '../../../src/agent/brain-operations/client.js';
import type {
  BrainCatalogEntry,
  BrainOperationResult,
} from '../../../src/agent/brain-operations/types.js';
import type { ToolContext } from '../../../src/agent/types.js';
import {
  checkCosmoActiveRun,
  compileBrainTool,
  compileSectionTool,
  continueRunTool,
  getBrainGraphTool,
  getBrainSummaryTool,
  launchTool,
  listBrainsTool,
  listResearchRunsTool,
  queryBrainTool,
  searchAllBrainsTool,
  stopRunTool,
  watchRunTool,
} from '../../../src/agent/tools/research.js';
import {
  canonicalResearchTarget,
  makeBrainOperationRecord,
} from '../../helpers/brain-operation-record.js';

type BrainClientStub = Record<string, (...args: any[]) => any>;
type ContextOverrides = Omit<Partial<ToolContext>, 'brainOperations' | 'turnRuntime'> & {
  brainOperations?: BrainClientStub;
  turnAbortController?: AbortController;
};

const PGS_PAIRS = Object.freeze({
  pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
  pgsSynth: { provider: 'anthropic', model: 'claude-sonnet-4-7' },
});
const CONTINUE_OPERATION_ID = 'brop_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

function schemaAccepts(schema: Record<string, unknown>, value: unknown): boolean {
  return new Ajv({ strict: false }).compile(schema)(value) as boolean;
}

function pgsQuery(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    query: 'pgs',
    enablePGS: true,
    pgsMode: 'fresh',
    pgsLevel: 'full',
    ...PGS_PAIRS,
    ...extra,
  };
}

let startupSentinelCalls = 0;

function makeCtx(overrides: ContextOverrides = {}): ToolContext {
  const {
    brainOperations = {},
    turnAbortController = new AbortController(),
    ...contextOverrides
  } = overrides;
  const runtimeStubs = { ...brainOperations };
  if (!runtimeStubs.launchQuery && runtimeStubs.query) {
    runtimeStubs.launchQuery = runtimeStubs.query;
  }
  const startupSentinel = new Proxy({}, {
    get: (_target, key) => () => {
      startupSentinelCalls += 1;
      throw new Error(`startup_global_client_used:${String(key)}`);
    },
  }) as BrainOperationsClient;
  const runtimeClient = new Proxy(runtimeStubs, {
    get: (target, key) => {
      if (typeof key === 'string' && key in target) return target[key];
      return () => { throw new Error(`unexpected_brain_client_call:${String(key)}`); };
    },
  }) as unknown as BrainOperationsClient;
  return {
    scheduler: null,
    ttsService: null,
    browser: null,
    projectRoot: '/fake',
    enginePort: 5002,
    agentName: 'jerry',
    cosmo23BaseUrl: 'http://localhost:43210',
    brainRoute: null,
    workspacePath: '/fake/instances/jerry/workspace',
    tempDir: '/tmp',
    contextManager: {
      getSystemPrompt: () => '',
      getPromptSourceInfo: () => ({ generatedAt: '', totalSections: 0, loadedFiles: [] }),
      invalidate: () => {},
    },
    subAgentTracker: { active: 0, maxConcurrent: 3, queue: [] },
    chatId: 'chat-fixture',
    telegramAdapter: null,
    runAgentLoop: null,
    brainOperations: startupSentinel,
    turnRuntime: {
      turnId: 'turn-fixture',
      abortController: turnAbortController,
      signal: turnAbortController.signal,
      brainOperations: runtimeClient,
      onOperationActivity: () => {},
    },
    ...contextOverrides,
  };
}

function canonicalResearch(id: string, displayName: string): BrainCatalogEntry {
  return {
    id,
    displayName,
    ownerAgent: 'jerry',
    kind: 'research',
    lifecycle: 'completed',
    canonicalRoot: `/tmp/${id}`,
    sourceType: 'local',
    nodeCount: 10,
    modifiedAt: '2026-07-09T12:00:00.000Z',
    route: `/api/brain/${id}`,
    mutationBoundaries: [
      { kind: 'brain', path: `/tmp/${id}` },
      { kind: 'run', path: `/tmp/${id}` },
      { kind: 'pgs', path: `/tmp/${id}/pgs-sessions` },
      { kind: 'session', path: `/tmp/${id}/sessions` },
      { kind: 'cache', path: `/tmp/${id}/cache` },
      { kind: 'export', path: `/tmp/${id}/exports` },
      { kind: 'agency', path: `/tmp/${id}/agency` },
    ],
  };
}

function completeOperation(
  operationId: string,
  answer: string,
  extraResult: Record<string, unknown> = {},
): BrainOperationResult {
  return {
    ...makeBrainOperationRecord({
      operationId,
      state: 'complete',
      phase: 'done',
      target: canonicalResearchTarget('brain-r1'),
      result: { answer, ...extraResult },
      resultHandle: 'brres_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches' },
    }),
    attachmentState: 'closed',
  };
}

function failedOperation(operationId: string, code: string): BrainOperationResult {
  return {
    ...completeOperation(operationId, ''),
    state: 'failed',
    result: null,
    resultHandle: null,
    error: { code, message: `${code} fixture`, retryable: true },
    sourceEvidence: { sourceHealth: 'unavailable', matchOutcome: 'unknown' },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('research_list_brains renders canonical catalog fields through the turn client', async () => {
  startupSentinelCalls = 0;
  const result = await listBrainsTool.execute({}, makeCtx({ brainOperations: {
    getCatalog: async () => ({ catalogRevision: 'catalog-7', brains: [{
      ...canonicalResearch('brain-r1', 'Research One'), nodeCount: 42,
    }] }),
  } }));
  assert.match(result.content, /Research One/);
  assert.match(result.content, /42 nodes/);
  assert.match(result.content, /completed/);
  assert.match(result.content, /catalog-7/);
  assert.equal(startupSentinelCalls, 0);
});

test('research_runs_list exposes authoritative run IDs and state for watch continue and stop', async () => {
  let received: unknown = null;
  const result = await listResearchRunsTool.execute({ state: 'active', limit: 10 }, makeCtx({
    brainOperations: {
      listResearchRuns: async (options: unknown) => {
        received = options;
        return { state: 'active', count: 1, runs: [{
          runId: 'run-1', state: 'active', topic: 'topic', continuable: false, stoppable: true,
        }] };
      },
    },
  }));
  assert.match(result.content, /run-1/);
  assert.match(result.content, /active/);
  assert.equal((received as { state: string }).state, 'active');
  assert.equal((received as { limit: number }).limit, 10);
  assert.ok((received as { signal: AbortSignal }).signal instanceof AbortSignal);
});

test('research_list_brains retains resident brains when reference rows are excluded', async () => {
  const resident = {
    ...canonicalResearch('brain-jerry', 'Jerry'), kind: 'resident' as const,
    lifecycle: 'resident' as const, sourceType: 'brain',
  };
  const result = await listBrainsTool.execute({ includeReferences: false }, makeCtx({
    brainOperations: {
      getCatalog: async () => ({ catalogRevision: 'catalog-residents', brains: [
        resident,
        { ...canonicalResearch('research-local', 'Local Research'), sourceType: 'local' },
        { ...canonicalResearch('research-reference', 'Reference Research'), sourceType: 'reference' },
      ] }),
    },
  }));
  assert.match(result.content, /Jerry/);
  assert.match(result.content, /Local Research/);
  assert.doesNotMatch(result.content, /Reference Research/);
});

test('research_search_all_brains reports one outcome per target and never hides failures', async () => {
  const ctx = makeCtx({ brainOperations: {
    getCatalog: async () => ({ catalogRevision: 'c1', brains: [
      canonicalResearch('brain-a', 'A'), canonicalResearch('brain-b', 'B'),
    ] }),
    query: async (request: Record<string, unknown>) => {
      const target = request.target as { brainId?: string } | undefined;
      return target?.brainId === 'brain-a'
        ? completeOperation('op-a', 'A found evidence')
        : failedOperation('op-b', 'provider_failed');
    },
  } });
  const result = await searchAllBrainsTool.execute({ query: 'evidence', topN: 2 }, ctx);
  assert.match(result.content, /A found evidence/);
  assert.match(result.content, /brain-b.*provider_failed/is);
  assert.match(result.content, /partial/i);
  assert.doesNotMatch(result.content, /no relevant findings/i);
  const outcomes = result.metadata?.outcomes as Array<Record<string, unknown>>;
  assert.equal(outcomes[0]?.operationId, 'op-a');
  assert.equal(outcomes[0]?.resultHandle, 'brres_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(outcomes[0]?.catalogRevision, 'c1');
  assert.deepEqual(outcomes[0]?.sourceEvidence, {
    sourceHealth: 'healthy', matchOutcome: 'matches',
  });
});

test('research_search_all_brains reports detached running work as in_progress', async () => {
  const ctx = makeCtx({ brainOperations: {
    getCatalog: async () => ({ catalogRevision: 'c-running', brains: [
      canonicalResearch('brain-a', 'A'), canonicalResearch('brain-b', 'B'),
    ] }),
    query: async (request: Record<string, unknown>) => {
      const brainId = (request.target as { brainId: string }).brainId;
      const operation = completeOperation(`op-${brainId}`, '');
      operation.state = 'running';
      operation.attachmentState = 'detached';
      operation.result = null;
      operation.resultHandle = null;
      operation.resultArtifact = null;
      return operation;
    },
  } });
  const result = await searchAllBrainsTool.execute({ query: 'evidence', topN: 2 }, ctx);
  assert.equal(result.is_error, undefined);
  assert.equal(result.metadata?.aggregate, 'in_progress');
  assert.match(result.content, /^in_progress/m);
  assert.doesNotMatch(result.content, /all_failed/);
  const outcomes = result.metadata?.outcomes as Array<Record<string, unknown>>;
  assert.equal(outcomes.every((outcome) => outcome.state === 'running'), true);
  assert.equal(outcomes.every((outcome) => outcome.operationId), true);
});

test('research query reuses the shared direct-query partial classifier', async () => {
  const valid = completeOperation('op-research-partial', 'useful research answer');
  valid.operationType = 'query';
  valid.state = 'partial';
  valid.error = { code: 'provider_incomplete', message: 'ended early', retryable: true };
  const ctx = makeCtx({ brainOperations: { query: async () => valid } });
  const useful = await queryBrainTool.execute({ brainId: 'brain-r1', query: 'x' }, ctx);
  assert.equal(useful.is_error, undefined);
  assert.equal(useful.metadata?.classification, 'useful_partial');
  assert.match(useful.content, /useful research answer/);
  assert.match(useful.content, /provider_incomplete/);
  valid.result = { answer: '' };
  const invalid = await queryBrainTool.execute({ brainId: 'brain-r1', query: 'x' }, ctx);
  assert.equal(invalid.is_error, true);
  assert.equal(invalid.metadata?.classification, 'invalid_partial_result');
});

test('research query separates direct and approved named PGS parameters and rejects present-null pairs', async () => {
  const requests: Record<string, unknown>[] = [];
  const ctx = makeCtx({ brainOperations: { query: async (request: Record<string, unknown>) => {
    requests.push(request);
    return completeOperation('op-query-shape', 'ok');
  } } });
  await queryBrainTool.execute({ brainId: 'brain-r1', query: 'direct' }, ctx);
  assert.deepEqual(requests[0], {
    target: { brainId: 'brain-r1' }, query: 'direct', mode: 'quick', enablePGS: false,
  });
  await queryBrainTool.execute({ brainId: 'brain-r1', ...pgsQuery() }, ctx);
  assert.deepEqual(requests[1], {
    target: { brainId: 'brain-r1' }, query: 'pgs', enablePGS: true,
    pgsMode: 'fresh', pgsLevel: 'full', ...PGS_PAIRS,
  });
  for (const input of [
    { brainId: 'brain-r1', query: 'x', modelSelection: null },
    { brainId: 'brain-r1', ...pgsQuery({ pgsSweep: null }) },
    { brainId: 'brain-r1', ...pgsQuery({ pgsSynth: null }) },
    { brainId: 'brain-r1', ...pgsQuery({ pgsConfig: { sweepFraction: 1 } }) },
  ]) {
    const before = requests.length;
    const result = await queryBrainTool.execute(input, ctx);
    assert.equal(result.is_error, true);
    assert.equal(requests.length, before);
  }
});

test('research_query_brain launches PGS detached instead of holding the agent turn', async () => {
  const launched: Record<string, unknown>[] = [];
  let attachedCalls = 0;
  const operation = completeOperation('brop_RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR', '');
  operation.operationType = 'pgs';
  operation.state = 'running';
  operation.attachmentState = 'detached';
  operation.result = null;
  operation.resultHandle = null;
  const result = await queryBrainTool.execute({
    brainId: 'brain-r1', query: 'background research PGS', enablePGS: true,
    pgsMode: 'fresh', pgsLevel: 'skim',
    pgsSweep: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
    pgsSynth: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
  }, makeCtx({ brainOperations: {
    launchQuery: async (request: Record<string, unknown>) => {
      launched.push(request);
      return operation;
    },
    query: async () => { attachedCalls += 1; return operation; },
  } }));

  assert.equal(launched.length, 1);
  assert.equal(attachedCalls, 0);
  assert.match(result.content, /running/i);
  assert.match(result.content, /brain_status.*status/i);
});

test('research_query_brain accepts every PGS mode and level including targeted continuation', async () => {
  const requests: Record<string, unknown>[] = [];
  const ctx = makeCtx({ brainOperations: { query: async (request: Record<string, unknown>) => {
    requests.push(request);
    const operation = completeOperation(`op-research-pgs-${requests.length}`, 'ok');
    operation.operationType = 'pgs';
    return operation;
  } } });
  for (const pgsMode of ['fresh', 'continue', 'targeted'] as const) {
    for (const pgsLevel of ['skim', 'sample', 'deep', 'full'] as const) {
      const modeFields = pgsMode === 'continue'
        ? { continueFromOperationId: CONTINUE_OPERATION_ID }
        : pgsMode === 'targeted'
          ? { targetPartitionIds: ['c-alpha', 'h-beta'] }
          : {};
      const result = await queryBrainTool.execute({
        brainId: 'brain-r1', ...pgsQuery({ pgsMode, pgsLevel, ...modeFields }),
      }, ctx);
      assert.equal(result.is_error, undefined, `${pgsMode}/${pgsLevel}`);
    }
  }
  const targetedContinuation = await queryBrainTool.execute({
    brainId: 'brain-r1',
    ...pgsQuery({
      pgsMode: 'targeted', pgsLevel: 'sample',
      continueFromOperationId: CONTINUE_OPERATION_ID,
      targetPartitionIds: ['h-beta', 'c-alpha'],
    }),
  }, ctx);
  assert.equal(targetedContinuation.is_error, undefined);
  assert.deepEqual(requests.at(-1), {
    target: { brainId: 'brain-r1' }, query: 'pgs', enablePGS: true,
    pgsMode: 'targeted', pgsLevel: 'sample',
    continueFromOperationId: CONTINUE_OPERATION_ID,
    targetPartitionIds: ['h-beta', 'c-alpha'],
    ...PGS_PAIRS,
  });
  assert.equal(requests.every((request) => !Object.hasOwn(request, 'pgsConfig')), true);
});

test('research query tools reject incomplete, mixed, legacy, or noncanonical PGS requests', async () => {
  let queryCalls = 0;
  const ctx = makeCtx({ brainOperations: {
    getCatalog: async () => ({ catalogRevision: 'invalid-pgs', brains: [
      canonicalResearch('brain-r1', 'R1'),
    ] }),
    query: async () => {
      queryCalls += 1;
      return completeOperation('op-invalid-research-pgs', 'unexpected');
    },
  } });
  const tooManyTargets = Array.from({ length: 257 }, (_, index) => `h-${index}`);
  const invalidParameters = [
    { query: 'x', enablePGS: true },
    pgsQuery({ pgsMode: undefined }),
    pgsQuery({ pgsLevel: undefined }),
    pgsQuery({ pgsSweep: undefined }),
    pgsQuery({ pgsSynth: undefined }),
    pgsQuery({ pgsMode: 'full' }),
    pgsQuery({ pgsLevel: 'quarter' }),
    pgsQuery({ pgsConfig: { sweepFraction: 0.25 } }),
    pgsQuery({ mode: 'quick' }),
    pgsQuery({ pgsMode: 'fresh', continueFromOperationId: CONTINUE_OPERATION_ID }),
    pgsQuery({ pgsMode: 'fresh', targetPartitionIds: ['c-alpha'] }),
    pgsQuery({ pgsMode: 'continue' }),
    pgsQuery({ pgsMode: 'continue', continueFromOperationId: 'brop_short' }),
    pgsQuery({ pgsMode: 'continue', continueFromOperationId: CONTINUE_OPERATION_ID,
      targetPartitionIds: ['c-alpha'] }),
    pgsQuery({ pgsMode: 'targeted' }),
    pgsQuery({ pgsMode: 'targeted', targetPartitionIds: [] }),
    pgsQuery({ pgsMode: 'targeted', targetPartitionIds: ['alpha'] }),
    pgsQuery({ pgsMode: 'targeted', targetPartitionIds: ['c-alpha', 'c-alpha'] }),
    pgsQuery({ pgsMode: 'targeted', targetPartitionIds: tooManyTargets }),
    { query: 'x', pgsMode: 'fresh' },
    { query: 'x', pgsLevel: 'full' },
    { query: 'x', continueFromOperationId: CONTINUE_OPERATION_ID },
    { query: 'x', targetPartitionIds: ['c-alpha'] },
  ];
  for (const parameters of invalidParameters) {
    for (const [tool, input] of [
      [queryBrainTool, { brainId: 'brain-r1', ...parameters }],
      [searchAllBrainsTool, { topN: 1, ...parameters }],
    ] as const) {
      const result = await tool.execute(input, ctx);
      assert.equal(result.is_error, true, `${tool.name}: ${JSON.stringify(input)}`);
      assert.match(result.content, /invalid_request|invalid/i);
    }
  }
  assert.equal(queryCalls, 0);
});

test('research query schema exposes provider-safe fields while runtime owns direct and PGS cross-field rules', () => {
  const querySchema = queryBrainTool.input_schema as any;
  assert.equal('pgsConfig' in querySchema.properties, false);
  assert.deepEqual(querySchema.properties.pgsMode.enum, ['fresh', 'continue', 'targeted']);
  assert.deepEqual(querySchema.properties.pgsLevel.enum, ['skim', 'sample', 'deep', 'full']);
  assert.equal(querySchema.properties.continueFromOperationId.pattern, '^brop_[A-Za-z0-9_-]{32}$');
  assert.equal(querySchema.properties.targetPartitionIds.uniqueItems, true);
  assert.equal(querySchema.properties.targetPartitionIds.maxItems, 256);
  for (const value of [
    { brainId: 'brain-r1', query: 'direct' },
    { brainId: 'brain-r1', query: 'direct', modelSelection: PGS_PAIRS.pgsSweep },
    { brainId: 'brain-r1', ...pgsQuery() },
    { brainId: 'brain-r1', ...pgsQuery({ pgsMode: 'continue',
      continueFromOperationId: CONTINUE_OPERATION_ID }) },
    { brainId: 'brain-r1', ...pgsQuery({ pgsMode: 'targeted',
      targetPartitionIds: ['c-alpha'] }) },
  ]) assert.equal(schemaAccepts(querySchema, value), true, JSON.stringify(value));
  for (const value of [
    { brainId: 'brain-r1', ...pgsQuery({ mode: 'quick' }) },
    { brainId: 'brain-r1', ...pgsQuery({ modelSelection: PGS_PAIRS.pgsSweep }) },
    { brainId: 'brain-r1', query: 'direct', pgsMode: 'fresh' },
  ]) assert.equal(schemaAccepts(querySchema, value), true, JSON.stringify(value));

  const searchSchema = searchAllBrainsTool.input_schema as any;
  for (const key of ['enablePGS', 'pgsMode', 'pgsLevel', 'continueFromOperationId',
    'targetPartitionIds', 'pgsSweep', 'pgsSynth']) {
    assert.equal(key in searchSchema.properties, false, key);
  }
});

test('search-all forwards Direct Query and rejects fresh, continue, and targeted PGS', async () => {
  const requests: Record<string, unknown>[] = [];
  const ctx = makeCtx({ brainOperations: {
    getCatalog: async () => ({ catalogRevision: 'pair-catalog', brains: [
      canonicalResearch('brain-a', 'A'), canonicalResearch('brain-b', 'B'),
    ] }),
    query: async (request: Record<string, unknown>) => {
      requests.push(request);
      return completeOperation(`op-${requests.length}`, 'ok');
    },
  } });
  for (const input of [
    { ...pgsQuery({ query: 'fresh' }), topN: 2 },
    { ...pgsQuery({ query: 'continue', pgsMode: 'continue',
      continueFromOperationId: CONTINUE_OPERATION_ID }), topN: 2 },
    { ...pgsQuery({ query: 'targeted', pgsMode: 'targeted',
      targetPartitionIds: ['c-alpha'] }), topN: 2 },
  ]) {
    const result = await searchAllBrainsTool.execute(input, ctx);
    assert.equal(result.is_error, true, JSON.stringify(input));
  }
  assert.equal(requests.length, 0);
  await searchAllBrainsTool.execute({ query: 'direct', topN: 2,
    modelSelection: { provider: 'xai', model: 'grok-4' } }, ctx);
  for (const request of requests) assert.deepEqual({ ...request, target: undefined }, {
    target: undefined, query: 'direct', mode: 'quick', enablePGS: false,
    modelSelection: { provider: 'xai', model: 'grok-4' },
  });
});

test('research_watch_run round-trips cursor 847 unchanged', async () => {
  let afterSeen: number | null = null;
  let runSeen: string | null = null;
  const ctx = makeCtx({ brainOperations: { watchResearch: async (request: {
    after: number; target: { runId: string };
  }) => {
    afterSeen = request.after;
    runSeen = request.target.runId;
    return { latest: 847, logs: [], active: true };
  } } });
  const first = await watchRunTool.execute({ runId: 'run-owned', after: 0 }, ctx);
  assert.match(first.content, /Cursor:\*\* 847/);
  await watchRunTool.execute({ runId: 'run-owned', after: 847 }, ctx);
  assert.equal(afterSeen, 847);
  assert.equal(runSeen, 'run-owned');
});

test('research_get_brain_graph sends server-side limits and exact filters', async () => {
  let request: Record<string, unknown> | null = null;
  await getBrainGraphTool.execute({
    brainId: 'brain-a', limit: 40, clusterId: 'cluster-1', minWeight: 0.4,
  }, makeCtx({ brainOperations: { graph: async (value: Record<string, unknown>) => {
    request = value;
    return { nodes: [], edges: [], clusters: [], meta: { nodeCount: 5000, edgeCount: 9000 } };
  } } }));
  assert.deepEqual(request, {
    target: { brainId: 'brain-a' }, nodeLimit: 40, edgeLimit: 80,
    clusterId: 'cluster-1', minWeight: 0.4,
  });
});

test('research_compile_section sends the exact section selector and requester result path', async () => {
  let request: Record<string, unknown> | null = null;
  const ctx = makeCtx({ brainOperations: { compile: async (value: Record<string, unknown>) => {
    request = value;
    return completeOperation('op-compile', 'compiled section', {
      path: 'workspace/research/section.md',
    });
  } } });
  const result = await compileSectionTool.execute({
    brainId: 'brain-a', section: 'goal', sectionId: 'goal-7', focus: 'facts only',
  }, ctx);
  assert.equal(request?.kind, 'section');
  assert.equal(request?.section, 'goal');
  assert.equal(request?.sectionId, 'goal-7');
  assert.match(result.content, /workspace\/research\/section\.md/);
});

test('research stop and continue forward only the canonical run selector', async () => {
  let stopped: Record<string, unknown> | null = null;
  let continued: Record<string, unknown> | null = null;
  const ctx = makeCtx({ brainOperations: {
    stopResearch: async (value: Record<string, unknown>) => {
      stopped = value;
      return completeOperation('op-stop', 'stopped');
    },
    continueResearch: async (value: Record<string, unknown>) => {
      continued = value;
      return completeOperation('op-continue', 'continued');
    },
  } });
  const result = await stopRunTool.execute({ runId: 'run-owned' }, ctx);
  await continueRunTool.execute({ runId: 'run-owned', context: 'resume' }, ctx);
  assert.deepEqual(stopped?.target, { runId: 'run-owned' });
  assert.deepEqual(continued, { target: { runId: 'run-owned' }, context: 'resume' });
  assert.match(result.content, /stopped/);
  assert.doesNotMatch(result.content, /30 second|timed out/i);
});

test('research_search_all_brains reports all_failed with every error code', async () => {
  const ctx = makeCtx({ brainOperations: {
    getCatalog: async () => ({ catalogRevision: 'c2', brains: [
      canonicalResearch('brain-a', 'A'), canonicalResearch('brain-b', 'B'),
    ] }),
    query: async (request: Record<string, unknown>) =>
      (request.target as { brainId: string }).brainId === 'brain-a'
        ? failedOperation('op-a', 'source_unavailable')
        : failedOperation('op-b', 'provider_failed'),
  } });
  const result = await searchAllBrainsTool.execute({ query: 'missing evidence', topN: 2 }, ctx);
  assert.match(result.content, /all_failed/);
  assert.match(result.content, /source_unavailable/);
  assert.match(result.content, /provider_failed/);
  assert.equal(result.is_error, true);
  assert.doesNotMatch(result.content, /no relevant findings|launch new research/i);
});

test('research launch and continue preserve every approved option and reject authority fields', async () => {
  let launched: Record<string, unknown> | null = null;
  let continued: Record<string, unknown> | null = null;
  const ctx = makeCtx({ brainOperations: {
    launchResearch: async (request: Record<string, unknown>) => {
      launched = request;
      return completeOperation('op-launch', 'launched');
    },
    continueResearch: async (request: Record<string, unknown>) => {
      continued = request;
      return completeOperation('op-continue', 'continued');
    },
  } });
  const options = {
    topic: 't', context: 'c', cycles: 4, explorationMode: 'autonomous',
    analysisDepth: 'deep', maxConcurrent: 2, primaryModel: 'm1', primaryProvider: 'p1',
    fastModel: 'm2', fastProvider: 'p2', strategicModel: 'm3', strategicProvider: 'p3',
  };
  await launchTool.execute(options, ctx);
  assert.deepEqual(launched, options);
  await continueRunTool.execute({ runId: 'run-owned', context: 'more' }, ctx);
  assert.deepEqual(continued, { target: { runId: 'run-owned' }, context: 'more' });
  for (const input of [
    { ...options, cycles: Infinity }, { ...options, maxConcurrent: 1.5 },
    { ...options, analysisDepth: 3 }, { ...options, explorationMode: 'broad' },
    { ...options, primaryProvider: null }, { ...options, owner: 'forrest' },
    { ...options, runRoot: '/tmp/escape' }, { ...options, enableWebSearch: false },
    { ...options, enableDebate: true }, { ...options, enableSynthesis: true },
    { topic: 't', primaryModel: 'duplicate-label' },
    { topic: 't', primaryProvider: 'provider-only' },
    { topic: 't', fastModel: 'duplicate-label' },
    { topic: 't', strategicProvider: 'provider-only' },
    { topic: 't' },
    { ...options, unknown: true },
  ]) {
    const before = launched;
    const result = await launchTool.execute(input, ctx);
    assert.equal(result.is_error, true, JSON.stringify(input));
    assert.equal(launched, before);
  }
});

test('research_launch schema requires both topic and framing context', () => {
  assert.deepEqual((launchTool.input_schema as any).required, ['topic', 'context']);
  assert.equal(schemaAccepts(launchTool.input_schema, { topic: 'topic only' }), false);
  assert.equal(schemaAccepts(launchTool.input_schema, { topic: 'topic', context: 'why and scope' }), true);
});

test('research launch requires topic as an own data property', async () => {
  let calls = 0;
  let getterReads = 0;
  const accessorInput: Record<string, unknown> = {};
  Object.defineProperty(accessorInput, 'topic', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'accessor topic';
    },
  });
  const inputs = [
    Object.create({ topic: 'inherited topic' }) as Record<string, unknown>,
    accessorInput,
    new Proxy({ topic: 'proxied topic' }, {}),
  ];
  const ctx = makeCtx({ brainOperations: {
    launchResearch: async () => {
      calls += 1;
      return completeOperation('op-prototype-launch', 'launched');
    },
  } });
  const results = [];
  for (const input of inputs) results.push(await launchTool.execute(input, ctx));
  assert.equal(calls, 0);
  assert.equal(getterReads, 0);
  assert.equal(results.every((result) => result.is_error === true), true);
});

test('continue stop and watch reject noncanonical run selectors before any client call', async () => {
  let calls = 0;
  const ctx = makeCtx({ brainOperations: {
    continueResearch: async () => { calls += 1; return completeOperation('bad', 'bad'); },
    stopResearch: async () => { calls += 1; return completeOperation('bad', 'bad'); },
    watchResearch: async () => { calls += 1; return { latest: 0, logs: [] }; },
  } });
  for (const tool of [continueRunTool, stopRunTool, watchRunTool]) {
    for (const input of [{}, { runId: null }, { runId: {} }, { runId: '*' },
      { runId: '   ' }, { runId: 'run-ok', brainId: 'brain-alias' }]) {
      const result = await tool.execute(input as never, ctx);
      assert.equal(result.is_error, true);
      assert.equal(calls, 0);
    }
  }
});

test('search-all selects only capped completed research targets with bounded concurrency/provenance', async () => {
  const completed = Array.from({ length: 25 }, (_, index) => ({
    ...canonicalResearch(`brain-${String(index).padStart(2, '0')}`, `Brain ${index}`),
    modifiedAt: `2026-07-${String((index % 9) + 1).padStart(2, '0')}T12:00:00.000Z`,
  })).reverse();
  const gate = deferred<void>();
  const threeStarted = deferred<void>();
  let active = 0;
  let peak = 0;
  const selected: string[] = [];
  const pending = searchAllBrainsTool.execute({ query: 'evidence', topN: 20 }, makeCtx({
    brainOperations: {
      getCatalog: async () => ({ catalogRevision: 'catalog-bounded', brains: [
        { ...canonicalResearch('resident', 'Resident'), kind: 'resident', lifecycle: 'resident' },
        { ...canonicalResearch('active', 'Active'), lifecycle: 'active' },
        { ...canonicalResearch('unavailable', 'Unavailable'), lifecycle: 'unavailable' },
        ...completed,
      ] }),
      query: async (request: Record<string, unknown>) => {
        const id = (request.target as { brainId: string }).brainId;
        selected.push(id);
        active += 1;
        peak = Math.max(peak, active);
        if (selected.length === 3) threeStarted.resolve();
        await gate.promise;
        active -= 1;
        return completeOperation(`op-${id}`, 'x'.repeat(10_000));
      },
    },
  }));
  await threeStarted.promise;
  assert.equal(peak, 3);
  gate.resolve();
  const result = await pending;
  assert.equal(selected.length, 20);
  assert.equal(selected.includes('resident'), false);
  assert.equal(selected.includes('active'), false);
  assert.equal(selected.includes('unavailable'), false);
  const outcomes = result.metadata?.outcomes as Array<Record<string, unknown>>;
  assert.equal(outcomes.length, 20);
  assert.equal(outcomes.every((row) => row.operationId && row.resultHandle && row.sourceEvidence), true);
  assert.equal(JSON.stringify(outcomes).includes('x'.repeat(1_000)), false);
});

test('search-all with no completed research targets is an explicit error', async () => {
  const result = await searchAllBrainsTool.execute({ query: 'x' }, makeCtx({ brainOperations: {
    getCatalog: async () => ({ catalogRevision: 'empty-catalog', brains: [
      { ...canonicalResearch('active', 'Active'), lifecycle: 'active' },
    ] }),
  } }));
  assert.equal(result.is_error, true);
  assert.match(result.content, /no_eligible_targets/);
  assert.equal(result.metadata?.catalogRevision, 'empty-catalog');
  assert.equal(result.metadata?.selectedCount, 0);
});

test('search-all cancellation stops after three claimed targets and preserves abort identity', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('turn_cancelled'), { code: 'turn_cancelled' });
  const threeStarted = deferred<void>();
  const seenSignals: AbortSignal[] = [];
  const selected: string[] = [];
  const caught: unknown[] = [];
  const pending = searchAllBrainsTool.execute({ query: 'x', topN: 20 }, makeCtx({
    turnAbortController: controller,
    brainOperations: {
      getCatalog: async () => ({ catalogRevision: 'cancel-catalog', brains: Array.from(
        { length: 20 }, (_, index) => canonicalResearch(`brain-${index}`, `Brain ${index}`),
      ) }),
      query: async (request: Record<string, unknown>, signal: AbortSignal) => {
        selected.push((request.target as { brainId: string }).brainId);
        seenSignals.push(signal);
        if (selected.length === 3) threeStarted.resolve();
        try {
          await new Promise((_, reject) => signal.addEventListener(
            'abort', () => reject(signal.reason), { once: true },
          ));
        } catch (error) {
          caught.push(error);
          throw error;
        }
        throw new Error('unreachable');
      },
    },
  }));
  await threeStarted.promise;
  controller.abort(reason);
  const result = await pending;
  assert.equal(result.is_error, true);
  assert.match(result.content, /turn_cancelled/);
  assert.equal(selected.length, 3);
  assert.equal(seenSignals.every((signal) => signal === controller.signal), true);
  assert.equal(caught.length, 3);
  assert.equal(caught.every((error) => error === reason), true);
});

test('summary is a bounded read and preserves exact include selection', async () => {
  let request: Record<string, unknown> | null = null;
  const result = await getBrainSummaryTool.execute({
    brainId: 'brain-summary', include: ['executive', 'goals'],
  }, makeCtx({ brainOperations: { readIntelligence: async (value: Record<string, unknown>) => {
    request = value;
    return { content: 'summary', sourceEvidence: { sourceHealth: 'healthy' } };
  } } }));
  assert.deepEqual(request, {
    target: { brainId: 'brain-summary' }, include: ['executive', 'goals'],
  });
  assert.match(result.content, /summary/);
});

test('active-run awareness consumes only the bounded nonterminal projection', async () => {
  let signalSeen: AbortSignal | undefined;
  const ctx = makeCtx({ brainOperations: { listNonterminal: async (signal: AbortSignal) => {
    signalSeen = signal;
    return [{
      operationId: 'brop_ACTIVEACTIVEACTIVEACTIVEACTIVE12', requestId: 'request-active',
      operationType: 'research_launch',
      requesterAgent: 'jerry', target: { domain: 'requester', requesterAgent: 'jerry' },
      state: 'running',
      phase: 'executing', recordVersion: 2, eventSequence: 7,
      startedAt: '2026-07-10T12:00:00.000Z',
      updatedAt: '2026-07-10T12:01:00.000Z',
      lastProviderActivityAt: null, lastProgressAt: null,
    }];
  } } });
  const active = await checkCosmoActiveRun(ctx);
  assert.equal(active?.runName, 'research-brop_ACTIVEACTIVEACTIVEACTIVEACTIVE12');
  assert.equal(active?.topic, '');
  assert.equal(signalSeen, ctx.turnRuntime?.signal);
  assert.equal(await checkCosmoActiveRun(), null);
});

test('active-run awareness trusts current run authority after launch operation is terminal', async () => {
  let operationListCalls = 0;
  const active = await checkCosmoActiveRun(makeCtx({ brainOperations: {
    getActiveResearchRun: async () => ({
      active: true,
      runName: 'research-brop_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      topic: 'underlying run still executing',
      startedAt: '2026-07-12T12:00:00.000Z',
      processCount: 4,
    }),
    listNonterminal: async () => { operationListCalls += 1; return []; },
  } }));
  assert.deepEqual(active, {
    runName: 'research-brop_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    topic: 'underlying run still executing',
    startedAt: '2026-07-12T12:00:00.000Z',
    processCount: 4,
  });
  assert.equal(operationListCalls, 0);
});

test('research template teaches bounded compile, direct-only search-all, and durable reattachment', () => {
  const template = readFileSync(new URL('../../../cli/templates/COSMO_RESEARCH.md', import.meta.url), 'utf8');
  assert.match(template, /direct query.*default/i);
  assert.match(template, /research_search_all_brains.*direct-only/is);
  assert.match(template, /bounded compiled artifact/i);
  assert.match(template, /brain_status.*detach.*reattach/is);
  assert.doesNotMatch(template, /one big node/i);
});

test('read-only research adapters contain no raw HTTP, agency assimilation, or local writes', () => {
  const source = readFileSync(new URL('../../../src/agent/tools/research.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /assimilateResearchOutput/);
  assert.doesNotMatch(source, /writeWorkspaceFile/);
  assert.doesNotMatch(source, /process\.env|process\.cwd\(\)/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /AbortSignal\.timeout/);
});

test('all research schemas are strict and run controls require runId', () => {
  const tools = [listBrainsTool, queryBrainTool, searchAllBrainsTool, launchTool, continueRunTool,
    stopRunTool, watchRunTool, getBrainSummaryTool, getBrainGraphTool, compileBrainTool,
    compileSectionTool];
  for (const tool of tools) assert.equal((tool.input_schema as any).additionalProperties, false, tool.name);
  for (const tool of [continueRunTool, stopRunTool, watchRunTool]) {
    assert.deepEqual((tool.input_schema as any).required, ['runId']);
    assert.equal('brainId' in (tool.input_schema as any).properties, false);
  }
});
