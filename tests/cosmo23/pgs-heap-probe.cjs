'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const v8 = require('node:v8');
const { spawnSync } = require('node:child_process');

const {
  HEAP_PROBE_LIMITS,
  createSyntheticPinnedSource,
} = require('./helpers/brain-operation-fixtures.cjs');

const POLICY = HEAP_PROBE_LIMITS.pgs;
const CHILD_ENV = 'HOME23_PGS_HEAP_CHILD';
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

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
  assert.equal(metrics.peakHeapDeltaBytes <= POLICY.maxHeapDeltaBytes, true,
    `${scenario} heap delta ${metrics.peakHeapDeltaBytes}`);
  assert.equal(metrics.peakRssDeltaBytes <= POLICY.maxRssDeltaBytes, true,
    `${scenario} RSS delta ${metrics.peakRssDeltaBytes}`);
  assert.equal(metrics.materializerCalls, 0);
}

function assertBoundedMetrics(row) {
  assert.equal(row.maxTransactionRecords <= row.limits.maxTransactionRecords, true);
  assert.equal(row.maxTransactionBytes <= row.limits.maxTransactionBytes, true);
  assert.equal(row.maxBuildRetainedRecords <= row.limits.maxTransactionRecords, true);
  assert.equal(row.maxWorkUnitRetainedRecords <= row.limits.maxNodesPerWorkUnit, true);
  assert.equal(row.peakScratchBytes <= row.limits.maxScratchBytes, true);
  assert.equal(row.maxSweepOutputBytes <= row.limits.maxSweepOutputBytes, true);
  assert.equal(row.totalSweepOutputBytes <= row.limits.maxTotalSweepOutputBytes, true);
  assert.equal(row.maxSynthesisInputBytes <= row.limits.maxSynthesisInputBytes, true);
  assert.equal(row.maxSynthesisOutputBytes <= row.limits.maxSynthesisOutputBytes, true);
  assert.equal(row.resultBytes <= row.limits.maxResultBytes, true);
}

