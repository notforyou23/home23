'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const v8 = require('node:v8');
const { spawnSync } = require('node:child_process');

const {
  HEAP_PROBE_LIMITS,
  createSyntheticPinnedSource,
} = require('./helpers/brain-operation-fixtures.cjs');

const POLICY = HEAP_PROBE_LIMITS.query;
const CHILD_ENV = 'HOME23_QUERY_HEAP_CHILD';
const EXPECTED_RECORDS = 4_000_000;

function parseSingleJsonLine(stdout, scenario) {
  const lines = String(stdout).trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `${scenario} must print exactly one JSON line`);
  return JSON.parse(lines[0]);
}

function assertCappedChild(metrics, scenario) {
  assert.equal(metrics.scenario, scenario);
  assert.equal(metrics.maxOldSpaceMiB, POLICY.maxOldSpaceMiB);
  assert.equal(metrics.execArgvOldSpaceMiB, POLICY.maxOldSpaceMiB);
  assert.equal(metrics.gcExposed, true);
  assert.equal(Number.isFinite(metrics.heapSizeLimitMiB), true);
  assert.equal(metrics.peakHeapDeltaBytes <= POLICY.maxHeapDeltaBytes, true,
    `${scenario} heap delta ${metrics.peakHeapDeltaBytes}`);
  assert.equal(metrics.peakRssDeltaBytes <= POLICY.maxRssDeltaBytes, true,
    `${scenario} RSS delta ${metrics.peakRssDeltaBytes}`);
  assert.equal(metrics.materializerCalls, 0);
}

function runParent() {
  assert.equal(typeof global.gc, 'function', 'query heap probe parent requires --expose-gc');
  const scenarios = [
    'scale', 'jerry-shaped', 'adversarial', 'record-over', 'prompt-over',
    'result-over', 'cancellation',
  ];
  const results = [];
  for (const scenario of scenarios) {
    const child = spawnSync(process.execPath, [
      `--max-old-space-size=${POLICY.maxOldSpaceMiB}`,
      '--expose-gc',
      __filename,
    ], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        TMPDIR: process.env.TMPDIR || os.tmpdir(),
        ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}),
        [CHILD_ENV]: scenario,
      },
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 12 * 60 * 1000,
    });
    assert.equal(child.status, 0,
      `${scenario} query heap child failed:\n${child.stderr}\n${child.stdout}`);
    const metrics = parseSingleJsonLine(child.stdout, scenario);
    assertCappedChild(metrics, scenario);
    results.push(metrics);
  }

  const scale = results.find(row => row.scenario === 'scale');
  assert.equal(scale.recordsScanned, EXPECTED_RECORDS);
  assert.equal(scale.nodeRecordsScanned, 1_000_000);
  assert.equal(scale.edgeRecordsScanned, 3_000_000);
  assert.equal(scale.maxOutstandingRecords <= 1, true);
  assert.equal(scale.maxRetainedNodes <= 4_000, true);
  assert.equal(scale.maxRetainedEdges <= 16_000, true);
  assert.equal(scale.promptBytes <= 8 * 1024 * 1024, true);
  assert.equal(scale.resultBytes <= 8 * 1024 * 1024, true);
  assert.equal(scale.providerCalls, 1);
  assert.equal(scale.envelopeState, 'complete');
  assert.equal(scale.resultArtifact, null);
  assert.equal(Number.isSafeInteger(scale.sourceRevision), true);
  assert.equal(scale.typedOutcome, 'complete');

  const jerryShaped = results.find(row => row.scenario === 'jerry-shaped');
  assert.equal(jerryShaped.typedOutcome, 'complete');
  assert.equal(jerryShaped.providerCalls, 1);
  assert.equal(jerryShaped.envelopeState, 'complete');
  assert.equal(jerryShaped.maxRetainedNodes > 0, true);
  assert.equal(jerryShaped.maxRetainedNodes < 4_000, true);
  assert.equal(jerryShaped.promptBytes <= 8 * 1024 * 1024, true);
  assert.equal(jerryShaped.laterBoundaryCalls, 1);

  const adversarial = results.find(row => row.scenario === 'adversarial');
  assert.equal(['complete', 'result_too_large'].includes(adversarial.typedOutcome), true);
  assert.equal(adversarial.providerCalls, 1);
  if (adversarial.typedOutcome === 'complete') {
    assert.equal(adversarial.envelopeState, 'complete');
    assert.equal(adversarial.resultBytes <= 8 * 1024 * 1024, true);
    assert.equal(adversarial.laterBoundaryCalls, 1);
  } else {
    assert.equal(adversarial.laterBoundaryCalls, 0);
  }

  for (const scenario of ['record-over', 'prompt-over']) {
    const row = results.find(candidate => candidate.scenario === scenario);
    assert.equal(row.typedOutcome, 'result_too_large');
    assert.equal(row.providerCalls, 0);
    assert.equal(row.laterBoundaryCalls, 0);
  }
  const resultOver = results.find(row => row.scenario === 'result-over');
  assert.equal(resultOver.typedOutcome, 'result_too_large');
  assert.equal(resultOver.providerCalls, 1);
  assert.equal(resultOver.laterBoundaryCalls, 0);

  const cancellation = results.find(row => row.scenario === 'cancellation');
  assert.equal(cancellation.typedOutcome, 'cancelled');
  assert.equal(cancellation.abortIdentityPreserved, true);
  assert.equal(cancellation.recordsScanned < 200_000, true);
  assert.equal(cancellation.providerCalls, 0);

  process.stdout.write(`${JSON.stringify({
    probe: 'query-engine-heap-v1',
    policy: POLICY,
    scenarios: results,
  })}\n`);
}

