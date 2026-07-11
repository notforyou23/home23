'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createDefaultMcpMemoryTools,
} = require('../../shared/memory-source/mcp-http-runtime.cjs');
const {
  readManifest,
  rewriteMemoryBase,
} = require('../../shared/memory-source');

async function createCanonicalBrain(t, { nodes = [], edges = [] } = {}) {
  const home23Root = await fsp.realpath(await fsp.mkdtemp(
    path.join(os.tmpdir(), 'home23-cosmo-mcp-tools-'),
  ));
  const brainDir = path.join(home23Root, 'brains', 'cosmo');
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  await Promise.all([
    fsp.mkdir(brainDir, { recursive: true }),
    fsp.mkdir(lockRoot, { recursive: true }),
  ]);
  await rewriteMemoryBase(brainDir, {
    nodes,
    edges,
    summary: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      clusterCount: nodes.length > 0 ? 1 : 0,
    },
  }, { lockRoot });
  t.after(() => fsp.rm(home23Root, { recursive: true, force: true }));
  return {
    home23Root,
    brainDir: await fsp.realpath(brainDir),
    manifest: await readManifest(brainDir),
  };
}

function createTools(fixture, requesterAgent = 'cosmo-test') {
  return createDefaultMcpMemoryTools({
    brainDir: fixture.brainDir,
    home23Root: fixture.home23Root,
    requesterAgent,
    logger: { warn() {} },
  });
}

test('COSMO MCP tools expose canonical server-derived identity and the committed revision', async (t) => {
  const fixture = await createCanonicalBrain(t, {
    nodes: [
      {
        id: 'canonical-canary',
        concept: 'canonical source identity canary',
        tag: 'identity',
        embedding: [1, 0],
      },
      {
        id: 'supporting-node',
        concept: 'supporting immutable evidence',
        tag: 'evidence',
        embedding: [0, 1],
      },
    ],
    edges: [{ source: 'canonical-canary', target: 'supporting-node', weight: 0.8 }],
  });
  const tools = createTools(fixture);

  const readiness = await tools.checkReadiness();
  assert.equal(readiness.ok, true);
  assert.equal(readiness.sourceHealth, 'healthy');
  assert.equal(readiness.revision, fixture.manifest.currentRevision);
  assert.deepEqual(readiness.totals, { nodes: 2, edges: 1 });

  const result = await tools.queryMemory({ query: 'canonical identity canary', limit: 5 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((row) => row.id), ['canonical-canary']);
  assert.equal(result.evidence.sourceHealth, 'healthy');
  assert.equal(result.evidence.matchOutcome, 'matches');
  assert.equal(result.evidence.deltaWatermark.revision, fixture.manifest.currentRevision);
  assert.deepEqual(result.evidence.authoritativeTotals, { nodes: 2, edges: 1 });
  assert.deepEqual(result.evidence.identity, {
    requesterAgent: 'cosmo-test',
    targetAgent: 'cosmo-test',
    brainId: 'resident-cosmo-test',
    canonicalRoot: fixture.brainDir,
    catalogRevision: 'local-self',
    kind: 'resident',
    sourceType: 'resident-brain',
    accessMode: 'own',
    operationId: result.evidence.identity.operationId,
  });
  assert.match(result.evidence.identity.operationId, /^mcp-[A-Za-z0-9_.-]+$/);
});

test('COSMO MCP reports healthy zero only with complete canonical-source evidence', async (t) => {
  const cases = [
    {
      label: 'empty corpus',
      nodes: [],
      expectedOutcome: 'corpus_empty',
      expectedTotal: 0,
    },
    {
      label: 'nonmatching corpus',
      nodes: [{ id: 'other', concept: 'unrelated evidence', tag: 'other' }],
      expectedOutcome: 'no_match',
      expectedTotal: 1,
    },
  ];

  for (const item of cases) {
    await t.test(item.label, async (t) => {
      const fixture = await createCanonicalBrain(t, { nodes: item.nodes });
      const result = await createTools(fixture, `cosmo-${item.expectedTotal}`)
        .queryMemory({ query: 'absent canonical canary', limit: 4 });

      assert.equal(result.ok, true);
      assert.equal(result.resultsFound, 0);
      assert.deepEqual(result.results, []);
      assert.equal(result.totalNodes, item.expectedTotal);
      assert.equal(result.evidence.sourceHealth, 'healthy');
      assert.equal(result.evidence.matchOutcome, item.expectedOutcome);
      assert.equal(result.evidence.completeCoverage, true);
      assert.equal(result.evidence.deltaWatermark.revision, fixture.manifest.currentRevision);
      assert.deepEqual(result.evidence.authoritativeTotals, {
        nodes: item.expectedTotal,
        edges: 0,
      });
      assert.deepEqual(result.evidence.returnedTotals, { nodes: 0, edges: 0 });
      assert.equal(result.evidence.identity.canonicalRoot, fixture.brainDir);
      assert.equal(result.evidence.identity.catalogRevision, 'local-self');
    });
  }
});