function runParent() {
  assert.equal(typeof global.gc, 'function', 'PGS heap probe parent requires --expose-gc');
  const scenarios = [
    'scale-partial',
    'complete',
    'adversarial-output',
    'source-context-over',
    'output-over',
    'low-quota',
  ];
  const results = [];
  for (const scenario of scenarios) {
    const timeout = scenario === 'scale-partial' ? 20 * 60 * 1000 : 5 * 60 * 1000;
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
      maxBuffer: 8 * MiB,
      timeout,
    });
    assert.equal(child.status, 0,
      `${scenario} PGS heap child failed:\n${child.stderr}\n${child.stdout}`);
    const metrics = parseSingleJsonLine(child.stdout, scenario);
    assertCappedChild(metrics, scenario);
    results.push(metrics);
  }

  const scale = results.find(row => row.scenario === 'scale-partial');
  assert.equal(scale.typedOutcome, 'partial');
  assert.equal(scale.errorCode, 'pgs_partitions_incomplete');
  assert.equal(scale.recordsScanned, 4_000_000);
  assert.equal(scale.nodeRecordsScanned, 1_000_000);
  assert.equal(scale.edgeRecordsScanned, 3_000_000);
  assert.equal(scale.maxOutstandingRecords <= 1, true);
  assert.equal(scale.sqliteRows.nodes, 1_000_000);
  assert.equal(scale.sqliteRows.edges, 3_000_000);
  assert.equal(scale.sqliteRows.workUnits, scale.workUnitCount);
  assert.equal(scale.sqliteRows.successfulSweeps, 64);
  assert.equal(scale.selectedWorkUnits, 64);
  assert.equal(scale.successfulSweeps, 64);
  assert.equal(scale.pendingWorkUnits, scale.workUnitCount - 64);
  assert.equal(scale.sweepProviderCalls, 64);
  assert.equal(scale.synthesisProviderCalls, 1);
  assert.equal(scale.storeClosed, true);
  assertBoundedMetrics(scale);

  const complete = results.find(row => row.scenario === 'complete');
  assert.equal(complete.typedOutcome, 'complete');
  assert.equal(complete.errorCode, null);
  assert.equal(complete.pendingWorkUnits, 0);
  assert.equal(complete.sqliteRows.successfulSweeps, complete.workUnitCount);
  assert.equal(complete.successReceiptCount, 1);
  assertBoundedMetrics(complete);

  const adversarial = results.find(row => row.scenario === 'adversarial-output');
  assert.equal(adversarial.typedOutcome, 'partial');
  assert.equal(adversarial.errorCode, 'result_too_large');
  assert.equal(adversarial.successfulSweeps, 64);
  assert.equal(adversarial.totalSweepOutputBytes >= 15 * MiB, true);
  assert.equal(adversarial.synthesisProviderCalls, 0);
  assert.equal(adversarial.successReceiptCount, 0);
  assertBoundedMetrics(adversarial);

  const sourceOver = results.find(row => row.scenario === 'source-context-over');
  assert.equal(sourceOver.typedOutcome, 'result_too_large');
  assert.equal(sourceOver.sweepProviderCalls, 0);
  assert.equal(sourceOver.synthesisProviderCalls, 0);
  assert.equal(sourceOver.successReceiptCount, 0);

  const outputOver = results.find(row => row.scenario === 'output-over');
  assert.equal(outputOver.typedOutcome, 'result_too_large');
  assert.equal(outputOver.sweepProviderCalls > 0, true);
  assert.equal(outputOver.synthesisProviderCalls, 0);
  assert.equal(outputOver.successReceiptCount, 0);

  const lowQuota = results.find(row => row.scenario === 'low-quota');
  assert.equal(lowQuota.typedOutcome, 'result_too_large');
  assert.equal(lowQuota.peakScratchBytes > 0, true);
  assert.equal(lowQuota.peakDbBytes > 0, true);
  assert.equal(lowQuota.peakScratchBytes <= lowQuota.limits.maxScratchBytes, true);
  assert.equal(lowQuota.synthesisProviderCalls, 0);
  assert.equal(lowQuota.successReceiptCount, 0);

  process.stdout.write(`${JSON.stringify({
    probe: 'pgs-heap-v1',
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

function walkRegularFiles(root) {
  const rows = [];
  function visit(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) rows.push({ path: absolute, size: fs.statSync(absolute).size });
    }
  }
  visit(root);
  return rows;
}

function createSampler(scratchDir) {
  global.gc();
  const baseline = process.memoryUsage();
  let peakHeapUsed = baseline.heapUsed;
  let peakRss = baseline.rss;
  let peakScratchBytes = 0;
  let peakDbBytes = 0;
  let peakWalBytes = 0;
  let peakShmBytes = 0;
  function sample() {
    const usage = process.memoryUsage();
    peakHeapUsed = Math.max(peakHeapUsed, usage.heapUsed);
    peakRss = Math.max(peakRss, usage.rss);
    const files = walkRegularFiles(scratchDir);
    let scratchBytes = 0;
    let dbBytes = 0;
    let walBytes = 0;
    let shmBytes = 0;
    for (const row of files) {
      scratchBytes += row.size;
      const basename = path.basename(row.path);
      if (basename.includes('projection.sqlite')) {
        if (basename.endsWith('-wal')) walBytes += row.size;
        else if (basename.endsWith('-shm')) shmBytes += row.size;
        else dbBytes += row.size;
      }
    }
    peakScratchBytes = Math.max(peakScratchBytes, scratchBytes);
    peakDbBytes = Math.max(peakDbBytes, dbBytes);
    peakWalBytes = Math.max(peakWalBytes, walBytes);
    peakShmBytes = Math.max(peakShmBytes, shmBytes);
  }
  sample();
  return {
    sample,
    metrics() {
      return {
        baselineHeapUsedBytes: baseline.heapUsed,
        baselineRssBytes: baseline.rss,
        peakHeapUsedBytes: peakHeapUsed,
        peakRssBytes: peakRss,
        peakHeapDeltaBytes: Math.max(0, peakHeapUsed - baseline.heapUsed),
        peakRssDeltaBytes: Math.max(0, peakRss - baseline.rss),
        peakScratchBytes,
        peakDbBytes,
        peakWalBytes,
        peakShmBytes,
      };
    },
  };
}

function catalog() {
  const model = id => ({
    id,
    kind: 'chat',
    maxOutputTokens: 512,
    contextWindowTokens: 272_000,
    providerStallMs: 900_000,
    transport: 'responses',
  });
  return {
    version: 1,
    providers: {
      'controlled-sweep': { models: [model('controlled-sweep-model')] },
      'controlled-synth': { models: [model('controlled-synth-model')] },
    },
    defaults: {},
  };
}

function scenarioConfig(scenario) {
  const production = {
    maxRecordBytes: 256 * 1024,
    maxTransactionRecords: 1_000,
    maxTransactionBytes: 8 * MiB,
    maxScratchBytes: 2 * GiB,
    minFreeScratchBytes: 1 * GiB,
    maxSelectedWorkUnits: 64,
    maxNodesPerWorkUnit: 250,
    maxContextCharsPerWorkUnit: 128_000,
    maxSweepOutputBytes: 256 * 1024,
    maxTotalSweepOutputBytes: 16 * MiB,
    maxSynthesisInputBytes: 16 * MiB,
    maxSynthesisOutputBytes: 2 * MiB,
    maxResultBytes: 24 * MiB,
  };
  if (scenario === 'scale-partial') {
    return {
      nodeCount: 1_000_000, edgeCount: 3_000_000, clusterCount: 256, limits: production,
    };
  }
  if (scenario === 'complete') {
    return { nodeCount: 16_000, edgeCount: 48_000, clusterCount: 64, limits: production };
  }
  if (scenario === 'adversarial-output') {
    return {
      nodeCount: 64,
      edgeCount: 192,
      clusterCount: 64,
      sweepOutputBytes: 250 * 1024,
      synthesisOutputBytes: Math.floor(1.5 * MiB),
      limits: { ...production, maxScratchBytes: 256 * MiB, minFreeScratchBytes: 1 },
    };
  }
  if (scenario === 'source-context-over') {
    return {
      nodeCount: 1,
      edgeCount: 0,
      clusterCount: 1,
      sourceContentBytes: (255 * 1024),
      limits: { ...production, maxScratchBytes: 128 * MiB, minFreeScratchBytes: 1 },
    };
  }
  if (scenario === 'output-over') {
    return {
      nodeCount: 2,
      edgeCount: 1,
      clusterCount: 2,
      sweepOutputBytes: 1_025,
      limits: {
        ...production,
        maxScratchBytes: 128 * MiB,
        minFreeScratchBytes: 1,
        maxSweepOutputBytes: 1_024,
        maxTotalSweepOutputBytes: 8 * 1024,
      },
    };
  }
  if (scenario === 'low-quota') {
    return {
      nodeCount: 10_000,
      edgeCount: 30_000,
      clusterCount: 256,
      limits: {
        ...production,
        maxScratchBytes: 1 * MiB,
        minFreeScratchBytes: 1,
        maxTransactionRecords: 100,
        maxTransactionBytes: 256 * 1024,
      },
    };
  }
  throw new Error(`unknown PGS heap scenario: ${scenario}`);
}

async function createScratch(limits) {
  const {
    createOperationScratchQuota,
    durableBrainOperationRoot,
  } = require('../../shared/memory-source/index.cjs');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-pgs-heap-'));
  await fsp.chmod(root, 0o700);
  const operationId = `brop_${'p'.repeat(32)}`;
  const operationRoot = durableBrainOperationRoot(root, 'probe', operationId);
  const scratchDir = path.join(operationRoot, 'scratch');
  await fsp.mkdir(scratchDir, { recursive: true, mode: 0o700 });
  const quota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: limits.maxScratchBytes,
    // The probe owns the only quota handle in its private temp root. Avoid an
    // OS process-table lookup at every 1,000-record checkpoint while retaining
    // the real quota ledger, reconciliation, WAL/SHM accounting, and cleanup.
    isProcessAlive: async () => true,
    lockRetryMs: 1,
  });
  return {
    root,
    operationRoot,
    scratchDir,
    quota,
    async cleanup() {
      quota.close();
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

function findDatabase(scratchDir) {
  return walkRegularFiles(scratchDir)
    .map(row => row.path)
    .find(file => path.basename(file) === 'projection.sqlite') || null;
}

function countSuccessReceipts(scratchDir) {
  const receiptDir = path.join(scratchDir, 'pgs-receipts');
  try {
    return fs.readdirSync(receiptDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json')).length;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

async function runScenario(scenario, config, scratch, sampler) {
  const Database = require('better-sqlite3');
  const { PGSEngine } = require('../../cosmo23/pgs-engine/src/index.js');
  const {
    openPinnedPGSStore,
  } = require('../../cosmo23/pgs-engine/src/pinned-store.js');
  let sweepProviderCalls = 0;
  let synthesisProviderCalls = 0;
  let maxSweepOutputBytes = 0;
  let totalSweepOutputBytes = 0;
  let maxSynthesisInputBytes = 0;
  let maxSynthesisOutputBytes = 0;
  let capturedStoreStats = null;
  let maxWorkUnitRetainedRecords = 0;
  let storeClosed = false;

  const sweepClient = {
    providerId: 'controlled-sweep',
    async generate(options) {
      sweepProviderCalls += 1;
      sampler.sample();
      options.onProviderActivity?.({ type: 'controlled_sweep', at: new Date().toISOString() });
      const output = config.sweepOutputBytes
        ? 's'.repeat(config.sweepOutputBytes)
        : `controlled finding ${sweepProviderCalls}`;
      const bytes = Buffer.byteLength(output, 'utf8');
      maxSweepOutputBytes = Math.max(maxSweepOutputBytes, bytes);
      totalSweepOutputBytes += bytes;
      sampler.sample();
      return {
        content: output,
        terminalReceived: true,
        finishReason: 'completed',
        hadError: false,
        provider: 'controlled-sweep',
        model: 'controlled-sweep-model',
      };
    },
  };
  const synthClient = {
    providerId: 'controlled-synth',
    async generate(options) {
      synthesisProviderCalls += 1;
      maxSynthesisInputBytes = Math.max(
        maxSynthesisInputBytes,
        Buffer.byteLength(options.input, 'utf8'),
      );
      const output = config.synthesisOutputBytes
        ? 'y'.repeat(config.synthesisOutputBytes)
        : 'controlled PGS synthesis';
      maxSynthesisOutputBytes = Math.max(
        maxSynthesisOutputBytes,
        Buffer.byteLength(output, 'utf8'),
      );
      sampler.sample();
      return {
        content: output,
        terminalReceived: true,
        finishReason: 'completed',
        hadError: false,
        provider: 'controlled-synth',
        model: 'controlled-synth-model',
      };
    },
  };
  const registry = {
    get(provider) {
      return provider === 'controlled-sweep' ? sweepClient : synthClient;
    },
  };
  const engine = new PGSEngine({ providerRegistry: registry, modelCatalog: catalog() });
  engine.openPinnedPGSStore = async (input) => {
    const store = await openPinnedPGSStore(input);
    capturedStoreStats = { ...store.stats };
    return {
      sourceRevision: store.sourceRevision,
      descriptorDigest: store.descriptorDigest,
      databasePath: store.databasePath,
      reused: store.reused,
      stats: store.stats,
      snapshotPendingWorkUnits: input => store.snapshotPendingWorkUnits(input),
      beginWorkUnitAttempt: (id, input) => store.beginWorkUnitAttempt(id, input),
      loadWorkUnit(id, input) {
        const work = store.loadWorkUnit(id, input);
        maxWorkUnitRetainedRecords = Math.max(
          maxWorkUnitRetainedRecords,
          work.stats?.retainedRecords || work.nodes.length,
        );
        sampler.sample();
        return work;
      },
      commitSuccessfulSweeps: rows => store.commitSuccessfulSweeps(rows),
      listSuccessfulSweeps: () => store.listSuccessfulSweeps(),
      listRetryablePartitions: () => store.listRetryablePartitions(),
      countPendingWorkUnits: () => store.countPendingWorkUnits(),
      recordRetryableFailure: (id, error) => store.recordRetryableFailure(id, error),
      close() {
        storeClosed = true;
        store.close();
      },
    };
  };

  let maxSourceRecordBytes = 0;
  const nodeFactory = index => {
    const record = {
      id: `n${index}`,
      clusterId: `cluster-${index % config.clusterCount}`,
      content: config.sourceContentBytes
        ? 'x'.repeat(config.sourceContentBytes)
        : `pinned scale evidence ${index}`,
    };
    if (index === 0 || index === config.nodeCount - 1) {
      maxSourceRecordBytes = Math.max(
        maxSourceRecordBytes,
        Buffer.byteLength(JSON.stringify(record), 'utf8'),
      );
    }
    return record;
  };
  const edgeFactory = index => {
    const record = {
      source: `n${index % Math.max(1, config.nodeCount)}`,
      target: `n${(index + 1) % Math.max(1, config.nodeCount)}`,
      type: 'scale-edge',
    };
    if (index === 0 || index === config.edgeCount - 1) {
      maxSourceRecordBytes = Math.max(
        maxSourceRecordBytes,
        Buffer.byteLength(JSON.stringify(record), 'utf8'),
      );
    }
    return record;
  };
  const sourcePin = createSyntheticPinnedSource({
    nodeCount: config.nodeCount,
    edgeCount: config.edgeCount,
    nodeFactory,
    edgeFactory,
    onRecord(count) {
      const interval = scenario === 'low-quota' ? 100 : 10_000;
      if (count % interval === 0) sampler.sample();
    },
  });
  let envelope = null;
  let error = null;
  try {
    envelope = await engine.runPinnedOperation({
      sourcePin,
      scratchDir: scratch.scratchDir,
      scratchQuota: scratch.quota,
      query: 'What does the complete pinned scale source show?',
      pgsSweep: {
        provider: 'controlled-sweep', model: 'controlled-sweep-model',
      },
      pgsSynth: {
        provider: 'controlled-synth', model: 'controlled-synth-model',
      },
      pgsConfig: { sweepFraction: 1 },
      signal: new AbortController().signal,
      reportEvent() { sampler.sample(); },
      accessMode: 'read-only',
      mutationPolicy: 'read-only',
      limits: config.limits,
    });
  } catch (caught) {
    error = caught;
  }
  sampler.sample();
  const databasePath = findDatabase(scratch.scratchDir);
  let sqliteRows = null;
  if (databasePath) {
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    sqliteRows = {
      nodes: database.prepare('SELECT COUNT(*) AS count FROM nodes').get().count,
      edges: database.prepare('SELECT COUNT(*) AS count FROM edges').get().count,
      workUnits: database.prepare('SELECT COUNT(*) AS count FROM work_units').get().count,
      successfulSweeps: database.prepare(
        'SELECT COUNT(*) AS count FROM successful_sweeps',
      ).get().count,
    };
    database.close();
  }
  const resultBytes = envelope?.result
    ? Buffer.byteLength(JSON.stringify(envelope.result), 'utf8')
    : 0;
  global.gc();
  sampler.sample();
  return {
    sourcePin,
    envelope,
    error,
    sqliteRows,
    capturedStoreStats,
    maxWorkUnitRetainedRecords,
    storeClosed,
    sweepProviderCalls,
    synthesisProviderCalls,
    maxSourceRecordBytes,
    maxSweepOutputBytes,
    totalSweepOutputBytes,
    maxSynthesisInputBytes,
    maxSynthesisOutputBytes,
    resultBytes,
    successReceiptCount: countSuccessReceipts(scratch.scratchDir),
  };
}

async function runChild() {
  const scenario = process.env[CHILD_ENV];
  assert.equal([
    'scale-partial', 'complete', 'adversarial-output', 'source-context-over',
    'output-over', 'low-quota',
  ].includes(scenario), true, 'unknown PGS heap scenario');
  assert.equal(typeof global.gc, 'function', 'PGS heap child requires --expose-gc');
  const execArgvOldSpaceMiB = oldSpaceFromExecArgv();
  assert.equal(execArgvOldSpaceMiB, POLICY.maxOldSpaceMiB,
    'PGS heap child must use the reviewed old-space cap');
  const config = scenarioConfig(scenario);
  const scratch = await createScratch(config.limits);
  const sampler = createSampler(scratch.scratchDir);
  try {
    const outcome = await runScenario(scenario, config, scratch, sampler);
    const sourceStats = outcome.sourcePin.stats();
    const pgs = outcome.envelope?.result?.metadata?.pgs || {};
    const store = outcome.capturedStoreStats || {};
    const metrics = {
      probe: 'pgs-heap-child-v1',
      scenario,
      maxOldSpaceMiB: POLICY.maxOldSpaceMiB,
      execArgvOldSpaceMiB,
      heapSizeLimitMiB: Number((v8.getHeapStatistics().heap_size_limit / MiB).toFixed(3)),
      gcExposed: typeof global.gc === 'function',
      limits: config.limits,
      ...sampler.metrics(),
      recordsScanned: sourceStats.recordsConsumed,
      nodeRecordsScanned: sourceStats.nodeRecordsConsumed,
      edgeRecordsScanned: sourceStats.edgeRecordsConsumed,
      maxOutstandingRecords: sourceStats.maxOutstandingRecords,
      materializerCalls: sourceStats.materializerCalls,
      maxSourceRecordBytes: outcome.maxSourceRecordBytes,
      maxTransactionRecords: store.maxTransactionRecords || 0,
      maxTransactionBytes: store.maxTransactionBytes || 0,
      maxBuildRetainedRecords: store.maxRetainedRecords || 0,
      maxWorkUnitRetainedRecords: outcome.maxWorkUnitRetainedRecords,
      nodeCount: store.nodeCount ?? null,
      edgeCount: store.edgeCount ?? null,
      workUnitCount: store.workUnitCount ?? null,
      sqliteRows: outcome.sqliteRows,
      sweepProviderCalls: outcome.sweepProviderCalls,
      synthesisProviderCalls: outcome.synthesisProviderCalls,
      maxSweepOutputBytes: outcome.maxSweepOutputBytes,
      totalSweepOutputBytes: outcome.totalSweepOutputBytes,
      maxSynthesisInputBytes: outcome.maxSynthesisInputBytes,
      maxSynthesisOutputBytes: outcome.maxSynthesisOutputBytes,
      resultBytes: outcome.resultBytes,
      selectedWorkUnits: pgs.selectedWorkUnits ?? null,
      successfulSweeps: pgs.successfulSweeps ?? null,
      pendingWorkUnits: pgs.pendingWorkUnits ?? null,
      successReceiptCount: outcome.successReceiptCount,
      storeClosed: outcome.storeClosed,
      typedOutcome: outcome.error?.code || outcome.envelope?.state || 'unknown',
      errorCode: outcome.error?.code || outcome.envelope?.error?.code || null,
      errorMessage: outcome.error?.message || outcome.envelope?.error?.message || null,
    };
    process.stdout.write(`${JSON.stringify(metrics)}\n`);
  } finally {
    await scratch.cleanup();
  }
}

if (process.env[CHILD_ENV]) {
  runChild().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
} else {
  runParent();
}
