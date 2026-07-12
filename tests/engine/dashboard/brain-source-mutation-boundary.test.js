import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildCanonicalCatalog,
  MUTATION_BOUNDARY_KINDS,
} = require('../../../cosmo23/server/lib/brain-registry');
const { createMemorySearchService } = require('../../../engine/src/dashboard/memory-search.js');
const { createBrainSourceService } = require('../../../engine/src/dashboard/brain-source-api.js');
const { createGraphExportExecutor } = require('../../../engine/src/dashboard/brain-operations/graph-export-executor.js');
const {
  createSourceOperationExecutors,
} = require('../../../engine/src/dashboard/brain-operations/source-executors.js');
const {
  createMemorySourcePinProvider,
  createOperationScratchQuota,
  rewriteMemoryBase,
} = require('../../../shared/memory-source');

const REQUIRED_BOUNDARY_KINDS = [
  'brain', 'run', 'pgs', 'session', 'cache', 'export', 'agency',
];

async function inventoryTree(root) {
  const rows = [];
  async function walk(current) {
    const stat = await fsp.lstat(current, { bigint: true });
    const relative = path.relative(root, current) || '.';
    const row = {
      path: relative,
      type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file',
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      mode: stat.mode.toString(),
      nlink: stat.nlink.toString(),
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
    };
    if (stat.isFile()) {
      row.sha256 = crypto.createHash('sha256').update(await fsp.readFile(current)).digest('hex');
    } else if (stat.isSymbolicLink()) {
      row.target = await fsp.readlink(current);
    }
    rows.push(row);
    if (!stat.isDirectory()) return;
    const entries = await fsp.readdir(current);
    entries.sort((left, right) => left.localeCompare(right));
    for (const entry of entries) await walk(path.join(current, entry));
  }
  await walk(root);
  return rows;
}

async function inventoryBoundaries(entry) {
  const result = [];
  for (const boundary of entry.mutationBoundaries) {
    result.push({
      kind: boundary.kind,
      path: boundary.path,
      rows: await inventoryTree(boundary.path),
    });
  }
  return result;
}

async function walkFiles(root) {
  const rows = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      rows.push(full);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(full);
    }
  }
  await walk(root);
  return rows;
}

async function seedTarget(root, label, lockRoot, { completed = false } = {}) {
  await fsp.mkdir(root, { recursive: true });
  const boundaryPaths = [
    root,
    path.join(root, 'pgs-sessions'),
    path.join(root, 'sessions'),
    path.join(root, 'cache'),
    path.join(root, 'exports'),
    path.join(root, 'agency'),
  ];
  for (const directory of boundaryPaths) await fsp.mkdir(directory, { recursive: true });
  for (const [index, directory] of boundaryPaths.entries()) {
    await fsp.writeFile(
      path.join(directory, `boundary-canary-${index}.bin`),
      Buffer.from(`${label}:boundary:${index}:\0bytes\n`, 'utf8'),
    );
  }
  const nodes = [
    { id: `${label}-1`, concept: `${label} mutation canary`, tag: 'research', embedding: [0.2, 0.8] },
    { id: `${label}-2`, concept: `${label} complete finding`, tag: 'finding', embedding: [0.4, 0.6] },
  ];
  const edges = [{ source: nodes[0].id, target: nodes[1].id, weight: 0.9, type: 'supports' }];
  await rewriteMemoryBase(root, {
    nodes,
    edges,
    summary: { nodeCount: nodes.length, edgeCount: edges.length, clusterCount: 1 },
  }, { lockRoot });
  await fsp.writeFile(path.join(root, 'state.json'), `${JSON.stringify({
    cycleCount: 3,
    memory: { nodes: [], edges: [], clusters: [], nodeCount: nodes.length, edgeCount: edges.length },
    memorySource: 'manifest',
  })}\n`);
  if (completed) {
    await fsp.mkdir(path.join(root, 'plans'), { recursive: true });
    await fsp.writeFile(path.join(root, 'plans', 'plan:main.json'), JSON.stringify({
      status: 'COMPLETED',
      completedAt: Date.parse('2026-07-11T00:00:00.000Z'),
    }));
    await fsp.writeFile(path.join(root, 'run.json'), JSON.stringify({ owner: 'researcher' }));
  }
}

