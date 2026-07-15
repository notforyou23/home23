import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createMemoryTools,
  writeJsonlGzAtomic,
} = require('../../../shared/memory-source');

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeManifestFixture({ missingBase = false } = {}) {
  const brainDir = await tempDir('home23-mcp-memory-brain-');
  const nodes = await writeJsonlGzAtomic(path.join(brainDir, 'nodes.gz'), [
    { id: 'base-keep', concept: 'ordinary base node', tag: 'base', activation: 0.2, weight: 0.4 },
    { id: 'base-remove', concept: 'removed base tombstone', tag: 'base', activation: 0.9, weight: 0.9 },
  ]);
  const edges = await writeJsonlGzAtomic(path.join(brainDir, 'edges.gz'), [
    { source: 'base-keep', target: 'base-remove', weight: 0.5 },
  ]);
  const delta = [
    JSON.stringify({
      epoch: 'e3',
      sequence: 1,
      revision: 3,
      op: 'upsert_node',
      record: { id: 'delta-canary', concept: 'rare delta canary phrase', tag: 'delta', activation: 1, weight: 1 },
    }),
    JSON.stringify({
      epoch: 'e3',
      sequence: 2,
      revision: 4,
      op: 'remove_node',
      id: 'base-remove',
    }),
  ].join('\n') + '\n';
  await fsp.writeFile(path.join(brainDir, 'delta.jsonl'), delta);
  await fsp.writeFile(path.join(brainDir, 'memory-manifest.json'), `${JSON.stringify({
    formatVersion: 1,
    generation: 'g1',
    baseRevision: 2,
    currentRevision: 4,
    activeDeltaEpoch: 'e3',
    activeBase: {
      nodes: { file: 'nodes.gz', count: 2, bytes: nodes.bytes },
      edges: { file: 'edges.gz', count: 1, bytes: edges.bytes },
    },
    activeDelta: {
      epoch: 'e3',
      file: 'delta.jsonl',
      fromRevision: 3,
      toRevision: 4,
      count: 2,
      committedBytes: Buffer.byteLength(delta),
    },
    ann: { indexFile: null, metaFile: null, builtFromRevision: 2 },
    summary: { nodeCount: 2, edgeCount: 0, clusterCount: 0 },
  }, null, 2)}\n`);
  if (missingBase) await fsp.rm(path.join(brainDir, 'nodes.gz'));
  return brainDir;
}

function toolsFor({
  brainDir,
  home23Root,
  resolveTargetContext,
  withEphemeralSource,
  searchMemory,
} = {}) {
  return createMemoryTools({
    brainDir,
    home23Root,
    requesterAgent: 'ada',
    resolveTargetContext: resolveTargetContext || (async () => ({
      catalogRevision: 'test-catalog',
      accessMode: 'own',
      target: {
        id: 'ada',
        ownerAgent: 'ada',
        canonicalRoot: await fsp.realpath(brainDir),
        kind: 'resident',
        sourceType: 'memory-manifest',
      },
    })),
    readScalarState: async () => ({ cycleCount: 7 }),
    logger: { warn() {} },
    ...(withEphemeralSource ? { withEphemeralSource } : {}),
    ...(searchMemory ? { searchMemory } : {}),
  });
}

test('MCP query delegates to the shared search authority response when injected', async () => {
  const brainDir = await writeManifestFixture();
  const home23Root = await tempDir('home23-mcp-memory-shared-search-');
  const calls = [];
  const evidence = {
    sourceHealth: 'healthy',
    matchOutcome: 'matches',
    deltaWatermark: { revision: 4 },
    retrievalMode: 'semantic-ann-delta-overlay',
    indexCoverage: { complete: true, coveredThroughRevision: 4 },
    authoritativeTotals: { nodes: 2, edges: 0 },
    returnedTotals: { nodes: 1, edges: 0 },
    selectedBrain: null,
    selectedAgent: null,
    identity: {
      requesterAgent: 'ada',
      targetAgent: 'ada',
      brainId: 'brain-ada',
      canonicalRoot: brainDir,
      catalogRevision: 'catalog-4',
      kind: 'resident',
      sourceType: 'memory-manifest',
      accessMode: 'own',
      operationId: 'mcp-search-test',
    },
  };
  const tools = toolsFor({
    brainDir,
    home23Root,
    withEphemeralSource: async () => {
      throw new Error('legacy keyword scan must not run');
    },
    searchMemory: async (input) => {
      calls.push(input);
      return {
        query: input.query,
        results: [{ id: 'shared-canary' }],
        evidence,
      };
    },
  });

  const result = await tools.queryMemory({
    query: 'shared canary', limit: 3, tag: 'proof',
  });
  assert.equal(result.ok, true);
  assert.equal(result.resultsFound, 1);
  assert.equal(result.totalNodes, 2);
  assert.deepEqual(result.results, [{ id: 'shared-canary' }]);
  assert.equal(result.evidence.selectedBrain, 'brain-ada');
  assert.equal(result.evidence.selectedAgent, 'ada');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, 'shared canary');
  assert.equal(calls[0].topK, 3);
  assert.equal(calls[0].tag, 'proof');
});

