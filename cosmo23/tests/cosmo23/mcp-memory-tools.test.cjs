'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createDefaultMcpMemoryTools,
} = require('../../shared/memory-source/mcp-http-runtime.cjs');
const { createMemoryTools } = require('../../shared/memory-source/mcp-tools.cjs');
const {
  createEvidence,
} = require('../../shared/memory-source/contracts.cjs');
const {
  enumerateMemoryMutationBoundaries,
  readManifest,
  rewriteMemoryBase,
} = require('../../shared/memory-source');

async function inventoryTree(root) {
  const rows = [];
  async function walk(current) {
    const stat = await fsp.lstat(current, { bigint: true });
    const row = {
      path: path.relative(root, current) || '.',
      type: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file',
      dev: String(stat.dev),
      ino: String(stat.ino),
      mode: String(stat.mode),
      nlink: String(stat.nlink),
      size: String(stat.size),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
    };
    if (stat.isFile()) {
      row.sha256 = crypto.createHash('sha256').update(await fsp.readFile(current)).digest('hex');
    } else if (stat.isSymbolicLink()) {
      row.target = await fsp.readlink(current);
    }
    rows.push(row);
    if (!stat.isDirectory()) return;
    const names = await fsp.readdir(current);
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) await walk(path.join(current, name));
  }
  await walk(root);
  return rows;
}

async function inventoryBoundaries(brainDir) {
  const rows = [];
  for (const boundary of enumerateMemoryMutationBoundaries(brainDir)) {
    rows.push({ kind: boundary.kind, path: boundary.path, tree: await inventoryTree(boundary.path) });
  }
  return rows;
}

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
  for (const relative of ['pgs-sessions', 'sessions', 'cache', 'exports', 'agency']) {
    const directory = path.join(brainDir, relative);
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'read-only-canary.bin'), `${relative}\0canary\n`);
  }
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
  assert.equal(result.results[0].retrievalAuthority.authorityClass, 'narrative');
  assert.equal(result.results[0].retrievalAuthority.requiresFreshVerification, true);
  assert.equal(Number.isFinite(result.results[0].retrievalScore), true);
  assert.equal(result.evidence.sourceHealth, 'degraded');
  assert.equal(result.evidence.matchOutcome, 'matches');
  assert.equal(result.evidence.retrievalMode, 'logical-source-scan');
  assert.deepEqual(result.evidence.fallback, {
    route: 'logical-source-scan', reason: 'keyword_source_scan', completeness: 'complete',
  });
  assert.equal(result.evidence.authoritySummary.total, 1);
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

