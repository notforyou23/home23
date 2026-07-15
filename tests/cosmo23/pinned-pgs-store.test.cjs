'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const Database = require('better-sqlite3');
const pinnedStoreRequire = createRequire(require.resolve(
  '../../cosmo23/pgs-engine/src/pinned-store',
));
const PinnedStoreDatabase = pinnedStoreRequire('better-sqlite3');

const {
  createOperationScratchQuota,
} = require('../../shared/memory-source/scratch-quota.cjs');
const {
  canonicalJson,
  sourceDescriptorDigest,
} = require('../../shared/memory-source/contracts.cjs');
const {
  attestMemoryAuthority,
} = require('../../shared/memory-authority-attestation.cjs');
const {
  openPinnedPGSStore,
} = require('../../cosmo23/pgs-engine/src/pinned-store');

const AUTHORITY_KEY = '7'.repeat(64);
const priorAuthorityKey = process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = AUTHORITY_KEY;
test.after(() => {
  if (priorAuthorityKey === undefined) delete process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
  else process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = priorAuthorityKey;
});

function descriptor(revision = 3, nodeCount = 600, edgeCount = 599) {
  return {
    version: 1,
    canonicalRoot: '/synthetic/pinned-brain',
    generation: `g${revision}`,
    baseRevision: revision,
    cutoffRevision: revision,
    summary: { nodeCount, edgeCount, clusterCount: 3 },
    activeBase: {
      nodes: { file: 'nodes.jsonl.gz', count: nodeCount, bytes: 1 },
      edges: { file: 'edges.jsonl.gz', count: edgeCount, bytes: 1 },
    },
    activeDelta: {
      epoch: 'e1', file: 'delta.jsonl', fromRevision: revision + 1,
      toRevision: revision, count: 0, committedBytes: 0,
    },
  };
}

function syntheticSource({
  revision = 3,
  nodeCount = 600,
  edgeCount = 599,
  oversized = false,
  contentBytes = null,
  onNode = null,
  nodeFactory = null,
  edgeFactory = null,
} = {}) {
  return {
    revision,
    descriptor: descriptor(revision, nodeCount, edgeCount),
    async *iterateNodes({ signal } = {}) {
      for (let index = 0; index < nodeCount; index += 1) {
        if (signal?.aborted) throw signal.reason;
        onNode?.(index);
        const fallback = {
          id: `n${index}`,
          clusterId: `cluster-${index % 3}`,
          content: oversized && index === 0
            ? 'x'.repeat(257 * 1024)
            : contentBytes && index === 0 ? 'x'.repeat(contentBytes) : `node ${index}`,
        };
        yield nodeFactory ? nodeFactory(index, fallback) : fallback;
      }
    },
    async *iterateEdges({ signal } = {}) {
      for (let index = 0; index < edgeCount; index += 1) {
        if (signal?.aborted) throw signal.reason;
        const fallback = { source: `n${index}`, target: `n${index + 1}`, type: 'next' };
        yield edgeFactory ? edgeFactory(index, fallback) : fallback;
      }
    },
    loadAll() { throw new Error('materializer forbidden'); },
    loadState() { throw new Error('materializer forbidden'); },
  };
}

async function fixture(t, maxBytes = 64 * 1024 * 1024) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-pgs-store-'));
  const operationRoot = path.join(root, 'instances', 'jerry', 'runtime', 'brain-operations', 'op-pgs');
  const scratchDir = path.join(operationRoot, 'scratch');
  await fs.mkdir(scratchDir, { recursive: true });
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes });
  t.after(async () => {
    quota.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, operationRoot, scratchDir, quota };
}

const limits = {
  maxScratchBytes: 64 * 1024 * 1024,
  minFreeScratchBytes: 1,
  maxTransactionRecords: 100,
  maxTransactionBytes: 1024 * 1024,
  maxNodesPerWorkUnit: 25,
  maxContextCharsPerWorkUnit: 4096,
};

const query = 'What does the pinned evidence show?';

test('streams a revision-bound projection and creates deterministic bounded work units', async t => {
  const { scratchDir, quota } = await fixture(t);
  const store = await openPinnedPGSStore({
    sourcePin: syntheticSource({}),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits,
  });
  t.after(() => store.close());

  assert.equal(store.stats.nodeCount, 600);
  assert.equal(store.stats.edgeCount, 599);
  assert.equal(store.stats.maxTransactionRecords <= 100, true);
  assert.equal(store.stats.maxTransactionBytes <= 1024 * 1024, true);
  assert.equal(store.stats.maxRetainedRecords <= 100, true);
  assert.equal(store.stats.workUnitCount > 3, true);

  const pending = store.snapshotPendingWorkUnits({ attemptId: 'attempt-1', limit: 10 });
  assert.equal(pending.length, 10);
  assert.deepEqual(
    pending.slice(0, 3).map(workUnitId => store.loadWorkUnit(workUnitId).partitionId),
    ['c-cluster-0', 'c-cluster-1', 'c-cluster-2'],
  );
  const unit = store.loadWorkUnit(pending[0]);
  assert.equal(unit.nodes.length <= 25, true);
  assert.equal(unit.stats.contextChars <= 4096, true);
  assert.match(unit.workUnitId, /^p-c-cluster-[0-2]-u\d{4}$/);
});