function oldSpaceFromExecArgv() {
  const values = process.execArgv
    .map(value => /^--max-old-space-size=(\d+)$/.exec(value))
    .filter(Boolean)
    .map(match => Number(match[1]));
  return values.length === 1 ? values[0] : null;
}

function createSampler() {
  global.gc();
  const baseline = process.memoryUsage();
  let peakHeapUsed = baseline.heapUsed;
  let peakRss = baseline.rss;
  return {
    baseline,
    sample() {
      const usage = process.memoryUsage();
      peakHeapUsed = Math.max(peakHeapUsed, usage.heapUsed);
      peakRss = Math.max(peakRss, usage.rss);
    },
    metrics() {
      return {
        baselineHeapUsedBytes: baseline.heapUsed,
        baselineRssBytes: baseline.rss,
        peakHeapUsedBytes: peakHeapUsed,
        peakRssBytes: peakRss,
        peakHeapDeltaBytes: Math.max(0, peakHeapUsed - baseline.heapUsed),
        peakRssDeltaBytes: Math.max(0, peakRss - baseline.rss),
      };
    },
  };
}

function catalog() {
  return {
    version: 1,
    providers: {
      controlled: {
        models: [{
          id: 'controlled-query',
          kind: 'chat',
          maxOutputTokens: 256,
          contextWindowTokens: 128_000,
          providerStallMs: 900_000,
          transport: 'responses',
        }],
      },
    },
    defaults: {},
  };
}

function target() {
  const root = '/synthetic';
  return {
    domain: 'brain',
    brainId: 'brain-synthetic',
    canonicalRoot: root,
    accessMode: 'read-only',
    ownerAgent: 'fixture',
    displayName: 'Synthetic Brain',
    kind: 'resident',
    lifecycle: 'resident',
    catalogRevision: 'catalog-probe-1',
    route: '/api/brain/brain-synthetic',
    mutationBoundaries: ['brain', 'run', 'pgs', 'session', 'cache', 'export', 'agency']
      .map(kind => ({ kind, path: kind === 'brain' || kind === 'run' ? root : `${root}/${kind}` })),
  };
}