test('MCP query preserves the search producer evidence instead of rebuilding it', async (t) => {
  const fixture = await createCanonicalBrain(t, {
    nodes: [{ id: 'canary', concept: 'producer evidence canary' }],
  });
  const producerEvidence = createEvidence({
    sourceHealth: 'degraded',
    matchOutcome: 'matches',
    freshness: 'known',
    deltaRevision: fixture.manifest.currentRevision,
    retrievalMode: 'logical-source-scan',
    indexCoverage: {
      complete: false,
      indexedRevision: null,
      currentRevision: fixture.manifest.currentRevision,
      coveredThroughRevision: fixture.manifest.currentRevision,
      deltaRecords: 0,
      route: 'keyword-source-scan',
      completeness: 'complete',
    },
    stageTimingsMs: { keywordScoring: 2.5, response: 3.5 },
    returnedTotals: { nodes: 1, edges: 0 },
    authoritativeTotals: { nodes: 1, edges: 0 },
    completeCoverage: true,
    authoritySummary: {
      total: 1,
      authorityClasses: { narrative: 1 },
      retrievalDomains: { current_ops: 1 },
      sourceChain: { withEvidence: 0, withoutEvidence: 1, referenceCounts: {} },
      requiresFreshVerification: 1,
    },
  });
  const source = {
    revision: fixture.manifest.currentRevision,
    async summarize() { return { nodes: 1, edges: 0, clusters: 1 }; },
    async searchKeyword() {
      return {
        results: [{
          id: 'canary',
          retrievalAuthority: {
            authorityClass: 'narrative', retrievalDomain: 'current_ops',
            requiresFreshVerification: true, sourceChain: [],
          },
        }],
        filtered: 0,
        evidence: producerEvidence,
      };
    },
    getEvidence(extra = {}) {
      return createEvidence({
        sourceHealth: 'healthy',
        deltaRevision: fixture.manifest.currentRevision,
        ...extra,
      });
    },
  };
  const tools = createMemoryTools({
    brainDir: fixture.brainDir,
    home23Root: fixture.home23Root,
    requesterAgent: 'cosmo-test',
    resolveTargetContext: async () => ({
      catalogRevision: 'catalog-test',
      accessMode: 'own',
      target: {
        id: 'resident-cosmo-test', ownerAgent: 'cosmo-test', kind: 'resident',
        sourceType: 'resident-brain', canonicalRoot: fixture.brainDir,
      },
    }),
    withEphemeralSource: async (_options, callback) => callback(source, {
      identity: {
        requesterAgent: 'cosmo-test', targetAgent: 'cosmo-test',
        brainId: 'resident-cosmo-test', canonicalRoot: fixture.brainDir,
        catalogRevision: 'catalog-test', kind: 'resident', sourceType: 'resident-brain',
        accessMode: 'own', operationId: 'mcp-test-operation',
      },
    }),
    logger: { warn() {} },
  });

  const result = await tools.queryMemory({ query: 'producer evidence canary', limit: 5 });

  assert.equal(result.evidence.sourceHealth, 'degraded');
  assert.equal(result.evidence.retrievalMode, 'logical-source-scan');
  assert.equal(result.evidence.indexCoverage.route, 'keyword-source-scan');
  assert.equal(result.evidence.stageTimingsMs.keywordScoring, 2.5);
  assert.equal(result.evidence.authoritySummary.authorityClasses.narrative, 1);
});

test('COSMO MCP reports known zero through a complete degraded logical-source scan', async (t) => {
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
      assert.equal(result.evidence.sourceHealth, 'degraded');
      assert.equal(result.evidence.matchOutcome, item.expectedOutcome);
      assert.equal(result.evidence.completeCoverage, true);
      assert.equal(result.evidence.retrievalMode, 'logical-source-scan');
      assert.equal(result.evidence.indexCoverage.complete, false);
      assert.equal(result.evidence.indexCoverage.currentRevision, fixture.manifest.currentRevision);
      assert.equal(result.evidence.indexCoverage.route, 'logical-source-scan');
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

test('COSMO MCP reads preserve every canonical target mutation boundary byte-for-byte', async (t) => {
  const fixture = await createCanonicalBrain(t, {
    nodes: [
      { id: 'readonly-canary', concept: 'read only MCP canary', tag: 'proof' },
      { id: 'readonly-support', concept: 'supporting result', tag: 'proof' },
    ],
    edges: [{ source: 'readonly-canary', target: 'readonly-support', weight: 0.7 }],
  });
  const boundaries = enumerateMemoryMutationBoundaries(fixture.brainDir);
  assert.deepEqual(boundaries.map(({ kind }) => kind), [
    'agency', 'brain', 'cache', 'export', 'pgs', 'run', 'session',
  ]);
  assert.equal(new Set(boundaries.map(({ kind }) => kind)).size, 7);
  const before = await inventoryBoundaries(fixture.brainDir);
  const tools = createTools(fixture, 'cosmo-readonly');

  const readiness = await tools.checkReadiness();
  const search = await tools.queryMemory({ query: 'read only MCP canary', limit: 5 });
  const statistics = await tools.getMemoryStatistics();
  const graph = await tools.getMemoryGraph({ nodeLimit: 2, edgeLimit: 2 });

  assert.equal(readiness.ok, true);
  assert.equal(search.ok, true);
  assert.equal(statistics.ok, true);
  assert.equal(graph.evidence.sourceHealth, 'healthy');
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(search.evidence.identity.accessMode, 'own');
  assert.equal(search.evidence.identity.canonicalRoot, fixture.brainDir);
  assert.deepEqual(await inventoryBoundaries(fixture.brainDir), before);
  assert.equal(fs.existsSync(path.join(fixture.brainDir, 'runtime')), false);
});