test('MCP readiness and foreground query serialize their local source admission', async () => {
  const brainDir = await writeManifestFixture();
  const home23Root = await tempDir('home23-mcp-memory-local-admission-');
  let releaseReadiness;
  let readinessEntered;
  const entered = new Promise((resolve) => { readinessEntered = resolve; });
  let sourceActive = false;
  let searchCalls = 0;
  const tools = toolsFor({
    brainDir,
    home23Root,
    withEphemeralSource: async (_options, callback) => {
      sourceActive = true;
      readinessEntered();
      await new Promise((resolve) => { releaseReadiness = resolve; });
      const source = {
        revision: 4,
        async summarize() { return { nodes: 2, edges: 0 }; },
        getEvidence(extra = {}) {
          return {
            sourceHealth: 'healthy',
            matchOutcome: 'matches',
            ...extra,
          };
        },
      };
      try {
        return await callback(source, {
          identity: {
            requesterAgent: 'ada', targetAgent: 'ada', brainId: 'ada',
            canonicalRoot: brainDir, catalogRevision: 'test', accessMode: 'own',
            kind: 'resident', sourceType: 'memory-manifest', operationId: 'readiness-test',
          },
        });
      } finally {
        sourceActive = false;
      }
    },
    searchMemory: async () => {
      searchCalls += 1;
      if (sourceActive) throw Object.assign(new Error('self contention'), {
        code: 'source_busy', retryable: true,
      });
      return {
        results: [{ id: 'foreground' }],
        evidence: {
          sourceHealth: 'healthy',
          matchOutcome: 'matches',
          authoritativeTotals: { nodes: 2, edges: 0 },
          identity: {
            requesterAgent: 'ada', targetAgent: 'ada', brainId: 'ada',
            canonicalRoot: brainDir, catalogRevision: 'test', accessMode: 'own',
            kind: 'resident', sourceType: 'memory-manifest', operationId: 'query-test',
          },
        },
      };
    },
  });

  const readiness = tools.checkReadiness();
  await entered;
  const abortedController = new AbortController();
  const abortedReason = Object.assign(new Error('caller disconnected'), {
    name: 'AbortError', code: 'cancelled',
  });
  const abortedQuery = tools.queryMemory({
    query: 'aborted foreground', limit: 1, signal: abortedController.signal,
  });
  let abortedOutcome = null;
  void abortedQuery.then(
    () => { abortedOutcome = 'resolved'; },
    (error) => { abortedOutcome = error; },
  );
  const query = tools.queryMemory({ query: 'foreground', limit: 1 });
  abortedController.abort(abortedReason);
  await new Promise((resolve) => setImmediate(resolve));
  const callsBeforeRelease = searchCalls;
  const abortBeforeRelease = abortedOutcome;
  releaseReadiness();
  assert.equal((await readiness).ok, true);
  await assert.rejects(abortedQuery, (error) => error === abortedReason);
  const result = await query;
  assert.equal(callsBeforeRelease, 0);
  assert.equal(abortBeforeRelease, abortedReason);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].id, 'foreground');
  assert.equal(searchCalls, 1);
});