async function runCancellationScenario(sampler) {
  const { projectPinnedQuery } = require('../../cosmo23/lib/pinned-query-projection.js');
  const controller = new AbortController();
  const reason = Object.assign(new Error('query probe cancellation'), { code: 'cancelled' });
  const sourcePin = createSyntheticPinnedSource({
    nodeCount: 100_000,
    edgeCount: 100_000,
    onRecord(count) { if (count % 10_000 === 0) sampler.sample(); },
  });
  setImmediate(() => controller.abort(reason));
  let caught = null;
  try {
    await projectPinnedQuery({
      sourcePin,
      query: 'bounded canary',
      signal: controller.signal,
    });
  } catch (error) {
    caught = error;
  }
  global.gc();
  sampler.sample();
  return {
    sourcePin,
    result: null,
    providerCalls: 0,
    laterBoundaryCalls: 0,
    typedOutcome: caught?.code || caught?.name || 'unexpected_complete',
    abortIdentityPreserved: caught === reason,
  };
}

async function runQueryScenario(scenario, sampler) {
  const { QueryEngine } = require('../../cosmo23/lib/query-engine.js');
  const {
    createQueryOperationExecutor,
  } = require('../../cosmo23/server/lib/query-operation-worker.js');

  let providerCalls = 0;
  let laterBoundaryCalls = 0;
  const scale = scenario === 'scale';
  const jerryShaped = scenario === 'jerry-shaped';
  const adversarial = scenario === 'adversarial';
  const recordOver = scenario === 'record-over';
  const promptOver = scenario === 'prompt-over';
  const resultOver = scenario === 'result-over';
  const nodeCount = scale ? 1_000_000 : (jerryShaped || adversarial) ? 4_000 : 1;
  const edgeCount = scale ? 3_000_000 : (jerryShaped || adversarial) ? 16_000 : 0;
  const sourcePin = createSyntheticPinnedSource({
    nodeCount,
    edgeCount,
    nodeFactory: (jerryShaped || adversarial)
      ? index => ({
        id: `n${index}`,
        content: `bounded-canary-${index}-${'x'.repeat(20 * 1024)}`,
        salience: 1,
      })
      : recordOver
        ? () => ({ id: 'n0', content: 'x'.repeat((256 * 1024) + 1), salience: 1 })
        : null,
    edgeFactory: (jerryShaped || adversarial)
      ? index => ({
        source: `n${index % 4_000}`,
        target: `n${(index + 1) % 4_000}`,
        type: 'near-limit-edge',
      })
      : null,
    onRecord(count) {
      if (count % 10_000 === 0) sampler.sample();
    },
  });
  const providerClient = {
    providerId: 'controlled',
    async generate(options) {
      providerCalls += 1;
      sampler.sample();
      const content = resultOver
        ? 'r'.repeat(2_048)
        : adversarial ? 'r'.repeat(Math.floor(7.5 * 1024 * 1024)) : 'bounded answer';
      assert.equal(options.provider, 'controlled');
      assert.equal(options.model, 'controlled-query');
      return {
        provider: 'controlled',
        model: 'controlled-query',
        content,
        terminalReceived: true,
        finishReason: 'completed',
        hadError: false,
      };
    },
  };
  const engine = new QueryEngine({
    operationMode: true,
    providerRegistry: { get() { return providerClient; } },
    modelCatalog: catalog(),
  });
  const limits = promptOver
    ? { maxPromptBytes: 128 }
    : resultOver ? { maxResultBytes: 1_024 } : {};
  let result = null;
  let typedOutcome = 'complete';
  let errorMessage = null;
  try {
    if (promptOver || resultOver) {
      result = await engine.executeQuery('bounded canary', {
        sourcePin,
        modelSelection: { provider: 'controlled', model: 'controlled-query' },
        mutationPolicy: 'read-only',
        accessMode: 'read-only',
        allowActions: false,
        signal: new AbortController().signal,
        limits,
      });
      // This boundary is intentionally after canonical Query result validation.
      laterBoundaryCalls += 1;
    } else {
      const execute = createQueryOperationExecutor({ queryEngine: engine });
      result = await execute({
        operationId: `brop_${'q'.repeat(32)}`,
        operationType: 'query',
        requesterAgent: 'probe',
        target: target(),
        parameters: {
          query: 'bounded canary',
          modelSelection: { provider: 'controlled', model: 'controlled-query' },
        },
        scratchDir: '/synthetic/requester/scratch',
        scratchQuota: { probe: 'query-heap' },
        signal: new AbortController().signal,
        sourcePin,
        reportEvent() { sampler.sample(); },
      });
      laterBoundaryCalls += 1;
    }
    sampler.sample();
  } catch (error) {
    typedOutcome = error?.code || error?.name || 'Error';
    errorMessage = String(error?.message || error);
  }
  global.gc();
  sampler.sample();
  return {
    sourcePin, result, providerCalls, laterBoundaryCalls, typedOutcome, errorMessage,
  };
}

