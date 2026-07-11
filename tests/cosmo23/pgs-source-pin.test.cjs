'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { PGSEngine } = require('../../cosmo23/pgs-engine/src');
const { createOperationScratchQuota } = require('../../shared/memory-source/scratch-quota.cjs');

function catalog() {
  const row = id => ({
    id, kind: 'chat', maxOutputTokens: 512, providerStallMs: 900_000,
    transport: 'responses',
  });
  return {
    version: 1,
    providers: {
      sweep: { models: [row('shared-model')] },
      synth: { models: [row('shared-model')] },
    },
    defaults: {},
  };
}

function sourcePin({ nodeCount = 12 } = {}) {
  let releases = 0;
  const edgeCount = Math.max(0, nodeCount - 1);
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    id: `n${index}`,
    clusterId: `cluster-${index % 2}`,
    content: `pinned evidence ${index}`,
  }));
  return {
    revision: 5,
    descriptor: {
      version: 1,
      canonicalRoot: '/synthetic/brain',
      generation: 'g5',
      baseRevision: 5,
      cutoffRevision: 5,
      summary: { nodeCount: nodes.length, edgeCount, clusterCount: nodeCount ? 2 : 0 },
      activeBase: {
        nodes: { file: 'nodes.gz', count: nodes.length, bytes: 1 },
        edges: { file: 'edges.gz', count: edgeCount, bytes: 1 },
      },
      activeDelta: {
        epoch: 'e1', file: 'delta', fromRevision: 6, toRevision: 5,
        count: 0, committedBytes: 0,
      },
    },
    async *iterateNodes({ signal } = {}) {
      for (const node of nodes) {
        if (signal?.aborted) throw signal.reason;
        yield node;
      }
    },
    async *iterateEdges({ signal } = {}) {
      for (let index = 0; index < edgeCount; index += 1) {
        if (signal?.aborted) throw signal.reason;
        yield { source: `n${index}`, target: `n${index + 1}`, type: 'next' };
      }
    },
    getEvidence(extra) {
      return { sourceHealth: 'healthy', deltaWatermark: { revision: 5 }, ...extra };
    },
    async release() { releases += 1; },
    releaseCount() { return releases; },
    loadAll() { throw new Error('materializer forbidden'); },
    loadState() { throw new Error('materializer forbidden'); },
  };
}

async function scratchFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-pgs-operation-'));
  const operationRoot = path.join(root, 'instances', 'jerry', 'runtime', 'brain-operations', 'op-pgs');
  const scratchDir = path.join(operationRoot, 'scratch');
  await fs.mkdir(scratchDir, { recursive: true });
  const quota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 64 * 1024 * 1024,
  });
  t.after(async () => {
    quota.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, operationRoot, scratchDir, quota };
}

const limits = {
  maxScratchBytes: 64 * 1024 * 1024,
  minFreeScratchBytes: 1,
  maxTransactionRecords: 10,
  maxTransactionBytes: 1024 * 1024,
  maxNodesPerWorkUnit: 2,
  maxContextCharsPerWorkUnit: 4096,
  maxSelectedWorkUnits: 16,
  maxSweepOutputBytes: 16 * 1024,
  maxTotalSweepOutputBytes: 128 * 1024,
  maxSynthesisInputBytes: 256 * 1024,
  maxSynthesisOutputBytes: 64 * 1024,
  maxResultBytes: 512 * 1024,
};

function makeEngine({
  pending = false,
  sweepOutput = null,
  synthesisOutput = null,
  enforceOutputBytes = false,
} = {}) {
  const events = [];
  const calls = [];
  const sweepClient = {
    providerId: 'sweep',
    async generate(options) {
      calls.push({ phase: 'sweep', options });
      options.onProviderActivity({ type: 'response.output_text.delta', at: '2000-01-01T00:00:00Z' });
      const content = sweepOutput
        ?? `finding for ${JSON.parse(JSON.stringify(options.input)).slice(0, 24)}`;
      if (enforceOutputBytes && Buffer.byteLength(content, 'utf8') > options.maxOutputBytes) {
        throw Object.assign(new Error('bounded sweep adapter rejected output'), {
          code: 'result_too_large', retryable: false,
        });
      }
      return {
        content,
        terminalReceived: true,
        finishReason: 'completed',
        hadError: false,
        provider: 'sweep',
        model: 'shared-model',
      };
    },
  };
  const synthClient = {
    providerId: 'synth',
    async generate(options) {
      calls.push({ phase: 'synth', options });
      const content = synthesisOutput ?? 'final pinned synthesis';
      if (enforceOutputBytes && Buffer.byteLength(content, 'utf8') > options.maxOutputBytes) {
        throw Object.assign(new Error('bounded synthesis adapter rejected output'), {
          code: 'result_too_large', retryable: false,
        });
      }
      return {
        content,
        terminalReceived: true,
        finishReason: 'completed',
        hadError: false,
        provider: 'synth',
        model: 'shared-model',
      };
    },
  };
  const engine = new PGSEngine({
    modelCatalog: catalog(),
    providerRegistry: {
      get(provider) { return provider === 'sweep' ? sweepClient : synthClient; },
    },
  });
  return { engine, events, calls, pending };
}

