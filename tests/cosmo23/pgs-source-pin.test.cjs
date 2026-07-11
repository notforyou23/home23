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

function sourcePin() {
  let releases = 0;
  const nodes = Array.from({ length: 12 }, (_, index) => ({
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
      summary: { nodeCount: nodes.length, edgeCount: 11, clusterCount: 2 },
      activeBase: {
        nodes: { file: 'nodes.gz', count: nodes.length, bytes: 1 },
        edges: { file: 'edges.gz', count: 11, bytes: 1 },
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
      for (let index = 0; index < 11; index += 1) {
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

function makeEngine({ pending = false } = {}) {
  const events = [];
  const calls = [];
  const sweepClient = {
    providerId: 'sweep',
    async generate(options) {
      calls.push({ phase: 'sweep', options });
      options.onProviderActivity({ type: 'response.output_text.delta', at: '2000-01-01T00:00:00Z' });
      return {
        content: `finding for ${JSON.parse(JSON.stringify(options.input)).slice(0, 24)}`,
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
      return {
        content: 'final pinned synthesis',
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
    pgsConfig: extra.pgsConfig || { sweepFraction: 1, maxConcurrentSweeps: 2 },
    limits,
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
  assert.deepEqual(envelope.result.metadata.pgs.retryablePartitions, []);
  assert.equal(envelope.result.sourceEvidence.deltaWatermark.revision, 5);
  assert.equal(envelope.resultArtifact, null);
  assert.equal(pin.releaseCount(), 0);
  assert.equal(fixture.calls.filter(call => call.phase === 'sweep').length, 6);
  assert.equal(fixture.calls.filter(call => call.phase === 'synth').length, 1);
  assert.equal(fixture.calls.every(call => call.options.maxOutputTokens === 512), true);
  assert.equal(events.filter(event => event.type === 'provider_selected').length, 7);
  assert.equal(events.filter(event => event.type === 'provider_call_terminal').length, 7);
  assert.equal(events.every(event => event.type !== 'response.output_text.delta'), true);
  assert.equal(events.find(event => event.phase === 'pgs_sweep').provider, 'sweep');
  assert.equal(events.find(event => event.phase === 'pgs_synthesis').provider, 'synth');

  const receipts = await fs.readdir(path.join(scratch.scratchDir, 'pgs-receipts'));
  assert.equal(receipts.length, 1);
});

test('fractional run is honestly partial and a retry executes only pending work', async t => {
  const scratch = await scratchFixture(t);
  const pin = sourcePin();
  const first = makeEngine();
  const partial = await first.engine.runPinnedOperation(options(pin, scratch, {
    pgsConfig: { sweepFraction: 0.5, maxConcurrentSweeps: 2 },
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