test('summarizes authority, domain, and source-chain evidence from the exact PGS scope', async t => {
  const { scratchDir, quota } = await fixture(t);
  const nodes = [
    attestMemoryAuthority({
      id: 'current', clusterId: 'ops', content: 'current verified state',
      asserted_at: '2026-07-14T12:00:00.000Z',
      metadata: { sourcePath: '/Users/jtr/private/runtime/current.json' },
      provenance: {
        schema: 'home23.node-provenance.v1',
        authorityClass: 'verified_current_state', operationalAuthority: true,
        evidenceRefs: ['verifier:/Volumes/private/current.json'],
      },
    }, AUTHORITY_KEY),
    {
      id: 'archive', clusterId: 'archive', content: 'old news archive',
      tag: 'news', source_event_at: '2025-01-01T00:00:00.000Z',
      provenance: { authorityClass: 'narrative', operationalAuthority: false },
    },
  ];
  const store = await openPinnedPGSStore({
    sourcePin: syntheticSource({
      nodeCount: nodes.length,
      edgeCount: 1,
      nodeFactory: index => nodes[index],
      edgeFactory: () => ({ source: 'current', target: 'archive', type: 'relates' }),
    }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits,
  });
  t.after(() => store.close());
  store.planScope({
    attemptId: 'attempt-authority-fractional',
    coverageLevel: 'deep',
    coverageFraction: 0.5,
  });
  const fractionalSummary = store.summarizeAuthority({
    attemptId: 'attempt-authority-fractional',
    signal: new AbortController().signal,
  });
  const fractionalTotals = store.summarizeScopeTotals({
    attemptId: 'attempt-authority-fractional',
    signal: new AbortController().signal,
  });
  assert.equal(fractionalSummary.total, 1);
  assert.deepEqual(fractionalTotals, { nodes: 1, edges: 1 });

  store.planScope({ attemptId: 'attempt-authority', coverageLevel: 'full', coverageFraction: 1 });

  const summary = store.summarizeAuthority({
    attemptId: 'attempt-authority',
    signal: new AbortController().signal,
  });
  const scopedTotals = store.summarizeScopeTotals({
    attemptId: 'attempt-authority',
    signal: new AbortController().signal,
  });

  assert.equal(summary.total, 2);
  assert.deepEqual(scopedTotals, { nodes: 2, edges: 1 });
  assert.equal(summary.authorityClasses.verified_current_state, 1);
  assert.equal(summary.authorityClasses.narrative, 1);
  assert.equal(summary.retrievalDomains.current_ops, 1);
  assert.equal(summary.retrievalDomains.external_intake, 1);
  assert.equal(summary.sourceChain.referenceCounts.evidence, 1);

  const workUnitIds = store.snapshotPendingWorkUnits({
    attemptId: 'attempt-authority',
    limit: 2,
  });
  const work = workUnitIds.map(workUnitId => store.loadWorkUnit(workUnitId));
  const providerNodes = work.flatMap(unit => unit.nodes);
  const providerAuthorities = work.flatMap(unit => unit.nodeAuthorities);
  assert.equal(providerAuthorities.length, providerNodes.length);
  const currentIndex = providerNodes.findIndex(node => node.id === 'current');
  assert.notEqual(currentIndex, -1);
  assert.equal(providerAuthorities[currentIndex].authorityClass, 'verified_current_state');
  assert.equal(providerAuthorities[currentIndex].operationalAuthority, true);
  assert.equal(JSON.stringify(providerNodes[currentIndex]).includes('/Users/'), false);
  assert.equal(JSON.stringify(providerAuthorities[currentIndex]).includes('/Volumes/'), false);
});

test('store close releases anchored handles when SQLite close throws', async t => {
  const { scratchDir, quota } = await fixture(t);
  const store = await openPinnedPGSStore({
    sourcePin: syntheticSource({ nodeCount: 1, edgeCount: 0 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits,
  });
  const marker = Object.assign(new Error('sqlite close failed'), { code: 'sqlite_close_failed' });
  const originalDatabaseClose = PinnedStoreDatabase.prototype.close;
  const originalCloseSync = fsSync.closeSync;
  let closedAnchorHandles = 0;
  PinnedStoreDatabase.prototype.close = function closeThenThrow(...args) {
    originalDatabaseClose.apply(this, args);
    throw marker;
  };
  fsSync.closeSync = function instrumentedCloseSync(...args) {
    closedAnchorHandles += 1;
    return originalCloseSync.apply(this, args);
  };

  try {
    assert.throws(() => store.close(), error => error === marker);
  } finally {
    PinnedStoreDatabase.prototype.close = originalDatabaseClose;
    fsSync.closeSync = originalCloseSync;
  }
  assert.equal(closedAnchorHandles > 0, true);
});

test('rejects a symlinked PGS directory without touching its outside target', async t => {
  const { scratchDir, quota } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-pgs-store-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const sourcePin = syntheticSource({ nodeCount: 1, edgeCount: 0 });
  const component = `${sourceDescriptorDigest(sourcePin.descriptor)}-r${sourcePin.revision}`;
  const outsideComponent = path.join(outside, component);
  const canary = path.join(outsideComponent, 'keep.txt');
  await fs.mkdir(outsideComponent, { recursive: true });
  await fs.writeFile(canary, 'outside content must survive\n');
  await fs.symlink(outside, path.join(scratchDir, 'pgs'));

  await assert.rejects(
    () => openPinnedPGSStore({
      sourcePin,
      scratchDir,
      scratchQuota: quota,
      pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
      query,
      signal: new AbortController().signal,
      limits,
    }),
    { code: 'invalid_request' },
  );
  assert.equal(await fs.readFile(canary, 'utf8'), 'outside content must survive\n');
  assert.deepEqual(await fs.readdir(outsideComponent), ['keep.txt']);
});

test('rejects a symlinked revision directory without touching its outside target', async t => {
  const { scratchDir, quota } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-pgs-revision-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const sourcePin = syntheticSource({ nodeCount: 1, edgeCount: 0 });
  const component = `${sourceDescriptorDigest(sourcePin.descriptor)}-r${sourcePin.revision}`;
  const pgsRoot = path.join(scratchDir, 'pgs');
  const canary = path.join(outside, 'keep.txt');
  await fs.mkdir(pgsRoot);
  await fs.writeFile(canary, 'outside content must survive\n');
  await fs.symlink(outside, path.join(pgsRoot, component));

  await assert.rejects(
    () => openPinnedPGSStore({
      sourcePin,
      scratchDir,
      scratchQuota: quota,
      pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
      query,
      signal: new AbortController().signal,
      limits,
    }),
    { code: 'invalid_request' },
  );
  assert.equal(await fs.readFile(canary, 'utf8'), 'outside content must survive\n');
  assert.deepEqual(await fs.readdir(outside), ['keep.txt']);
});

test('persists successful work idempotently and leaves failed work pending', async t => {
  const { scratchDir, quota } = await fixture(t);
  const store = await openPinnedPGSStore({
    sourcePin: syntheticSource({ nodeCount: 12, edgeCount: 11 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits: { ...limits, maxNodesPerWorkUnit: 2 },
  });
  t.after(() => store.close());

  const [first, second] = store.snapshotPendingWorkUnits({ attemptId: 'attempt-2', limit: 2 });
  store.beginWorkUnitAttempt(first, {
    attemptId: 'attempt-2', provider: 'minimax', model: 'MiniMax-M3',
  });
  store.beginWorkUnitAttempt(second, {
    attemptId: 'attempt-2', provider: 'minimax', model: 'MiniMax-M3',
  });
  await store.commitSuccessfulSweeps([{ workUnitId: first, output: 'durable finding' }]);
  await store.commitSuccessfulSweeps([{ workUnitId: first, output: 'durable finding' }]);
  store.recordRetryableFailure(second, Object.assign(new Error('retry'), { code: 'provider_failed' }));

  assert.deepEqual(store.listSuccessfulSweeps().map(row => row.output), ['durable finding']);
  assert.equal(store.countPendingWorkUnits(), store.stats.workUnitCount - 1);
  assert.equal(store.listRetryablePartitions().length > 0, true);
  await assert.rejects(
    store.commitSuccessfulSweeps([{ workUnitId: first, output: 'changed' }]),
    error => error.code === 'pgs_state_conflict',
  );
});

test('caps cumulative durable sweep output before every retry commit', async t => {
  const { scratchDir, quota } = await fixture(t);
  const store = await openPinnedPGSStore({
    sourcePin: syntheticSource({ nodeCount: 2, edgeCount: 0 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits: {
      ...limits,
      maxNodesPerWorkUnit: 1,
      maxSelectedWorkUnits: 16,
      maxSweepOutputBytes: 64,
      maxTotalSweepOutputBytes: 64,
    },
  });
  t.after(() => store.close());

  const [first, second] = store.snapshotPendingWorkUnits({
    attemptId: 'attempt-cumulative-cap',
    limit: 2,
  });
  for (const workUnitId of [first, second]) {
    store.beginWorkUnitAttempt(workUnitId, {
      attemptId: 'attempt-cumulative-cap',
      provider: 'minimax',
      model: 'MiniMax-M3',
    });
  }
  const escapedOutput = '"\n'.repeat(20);
  assert.equal(Buffer.byteLength(escapedOutput, 'utf8'), 40);
  assert.equal(Buffer.byteLength(canonicalJson({ output: escapedOutput }), 'utf8') > 64, true);
  await assert.rejects(
    store.commitSuccessfulSweeps([{ workUnitId: first, output: escapedOutput }]),
    error => error.code === 'result_too_large',
  );
  const exactOutput = 'x'.repeat(51);
  assert.equal(Buffer.byteLength(canonicalJson({ output: exactOutput }), 'utf8'), 64);
  await assert.rejects(
    store.commitSuccessfulSweeps(Array.from({ length: 17 }, () => ({
      workUnitId: first,
      output: exactOutput,
    }))),
    error => error.code === 'result_too_large',
  );
  await store.commitSuccessfulSweeps([{ workUnitId: first, output: exactOutput }]);
  await assert.rejects(
    store.commitSuccessfulSweeps([{ workUnitId: second, output: 'y' }]),
    error => error.code === 'result_too_large',
  );
  assert.deepEqual(store.listSuccessfulSweeps().map(row => ({
    workUnitId: row.workUnitId,
    output: row.output,
  })), [{ workUnitId: first, output: exactOutput }]);
  assert.equal(store.countPendingWorkUnits(), 1);
});

test('durable sweep and retry listings stream rows through explicit byte bounds', () => {
  const source = require('node:fs').readFileSync(
    path.resolve(__dirname, '../../cosmo23/pgs-engine/src/pinned-store.js'),
    'utf8',
  );
  const successful = source.slice(
    source.indexOf('    listSuccessfulSweeps('),
    source.indexOf('    listRetryablePartitions(', source.indexOf('    listSuccessfulSweeps(')),
  );
  const retryable = source.slice(
    source.indexOf('    listRetryablePartitions('),
    source.indexOf('    countPendingWorkUnits()', source.indexOf('    listRetryablePartitions(')),
  );
  for (const body of [successful, retryable]) {
    assert.match(body, /\.iterate\s*\(/);
    assert.doesNotMatch(body, /\.all\s*\(/);
  }
  assert.match(successful, /maxTotalSweepOutputBytes/);
  assert.match(retryable, /maxResultBytes/);
});

test('reuses only an exact source revision, limits, and sweep pair', async t => {
  const { scratchDir, quota } = await fixture(t);
  const options = {
    sourcePin: syntheticSource({ nodeCount: 20, edgeCount: 19 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits,
  };
  const first = await openPinnedPGSStore(options);
  assert.equal(first.reused, false);
  first.close();
  const second = await openPinnedPGSStore(options);
  assert.equal(second.reused, true);
  second.close();

  await assert.rejects(
    openPinnedPGSStore({ ...options, query: `${query} changed` }),
    { code: 'pgs_binding_mismatch' },
  );
  await assert.rejects(
    openPinnedPGSStore({
      ...options,
      pgsSweep: { provider: 'minimax', model: 'MiniMax-M3-alt' },
    }),
    { code: 'pgs_binding_mismatch' },
  );
});

test('migrates a pre-authority v3 projection without losing completed sweep work', async t => {
  const { scratchDir, quota } = await fixture(t);
  const options = {
    sourcePin: syntheticSource({ nodeCount: 6, edgeCount: 5 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits,
  };
  const first = await openPinnedPGSStore(options);
  const { databasePath } = first;
  first.planScope({ attemptId: 'old-v3', coverageLevel: 'full', coverageFraction: 1 });
  const [completedWorkUnit] = first.snapshotPendingWorkUnits({
    attemptId: 'old-v3',
    limit: 1,
  });
  first.beginWorkUnitAttempt(completedWorkUnit, {
    attemptId: 'old-v3', provider: 'minimax', model: 'MiniMax-M3',
  });
  await first.commitSuccessfulSweeps([{
    workUnitId: completedWorkUnit,
    output: 'preserved completed sweep',
  }]);
  first.close();

  const oldV3 = new Database(databasePath);
  oldV3.prepare("DELETE FROM metadata WHERE key = 'authorityProjectionVersion'").run();
  oldV3.exec('ALTER TABLE nodes DROP COLUMN authority_mac');
  oldV3.exec('ALTER TABLE nodes DROP COLUMN authority_json');
  oldV3.close();

  const migrated = await openPinnedPGSStore(options);
  t.after(() => migrated.close());
  assert.equal(migrated.reused, true);
  assert.equal(
    migrated.listSuccessfulSweeps().some(row => (
      row.workUnitId === completedWorkUnit && row.output === 'preserved completed sweep'
    )),
    true,
  );
  const readback = new Database(databasePath, { readonly: true });
  assert.equal(
    readback.prepare(
      "SELECT json_extract(value, '$') AS version FROM metadata WHERE key = 'authorityProjectionVersion'",
    ).get().version,
    2,
  );
  assert.equal(
    readback.pragma('table_info(nodes)').some(column => column.name === 'authority_json'),
    true,
  );
  assert.equal(
    readback.pragma('table_info(nodes)').some(column => column.name === 'authority_mac'),
    true,
  );
  readback.close();
});

test('pre-authority migration checkpoints quota and preserves exact cancellation', async t => {
  const { operationRoot, scratchDir, quota } = await fixture(t);
  const migrationLimits = {
    ...limits,
    maxTransactionRecords: 16,
    maxTransactionBytes: 1024 * 1024,
    maxContextCharsPerWorkUnit: 64 * 1024,
  };
  const options = {
    sourcePin: syntheticSource({ nodeCount: 20, edgeCount: 19, contentBytes: 32 * 1024 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits: migrationLimits,
  };
  const first = await openPinnedPGSStore(options);
  const { databasePath } = first;
  first.close();
  const oldV3 = new Database(databasePath);
  oldV3.prepare("DELETE FROM metadata WHERE key = 'authorityProjectionVersion'").run();
  oldV3.exec('ALTER TABLE nodes DROP COLUMN authority_mac');
  oldV3.exec('ALTER TABLE nodes DROP COLUMN authority_json');
  oldV3.close();
  quota.close();

  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel authority migration'), { code: 'cancelled' });
  let armed = false;
  const cancellingQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: limits.maxScratchBytes,
    signal: controller.signal,
    _testHooks: {
      afterLedgerPublish() {
        if (armed) controller.abort(reason);
      },
    },
  });
  armed = true;
  await assert.rejects(
    openPinnedPGSStore({
      ...options,
      scratchQuota: cancellingQuota,
      signal: controller.signal,
    }),
    error => error === reason,
  );
  cancellingQuota.close();

  const recoveryQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: limits.maxScratchBytes,
  });
  t.after(() => recoveryQuota.close());
  const recovered = await openPinnedPGSStore({
    ...options,
    scratchQuota: recoveryQuota,
    signal: new AbortController().signal,
  });
  t.after(() => recovered.close());
  assert.equal(recovered.reused, true);
});

test('persisted PGS authority is bound to node identity and sanitized record bytes', async t => {
  for (const scenario of ['forged-class', 'copied-authority', 'changed-node']) {
    await t.test(scenario, async t => {
      const { scratchDir, quota } = await fixture(t);
      const options = {
        sourcePin: syntheticSource({ nodeCount: 2, edgeCount: 1 }),
        scratchDir,
        scratchQuota: quota,
        pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
        query,
        signal: new AbortController().signal,
        limits,
      };
      const first = await openPinnedPGSStore(options);
      const { databasePath } = first;
      first.close();
      const database = new Database(databasePath);
      const rows = database.prepare(
        'SELECT id, json, authority_json, authority_mac FROM nodes ORDER BY ordinal',
      ).all();
      if (scenario === 'forged-class') {
        const authority = JSON.parse(rows[0].authority_json);
        authority.authorityClass = 'verified_current_state';
        authority.operationalAuthority = true;
        authority.requiresFreshVerification = false;
        database.prepare('UPDATE nodes SET authority_json = ? WHERE id = ?')
          .run(JSON.stringify(authority), rows[0].id);
      } else if (scenario === 'copied-authority') {
        database.prepare(
          'UPDATE nodes SET authority_json = ?, authority_mac = ? WHERE id = ?',
        ).run(rows[0].authority_json, rows[0].authority_mac, rows[1].id);
      } else {
        const node = JSON.parse(rows[0].json);
        node.content = 'forged provider-visible assertion';
        database.prepare('UPDATE nodes SET json = ? WHERE id = ?')
          .run(JSON.stringify(node), rows[0].id);
      }
      database.close();

      const reopened = await openPinnedPGSStore(options);
      t.after(() => reopened.close());
      assert.equal(reopened.reused, true);
      reopened.planScope({
        attemptId: `tamper-${scenario}`,
        coverageLevel: 'full',
        coverageFraction: 1,
      });
      assert.throws(
        () => reopened.summarizeAuthority({ attemptId: `tamper-${scenario}` }),
        { code: 'pgs_projection_invalid' },
      );
    });
  }
});

test('missing authority key reuses PGS work safely but demotes persisted authority', async t => {
  const { scratchDir, quota } = await fixture(t);
  const signed = attestMemoryAuthority({
    id: 'signed-current',
    content: 'signed current receipt',
    asserted_at: '2026-07-14T12:00:00.000Z',
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'verified_current_state',
      operationalAuthority: true,
      evidenceRefs: ['verifier:live'],
    },
  }, AUTHORITY_KEY);
  const options = {
    sourcePin: syntheticSource({
      nodeCount: 1,
      edgeCount: 0,
      nodeFactory: () => signed,
    }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits,
  };
  const first = await openPinnedPGSStore(options);
  first.close();

  delete process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
  try {
    const reopened = await openPinnedPGSStore(options);
    t.after(() => reopened.close());
    assert.equal(reopened.reused, true);
    reopened.planScope({ attemptId: 'missing-key', coverageLevel: 'full', coverageFraction: 1 });
    const summary = reopened.summarizeAuthority({ attemptId: 'missing-key' });
    assert.equal(summary.authorityClasses.verified_current_state, 0);
    assert.equal(summary.authorityClasses.narrative, 1);
  } finally {
    process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = AUTHORITY_KEY;
  }
});

test('adding an authority key does not break a narrative PGS projection built without one', async t => {
  const { scratchDir, quota } = await fixture(t);
  const options = {
    sourcePin: syntheticSource({ nodeCount: 1, edgeCount: 0 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits,
  };
  delete process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
  try {
    const first = await openPinnedPGSStore(options);
    first.close();
  } finally {
    process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = AUTHORITY_KEY;
  }

  const reopened = await openPinnedPGSStore(options);
  t.after(() => reopened.close());
  assert.equal(reopened.reused, true);
  reopened.planScope({ attemptId: 'key-added', coverageLevel: 'full', coverageFraction: 1 });
  const summary = reopened.summarizeAuthority({ attemptId: 'key-added' });
  assert.equal(summary.authorityClasses.verified_current_state, 0);
  assert.equal(summary.authorityClasses.narrative, 1);
});

test('rebuilds boundedly when durable projection metadata has an unexpected oversized field', async t => {
  const { scratchDir, quota } = await fixture(t);
  const options = {
    sourcePin: syntheticSource({ nodeCount: 20, edgeCount: 19 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits,
  };
  const first = await openPinnedPGSStore(options);
  const { databasePath } = first;
  first.close();
  const database = new Database(databasePath);
  database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run(
    'unexpected', JSON.stringify('x'.repeat(512 * 1024)),
  );
  database.close();

  const rebuilt = await openPinnedPGSStore(options);
  assert.equal(rebuilt.reused, false);
  rebuilt.close();
  const readback = new Database(databasePath, { readonly: true });
  assert.equal(
    readback.prepare("SELECT COUNT(*) AS count FROM metadata WHERE key = 'unexpected'").get().count,
    0,
  );
  readback.close();
});

test('oversized records and cancellation remove an incomplete projection', async t => {
  const { scratchDir, quota } = await fixture(t);
  await assert.rejects(openPinnedPGSStore({
    sourcePin: syntheticSource({ nodeCount: 2, edgeCount: 0, oversized: true }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits,
  }), error => error.code === 'result_too_large');

  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel store'), { code: 'cancelled' });
  await assert.rejects(openPinnedPGSStore({
    sourcePin: syntheticSource({
      nodeCount: 500,
      edgeCount: 0,
      onNode(index) { if (index === 25) controller.abort(reason); },
    }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: controller.signal,
    limits,
  }), error => error === reason);

  const pgsRoot = path.join(scratchDir, 'pgs');
  const entries = await fs.readdir(pgsRoot).catch(() => []);
  assert.deepEqual(entries, []);
});

test('refuses schema-v2 state instead of silently rebuilding it', async t => {
  const { scratchDir, quota } = await fixture(t);
  const options = {
    sourcePin: syntheticSource({ nodeCount: 6, edgeCount: 5 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits,
  };
  const first = await openPinnedPGSStore(options);
  const { databasePath } = first;
  first.close();
  const database = new Database(databasePath);
  database.prepare("UPDATE metadata SET value = '2' WHERE key = 'schemaVersion'").run();
  database.close();

  await assert.rejects(openPinnedPGSStore(options), { code: 'pgs_schema_unsupported' });
});

test('plans deterministic cumulative round-robin scopes and never reselects success', async t => {
  const { scratchDir, quota } = await fixture(t);
  const store = await openPinnedPGSStore({
    sourcePin: syntheticSource({ nodeCount: 30, edgeCount: 29 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits: { ...limits, maxNodesPerWorkUnit: 1, maxSelectedWorkUnits: 64 },
  });
  t.after(() => store.close());
  const completed = new Set();
  const levels = [
    ['skim', 0.1, 3],
    ['sample', 0.25, 8],
    ['deep', 0.5, 15],
    ['full', 1, 30],
  ];

  for (const [coverageLevel, coverageFraction, expectedScope] of levels) {
    const attemptId = `attempt-${coverageLevel}`;
    const plan = store.planScope({ attemptId, coverageLevel, coverageFraction });
    assert.equal(plan.scopeWorkUnits, expectedScope);
    const selected = store.snapshotPendingWorkUnits({ attemptId, limit: 64 });
    assert.equal(selected.length, expectedScope - completed.size);
    assert.equal(selected.every(id => !completed.has(id)), true);
    if (coverageLevel === 'skim') {
      assert.equal(new Set(selected.map(id => store.loadWorkUnit(id).partitionId)).size, 3);
    }
    for (const workUnitId of selected) {
      store.beginWorkUnitAttempt(workUnitId, {
        attemptId, provider: 'minimax', model: 'MiniMax-M3',
      });
    }
    await store.commitSuccessfulSweeps(selected.map(workUnitId => ({
      workUnitId, output: `finding ${workUnitId}`,
    })));
    selected.forEach(id => completed.add(id));
    assert.equal(store.countScopePendingWorkUnits(attemptId), 0);
    assert.equal(store.countScopeSuccessfulWorkUnits(attemptId), expectedScope);
  }
});

test('compacts 1000 transient attempt scopes without losing sweep or monotonic scope state', async t => {
  const { scratchDir, quota } = await fixture(t);
  const options = {
    sourcePin: syntheticSource({ nodeCount: 30, edgeCount: 29 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits: { ...limits, maxNodesPerWorkUnit: 1, maxSelectedWorkUnits: 64 },
  };
  const store = await openPinnedPGSStore(options);
  const { databasePath } = store;
  const root = store.planScope({
    attemptId: 'attempt-retained-root',
    coverageLevel: 'full',
    coverageFraction: 1,
  });
  const [completedWorkUnit] = store.snapshotPendingWorkUnits({
    attemptId: root.attemptId,
    limit: 1,
  });
  store.beginWorkUnitAttempt(completedWorkUnit, {
    attemptId: root.attemptId,
    provider: 'minimax',
    model: 'MiniMax-M3',
  });
  await store.commitSuccessfulSweeps([{
    workUnitId: completedWorkUnit,
    output: 'durable completed sweep',
  }]);

  for (let index = 0; index < 1_000; index += 1) {
    const attemptId = `attempt-batch-${String(index).padStart(4, '0')}`;
    store.planScope({ attemptId, coverageLevel: 'full', coverageFraction: 1 });
    store.snapshotPendingWorkUnits({ attemptId, limit: 1 });
    store.releaseAttemptScope(attemptId);
  }

  const liveReadback = new Database(databasePath, { readonly: true });
  assert.equal(liveReadback.prepare('SELECT COUNT(*) AS count FROM attempt_scopes').get().count, 2);
  assert.equal(
    liveReadback.prepare('SELECT COUNT(*) AS count FROM attempt_scope_work_units').get().count
      <= root.scopeWorkUnits * 2,
    true,
  );
  liveReadback.close();
  assert.equal(store.getScopeSummary(root.attemptId).scopeSuccessfulWorkUnits, 1);
  store.close();

  const historical = new Database(databasePath);
  historical.prepare('DELETE FROM attempt_scope_work_units').run();
  historical.prepare('DELETE FROM attempt_scopes').run();
  const insertHistoricalScope = historical.prepare(`
    INSERT INTO attempt_scopes(
      attempt_id, scope_kind, coverage_level, coverage_fraction,
      target_partition_ids_json, created_at
    ) VALUES (?, 'level', 'full', 1, '[]', ?)
  `);
  const insertHistoricalMappings = historical.prepare(`
    INSERT INTO attempt_scope_work_units(attempt_id, work_unit_id)
    SELECT ?, work_unit_id FROM work_units
  `);
  historical.transaction(() => {
    for (let index = 0; index < 1_000; index += 1) {
      const attemptId = `historical-attempt-${String(index).padStart(4, '0')}`;
      insertHistoricalScope.run(attemptId, '2026-07-14T12:00:00.000Z');
      insertHistoricalMappings.run(attemptId);
    }
  })();
  assert.equal(historical.prepare('SELECT COUNT(*) AS count FROM attempt_scopes').get().count, 1_000);
  assert.equal(
    historical.prepare('SELECT COUNT(*) AS count FROM attempt_scope_work_units').get().count,
    root.scopeWorkUnits * 1_000,
  );
  historical.close();

  const reopened = await openPinnedPGSStore(options);
  t.after(() => reopened.close());
  const compactedReadback = new Database(databasePath, { readonly: true });
  assert.equal(compactedReadback.prepare('SELECT COUNT(*) AS count FROM attempt_scopes').get().count, 1);
  assert.equal(
    compactedReadback.prepare('SELECT COUNT(*) AS count FROM attempt_scope_work_units').get().count,
    root.scopeWorkUnits,
  );
  compactedReadback.close();
  assert.equal(reopened.listSuccessfulSweeps().some(row => (
    row.workUnitId === completedWorkUnit && row.output === 'durable completed sweep'
  )), true);
  await assert.rejects(
    Promise.resolve().then(() => reopened.planScope({
      attemptId: 'attempt-illegal-shrink',
      coverageLevel: 'deep',
      coverageFraction: 0.5,
    })),
    { code: 'pgs_scope_non_monotonic' },
  );
});

test('retained targeted scope policy preserves target unions across reopen', async t => {
  const { scratchDir, quota } = await fixture(t);
  const options = {
    sourcePin: syntheticSource({ nodeCount: 12, edgeCount: 11 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits: { ...limits, maxNodesPerWorkUnit: 1, maxSelectedWorkUnits: 64 },
  };
  const first = await openPinnedPGSStore(options);
  const firstPlan = first.planScope({
    attemptId: 'attempt-target-before-reopen',
    coverageLevel: 'sample',
    coverageFraction: 0.25,
    targetPartitionIds: ['c-cluster-1'],
  });
  const [completedWorkUnit] = first.snapshotPendingWorkUnits({
    attemptId: firstPlan.attemptId,
    limit: 64,
  });
  first.beginWorkUnitAttempt(completedWorkUnit, {
    attemptId: firstPlan.attemptId,
    provider: 'minimax',
    model: 'MiniMax-M3',
  });
  await first.commitSuccessfulSweeps([{
    workUnitId: completedWorkUnit,
    output: 'retained targeted sweep',
  }]);
  first.close();

  const reopened = await openPinnedPGSStore(options);
  t.after(() => reopened.close());
  await assert.rejects(
    Promise.resolve().then(() => reopened.planScope({
      attemptId: 'attempt-target-removal',
      coverageLevel: 'sample',
      coverageFraction: 0.25,
      targetPartitionIds: ['c-cluster-2'],
    })),
    { code: 'pgs_scope_non_monotonic' },
  );
  const union = reopened.planScope({
    attemptId: 'attempt-target-after-reopen',
    coverageLevel: 'sample',
    coverageFraction: 0.25,
    targetPartitionIds: ['c-cluster-1', 'c-cluster-2'],
  });
  assert.equal(
    reopened.listSuccessfulSweeps({ attemptId: union.attemptId })
      .some(row => row.workUnitId === completedWorkUnit),
    true,
  );
  assert.equal(
    reopened.snapshotPendingWorkUnits({ attemptId: union.attemptId, limit: 64 }).length,
    union.scopeWorkUnits - 1,
  );
});

test('target scopes filter snapshots, successes, counts, and monotonic unions', async t => {
  const { scratchDir, quota } = await fixture(t);
  const store = await openPinnedPGSStore({
    sourcePin: syntheticSource({ nodeCount: 12, edgeCount: 11 }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits: { ...limits, maxNodesPerWorkUnit: 1, maxSelectedWorkUnits: 64 },
  });
  t.after(() => store.close());

  const firstPlan = store.planScope({
    attemptId: 'attempt-target-one',
    coverageLevel: 'sample',
    coverageFraction: 0.25,
    targetPartitionIds: ['c-cluster-1'],
  });
  assert.deepEqual(firstPlan.targetPartitionIds, ['c-cluster-1']);
  const first = store.snapshotPendingWorkUnits({ attemptId: firstPlan.attemptId, limit: 64 });
  assert.equal(first.length, 1);
  assert.equal(first.every(id => store.loadWorkUnit(id).partitionId === 'c-cluster-1'), true);
  for (const workUnitId of first) {
    store.beginWorkUnitAttempt(workUnitId, {
      attemptId: firstPlan.attemptId, provider: 'minimax', model: 'MiniMax-M3',
    });
  }
  await store.commitSuccessfulSweeps(first.map(workUnitId => ({
    workUnitId, output: `target ${workUnitId}`,
  })));
  assert.equal(store.listSuccessfulSweeps({ attemptId: firstPlan.attemptId }).length, 1);
  assert.equal(store.countScopePendingWorkUnits(firstPlan.attemptId), 0);
  assert.equal(store.countPendingWorkUnits(), 11);

  const union = store.planScope({
    attemptId: 'attempt-target-union',
    coverageLevel: 'sample',
    coverageFraction: 0.25,
    targetPartitionIds: ['c-cluster-2', 'c-cluster-1'],
  });
  assert.deepEqual(union.targetPartitionIds, ['c-cluster-1', 'c-cluster-2']);
  const newIds = store.snapshotPendingWorkUnits({ attemptId: union.attemptId, limit: 64 });
  assert.equal(newIds.length, 1);
  assert.equal(newIds.every(id => store.loadWorkUnit(id).partitionId === 'c-cluster-2'), true);

  const deeper = store.planScope({
    attemptId: 'attempt-target-deeper',
    coverageLevel: 'deep',
    coverageFraction: 0.5,
    targetPartitionIds: ['c-cluster-1', 'c-cluster-2'],
  });
  assert.equal(deeper.scopeWorkUnits, 4);
  assert.equal(store.snapshotPendingWorkUnits({ attemptId: deeper.attemptId, limit: 64 }).length, 3);
  await assert.rejects(
    Promise.resolve().then(() => store.planScope({
      attemptId: 'attempt-target-shrink',
      coverageLevel: 'deep',
      coverageFraction: 0.5,
      targetPartitionIds: ['c-cluster-2'],
    })),
    { code: 'pgs_scope_non_monotonic' },
  );
});

test('a source record that cannot fit one work-unit context fails before provider use', async t => {
  const { scratchDir, quota } = await fixture(t);
  await assert.rejects(openPinnedPGSStore({
    sourcePin: syntheticSource({
      nodeCount: 1,
      edgeCount: 0,
      contentBytes: 129 * 1024,
    }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'minimax', model: 'MiniMax-M3' },
    query,
    signal: new AbortController().signal,
    limits,
  }), error => error.code === 'result_too_large');

  const pgsRoot = path.join(scratchDir, 'pgs');
  assert.deepEqual(await fs.readdir(pgsRoot).catch(() => []), []);
});

test('PGS persists provider-safe records without mutating vector-bearing source evidence', async t => {
  const { scratchDir, quota } = await fixture(t);
  const node = {
    id: 'n0',
    clusterId: 'cluster-0',
    content: 'provider-safe PGS evidence',
    embedding: Buffer.from([1, 2, 3, 4]),
    vector: new Float32Array([0.3, 0.4]),
    metadata: {
      embeddings: Object.assign(new Array(3), { 2: 0.6 }),
      nested: { vectors: [[0.7], [0.8]], evidence: 'preserved' },
      vector: 'textual vector field must remain',
    },
  };
  const edge = {
    source: 'n0', target: 'n0', type: 'self',
    embedding: [0.9],
    vector: 'textual edge vector must remain',
  };
  const beforeNode = {
    ...node,
    vector: [...node.vector],
    metadata: structuredClone(node.metadata),
  };
  const beforeEdge = structuredClone(edge);
  const store = await openPinnedPGSStore({
    sourcePin: syntheticSource({
      nodeCount: 1,
      edgeCount: 1,
      nodeFactory: () => node,
      edgeFactory: () => edge,
    }),
    scratchDir,
    scratchQuota: quota,
    pgsSweep: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
    query,
    signal: new AbortController().signal,
    limits,
  });
  t.after(() => store.close());

  const [workUnitId] = store.snapshotPendingWorkUnits({ attemptId: 'safe-records', limit: 1 });
  const work = store.loadWorkUnit(workUnitId);
  assert.equal(Object.hasOwn(work.nodes[0], 'embedding'), false);
  assert.equal(Object.hasOwn(work.nodes[0], 'vector'), false);
  assert.equal(Object.hasOwn(work.nodes[0].metadata, 'embeddings'), false);
  assert.equal(Object.hasOwn(work.nodes[0].metadata.nested, 'vectors'), false);
  assert.equal(work.nodes[0].metadata.nested.evidence, 'preserved');
  assert.equal(work.nodes[0].metadata.vector, 'textual vector field must remain');
  assert.equal(Object.hasOwn(work.edges[0], 'embedding'), false);
  assert.equal(work.edges[0].vector, 'textual edge vector must remain');
  assert.deepEqual({
    ...node,
    vector: [...node.vector],
    metadata: structuredClone(node.metadata),
  }, beforeNode);
  assert.deepEqual(edge, beforeEdge);
});