function options(pin, scratch, extra = {}) {
  return {
    sourcePin: pin,
    scratchDir: scratch.scratchDir,
    scratchQuota: scratch.quota,
    query: 'What does the pinned evidence show?',
    pgsSweep: { provider: 'sweep', model: 'shared-model' },
    pgsSynth: { provider: 'synth', model: 'shared-model' },
    signal: new AbortController().signal,
    reportEvent: extra.reportEvent,
    pgsConfig: extra.pgsConfig || { sweepFraction: 1 },
    limits,
  };
}

function singleWorkStore() {
  let committed = false;
  return {
    stats: { nodeCount: 1, edgeCount: 0, workUnitCount: 1 },
    snapshotPendingWorkUnits() { return ['p-c-one-u0000']; },
    beginWorkUnitAttempt() {},
    loadWorkUnit() {
      return {
        workUnitId: 'p-c-one-u0000', partitionId: 'c-one',
        nodes: [{ id: 'n1', content: 'one' }], edges: [],
      };
    },
    async commitSuccessfulSweeps() { committed = true; },
    listSuccessfulSweeps() {
      return committed ? [{
        workUnitId: 'p-c-one-u0000', partitionId: 'c-one',
        provider: 'sweep', model: 'shared-model', output: 'finding',
      }] : [];
    },
    listRetryablePartitions() { return []; },
    countPendingWorkUnits() { return committed ? 0 : 1; },
    recordRetryableFailure() {},
    close() {},
  };
}

test('pinned PGS keeps provider roles exact and returns machine-readable durable sweeps', async t => {
  const scratch = await scratchFixture(t);
  const pin = sourcePin();
  const fixture = makeEngine();
  const events = [];

  const envelope = await fixture.engine.runPinnedOperation(options(pin, scratch, {
    reportEvent: event => events.push(event),
  }));

  assert.equal(envelope.state, 'complete');
  assert.equal(envelope.result.answer, 'final pinned synthesis');
  assert.equal(envelope.result.sweepOutputs.length, 6);
  assert.equal(envelope.result.metadata.pgs.successfulSweeps, 6);
  assert.equal(envelope.result.metadata.pgs.pendingWorkUnits, 0);
  assert.equal(envelope.result.metadata.pgs.selectedWorkUnits, 6);
  assert.deepEqual(envelope.result.metadata.pgs.sourceTotals, {
    nodes: 12, edges: 11, workUnits: 6,
  });
  assert.deepEqual(envelope.result.metadata.pgs.retryablePartitions, []);
  assert.equal(envelope.result.sourceEvidence.deltaWatermark.revision, 5);
  assert.equal(envelope.resultArtifact, null);
  assert.equal(pin.releaseCount(), 0);
  assert.equal(fixture.calls.filter(call => call.phase === 'sweep').length, 6);
  assert.equal(fixture.calls.filter(call => call.phase === 'synth').length, 1);
  assert.equal(fixture.calls.every(call => call.options.maxOutputTokens === 512), true);
  assert.equal(fixture.calls
    .filter(call => call.phase === 'sweep')
    .every(call => call.options.maxOutputBytes === limits.maxSweepOutputBytes), true);
  assert.equal(fixture.calls.find(call => call.phase === 'synth').options.maxOutputBytes,
    limits.maxSynthesisOutputBytes);
  assert.equal(events.filter(event => event.type === 'provider_selected').length, 7);
  assert.equal(events.filter(event => event.type === 'provider_call_terminal').length, 7);
  assert.equal(events.every(event => event.type !== 'response.output_text.delta'), true);
  assert.equal(events.find(event => event.phase === 'pgs_sweep').provider, 'sweep');
  assert.equal(events.find(event => event.phase === 'pgs_synthesis').provider, 'synth');

  const receipts = await fs.readdir(path.join(scratch.scratchDir, 'pgs-receipts'));
  assert.equal(receipts.length, 1);
  const receiptPath = path.join(scratch.scratchDir, 'pgs-receipts', receipts[0]);
  const receiptStat = await fs.lstat(receiptPath);
  assert.equal(receiptStat.isFile(), true);
  assert.equal(receiptStat.isSymbolicLink(), false);
  assert.equal(receiptStat.nlink, 1);
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.match(receipt.attemptId, /^attempt-/);
  assert.equal(receipt.result.answer, 'final pinned synthesis');
});