test('MCP query reads manifest base plus delta and excludes tombstones', async () => {
  const brainDir = await writeManifestFixture();
  const home23Root = await tempDir('home23-mcp-memory-home-');
  const tools = toolsFor({ brainDir, home23Root });

  const delta = await tools.queryMemory({ query: 'delta canary', limit: 5 });
  assert.equal(delta.ok, true);
  assert.deepEqual(delta.results.map((row) => row.id), ['delta-canary']);
  assert.equal(delta.evidence.authoritativeTotals.nodes, 2);
  assert.equal(delta.evidence.selectedBrain, 'ada');
  assert.equal(delta.evidence.selectedAgent, 'ada');
  assert.equal(delta.evidence.deltaWatermark.revision, 4);
  assert.equal(delta.evidence.identity.canonicalRoot, await fsp.realpath(brainDir));

  const removed = await tools.queryMemory({ query: 'tombstone', limit: 5 });
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.results, []);
});

test('MCP statistics preserves scalar totals and honest omitted breakdowns', async () => {
  const brainDir = await writeManifestFixture();
  const home23Root = await tempDir('home23-mcp-memory-home-');
  const stats = await toolsFor({ brainDir, home23Root }).getMemoryStatistics();

  assert.equal(stats.ok, true);
  assert.equal(stats.totalNodes, 2);
  assert.equal(stats.totalEdges, 0);
  assert.equal(stats.nodesByTag, null);
  assert.equal(stats.clusterTotals, null);
  assert.equal(stats.breakdownsOmitted, true);
  assert.deepEqual(stats.mostAccessedNodes, []);
  assert.deepEqual(stats.highestActivationNodes, []);
});

test('MCP unavailable source is unknown evidence and never healthy zero', async () => {
  const brainDir = await writeManifestFixture({ missingBase: true });
  const home23Root = await tempDir('home23-mcp-memory-home-');
  const result = await toolsFor({ brainDir, home23Root }).queryMemory({ query: 'anything', limit: 5 });

  assert.equal(result.ok, false);
  assert.equal(result.totalNodes, null);
  assert.equal(result.error.code, 'source_unavailable');
  assert.equal(result.evidence.sourceHealth, 'unavailable');
  assert.equal(result.evidence.matchOutcome, 'unknown');
});

test('MCP tools preserve typed retryable compatibility admission contention', async () => {
  const brainDir = await writeManifestFixture();
  const home23Root = await tempDir('home23-mcp-memory-busy-home-');
  const result = await toolsFor({
    brainDir,
    home23Root,
    withEphemeralSource: async () => {
      throw Object.assign(new Error('compatibility source busy'), {
        code: 'source_busy',
        retryable: true,
      });
    },
  }).queryMemory({ query: 'anything', limit: 5 });

  assert.equal(result.ok, false);
  assert.equal(result.totalNodes, null);
  assert.equal(result.error.code, 'source_busy');
  assert.equal(result.error.retryable, true);
  assert.equal(result.evidence.sourceHealth, 'unavailable');
  assert.equal(result.evidence.matchOutcome, 'unknown');
});

test('MCP graph applies bounded node and edge caps', async () => {
  const brainDir = await writeManifestFixture();
  const home23Root = await tempDir('home23-mcp-memory-home-');
  const graph = await toolsFor({ brainDir, home23Root }).getMemoryGraph({ nodeLimit: 1, edgeLimit: 0 });

  assert.equal(graph.nodes.length <= 1, true);
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.meta.authoritativeNodeCount, 2);
  assert.equal(graph.meta.limited, true);
});

test('MCP source identity is server-derived and catalog mismatches fail closed', async () => {
  const brainDir = await writeManifestFixture();
  const home23Root = await tempDir('home23-mcp-memory-home-');
  await assert.rejects(
    () => toolsFor({ brainDir, home23Root }).queryMemory({ query: 'x', identity: { canonicalRoot: brainDir } }),
    { code: 'invalid_request' },
  );

  const other = await tempDir('home23-mcp-memory-other-');
  const mismatch = await toolsFor({
    brainDir,
    home23Root,
    resolveTargetContext: async () => ({
      catalogRevision: 'wrong',
      accessMode: 'own',
      target: { canonicalRoot: other, id: 'other' },
    }),
  }).queryMemory({ query: 'delta', limit: 5 });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, 'source_changed');
  assert.equal(mismatch.totalNodes, null);
});
