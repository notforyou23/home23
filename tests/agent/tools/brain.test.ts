import test from 'node:test';
import assert from 'node:assert/strict';
import {
  brainMemoryGraphTool,
  brainQueryExportTool,
  brainQueryTool,
  brainSearchTool,
  brainStatusTool,
  brainSynthesizeTool,
} from '../../../src/agent/tools/brain.js';
import type { BrainOperationsClient } from '../../../src/agent/brain-operations/client.js';
import { optionalJsonObject } from '../../../src/agent/brain-operations/input-validation.js';
import type { BrainOperationResult } from '../../../src/agent/brain-operations/types.js';
import type { ToolContext } from '../../../src/agent/types.js';
import {
  canonicalBrainTarget,
  makeBrainOperationRecord,
} from '../../helpers/brain-operation-record.js';

type BrainClientStub = Record<string, (...args: any[]) => any>;
type ContextOverrides = Omit<Partial<ToolContext>, 'brainOperations' | 'turnRuntime'> & {
  brainOperations?: BrainClientStub;
};

function makeCtx(overrides: ContextOverrides = {}): ToolContext {
  const { brainOperations = {}, ...contextOverrides } = overrides;
  const abortController = new AbortController();
  const startupSentinel = new Proxy({}, {
    get: (_target, key) => () => { throw new Error(`startup_global_client_used:${String(key)}`); },
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

test('brain_search uses the turn-scoped client and forwards an explicit sibling target', async () => {
  let request: Record<string, unknown> | null = null;
  let signal: AbortSignal | null = null;
  const result = await brainSearchTool.execute({
    query: 'Find Forrest evidence', target: { agent: 'forrest' }, limit: 12,
  }, makeCtx({ brainOperations: {
    search: async (value: Record<string, unknown>, receivedSignal: AbortSignal) => {
      request = value;
      signal = receivedSignal;
      return { results: [{ id: 'n1', concept: 'evidence' }], operationId: 'op-search' };
    },
  } }));
  assert.deepEqual(request, {
    target: { agent: 'forrest' }, query: 'Find Forrest evidence', topK: 12,
  });
  assert.ok(signal);
  assert.match(result.content, /evidence/);
  assert.equal(result.metadata?.operationId, 'op-search');
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
    operationId: 'op-existing', resultHandle: 'brres_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    format: 'markdown',
  }, ctx);
  assert.deepEqual(canonicalRequest, {
    operationId: 'op-existing', resultHandle: 'brres_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    format: 'markdown',
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
  const result = await brainQueryTool.execute({ query: 'x', enablePGS: true }, makeCtx({
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

test('PGS request excludes query-only false defaults and preserves exact sweep fraction', async () => {
  let request: Record<string, unknown> | null = null;
  const operation = completeOperation('op-pgs-projection', 'answer');
  operation.operationType = 'pgs';
  await brainQueryTool.execute({
    query: 'x', mode: 'quick', enablePGS: true, pgsConfig: { sweepFraction: 0.25 },
  }, makeCtx({ brainOperations: {
    query: async (value: Record<string, unknown>) => { request = value; return operation; },
  } }));
  assert.deepEqual(request, {
    query: 'x', mode: 'quick', enablePGS: true, pgsMode: 'full',
    pgsConfig: { sweepFraction: 0.25 },
  });
  for (const key of ['modelSelection', 'enableSynthesis', 'includeOutputs', 'includeThoughts',
    'includeCoordinatorInsights', 'allowActions']) {
    assert.equal(key in (request || {}), false);
  }
});

test('PGS with no useful sweeps is all_failed and is_error true', async () => {
  const failed = failedOperation('op-pgs-all-failed', 'provider_failed');
  failed.operationType = 'pgs';
  failed.result = { answer: null, sweepOutputs: [],
    metadata: { pgs: { successfulSweeps: 0, retryablePartitions: ['sweep-1', 'sweep-2'] } } };
  const result = await brainQueryTool.execute({ query: 'x', enablePGS: true }, makeCtx({
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
    const result = await brainQueryTool.execute({ query: 'x', enablePGS: true }, makeCtx({
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
  const result = await brainQueryTool.execute({ query: 'x', enablePGS: true }, makeCtx({
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
  assert.match(result.content, /brain_status.*wait/i);
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
  const sourceChanged = failedOperation('op-source-changed', 'source_changed');
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
    action: 'reattach', operationId: 'op-source-changed',
  }, ctx);
  assert.deepEqual(reattached, ['op-source-changed']);
  assert.equal(resumed.is_error, true);
  assert.match(resumed.content, /source_changed/);
  assert.doesNotMatch(resumed.content, /generation.*complete/i);
  assert.equal(starts, 0);
});

test('brain_status exposes status, result, wait, and exact cancel by operation ID', async () => {
  const inspected: string[] = [];
  const resumed: string[] = [];
  const running = completeOperation('op-control', '');
  running.state = 'running';
  running.attachmentState = 'detached';
  const ctx = makeCtx({ brainOperations: {
    inspectOperation: async (operationId: string, action: string) => {
      inspected.push(`${operationId}:${action}`);
      return action === 'result'
        ? { operationId, state: 'complete', result: { answer: 'stored' }, resultHandle: null,
          resultArtifact: null, error: null, sourceEvidence: null }
        : { ...running, state: action === 'cancel' ? 'cancelled' : 'running' };
    },
    resumeOperation: async (operationId: string) => { resumed.push(operationId); return running; },
  } });
  for (const action of ['status', 'result', 'cancel'] as const) {
    await brainStatusTool.execute({ operationId: 'op-control', action }, ctx);
  }
  const waited = await brainStatusTool.execute({ operationId: 'op-control', action: 'wait' }, ctx);
  assert.deepEqual(inspected, ['op-control:status', 'op-control:result', 'op-control:cancel']);
  assert.deepEqual(resumed, ['op-control']);
  assert.match(waited.content, /running|Detached/i);
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
    { query: 'x', enablePGS: false, pgsMode: 'full' },
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

test('JSON metadata validation preserves dangerous keys without prototype mutation', () => {
  const metadata = JSON.parse('{"__proto__":{"polluted":true},"safe":1}') as Record<string, unknown>;
  const validated = optionalJsonObject(metadata, 'metadata', 32_000)!;
  assert.equal(Object.getPrototypeOf(validated), null);
  assert.equal((validated.__proto__ as { polluted: boolean }).polluted, true);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  assert.equal(JSON.stringify(validated), '{"__proto__":{"polluted":true},"safe":1}');
});