async function makeFixture(t) {
  const home23Root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-mutation-boundary-')));
  const instancesRoot = path.join(home23Root, 'instances');
  const localRunsPath = path.join(home23Root, 'brains', 'runs');
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  const ownRoot = path.join(instancesRoot, 'jerry', 'brain');
  const siblingRoot = path.join(instancesRoot, 'forrest', 'brain');
  const researchRoot = path.join(localRunsPath, 'completed-research');
  await Promise.all([
    fsp.mkdir(instancesRoot, { recursive: true }),
    fsp.mkdir(localRunsPath, { recursive: true }),
    fsp.mkdir(lockRoot, { recursive: true }),
  ]);
  await seedTarget(ownRoot, 'own', lockRoot);
  await seedTarget(siblingRoot, 'sibling', lockRoot);
  await seedTarget(researchRoot, 'research', lockRoot, { completed: true });

  const catalog = await buildCanonicalCatalog({
    instancesRoot,
    localRunsPath,
    referenceRunsPaths: [],
    configuredAgentNames: ['jerry', 'forrest'],
    activeRunPath: null,
  });
  const entries = {
    own: catalog.brains.find((entry) => entry.canonicalRoot === ownRoot),
    sibling: catalog.brains.find((entry) => entry.canonicalRoot === siblingRoot),
    research: catalog.brains.find((entry) => entry.canonicalRoot === researchRoot),
  };
  assert.ok(entries.own);
  assert.ok(entries.sibling);
  assert.ok(entries.research);
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  t.after(() => fsp.rm(home23Root, { recursive: true, force: true }));
  return {
    home23Root,
    instancesRoot,
    localRunsPath,
    lockRoot,
    catalog,
    entries,
    provider,
  };
}

function operationTarget(fixture, entry, accessMode) {
  return {
    domain: 'brain',
    brainId: entry.id,
    canonicalRoot: entry.canonicalRoot,
    accessMode,
    ownerAgent: entry.ownerAgent,
    displayName: entry.displayName,
    kind: entry.kind,
    lifecycle: entry.lifecycle,
    catalogRevision: fixture.catalog.catalogRevision,
    route: entry.route,
    mutationBoundaries: entry.mutationBoundaries,
  };
}