test('pinned PGS enforces lowered sweep and synthesis byte ceilings inside provider adapters', async t => {
  const exactSweepBytes = 128;
  const exactSynthesisBytes = 192;

  for (const [phase, over] of [
    ['sweep', false],
    ['sweep', true],
    ['synthesis', false],
    ['synthesis', true],
  ]) {
    const scratch = await scratchFixture(t);
    const fixture = makeEngine({
      enforceOutputBytes: true,
      sweepOutput: 's'.repeat(exactSweepBytes + (phase === 'sweep' && over ? 1 : 0)),
      synthesisOutput: 'y'.repeat(
        exactSynthesisBytes + (phase === 'synthesis' && over ? 1 : 0),
      ),
    });
    const bounded = {
      ...limits,
      maxSweepOutputBytes: exactSweepBytes,
      maxSynthesisOutputBytes: exactSynthesisBytes,
    };
    const run = fixture.engine.runPinnedOperation({
      ...options(sourcePin({ nodeCount: 1 }), scratch),
      limits: bounded,
    });

    if (over) {
      await assert.rejects(run, { code: 'result_too_large', retryable: false });
      const callPhase = phase === 'synthesis' ? 'synth' : phase;
      assert.equal(
        fixture.calls.filter(call => call.phase === callPhase).length,
        1,
        `${phase} over-limit call count`,
      );
      if (phase === 'sweep') {
        assert.equal(fixture.calls.some(call => call.phase === 'synth'), false);
      }
      const receipts = await fs.readdir(path.join(scratch.scratchDir, 'pgs-receipts'))
        .catch((error) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });
      assert.deepEqual(receipts, []);
    } else {
      const result = await run;
      assert.equal(result.state, 'complete');
      assert.equal(fixture.calls.find(call => call.phase === 'sweep').options.maxOutputBytes,
        exactSweepBytes);
      assert.equal(fixture.calls.find(call => call.phase === 'synth').options.maxOutputBytes,
        exactSynthesisBytes);
    }
  }
});

