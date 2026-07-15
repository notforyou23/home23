import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {
  brainMemoryGraphTool,
  brainCatalogTool,
  brainOperationsListTool,
  brainPgsPartitionsTool,
  brainQueryExportTool,
  brainQueryTool,
  brainSearchTool,
  brainStatusTool,
  brainSynthesizeTool,
} from '../../../src/agent/tools/brain.js';
import type { BrainOperationsClient } from '../../../src/agent/brain-operations/client.js';
import { optionalJsonObject } from '../../../src/agent/brain-operations/input-validation.js';
import type { BrainOperationResult } from '../../../src/agent/brain-operations/types.js';
import type { ToolContext, ToolDefinition } from '../../../src/agent/types.js';
import { CORE_RUNTIME_PROMPT } from '../../../src/agents/system-prompt.js';
import { createToolRegistry } from '../../../src/agent/tools/index.js';
import {
  canonicalBrainTarget,
  makeBrainOperationRecord,
} from '../../helpers/brain-operation-record.js';

type BrainClientStub = Record<string, (...args: any[]) => any>;
type ContextOverrides = Omit<Partial<ToolContext>, 'brainOperations' | 'turnRuntime'> & {
  brainOperations?: BrainClientStub;
};

const PGS_PAIRS = Object.freeze({
  pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
  pgsSynth: { provider: 'anthropic', model: 'claude-sonnet-4-7' },
});
const CONTINUE_OPERATION_ID = 'brop_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

function schemaAccepts(schema: Record<string, unknown>, value: unknown): boolean {
  return new Ajv({ strict: false }).compile(schema)(value) as boolean;
}

function pgsRequest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    query: 'x',
    enablePGS: true,
    pgsMode: 'fresh',
    pgsLevel: 'full',
    ...PGS_PAIRS,
    ...extra,
  };
}