async function runSourceOperation(fixture, label, entry, operationType) {
  const operationId = `brop_boundary_${label}_${operationType}`;
  const operationRoot = path.join(
    fixture.home23Root,
    'instances',
    'jerry',
    'runtime',
    'brain-operations',
    'operations',
    operationId,
  );
  const pinned = await fixture.provider.pin(entry.canonicalRoot, operationId);
  const quota = await createOperationScratchQuota({ operationRoot });
  let source;
  try {
    source = await fixture.provider.openPinnedSource(pinned.descriptor, {
      operationId,
      operationType,
      expectedCanonicalRoot: entry.canonicalRoot,
      expectedRevision: pinned.descriptor.cutoffRevision,
      expectedDigest: pinned.digest,
      scratchQuota: quota,
    });
    const pinsRoot = path.join(operationRoot, 'pins');
    const pinFiles = (await walkFiles(pinsRoot)).filter((candidate) => fs.statSync(candidate).isFile());
    assert.equal(pinFiles.length > 0, true, `${label}/${operationType} must hold a process pin`);
    for (const pinFile of pinFiles) {
      const relative = path.relative(pinsRoot, pinFile);
      assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false);
      assert.equal(relative.split(path.sep).length >= 2, true,
        'pin must be nested beneath a process identity');
    }
    const allPinPaths = (await walkFiles(fixture.home23Root))
      .filter((candidate) => candidate.split(path.sep).includes('pins'));
    assert.equal(allPinPaths.every((candidate) => {
      const relative = path.relative(operationRoot, candidate);
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    }), true, 'per-process pins may exist only in the requester operation');

    const scratchDir = path.join(operationRoot, 'scratch');
    const scratchStat = await fsp.lstat(scratchDir);
    assert.equal(scratchStat.isDirectory(), true,
      'source pinning creates only requester-owned operation scratch');
    assert.equal(scratchStat.isSymbolicLink(), false);
    const scratchBaseline = await inventoryTree(scratchDir);
    const target = operationTarget(
      fixture,
      entry,
      label === 'own' ? 'own' : 'read-only',
    );
    const searchService = createMemorySearchService({
      embedQuery: async () => null,
      loadAnn: async () => null,
      logger: { warn() {} },
    });
    const brainSourceService = createBrainSourceService();
    const executors = createSourceOperationExecutors({
      searchService,
      brainSourceService,
      graphExportExecutor: createGraphExportExecutor({ home23Root: fixture.home23Root }),
    });
    const parameters = operationType === 'search'
      ? { query: 'mutation canary', topK: 5 }
      : operationType === 'graph'
        ? { nodeLimit: 10, edgeLimit: 10 }
        : operationType === 'graph_export'
          ? { format: 'jsonl' }
          : {};
    const envelope = await executors.get(operationType)({
      operationId,
      operationType,
      requesterAgent: 'jerry',
      target,
      parameters,
      scratchDir,
      scratchQuota: quota,
      sourcePin: source,
    });
    assert.equal(envelope.state, 'complete', JSON.stringify(envelope.error));
    assert.equal(envelope.sourceEvidence.identity.operationId, operationId);
    assert.equal(envelope.sourceEvidence.identity.canonicalRoot, entry.canonicalRoot);
    if (operationType === 'search') {
      assert.equal(envelope.result.results.length > 0, true);
    } else if (operationType === 'status') {
      assert.equal(envelope.result.summary.nodes, 2);
    } else if (operationType === 'graph') {
      assert.equal(envelope.result.nodes.length, 2);
      assert.equal(envelope.result.edges.length, 1);
    } else {
      assert.equal(envelope.result, null);
      const resultRoot = path.join(operationRoot, 'scratch', 'results');
      const relative = path.relative(resultRoot, envelope.resultArtifact.scratchPath);
      assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false);
      assert.equal(await fsp.readFile(envelope.resultArtifact.scratchPath, 'utf8')
        .then((text) => text.split('\n').filter(Boolean).length), 3);
    }

    if (operationType === 'graph_export') {
      assert.equal(fs.existsSync(path.join(operationRoot, 'scratch', 'results')), true);
      assert.equal(fs.existsSync(path.join(
        fixture.home23Root, 'instances', 'jerry', 'workspace', 'brain-exports',
      )), false, 'regular graph export is retained only in operation result storage');
    } else {
      assert.deepEqual(
        await inventoryTree(scratchDir),
        scratchBaseline,
        `${operationType} must not add or mutate requester scratch`,
      );
      assert.deepEqual(await fsp.readdir(scratchDir), [],
        `${operationType} may use the requester scratch boundary but must not retain artifacts`);
    }
  } finally {
    await source?.release?.().catch(() => {});
    await Promise.resolve(quota.close()).catch(() => {});
    await fixture.provider.releaseOperationPins(operationId).catch(() => {});
  }
}

test('catalog source operations preserve all seven complete boundary trees for own, sibling, and completed research', async (t) => {
  assert.deepEqual(MUTATION_BOUNDARY_KINDS, REQUIRED_BOUNDARY_KINDS);
  const fixture = await makeFixture(t);

  for (const [label, entry] of Object.entries(fixture.entries)) {
    assert.deepEqual(entry.mutationBoundaries.map(({ kind }) => kind), REQUIRED_BOUNDARY_KINDS);
    assert.equal(entry.mutationBoundaries.every((boundary) =>
      Reflect.ownKeys(boundary).length === 2
      && typeof boundary.kind === 'string'
      && path.isAbsolute(boundary.path)), true);
    assert.equal(entry.lifecycle, label === 'research' ? 'completed' : 'resident');
    assert.equal(entry.kind, label === 'research' ? 'research' : 'resident');
    const lockCrossing = path.relative(entry.canonicalRoot, fixture.lockRoot);
    assert.equal(lockCrossing.startsWith(`..${path.sep}`) || path.isAbsolute(lockCrossing), true,
      'global source locks must be outside every target');

    const baseline = await inventoryBoundaries(entry);
    assert.equal(baseline.length, 7);
    assert.equal(baseline.every(({ rows }) => rows.length > 0), true,
      'every complete boundary tree is inventoried without exclusions');
    for (const operationType of ['search', 'status', 'graph', 'graph_export']) {
      await runSourceOperation(fixture, label, entry, operationType);
      assert.deepEqual(
        await inventoryBoundaries(entry),
        baseline,
        `${label} ${operationType} mutated a target boundary`,
      );
    }
  }
});