test('pinned PGS rejects a redirected receipt directory before provider work', async t => {
  const scratch = await scratchFixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-pgs-receipt-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(scratch.scratchDir, 'pgs-receipts'));
  const fixture = makeEngine();
  fixture.engine.openPinnedPGSStore = async () => singleWorkStore();

  await assert.rejects(
    () => fixture.engine.runPinnedOperation(options(sourcePin({ nodeCount: 1 }), scratch)),
    { code: 'invalid_request' },
  );
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('pinned PGS removes only its exact receipt temporary on cancellation', async t => {
  const scratch = await scratchFixture(t);
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel receipt publication'), { code: 'cancelled' });
  let reconciles = 0;
  const quota = {
    operationRoot: scratch.quota.operationRoot,
    async assertOperationRoot(candidate) {
      return scratch.quota.assertOperationRoot(candidate);
    },
    async reconcile() {
      reconciles += 1;
      if (reconciles === 1) controller.abort(reason);
      return scratch.quota.reconcile();
    },
  };
  const fixture = makeEngine();
  fixture.engine.openPinnedPGSStore = async () => singleWorkStore();

  await assert.rejects(
    () => fixture.engine.runPinnedOperation({
      ...options(sourcePin({ nodeCount: 1 }), scratch),
      scratchQuota: quota,
      signal: controller.signal,
    }),
    error => error === reason,
  );
  assert.equal(reconciles >= 2, true);
  assert.deepEqual(await fs.readdir(path.join(scratch.scratchDir, 'pgs-receipts')), []);
});

test('PGS receipt publication uses an atomic no-replace filesystem primitive', async () => {
  const source = await fs.readFile(
    path.resolve(__dirname, '../../cosmo23/pgs-engine/src/pinned-operation.js'),
    'utf8',
  );
  const start = source.indexOf('async function writeSuccessReceipt');
  const end = source.indexOf('async function runPinnedOperation', start);
  const writer = source.slice(start, end);
  assert.match(writer, /await fsp\.link\(temporary, destination\)/);
  assert.doesNotMatch(writer, /fsp\.rename\(temporary, destination\)/);
});

test('empty pinned source fails honestly without provider work', async t => {
  const scratch = await scratchFixture(t);
  const pin = sourcePin({ nodeCount: 0 });
  const fixture = makeEngine();

  const envelope = await fixture.engine.runPinnedOperation(options(pin, scratch));

  assert.equal(envelope.state, 'failed');
  assert.equal(envelope.error.code, 'source_empty');
  assert.equal(envelope.error.retryable, false);
  assert.deepEqual(envelope.result.sweepOutputs, []);
  assert.deepEqual(envelope.result.metadata.pgs.sourceTotals, {
    nodes: 0, edges: 0, workUnits: 0,
  });
  assert.equal(fixture.calls.length, 0);
  assert.equal(pin.releaseCount(), 0);
});

test('PGS requires exact client and completion provider identities', async t => {
  for (const [name, sweepClient, expectedCalls] of [
    ['missing client provider', {
      async generate() { throw new Error('unreachable'); },
    }, 0],
    ['mismatched client provider', {
      providerId: 'synth', async generate() { throw new Error('unreachable'); },
    }, 0],
    ['missing completion provider', {
      providerId: 'sweep', async generate() {
        return {
          content: 'finding', terminalReceived: true, finishReason: 'completed',
          hadError: false, provider: null, model: 'shared-model',
        };
      },
    }, 1],
    ['mismatched completion model', {
      providerId: 'sweep', async generate() {
        return {
          content: 'finding', terminalReceived: true, finishReason: 'completed',
          hadError: false, provider: 'sweep', model: 'wrong-model',
        };
      },
    }, 1],
  ]) {
    const scratch = await scratchFixture(t);
    let calls = 0;
    const wrappedSweep = {
      ...sweepClient,
      async generate(options) {
        calls += 1;
        return sweepClient.generate(options);
      },
    };
    const engine = new PGSEngine({
      modelCatalog: catalog(),
      providerRegistry: {
        get(provider) {
          if (provider === 'sweep') return wrappedSweep;
          return {
            providerId: 'synth',
            async generate() {
              return {
                content: 'synthesis', terminalReceived: true, finishReason: 'completed',
                hadError: false, provider: 'synth', model: 'shared-model',
              };
            },
          };
        },
      },
    });
    await assert.rejects(
      engine.runPinnedOperation(options(sourcePin({ nodeCount: 2 }), scratch)),
      error => error.code === 'provider_model_mismatch',
      name,
    );
    if (expectedCalls === 0) assert.equal(calls, 0, name);
    else assert.equal(calls > 0, true, name);
  }
});

test('pinned PGS rejects caller-controlled concurrency before store or provider work', async t => {
  const scratch = await scratchFixture(t);
  const fixture = makeEngine();
  let storeCalls = 0;
  fixture.engine.openPinnedPGSStore = async () => {
    storeCalls += 1;
    return singleWorkStore();
  };

  await assert.rejects(
    fixture.engine.runPinnedOperation(options(sourcePin({ nodeCount: 1 }), scratch, {
      pgsConfig: { sweepFraction: 1, maxConcurrentSweeps: 4 },
    })),
    error => error.code === 'invalid_request',
  );
  assert.equal(storeCalls, 0);
  assert.equal(fixture.calls.length, 0);
});

test('fractional run is honestly partial and a retry executes only pending work', async t => {
  const scratch = await scratchFixture(t);
  const pin = sourcePin();
  const first = makeEngine();
  const partial = await first.engine.runPinnedOperation(options(pin, scratch, {
    pgsConfig: { sweepFraction: 0.5 },
  }));
  assert.equal(partial.state, 'partial');
  assert.equal(partial.error.code, 'pgs_partitions_incomplete');
  assert.equal(partial.result.metadata.pgs.successfulSweeps, 3);
  assert.equal(partial.result.metadata.pgs.pendingWorkUnits, 3);

  const retry = makeEngine();
  const complete = await retry.engine.runPinnedOperation(options(pin, scratch));
  assert.equal(complete.state, 'complete');
  assert.equal(complete.result.metadata.pgs.successfulSweeps, 6);
  assert.equal(retry.calls.filter(call => call.phase === 'sweep').length, 3);
  assert.equal(retry.calls.filter(call => call.phase === 'synth').length, 1);
});

test('cancellation during concurrent sweeps preserves the exact reason and starts no later work', async t => {
  const scratch = await scratchFixture(t);
  const pin = sourcePin();
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel pgs'), { code: 'cancelled' });
  let starts = 0;
  const events = [];
  const pendingClient = {
    providerId: 'sweep',
    generate({ signal }) {
      starts += 1;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  const engine = new PGSEngine({
    modelCatalog: catalog(),
    providerRegistry: {
      get(provider) {
        if (provider === 'sweep') return pendingClient;
        return { providerId: 'synth', generate() { throw new Error('synthesis must not run'); } };
      },
    },
  });
  const pending = engine.runPinnedOperation({
    ...options(pin, scratch, { reportEvent: event => events.push(event) }),
    signal: controller.signal,
  });
  while (starts < 2) await new Promise(resolve => setImmediate(resolve));
  controller.abort(reason);

  await assert.rejects(pending, error => error === reason);
  assert.equal(starts, 2);
  assert.equal(events.filter(event => event.outcome === 'cancelled').length, 2);
  assert.equal(pin.releaseCount(), 0);
});