function makeCtx(overrides: ContextOverrides = {}): ToolContext {
  const { brainOperations = {}, ...contextOverrides } = overrides;
  const runtimeStubs = { ...brainOperations };
  if (!runtimeStubs.launchQuery && runtimeStubs.query) {
    runtimeStubs.launchQuery = runtimeStubs.query;
  }
  const abortController = new AbortController();
  const startupSentinel = new Proxy({}, {
    get: (_target, key) => () => { throw new Error(`startup_global_client_used:${String(key)}`); },
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
      abortController,
      signal: abortController.signal,
      brainOperations: runtimeClient,
      onOperationActivity: () => {},
    },
    ...contextOverrides,
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

test('brain discovery tools expose exact model pairs, recent operations, and canonical PGS partitions', async () => {
  const calls: Array<[string, unknown]> = [];
  const ctx = makeCtx({ brainOperations: {
    getCatalog: async () => ({ catalogRevision: 'catalog-9', brains: [{
      id: 'brain-jerry', displayName: 'Jerry', ownerAgent: 'jerry', kind: 'resident',
      lifecycle: 'resident', nodeCount: 42,
    }] }),
    getQueryCatalog: async () => ({
      available: true,
      models: [
        { provider: 'openai', id: 'shared', name: 'OpenAI shared' },
        { provider: 'anthropic', id: 'shared', name: 'Anthropic shared' },
      ],
      defaults: { provider: 'openai', model: 'shared' },
    }),
    listOperations: async (options: unknown) => {
      calls.push(['operations', options]);
      return [{ operationId: CONTINUE_OPERATION_ID, operationType: 'pgs', state: 'partial' }];
    },
    graph: async (request: unknown) => {
      calls.push(['graph', request]);
      return {
        complete: true,
        partitions: [{ partitionId: 'c-alpha', nodeCount: 42, estimatedWorkUnits: 1 }],
      };
    },
  } });
  const catalog = await brainCatalogTool.execute({}, ctx);
  assert.match(catalog.content, /"provider": "openai"/);
  assert.match(catalog.content, /"provider": "anthropic"/);
  assert.match(catalog.content, /"selectable": true/);
  assert.doesNotMatch(catalog.content, /"available": true/);
  const operations = await brainOperationsListTool.execute({ state: 'recent', limit: 5 }, ctx);
  assert.match(operations.content, new RegExp(CONTINUE_OPERATION_ID));
  const partitions = await brainPgsPartitionsTool.execute({ target: { agent: 'jerry' } }, ctx);
  assert.match(partitions.content, /c-alpha/);
  assert.deepEqual(calls, [
    ['operations', { state: 'recent', limit: 5, signal: ctx.turnRuntime?.signal }],
    ['graph', { target: { agent: 'jerry' }, view: 'pgs_partitions' }],
  ]);
});

test('brain_operations_list rejects a nonterminal limit instead of silently ignoring it', async () => {
  let calls = 0;
  const ctx = makeCtx({ brainOperations: {
    listOperations: async () => { calls += 1; return []; },
  } });
  assert.equal(schemaAccepts(brainOperationsListTool.input_schema, {
    state: 'nonterminal', limit: 5,
  }), true);
  const result = await brainOperationsListTool.execute({ state: 'nonterminal', limit: 5 }, ctx);
  assert.equal(result.is_error, true);
  assert.match(result.content, /invalid_request|invalid/i);
  assert.equal(calls, 0);
});

test('brain_search uses the turn-scoped client and forwards an explicit sibling target', async () => {
  let request: Record<string, unknown> | null = null;
  let signal: AbortSignal | null = null;
  const result = await brainSearchTool.execute({
    query: 'Find Forrest evidence', target: { agent: 'forrest' }, limit: 12,
  }, makeCtx({ brainOperations: {
    search: async (value: Record<string, unknown>, receivedSignal: AbortSignal) => {
      request = value;
      signal = receivedSignal;
      return {
        results: [{ id: 'n1', concept: 'evidence' }],
        operationId: 'op-search',
        evidence: {
          sourceHealth: 'degraded',
          retrievalMode: 'logical-source-scan',
          indexCoverage: {
            complete: false, currentRevision: 17, coveredThroughRevision: 17,
            route: 'keyword-source-scan', completeness: 'complete',
          },
          authoritySummary: {
            total: 1,
            authorityClasses: { narrative: 1 },
            retrievalDomains: { current_ops: 1 },
            sourceChain: { withEvidence: 0, withoutEvidence: 1, referenceCounts: {} },
            requiresFreshVerification: 1,
          },
        },
      };
    },
  } }));
  assert.deepEqual(request, {
    target: { agent: 'forrest' }, query: 'Find Forrest evidence', topK: 12,
  });
  assert.ok(signal);
  assert.match(result.content, /evidence/);
  assert.equal(result.metadata?.operationId, 'op-search');
  assert.equal((result.metadata?.sourceEvidence as any).retrievalMode, 'logical-source-scan');
  assert.equal((result.metadata?.sourceEvidence as any).indexCoverage.currentRevision, 17);
  assert.equal(
    (result.metadata?.sourceEvidence as any).authoritySummary.authorityClasses.narrative,
    1,
  );
});

test('brain_query forwards an explicit sibling target and returns operation provenance', async () => {
  let request: Record<string, unknown> | null = null;
  const ctx = makeCtx({ brainOperations: {
    query: async (value: Record<string, unknown>) => {
      request = value;
      return {
        ...completeOperation('op-sibling', 'Forrest answer'),
        requestId: 'req-1',
        target: canonicalBrainTarget('forrest', 'read-only'),
        resultHandle: 'brres_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      };
    },
  } });
  const result = await brainQueryTool.execute({
    query: 'what did Forrest learn?', target: { agent: 'forrest' }, mode: 'quick',
  }, ctx);
  assert.deepEqual(request?.target, { agent: 'forrest' });
  assert.match(result.content, /Forrest answer/);
  assert.equal(result.resultHandle, 'brres_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(result.metadata?.operationId, 'op-sibling');
});

test('brain_memory_graph delegates bounded node and edge limits without fetching api memory', async () => {
  let request: Record<string, unknown> | null = null;
  const result = await brainMemoryGraphTool.execute({ topN: 25 }, makeCtx({
    brainOperations: { graph: async (value: Record<string, unknown>) => {
      request = value;
      return { nodes: [], edges: [], meta: { nodeCount: 139000, edgeCount: 455000 } };
    } },
  }));
  assert.equal(request?.nodeLimit, 25);
  assert.equal(request?.edgeLimit, 100);
  assert.match(result.content, /139000/);
});

test('attachment-shaped empty tags are omitted for search and graph while invalid tags stay strict', async () => {
  let searchRequest: Record<string, unknown> | null = null;
  let graphRequest: Record<string, unknown> | null = null;
  const ctx = makeCtx({ brainOperations: {
    search: async (value: Record<string, unknown>) => {
      searchRequest = value;
      return { results: [], operationId: 'op-empty-tag-search' };
    },
    graph: async (value: Record<string, unknown>) => {
      graphRequest = value;
      return { nodes: [], edges: [] };
    },
  } });

  assert.equal((await brainSearchTool.execute({ query: 'brain', tag: '' }, ctx)).is_error, undefined);
  assert.equal((await brainMemoryGraphTool.execute({ tag: '' }, ctx)).is_error, undefined);
  assert.equal(Object.hasOwn(searchRequest || {}, 'tag'), false);
  assert.equal(Object.hasOwn(graphRequest || {}, 'tag'), false);

  for (const tag of ['   ', 23, 'x'.repeat(257)]) {
    assert.equal((await brainSearchTool.execute({ query: 'brain', tag }, makeCtx())).is_error, true);
    assert.equal((await brainMemoryGraphTool.execute({ tag }, makeCtx())).is_error, true);
  }
});

test('brain_memory_graph full export is a durable requester-owned graph_export operation', async () => {
  let exported: Record<string, unknown> | null = null;
  const operation = completeOperation('op-graph-export', '', { format: 'jsonl' });
  operation.result = null;
  operation.resultArtifact = {
    mediaType: 'application/x-ndjson', contentEncoding: 'identity', bytes: 1048576,
    sha256: 'a'.repeat(64),
  };
  const result = await brainMemoryGraphTool.execute({ exportFull: true, format: 'jsonl' }, makeCtx({
    brainOperations: { graphExport: async (value: Record<string, unknown>) => {
      exported = value;
      return operation;
    } },
  }));
  assert.equal(exported?.format, 'jsonl');
  assert.equal(result.resultHandle, 'brres_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal((result.metadata?.resultArtifact as { bytes: number }).bytes, 1048576);
  assert.doesNotMatch(result.content, /"nodes"|"edges"/);
  assert.match(result.content, /requester-owned/i);
});

test('brain_memory_graph never claims a failed or detached export was stored', async () => {
  const failed = failedOperation('op-graph-failed', 'source_unavailable');
  failed.operationType = 'graph_export';
  const detached = completeOperation('op-graph-detached', '');
  detached.operationType = 'graph_export';
  detached.state = 'running';
  detached.attachmentState = 'detached';
  detached.result = null;
  detached.resultHandle = null;
  detached.resultArtifact = null;
  const missingArtifact = completeOperation('op-graph-missing-artifact', '');
  missingArtifact.operationType = 'graph_export';
  missingArtifact.result = null;
  missingArtifact.resultArtifact = null;

  for (const [operation, shouldError] of [
    [failed, true],
    [detached, false],
    [missingArtifact, true],
  ] as const) {
    const result = await brainMemoryGraphTool.execute({ exportFull: true }, makeCtx({
      brainOperations: { graphExport: async () => operation },
    }));
    assert.equal(result.is_error === true, shouldError, operation.operationId);
    assert.doesNotMatch(result.content, /full graph stored/i, operation.operationId);
  }
});

test('brain_synthesize rejects a cross-brain target before starting an operation', async () => {
  const result = await brainSynthesizeTool.execute({
    action: 'run', target: { agent: 'forrest' },
  }, makeCtx());
  assert.equal(result.is_error, true);
  assert.match(result.content, /own brain only/i);
});

test('brain_query_export rejects target instead of silently ignoring it', async () => {
  let downstreamCalls = 0;
  const result = await brainQueryExportTool.execute({
    operationId: 'op-existing', target: { agent: 'forrest' }, format: 'markdown',
  }, makeCtx({ brainOperations: {
    exportResult: async () => { downstreamCalls += 1; throw new Error('must not run'); },
  } }));
  assert.equal(result.is_error, true);
  assert.equal(downstreamCalls, 0);
  assert.match(result.content, /invalid_request/);
});

test('brain_query_export preserves the bounded server export receipt in tool metadata', async () => {
  const receipt = {
    exportHandle: 'brexp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    relativePath: 'workspace/brain-exports/canary.md',
    bytes: 123,
    sha256: 'a'.repeat(64),
    sourceOperationId: 'brop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceResultHandleHash: null,
    format: 'markdown',
    canonicalEvidence: true,
  };
  const result = await brainQueryExportTool.execute({
    operationId: receipt.sourceOperationId,
    format: 'markdown',
  }, makeCtx({ brainOperations: {
    exportResult: async () => receipt,
  } }));

  assert.equal(result.is_error, undefined);
  assert.deepEqual(result.metadata, receipt);
  assert.match(result.content, /workspace\/brain-exports\/canary\.md/);
});

test('canonical export rejects caller metadata instead of altering durable provenance', async () => {
  let downstreamCalls = 0;
  const result = await brainQueryExportTool.execute({
    operationId: 'op-existing', format: 'markdown', metadata: { source: 'caller-forged' },
  }, makeCtx({ brainOperations: {
    exportResult: async () => { downstreamCalls += 1; return {}; },
  } }));
  assert.equal(result.is_error, true);
  assert.equal(downstreamCalls, 0);
  assert.match(result.content, /invalid_request/);
});

test('canonical and ad-hoc export branches preserve their distinct authority contracts', async () => {
  let canonicalRequest: Record<string, unknown> | null = null;
  let adHocRequest: Record<string, unknown> | null = null;
  const ctx = makeCtx({ brainOperations: {
    exportResult: async (request: Record<string, unknown>) => {
      canonicalRequest = request;
      return { exportedTo: 'workspace/canonical.md', operationId: request.operationId };
    },
    exportAdHocResult: async (request: Record<string, unknown>) => {
      adHocRequest = request;
      return { exportedTo: 'workspace/ad-hoc.md', operationId: 'op-ad-hoc' };
    },
  } });
  const canonical = await brainQueryExportTool.execute({
    operationId: CONTINUE_OPERATION_ID,
    format: 'markdown',
  }, ctx);
  assert.deepEqual(canonicalRequest, {
    operationId: CONTINUE_OPERATION_ID, format: 'markdown',
  });
  assert.equal(canonical.is_error, undefined);

  const adHoc = await brainQueryExportTool.execute({
    query: 'question', answer: 'answer', format: 'markdown', metadata: { note: 'context' },
  }, ctx);
  assert.deepEqual(adHocRequest, {
    query: 'question', answer: 'answer', format: 'markdown',
    metadata: { note: 'context', canonicalEvidence: false },
  });
  assert.equal(adHoc.is_error, undefined);
});

test('canonical export exposes only the bounded public export receipt in tool metadata', async () => {
  const receipt = {
    exportHandle: `brexp_${'e'.repeat(32)}`,
    relativePath: 'workspace/brain-exports/result.md',
    bytes: 42,
    sha256: 'a'.repeat(64),
    sourceOperationId: `brop_${'b'.repeat(32)}`,
    sourceResultHandleHash: 'c'.repeat(64),
    format: 'markdown',
    canonicalEvidence: true,
    internalPath: '/must/not/escape',
  };
  const result = await brainQueryExportTool.execute({
    operationId: receipt.sourceOperationId,
    format: 'markdown',
  }, makeCtx({ brainOperations: {
    exportResult: async () => receipt,
  } }));

  assert.deepEqual(result.metadata, {
    exportHandle: receipt.exportHandle,
    relativePath: receipt.relativePath,
    bytes: receipt.bytes,
    sha256: receipt.sha256,
    sourceOperationId: receipt.sourceOperationId,
    sourceResultHandleHash: receipt.sourceResultHandleHash,
    format: receipt.format,
    canonicalEvidence: true,
  });
  assert.equal(Object.hasOwn(result.metadata || {}, 'internalPath'), false);
  assert.doesNotMatch(result.content, /internalPath|must\/not\/escape/);
});

test('typed coordinator failure is an error and never an empty-brain claim', async () => {
  const result = await brainQueryTool.execute({ query: 'x' }, makeCtx({ brainOperations: {
    query: async () => failedOperation('op-fail', 'source_unavailable'),
  } }));
  assert.equal(result.is_error, true);
  assert.match(result.content, /source_unavailable/);
  assert.doesNotMatch(result.content, /empty brain/i);
});

test('PGS partial preserves useful sweep output and result handle', async () => {
  const partial = completeOperation('op-partial', '');
  partial.operationType = 'pgs';
  partial.state = 'partial';
  partial.result = {
    answer: null,
    sweepOutputs: [{ workUnitId: 'sweep-1-u1', partitionId: 'sweep-1',
      output: 'successful sweep evidence', provider: 'minimax', model: 'MiniMax-M3' }],
    metadata: { pgs: { successfulSweeps: 1, retryablePartitions: ['sweep-2'] } },
  };
  partial.error = { code: 'provider_incomplete', message: 'final synthesis truncated', retryable: true };
  partial.resultHandle = 'brres_cccccccccccccccccccccccccccccccc';
  const result = await brainQueryTool.execute(pgsRequest(), makeCtx({
    brainOperations: { query: async () => partial },
  }));
  assert.equal(result.is_error, undefined);
  assert.match(result.content, /successful sweep evidence/);
  assert.equal(result.metadata?.state, 'partial');
  assert.equal(result.metadata?.classification, 'useful_partial');
  assert.equal((result.metadata?.pgs as { successfulSweeps: number }).successfulSweeps, 1);
  assert.deepEqual(
    (result.metadata?.pgs as { retryablePartitions: string[] }).retryablePartitions,
    ['sweep-2'],
  );
  assert.match(result.content, /provider_incomplete/);
  assert.equal(result.resultHandle, 'brres_cccccccccccccccccccccccccccccccc');
});

test('PGS request preserves the approved fresh/full named contract without raw config', async () => {
  let request: Record<string, unknown> | null = null;
  const operation = completeOperation('op-pgs-projection', 'answer');
  operation.operationType = 'pgs';
  await brainQueryTool.execute(pgsRequest(), makeCtx({ brainOperations: {
    query: async (value: Record<string, unknown>) => { request = value; return operation; },
  } }));
  assert.deepEqual(request, {
    query: 'x', enablePGS: true, pgsMode: 'fresh', pgsLevel: 'full',
    ...PGS_PAIRS,
  });
  for (const key of ['modelSelection', 'enableSynthesis', 'includeOutputs', 'includeThoughts',
    'includeCoordinatorInsights', 'allowActions']) {
    assert.equal(key in (request || {}), false);
  }
});

test('brain_query accepts every named PGS mode and level with exact continuation and target fields', async () => {
  const requests: Record<string, unknown>[] = [];
  const ctx = makeCtx({ brainOperations: {
    query: async (value: Record<string, unknown>) => {
      requests.push(value);
      const operation = completeOperation(`op-pgs-${requests.length}`, 'answer');
      operation.operationType = 'pgs';
      return operation;
    },
  } });
  for (const pgsMode of ['fresh', 'continue', 'targeted'] as const) {
    for (const pgsLevel of ['skim', 'sample', 'deep', 'full'] as const) {
      const extra = pgsMode === 'continue'
        ? { continueFromOperationId: CONTINUE_OPERATION_ID }
        : pgsMode === 'targeted'
          ? { targetPartitionIds: ['c-alpha', 'h-beta'] }
          : {};
      const result = await brainQueryTool.execute(pgsRequest({ pgsMode, pgsLevel, ...extra }), ctx);
      assert.equal(result.is_error, undefined, `${pgsMode}/${pgsLevel}`);
    }
  }
  const targetedContinuation = await brainQueryTool.execute(pgsRequest({
    pgsMode: 'targeted',
    pgsLevel: 'deep',
    continueFromOperationId: CONTINUE_OPERATION_ID,
    targetPartitionIds: ['h-beta', 'c-alpha'],
  }), ctx);
  assert.equal(targetedContinuation.is_error, undefined);
  assert.deepEqual(requests.at(-1), {
    query: 'x', enablePGS: true, pgsMode: 'targeted', pgsLevel: 'deep',
    continueFromOperationId: CONTINUE_OPERATION_ID,
    targetPartitionIds: ['h-beta', 'c-alpha'],
    ...PGS_PAIRS,
  });
  assert.equal(requests.every((request) => !Object.hasOwn(request, 'pgsConfig')), true);
});

test('brain_query rejects incomplete, mixed, legacy, or noncanonical PGS requests before launch', async () => {
  let calls = 0;
  const ctx = makeCtx({ brainOperations: { query: async () => {
    calls += 1;
    return completeOperation('op-invalid-pgs', 'unexpected');
  } } });
  const tooManyTargets = Array.from({ length: 257 }, (_, index) => `c-${index}`);
  const invalid = [
    { query: 'x', enablePGS: true },
    pgsRequest({ pgsMode: undefined }),
    pgsRequest({ pgsLevel: undefined }),
    pgsRequest({ pgsSweep: undefined }),
    pgsRequest({ pgsSynth: undefined }),
    pgsRequest({ pgsMode: 'full' }),
    pgsRequest({ pgsLevel: 'quarter' }),
    pgsRequest({ pgsConfig: { sweepFraction: 0.25 } }),
    pgsRequest({ priorContext: { query: 'before', answer: 'after' } }),
    pgsRequest({ mode: 'quick' }),
    pgsRequest({ pgsMode: 'fresh', continueFromOperationId: CONTINUE_OPERATION_ID }),
    pgsRequest({ pgsMode: 'fresh', targetPartitionIds: ['c-alpha'] }),
    pgsRequest({ pgsMode: 'continue' }),
    pgsRequest({ pgsMode: 'continue', continueFromOperationId: 'brop_short' }),
    pgsRequest({ pgsMode: 'continue', continueFromOperationId: CONTINUE_OPERATION_ID,
      targetPartitionIds: ['c-alpha'] }),
    pgsRequest({ pgsMode: 'targeted' }),
    pgsRequest({ pgsMode: 'targeted', targetPartitionIds: [] }),
    pgsRequest({ pgsMode: 'targeted', targetPartitionIds: ['alpha'] }),
    pgsRequest({ pgsMode: 'targeted', targetPartitionIds: ['c-alpha', 'c-alpha'] }),
    pgsRequest({ pgsMode: 'targeted', targetPartitionIds: tooManyTargets }),
    { query: 'x', pgsMode: 'fresh' },
    { query: 'x', pgsLevel: 'full' },
    { query: 'x', continueFromOperationId: CONTINUE_OPERATION_ID },
    { query: 'x', targetPartitionIds: ['c-alpha'] },
    { query: 'x', pgsSweep: PGS_PAIRS.pgsSweep },
    { query: 'x', pgsSynth: PGS_PAIRS.pgsSynth },
  ];
  for (const input of invalid) {
    const result = await brainQueryTool.execute(input, ctx);
    assert.equal(result.is_error, true, JSON.stringify(input));
    assert.match(result.content, /invalid_request|invalid/i);
  }
  assert.equal(calls, 0);
});

test('brain_query schema publishes the direct and PGS parameter families without root unions', () => {
  const schema = brainQueryTool.input_schema as any;
  assert.equal('pgsConfig' in schema.properties, false);
  assert.deepEqual(schema.properties.pgsMode.enum, ['fresh', 'continue', 'targeted']);
  assert.deepEqual(schema.properties.pgsLevel.enum, ['skim', 'sample', 'deep', 'full']);
  assert.equal(schema.properties.continueFromOperationId.pattern, '^brop_[A-Za-z0-9_-]{32}$');
  assert.equal(schema.properties.targetPartitionIds.uniqueItems, true);
  assert.equal(schema.properties.targetPartitionIds.maxItems, 256);
  assert.equal(schema.properties.targetPartitionIds.items.pattern,
    '^(?:c|h)-[A-Za-z0-9._-]{1,253}$');
  for (const value of [
    { query: 'direct' },
    { query: 'direct', enablePGS: false, mode: 'quick' },
    { query: 'follow-up', priorContext: { query: 'before', answer: 'after' } },
    pgsRequest(),
    pgsRequest({ pgsMode: 'continue', continueFromOperationId: CONTINUE_OPERATION_ID }),
    pgsRequest({ pgsMode: 'targeted', targetPartitionIds: ['c-alpha'] }),
  ]) assert.equal(schemaAccepts(schema, value), true, JSON.stringify(value));

  for (const directField of [
    { mode: 'quick' },
    { modelSelection: PGS_PAIRS.pgsSweep },
    { enableSynthesis: true },
    { includeOutputs: true },
    { includeThoughts: true },
    { includeCoordinatorInsights: true },
    { allowActions: true },
    { priorContext: { query: 'before', answer: 'after' } },
  ]) {
    const value = pgsRequest(directField);
    assert.equal(schemaAccepts(schema, value), true, JSON.stringify(value));
  }
  for (const pgsField of [
    { pgsMode: 'fresh' },
    { pgsLevel: 'full' },
    { continueFromOperationId: CONTINUE_OPERATION_ID },
    { targetPartitionIds: ['c-alpha'] },
    { pgsSweep: PGS_PAIRS.pgsSweep },
    { pgsSynth: PGS_PAIRS.pgsSynth },
  ]) {
    const value = { query: 'direct', ...pgsField };
    assert.equal(schemaAccepts(schema, value), true, JSON.stringify(value));
  }
});

test('every provider-bound tool schema in the active registry has a plain object root', () => {
  const registry = createToolRegistry();
  const inventories = [
    {
      provider: 'openai-compatible',
      tools: registry.getOpenAITools().map((tool) => ({
        name: tool.function.name,
        schema: tool.function.parameters,
      })),
    },
    {
      provider: 'anthropic',
      tools: registry.getAnthropicTools().map((tool) => ({
        name: tool.name,
        schema: tool.input_schema,
      })),
    },
  ];
  for (const inventory of inventories) {
    assert.equal(inventory.tools.length, registry.size, `${inventory.provider} inventory`);
    for (const tool of inventory.tools) {
      const schema = tool.schema as Record<string, unknown>;
      assert.equal(schema.type, 'object', `${inventory.provider} ${tool.name} root`);
      for (const keyword of ['oneOf', 'anyOf', 'allOf', 'enum', 'const', 'not'] as const) {
        assert.equal(keyword in schema, false, `${inventory.provider} ${tool.name} root ${keyword}`);
      }
    }
  }

  const openAiTools = registry.getOpenAITools();
  const exportSchema = openAiTools.find((tool) => tool.function.name === 'brain_query_export')!
    .function.parameters as any;
  const skillsSchema = openAiTools.find((tool) => tool.function.name === 'skills_run')!
    .function.parameters as any;
  assert.equal(exportSchema.properties.metadata.additionalProperties, true);
  assert.equal(skillsSchema.properties.input.additionalProperties, true);
});

test('provider-compatible brain schemas retain action-specific runtime rejection', async () => {
  const invalidCases: Array<[ToolDefinition, Record<string, unknown>]> = [
    [brainOperationsListTool, { state: 'nonterminal', limit: 1 }],
    [brainQueryTool, pgsRequest({ pgsMode: 'continue' })],
    [brainQueryExportTool, {
      operationId: CONTINUE_OPERATION_ID, query: 'mixed', answer: 'invalid',
    }],
    [brainMemoryGraphTool, { exportFull: true, topN: 5 }],
    [brainSynthesizeTool, { action: 'reattach' }],
    [brainStatusTool, { action: 'result' }],
  ];

  for (const [tool, input] of invalidCases) {
    const result = await tool.execute(input, makeCtx());
    assert.equal(result.is_error, true, `${tool.name}: ${JSON.stringify(input)}`);
    assert.match(result.content, /invalid_request|invalid/i, tool.name);
  }
});

test('PGS launches detached while direct brain_query remains attached', async () => {
  const launched: Record<string, unknown>[] = [];
  const queried: Record<string, unknown>[] = [];
  const detached = completeOperation(CONTINUE_OPERATION_ID, '');
  detached.operationType = 'pgs';
  detached.state = 'running';
  detached.attachmentState = 'detached';
  detached.result = null;
  detached.resultHandle = null;
  const direct = completeOperation(`brop_${'D'.repeat(32)}`, 'direct answer');
  const ctx = makeCtx({ brainOperations: {
    launchQuery: async (request: Record<string, unknown>) => {
      launched.push(request);
      return detached;
    },
    query: async (request: Record<string, unknown>) => {
      queried.push(request);
      return direct;
    },
  } });

  const pgs = await brainQueryTool.execute(pgsRequest(), ctx);
  const ordinary = await brainQueryTool.execute({ query: 'direct' }, ctx);

  assert.equal(launched.length, 1);
  assert.equal(queried.length, 1);
  assert.match(pgs.content, /running/i);
  assert.match(pgs.content, new RegExp(CONTINUE_OPERATION_ID));
  assert.match(pgs.content, /brain_status.*status/i);
  assert.match(ordinary.content, /direct answer/);
});

test('brain_query rejects priorContext whose query and answer exceed 20,000 characters combined', async () => {
  let calls = 0;
  const ctx = makeCtx({ brainOperations: { query: async () => {
    calls += 1;
    return completeOperation('op-prior-context', 'ok');
  } } });
  const accepted = await brainQueryTool.execute({
    query: 'follow-up', priorContext: { query: 'q'.repeat(10_000), answer: 'a'.repeat(10_000) },
  }, ctx);
  assert.equal(accepted.is_error, undefined);
  const rejected = await brainQueryTool.execute({
    query: 'follow-up', priorContext: { query: 'q'.repeat(10_001), answer: 'a'.repeat(10_000) },
  }, ctx);
  assert.equal(rejected.is_error, true);
  assert.match(rejected.content, /priorContext.*invalid/i);
  assert.equal(calls, 1);
});

test('provider-compatible schemas expose action fields while runtime defers cross-field rules', () => {
  const cases: Array<[Record<string, unknown>, unknown[], unknown[]]> = [
    [brainQueryExportTool.input_schema,
      [
        { operationId: CONTINUE_OPERATION_ID },
        { operationId: CONTINUE_OPERATION_ID, format: 'json' },
        { query: 'q', answer: 'a' },
        { query: 'q', answer: 'a', metadata: { source: 'manual' } },
      ],
      [
        {},
        { operationId: CONTINUE_OPERATION_ID, metadata: {} },
        { operationId: CONTINUE_OPERATION_ID, query: 'q', answer: 'a' },
        { query: 'q' },
      ]],
    [brainMemoryGraphTool.input_schema,
      [{}, { topN: 10, tag: 'x' }, { exportFull: true }, { exportFull: true, format: 'jsonl' }],
      [{ format: 'jsonl' }, { exportFull: false, format: 'jsonl' },
        { exportFull: true, topN: 10 }, { exportFull: true, tag: 'x' }]],
    [brainSynthesizeTool.input_schema,
      [{}, { action: 'run', trigger: 'manual' }, { action: 'status' },
        { action: 'status', operationId: CONTINUE_OPERATION_ID },
        { action: 'status', generationMarker: 'g1' },
        { action: 'reattach', operationId: CONTINUE_OPERATION_ID }],
      [{ action: 'run', operationId: CONTINUE_OPERATION_ID },
        { action: 'status', trigger: 'manual' },
        { action: 'status', operationId: CONTINUE_OPERATION_ID, generationMarker: 'g1' },
        { action: 'reattach' },
        { action: 'reattach', operationId: CONTINUE_OPERATION_ID, reason: 'x' }]],
    [brainStatusTool.input_schema,
      [{}, { target: { agent: 'jerry' } },
        { operationId: CONTINUE_OPERATION_ID },
        { operationId: CONTINUE_OPERATION_ID, action: 'wait' }],
      [{ action: 'status' },
        { target: { agent: 'jerry' }, operationId: CONTINUE_OPERATION_ID },
        { target: { agent: 'jerry' }, action: 'status' }]],
  ];
  for (const [schema, accepted, rejected] of cases) {
    for (const value of accepted) assert.equal(schemaAccepts(schema, value), true, JSON.stringify(value));
    for (const value of rejected) assert.equal(schemaAccepts(schema, value), true, JSON.stringify(value));
  }
  assert.equal(schemaAccepts(brainQueryExportTool.input_schema, {
    operationId: CONTINUE_OPERATION_ID, resultHandle: 'ignored',
  }), false);
  assert.equal('resultHandle' in (brainQueryExportTool.input_schema as any).properties, false);
});

test('the runtime prompt has one canonical brain doctrine with bounded PGS and no bypass', () => {
  assert.equal(CORE_RUNTIME_PROMPT.match(/### Brain tools/g)?.length, 1);
  assert.doesNotMatch(CORE_RUNTIME_PROMPT, /## Brain Integration/);
  assert.match(CORE_RUNTIME_PROMPT, /PGS levels are cumulative/i);
  assert.match(CORE_RUNTIME_PROMPT, /fresh starts/i);
  assert.match(CORE_RUNTIME_PROMPT, /continue resumes/i);
  assert.match(CORE_RUNTIME_PROMPT, /targeted limits/i);
  assert.match(CORE_RUNTIME_PROMPT, /empty scoped result.*not.*full-brain absence/is);
  assert.match(CORE_RUNTIME_PROMPT, /priorContext is direct-query only/i);
  assert.doesNotMatch(CORE_RUNTIME_PROMPT, /brain is unreachable.*shell \+ curl/is);
});

test('PGS with no useful sweeps is all_failed and is_error true', async () => {
  const failed = failedOperation('op-pgs-all-failed', 'provider_failed');
  failed.operationType = 'pgs';
  failed.result = { answer: null, sweepOutputs: [],
    metadata: { pgs: { successfulSweeps: 0, retryablePartitions: ['sweep-1', 'sweep-2'] } } };
  const result = await brainQueryTool.execute(pgsRequest(), makeCtx({
    brainOperations: { query: async () => failed },
  }));
  assert.equal(result.is_error, true);
  assert.equal(result.metadata?.classification, 'all_failed');
  assert.match(result.content, /provider_failed/);
});

test('malformed PGS partials fail closed as invalid_partial_result', async () => {
  const baseResult = { answer: null, sweepOutputs: [{ workUnitId: 'u1', partitionId: 'p1',
    output: 'useful', provider: 'minimax', model: 'MiniMax-M3' }],
  metadata: { pgs: { successfulSweeps: 1, retryablePartitions: ['p2', 'p3'] } } };
  for (const mutate of [
    (value: any) => { value.metadata.pgs.successfulSweeps = '1'; },
    (value: any) => { value.metadata.pgs.successfulSweeps = Number.NaN; },
    (value: any) => { value.metadata.pgs.successfulSweeps = -1; },
    (value: any) => { value.sweepOutputs[0].output = ''; },
    (value: any) => { delete value.sweepOutputs[0].provider; },
    (value: any) => { value.metadata.pgs.retryablePartitions = ['p3', 'p2']; },
    (value: any) => { value.metadata.pgs.retryablePartitions = ['p2', 'p2']; },
  ]) {
    const operation = completeOperation('op-invalid-partial', '');
    operation.operationType = 'pgs';
    operation.state = 'partial';
    operation.result = structuredClone(baseResult);
    operation.error = { code: 'provider_incomplete', message: 'truncated', retryable: true };
    mutate(operation.result);
    const result = await brainQueryTool.execute(pgsRequest(), makeCtx({
      brainOperations: { query: async () => operation },
    }));
    assert.equal(result.is_error, true);
    assert.equal(result.metadata?.classification, 'invalid_partial_result');
    assert.match(result.content, /invalid_partial_result/);
  }
  const missingError = completeOperation('op-invalid-error', '');
  missingError.operationType = 'pgs';
  missingError.state = 'partial';
  missingError.result = structuredClone(baseResult);
  missingError.error = null;
  const result = await brainQueryTool.execute(pgsRequest(), makeCtx({
    brainOperations: { query: async () => missingError },
  }));
  assert.equal(result.metadata?.classification, 'invalid_partial_result');
  assert.equal(result.is_error, true);
});

test('direct query partial preserves a nonempty answer plus typed terminal error', async () => {
  const operation = completeOperation('op-query-partial', 'useful direct-query answer');
  operation.operationType = 'query';
  operation.state = 'partial';
  operation.error = { code: 'provider_incomplete', message: 'provider stream ended', retryable: true };
  const result = await brainQueryTool.execute({ query: 'x' }, makeCtx({ brainOperations: {
    query: async () => operation,
  } }));
  assert.equal(result.is_error, undefined);
  assert.equal(result.metadata?.classification, 'useful_partial');
  assert.match(result.content, /useful direct-query answer/);
  assert.match(result.content, /provider_incomplete/);
  assert.deepEqual(result.metadata?.error, operation.error);
  assert.deepEqual(result.metadata?.sourceEvidence, operation.sourceEvidence);
});

test('direct query partial without both nonempty answer and typed error fails closed', async () => {
  for (const mutate of [
    (operation: BrainOperationResult) => { operation.result = { answer: '   ' }; },
    (operation: BrainOperationResult) => { operation.error = null; },
    (operation: BrainOperationResult) => { operation.error = {
      code: 'provider_incomplete', message: '', retryable: true }; },
  ]) {
    const operation = completeOperation('op-query-partial-invalid', 'answer');
    operation.operationType = 'query';
    operation.state = 'partial';
    operation.error = { code: 'provider_incomplete', message: 'ended', retryable: true };
    mutate(operation);
    const result = await brainQueryTool.execute({ query: 'x' }, makeCtx({ brainOperations: {
      query: async () => operation,
    } }));
    assert.equal(result.is_error, true);
    assert.equal(result.metadata?.classification, 'invalid_partial_result');
    assert.match(result.content, /invalid_partial_result/);
  }
});

test('detached query remains running and exposes its operation ID', async () => {
  const running = completeOperation('op-running', '');
  running.state = 'running';
  running.attachmentState = 'detached';
  const result = await brainQueryTool.execute({ query: 'x' }, makeCtx({
    brainOperations: { query: async () => running },
  }));
  assert.match(result.content, /op-running/);
  assert.match(result.content, /running/);
  assert.match(result.content, /brain_status.*status/i);
  assert.doesNotMatch(result.content, /state=complete/i);
});

test('brain_synthesize returns the new generation marker from its own-brain operation', async () => {
  let request: Record<string, unknown> | null = null;
  const operation = completeOperation('op-synthesis', 'synthesis complete', {
    generationMarker: 'generation-2026-07-09T12:00:00Z',
  });
  operation.operationType = 'synthesis';
  const result = await brainSynthesizeTool.execute({ action: 'run' }, makeCtx({
    brainOperations: { synthesize: async (value: Record<string, unknown>) => {
      request = value;
      return operation;
    } },
  }));
  assert.equal('provider' in (request || {}), false);
  assert.equal('model' in (request || {}), false);
  assert.match(result.content, /generation-2026-07-09T12:00:00Z/);
  assert.equal(result.metadata?.operationId, 'op-synthesis');
});

test('brain_synthesize status and reattach never start a second synthesis', async () => {
  let starts = 0;
  const statusRequests: Record<string, unknown>[] = [];
  const reattached: string[] = [];
  const sourceChanged = failedOperation(CONTINUE_OPERATION_ID, 'source_changed');
  sourceChanged.operationType = 'synthesis';
  const ctx = makeCtx({ brainOperations: {
    synthesize: async () => { starts += 1; return completeOperation('unexpected', 'unexpected'); },
    synthesisStatus: async (request: Record<string, unknown>) => {
      statusRequests.push(request);
      return { ready: true, requestedGenerationMarker: 'g1', currentGenerationMarker: 'g2',
        markerStatus: 'changed', latestOperation: null, activeOperation: null };
    },
    reattachSynthesis: async (operationId: string) => {
      reattached.push(operationId);
      return sourceChanged;
    },
  } });
  const status = await brainSynthesizeTool.execute({ action: 'status', generationMarker: 'g1' }, ctx);
  assert.deepEqual(statusRequests, [{ generationMarker: 'g1' }]);
  assert.match(status.content, /currentGenerationMarker.*g2/s);
  assert.match(status.content, /markerStatus.*changed/s);
  const resumed = await brainSynthesizeTool.execute({
    action: 'reattach', operationId: CONTINUE_OPERATION_ID,
  }, ctx);
  assert.deepEqual(reattached, [CONTINUE_OPERATION_ID]);
  assert.equal(resumed.is_error, true);
  assert.match(resumed.content, /source_changed/);
  assert.doesNotMatch(resumed.content, /generation.*complete/i);
  assert.equal(starts, 0);
});

test('brain_status exposes status, result, wait, and exact cancel by operation ID', async () => {
  const operationId = `brop_${'C'.repeat(32)}`;
  const inspected: string[] = [];
  const resumed: string[] = [];
  const running = completeOperation(operationId, '');
  running.state = 'running';
  running.attachmentState = 'detached';
  running.phase = 'pgs_sweep';
  running.updatedAt = '2026-07-13T02:00:48.805Z';
  running.lastProviderActivityAt = '2026-07-13T02:00:48.805Z';
  running.lastProgressAt = '2026-07-13T01:14:22.908Z';
  running.pgsSession = { sessionId: `pgss_${'S'.repeat(32)}`, completedWorkUnits: 470 };
  const ctx = makeCtx({ brainOperations: {
    inspectOperation: async (operationId: string, action: string) => {
      inspected.push(`${operationId}:${action}`);
      if (action === 'result') {
        return { operationId, state: 'complete', result: { answer: 'stored' }, resultHandle: null,
          resultArtifact: null, error: null, sourceEvidence: null };
      }
      const { attachmentState: _attachmentState, ...status } = running;
      return { ...status, state: action === 'cancel' ? 'cancelled' : 'running' };
    },
    resumeOperation: async (operationId: string) => { resumed.push(operationId); return running; },
  } });
  for (const action of ['status', 'result', 'cancel'] as const) {
    await brainStatusTool.execute({ operationId, action }, ctx);
  }
  const waited = await brainStatusTool.execute({ operationId, action: 'wait' }, ctx);
  assert.deepEqual(inspected, [
    `${operationId}:status`, `${operationId}:result`, `${operationId}:cancel`,
  ]);
  assert.deepEqual(resumed, [operationId]);
  assert.match(waited.content, /running|Detached/i);
  const inspectedStatus = await brainStatusTool.execute({ operationId, action: 'status' }, ctx);
  assert.match(inspectedStatus.content, /pgs_sweep/);
  assert.match(inspectedStatus.content, /lastProviderActivityAt/);
  assert.match(inspectedStatus.content, /2026-07-13T02:00:48.805Z/);
  assert.match(inspectedStatus.content, /completedWorkUnits.*470/s);
  assert.deepEqual(Object.keys((brainStatusTool.input_schema as any).properties)
    .filter((key) => ['operationType', 'waitMs'].includes(key)), []);
});

test('brain_status result fails malformed partial envelopes closed', async () => {
  const result = await brainStatusTool.execute({
    operationId: 'brop_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', action: 'result',
  }, makeCtx({ brainOperations: {
    inspectOperation: async () => ({
      operationId: 'brop_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      operationType: 'query',
      state: 'partial',
      attachmentState: 'closed',
      result: { answer: '   ' },
      resultHandle: null,
      resultArtifact: null,
      error: null,
      sourceEvidence: null,
    }),
  } }));
  assert.equal(result.is_error, true);
  assert.equal(result.metadata?.classification, 'invalid_partial_result');
  assert.match(result.content, /invalid_partial_result/);
});

test('brain_status status reports terminal partial and directs protected result inspection', async () => {
  const operation = completeOperation(
    'brop_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    'useful partial answer',
  );
  operation.operationType = 'query';
  operation.state = 'partial';
  operation.error = { code: 'provider_incomplete', message: 'ended early', retryable: true };
  const { attachmentState: _attachmentState, ...status } = operation;
  const result = await brainStatusTool.execute({
    operationId: operation.operationId, action: 'status',
  }, makeCtx({ brainOperations: { inspectOperation: async () => status } }));
  assert.equal(result.is_error, undefined);
  assert.equal(result.metadata?.classification, 'partial_status');
  assert.match(result.content, /state=partial/);
  assert.match(result.content, /action:\"result\"/);
  assert.doesNotMatch(result.content, /invalid_partial_result|useful partial answer/);
});

test('brain_status renders authoritative summary totals without graph arrays', async () => {
  const result = await brainStatusTool.execute({}, makeCtx({ brainOperations: {
    status: async () => ({ memory: { nodeCount: 139000, edgeCount: 455000 },
      sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches' } }),
  } }));
  assert.match(result.content, /139000/);
  assert.match(result.content, /455000/);
  assert.doesNotMatch(result.content, /"nodes":\s*\[/);
});

test('omitted target stays omitted so the coordinator selects the exact own brain', async () => {
  let request: Record<string, unknown> | null = null;
  await brainQueryTool.execute({ query: 'own brain' }, makeCtx({ brainOperations: {
    query: async (value: Record<string, unknown>) => {
      request = value;
      return completeOperation('op-own', 'own');
    },
  } }));
  assert.equal(request?.target, undefined);
});

test('brain tools reject a target that mixes agent and brain ID selectors', async () => {
  let downstreamCalls = 0;
  const target = { agent: 'jerry', brainId: 'jerry' };
  const ctx = makeCtx({ brainOperations: {
    search: async () => { downstreamCalls += 1; return {}; },
    query: async () => { downstreamCalls += 1; return completeOperation('op-mixed', 'wrong'); },
    graph: async () => { downstreamCalls += 1; return {}; },
    status: async () => { downstreamCalls += 1; return {}; },
  } });

  for (const [tool, input] of [
    [brainSearchTool, { query: 'health', target }],
    [brainQueryTool, { query: 'health', target }],
    [brainMemoryGraphTool, { target }],
    [brainStatusTool, { target }],
  ] as const) {
    const result = await tool.execute(input, ctx);
    assert.equal(result.is_error, true, tool.name);
    assert.match(result.content, /target_invalid/, tool.name);
  }
  assert.equal(downstreamCalls, 0);
});

test('brain tool schemas make own-brain and exact-selector contracts explicit', () => {
  const target = (brainSearchTool.input_schema as any).properties.target;
  assert.equal(target.minProperties, 1);
  assert.equal(target.maxProperties, 1);
  assert.match(target.description, /omit.*own brain/i);
  assert.match(target.properties.agent.description, /agent name/i);
  assert.match(target.properties.brainId.description, /catalog/i);

  const operationId = (brainStatusTool.input_schema as any).properties.operationId;
  assert.equal(operationId.pattern, '^brop_[A-Za-z0-9_-]{32}$');
  assert.match(operationId.description, /returned.*brain/i);
  assert.match(brainStatusTool.description, /omit.*health/i);
});

test('brain_status rejects an invented operation ID before calling the client', async () => {
  let downstreamCalls = 0;
  const result = await brainStatusTool.execute({
    operationId: 'health', action: 'status',
  }, makeCtx({ brainOperations: {
    inspectOperation: async () => { downstreamCalls += 1; return {}; },
  } }));
  assert.equal(result.is_error, true);
  assert.match(result.content, /operation_id_invalid/);
  assert.equal(downstreamCalls, 0);
});

test('strict schemas and executors reject coercion, null, extras, and legacy model shortcuts', async () => {
  for (const tool of [brainSearchTool, brainQueryTool, brainQueryExportTool, brainMemoryGraphTool,
    brainSynthesizeTool, brainStatusTool]) {
    assert.equal((tool.input_schema as any).additionalProperties, false, tool.name);
  }
  const invalidQueries = [
    { query: 'x', limit: '10' },
    { query: 'x', limit: undefined },
    { query: 'x', tag: undefined },
    { query: 'x', target: null },
    { query: 'x', target: { agent: 'forrest', extra: true } },
    { query: 'x', model: 'legacy-flat-model' },
    { query: 'x', modelSelection: { provider: 'openai' } },
    { query: 'x', modelSelection: undefined },
    { query: 'x', modelSelection: { provider: 'x'.repeat(257), model: 'gpt' } },
    { query: 'x', modelSelection: { provider: 'openai', model: 'x'.repeat(257) } },
    { query: 'x', enablePGS: true, modelSelection: { provider: 'openai', model: 'gpt' } },
    { query: 'x', enablePGS: false, pgsMode: 'fresh' },
  ];
  for (const input of invalidQueries) {
    const result = await brainQueryTool.execute(input, makeCtx());
    assert.equal(result.is_error, true, JSON.stringify(input));
    assert.match(result.content, /invalid_request|invalid/i);
  }
  const graph = await brainMemoryGraphTool.execute({ exportFull: true, topN: 5 }, makeCtx());
  assert.equal(graph.is_error, true);
  const jsonGraph = await brainMemoryGraphTool.execute({ exportFull: true, format: 'json' }, makeCtx());
  assert.equal(jsonGraph.is_error, true);
});

test('brain_query requires query as an own data property', async () => {
  let calls = 0;
  let getterReads = 0;
  const accessorInput: Record<string, unknown> = {};
  Object.defineProperty(accessorInput, 'query', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'accessor query';
    },
  });
  const inputs = [
    Object.create({ query: 'inherited query' }) as Record<string, unknown>,
    accessorInput,
    new Proxy({ query: 'proxied query' }, {}),
  ];
  const ctx = makeCtx({ brainOperations: {
    query: async () => {
      calls += 1;
      return completeOperation('op-prototype-query', 'queried');
    },
  } });
  const results = [];
  for (const input of inputs) results.push(await brainQueryTool.execute(input, ctx));
  assert.equal(calls, 0);
  assert.equal(getterReads, 0);
  assert.equal(results.every((result) => result.is_error === true), true);
});

test('ad-hoc export metadata rejects cycles, nonfinite leaves, and oversized JSON', async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const metadata of [cyclic, { score: Number.NaN }, { text: 'x'.repeat(33_000) }]) {
    const result = await brainQueryExportTool.execute({
      query: 'q', answer: 'a', format: 'markdown', metadata,
    }, makeCtx());
    assert.equal(result.is_error, true);
    assert.match(result.content, /invalid/i);
  }
});

test('ad-hoc export publishes and enforces the one-million-character answer ceiling', async () => {
  const schema = brainQueryExportTool.input_schema as any;
  assert.equal(schema.properties.answer.maxLength, 1_000_000);
  let calls = 0;
  const result = await brainQueryExportTool.execute({
    query: 'q', answer: 'a'.repeat(1_000_001), format: 'markdown',
  }, makeCtx({ brainOperations: {
    exportAdHocResult: async () => { calls += 1; return {}; },
  } }));
  assert.equal(result.is_error, true);
  assert.match(result.content, /answer_invalid|invalid_request|invalid/i);
  assert.equal(calls, 0);
});

test('JSON metadata validation preserves dangerous keys without prototype mutation', () => {
  const metadata = JSON.parse('{"__proto__":{"polluted":true},"safe":1}') as Record<string, unknown>;
  const validated = optionalJsonObject(metadata, 'metadata', 32_000)!;
  assert.equal(Object.getPrototypeOf(validated), null);
  assert.equal((validated.__proto__ as { polluted: boolean }).polluted, true);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  assert.equal(JSON.stringify(validated), '{"__proto__":{"polluted":true},"safe":1}');
});

test('runtime prompt teaches durable brain waits without obsolete short latency promises', () => {
  assert.match(CORE_RUNTIME_PROMPT, /ordinary (?:query )?attachment(?:s)? wait for up to 90 minutes/i);
  assert.match(CORE_RUNTIME_PROMPT, /PGS.*launch.*detached.*immediately/i);
  assert.match(CORE_RUNTIME_PROMPT, /brain_status \{action:"status",operationId:/i);
  assert.match(CORE_RUNTIME_PROMPT, /chat Stop.*detach.*durable/i);
  assert.match(CORE_RUNTIME_PROMPT, /only brain_status action:"cancel".*cancels/i);
  assert.match(CORE_RUNTIME_PROMPT, /verified operation activity.*renews.*turn lease/i);
  assert.match(CORE_RUNTIME_PROMPT, /own-brain health.*brain_status \{\}/i);
  assert.match(CORE_RUNTIME_PROMPT, /own-brain (?:search|lookup).*omit.*target/i);
  assert.match(CORE_RUNTIME_PROMPT, /never.*agent name.*brainId/i);
  assert.match(CORE_RUNTIME_PROMPT, /never invent.*operationId/i);
  assert.match(CORE_RUNTIME_PROMPT, /do not fall back.*direct COSMO/i);
  assert.doesNotMatch(CORE_RUNTIME_PROMPT, /brain_search[^\n]*~500ms/i);
  assert.doesNotMatch(CORE_RUNTIME_PROMPT, /brain_query[^\n]*1-6 min/i);
  assert.doesNotMatch(CORE_RUNTIME_PROMPT, /PGS[^\n]*5-10\+ min/i);
});