async function runChild() {
  const scenario = process.env[CHILD_ENV];
  assert.equal([
    'scale', 'jerry-shaped', 'adversarial', 'record-over', 'prompt-over',
    'result-over', 'cancellation',
  ].includes(scenario), true, 'unknown query heap scenario');
  assert.equal(typeof global.gc, 'function', 'query heap child requires --expose-gc');
  const execArgvOldSpaceMiB = oldSpaceFromExecArgv();
  assert.equal(execArgvOldSpaceMiB, POLICY.maxOldSpaceMiB,
    'query heap child must use the reviewed old-space cap');
  const sampler = createSampler();
  const outcome = scenario === 'cancellation'
    ? await runCancellationScenario(sampler)
    : await runQueryScenario(scenario, sampler);
  const stats = outcome.sourcePin.stats();
  const operationResult = outcome.result?.result || outcome.result;
  const projection = operationResult?.metadata?.projection || {};
  const sourceEvidence = outcome.result?.sourceEvidence || operationResult?.sourceEvidence || null;
  const metrics = {
    probe: 'query-engine-heap-child-v1',
    scenario,
    maxOldSpaceMiB: POLICY.maxOldSpaceMiB,
    execArgvOldSpaceMiB,
    heapSizeLimitMiB: Number((v8.getHeapStatistics().heap_size_limit / (1024 * 1024)).toFixed(3)),
    gcExposed: typeof global.gc === 'function',
    ...sampler.metrics(),
    recordsScanned: stats.recordsConsumed,
    nodeRecordsScanned: stats.nodeRecordsConsumed,
    edgeRecordsScanned: stats.edgeRecordsConsumed,
    maxOutstandingRecords: stats.maxOutstandingRecords,
    materializerCalls: stats.materializerCalls,
    maxRetainedNodes: projection.maxRetainedNodes || 0,
    maxRetainedEdges: projection.maxRetainedEdges || 0,
    promptBytes: operationResult?.metadata?.promptBytes || 0,
    resultBytes: operationResult
      ? Buffer.byteLength(JSON.stringify(operationResult), 'utf8')
      : 0,
    providerCalls: outcome.providerCalls,
    laterBoundaryCalls: outcome.laterBoundaryCalls,
    envelopeState: outcome.result?.state || (operationResult ? 'complete' : null),
    resultArtifact: outcome.result?.resultArtifact ?? operationResult?.resultArtifact ?? null,
    sourceRevision: sourceEvidence?.deltaWatermark?.revision ?? null,
    typedOutcome: outcome.typedOutcome,
    errorMessage: outcome.errorMessage ?? null,
    abortIdentityPreserved: outcome.abortIdentityPreserved ?? null,
  };
  process.stdout.write(`${JSON.stringify(metrics)}\n`);
}

if (process.env[CHILD_ENV]) {
  runChild().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
} else {
  runParent();
}
