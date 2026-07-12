'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { PGSEngine } = require('../../../cosmo23/pgs-engine/src');
const {
  createOperationScratchQuota,
} = require('../../../shared/memory-source/scratch-quota.cjs');

const limits = Object.freeze({
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
});

function catalog() {
  const model = {
    id: 'shared-model', kind: 'chat', transport: 'responses',
    maxOutputTokens: 512, contextWindowTokens: 128_000, providerStallMs: 900_000,
  };
  return {
    version: 1,
    providers: {
      sweep: { models: [{ ...model }] },
      synth: { models: [{ ...model }] },
    },
    defaults: {},
  };
}

function sourcePin({
  canonicalRoot = '/synthetic/brain',
  nodeCount = 12,
  onNode = null,
} = {}) {
  const edgeCount = Math.max(0, nodeCount - 1);
  let releases = 0;
  return {
    revision: 5,
    descriptor: {
      version: 1,
      canonicalRoot,
      generation: 'g5',
      baseRevision: 5,
      cutoffRevision: 5,
      summary: { nodeCount, edgeCount, clusterCount: nodeCount ? 2 : 0 },
      activeBase: {
        nodes: { file: 'nodes.gz', count: nodeCount, bytes: 1 },
        edges: { file: 'edges.gz', count: edgeCount, bytes: 1 },
      },
      activeDelta: {
        epoch: 'e1', file: 'delta', fromRevision: 6, toRevision: 5,
        count: 0, committedBytes: 0,
      },
    },
    async *iterateNodes({ signal } = {}) {
      for (let index = 0; index < nodeCount; index += 1) {
        if (signal?.aborted) throw signal.reason;
        onNode?.(index);
        if (signal?.aborted) throw signal.reason;
        yield {
          id: `n${index}`,
          clusterId: `cluster-${index % 2}`,
          content: `pinned evidence ${index}`,
        };
      }
    },
    async *iterateEdges({ signal } = {}) {
      for (let index = 0; index < edgeCount; index += 1) {
        if (signal?.aborted) throw signal.reason;
        yield { source: `n${index}`, target: `n${index + 1}`, type: 'next' };
      }
    },
    getEvidence(extra = {}) {
      return { sourceHealth: 'healthy', deltaWatermark: { revision: 5 }, ...extra };
    },
    async release() { releases += 1; },
    releaseCount() { return releases; },
    loadAll() { throw new Error('full materializer forbidden'); },
    loadState() { throw new Error('full materializer forbidden'); },
  };
}

async function scratchFixture(t, prefix = 'home23-pgs-contract-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const operationRoot = path.join(
    root, 'instances', 'jerry', 'runtime', 'brain-operations', 'op-pgs',
  );
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

function createEngine({ sweepGenerate, synthGenerate } = {}) {
  const calls = [];
  const sweepClient = {
    providerId: 'sweep',
    async generate(options) {
      calls.push({ phase: 'sweep', options });
      if (sweepGenerate) return sweepGenerate(options, calls.length);
      return {
        content: `finding ${calls.length}`,
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
      if (synthGenerate) return synthGenerate(options, calls.length);
      return {
        content: 'pinned synthesis',
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
  return { engine, calls };
}

function operationOptions(pin, scratch, overrides = {}) {
  return {
    sourcePin: pin,
    scratchDir: scratch.scratchDir,
    scratchQuota: scratch.quota,
    query: 'What does the pinned evidence show?',
    pgsSweep: { provider: 'sweep', model: 'shared-model' },
    pgsSynth: { provider: 'synth', model: 'shared-model' },
    signal: new AbortController().signal,
    pgsConfig: { sweepFraction: 1 },
    limits,
    ...overrides,
  };
}

module.exports = {
  catalog,
  createEngine,
  limits,
  operationOptions,
  scratchFixture,
  sourcePin,
};
