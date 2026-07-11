import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

let startupSentinelCalls = 0;

function makeCtx(overrides: ContextOverrides = {}): ToolContext {
  const {
    brainOperations = {},
    turnAbortController = new AbortController(),
    ...contextOverrides
  } = overrides;
  const startupSentinel = new Proxy({}, {
    get: (_target, key) => () => {
      startupSentinelCalls += 1;
      throw new Error(`startup_global_client_used:${String(key)}`);
    },
  }) as BrainOperationsClient;
  const runtimeClient = new Proxy(brainOperations, {
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

test('research query separates direct and PGS parameters and rejects present-null pairs', async () => {
  const requests: Record<string, unknown>[] = [];
  const ctx = makeCtx({ brainOperations: { query: async (request: Record<string, unknown>) => {
    requests.push(request);
    return completeOperation('op-query-shape', 'ok');
  } } });
  await queryBrainTool.execute({ brainId: 'brain-r1', query: 'direct' }, ctx);
  assert.deepEqual(requests[0], {
    target: { brainId: 'brain-r1' }, query: 'direct', mode: 'quick', enablePGS: false,
  });
  await queryBrainTool.execute({
    brainId: 'brain-r1', query: 'pgs', enablePGS: true,
    pgsConfig: { sweepFraction: 0.25 },
  }, ctx);
  assert.deepEqual(requests[1], {
    target: { brainId: 'brain-r1' }, query: 'pgs', mode: 'quick', enablePGS: true,
    pgsMode: 'full', pgsConfig: { sweepFraction: 0.25 },
  });
  for (const input of [
    { brainId: 'brain-r1', query: 'x', modelSelection: null },
    { brainId: 'brain-r1', query: 'x', enablePGS: true, pgsSweep: null },
    { brainId: 'brain-r1', query: 'x', enablePGS: true, pgsSynth: null },
    { brainId: 'brain-r1', query: 'x', enablePGS: true, pgsConfig: null },
  ]) {
    const before = requests.length;
    const result = await queryBrainTool.execute(input, ctx);
    assert.equal(result.is_error, true);
    assert.equal(requests.length, before);
  }
});

test('search-all forwards exact Direct Query and PGS provider shapes', async () => {
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
  await searchAllBrainsTool.execute({
    query: 'x', topN: 2, enablePGS: true, pgsConfig: { sweepFraction: 0.25 },
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    pgsSynth: { provider: 'anthropic', model: 'claude-sonnet-4-7' },
  }, ctx);
  assert.equal(requests.length, 2);
  for (const request of requests) assert.deepEqual({ ...request, target: undefined }, {
    target: undefined, query: 'x', mode: 'quick', enablePGS: true, pgsMode: 'full',
    pgsConfig: { sweepFraction: 0.25 },
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    pgsSynth: { provider: 'anthropic', model: 'claude-sonnet-4-7' },
  });
  requests.length = 0;
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
    { ...options, unknown: true },
  ]) {
    const before = launched;
    const result = await launchTool.execute(input, ctx);
    assert.equal(result.is_error, true, JSON.stringify(input));
    assert.equal(launched, before);
  }
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
