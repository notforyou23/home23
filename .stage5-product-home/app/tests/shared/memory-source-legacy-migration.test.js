import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  migrateLegacyResidentToManifest,
  openMemorySource,
  readManifest,
  resolveMemorySourceSelection,
  writeJsonlGzAtomic,
} = require('../../shared/memory-source');
const { appendMemoryDelta } = require('../../engine/src/core/memory-sidecar');

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function fixture() {
  const home23Root = await tempDir('home23-legacy-migration-home-');
  const brainDir = path.join(home23Root, 'instances', 'jerry', 'brain');
  await fsp.mkdir(brainDir, { recursive: true });
  await writeJsonlGzAtomic(path.join(brainDir, 'memory-nodes.jsonl.gz'), [
    { id: 'n1', concept: 'old', cluster: 'a' },
    { id: 'n2', concept: 'remove', cluster: 'b' },
  ]);
  await writeJsonlGzAtomic(path.join(brainDir, 'memory-edges.jsonl.gz'), [
    { source: 'n1', target: 'n2', weight: 0.5 },
  ]);
  await fsp.writeFile(path.join(brainDir, 'memory-delta.jsonl'), [
    { op: 'upsert_node', record: { id: 'n1', concept: 'updated', cluster: 'c' } },
    { op: 'remove_node', id: 'n2' },
    { op: 'upsert_node', record: { id: 'n3', concept: 'canary', cluster: 'c' } },
    { op: 'upsert_edge', record: { source: 'n1', target: 'n3', weight: 0.9 } },
  ].map((row) => `${JSON.stringify(row)}\n`).join(''));
  return { home23Root, brainDir };
}

test('streams legacy logical state into manifest-v1 without changing legacy files', async () => {
  const fx = await fixture();
  const legacyNames = ['memory-nodes.jsonl.gz', 'memory-edges.jsonl.gz', 'memory-delta.jsonl'];
  const before = new Map(await Promise.all(legacyNames.map(async (name) => [
    name,
    await fsp.readFile(path.join(fx.brainDir, name)),
  ])));

  const result = await migrateLegacyResidentToManifest({
    brainDir: fx.brainDir,
    home23Root: fx.home23Root,
    requesterAgent: 'jerry',
    operationId: 'migration-test',
    minFreeBytes: 0,
  });

  assert.equal(result.migrated, true);
  assert.equal(result.authority, 'manifest-v1');
  assert.equal(result.unchangedLegacy, true);
  assert.deepEqual(result.summary, { nodeCount: 2, edgeCount: 1, clusterCount: 1 });
  for (const name of legacyNames) {
    assert.deepEqual(await fsp.readFile(path.join(fx.brainDir, name)), before.get(name));
  }
  const manifest = await readManifest(fx.brainDir);
  assert.equal(manifest.currentRevision, result.revision);
  assert.equal(manifest.ann.builtFromRevision, null);

  const source = await openMemorySource(fx.brainDir, {
    requesterAgent: 'jerry',
    operationId: 'read-migrated',
    operationRoot: path.join(fx.home23Root, 'read-operation'),
    lockRoot: path.join(fx.home23Root, 'runtime', 'brain-source-locks'),
  });
  try {
    const nodes = [];
    const edges = [];
    for await (const node of source.iterateNodes()) nodes.push(node);
    for await (const edge of source.iterateEdges()) edges.push(edge);
    assert.deepEqual(nodes.map((node) => node.id).sort(), ['n1', 'n3']);
    assert.deepEqual(edges.map((edge) => [edge.source, edge.target]), [['n1', 'n3']]);
  } finally {
    await source.close();
  }
});

test('migration is idempotent when manifest-v1 already owns authority', async () => {
  const fx = await fixture();
  const options = {
    brainDir: fx.brainDir,
    home23Root: fx.home23Root,
    requesterAgent: 'jerry',
    operationId: 'migration-idempotent',
    minFreeBytes: 0,
  };
  const first = await migrateLegacyResidentToManifest(options);
  const second = await migrateLegacyResidentToManifest({ ...options, operationId: 'migration-idempotent-2' });
  assert.equal(first.migrated, true);
  assert.equal(second.migrated, false);
  assert.equal(second.authority, 'manifest-v1');
  assert.equal(second.generation, first.generation);
  assert.equal((await resolveMemorySourceSelection(fx.brainDir)).authority, 'manifest-v1');
});

test('capacity refusal leaves legacy authority and target tree unchanged', async () => {
  const fx = await fixture();
  const before = (await fsp.readdir(fx.brainDir)).sort();
  await assert.rejects(
    migrateLegacyResidentToManifest({
      brainDir: fx.brainDir,
      home23Root: fx.home23Root,
      requesterAgent: 'jerry',
      operationId: 'migration-capacity',
      minFreeBytes: Number.MAX_SAFE_INTEGER,
    }),
    (error) => error?.code === 'insufficient_disk',
  );
  assert.deepEqual((await fsp.readdir(fx.brainDir)).sort(), before);
  assert.equal((await resolveMemorySourceSelection(fx.brainDir)).authority, 'legacy-resident-sidecars');
});

test('split-filesystem preflight independently protects operation scratch capacity', async () => {
  const fx = await fixture();
  const before = (await fsp.readdir(fx.brainDir)).sort();
  await assert.rejects(
    migrateLegacyResidentToManifest({
      brainDir: fx.brainDir,
      home23Root: fx.home23Root,
      requesterAgent: 'jerry',
      operationId: 'migration-split-capacity',
      minFreeBytes: 0,
      statfsImpl: async (candidate) => path.basename(candidate) === 'brain'
        ? { bavail: 1024n * 1024n, bsize: 1n }
        : { bavail: 1n, bsize: 1n },
      deviceImpl: async (candidate) => path.basename(candidate) === 'brain' ? 1n : 2n,
    }),
    (error) => error?.code === 'insufficient_disk' && error?.capacityDomain === 'scratch',
  );
  assert.deepEqual((await fsp.readdir(fx.brainDir)).sort(), before);
  assert.equal((await resolveMemorySourceSelection(fx.brainDir)).authority, 'legacy-resident-sidecars');
});

test('a legacy append waiting on migration is committed to the new manifest delta', async () => {
  const fx = await fixture();
  let copiedResolve;
  let releaseResolve;
  const copied = new Promise((resolve) => { copiedResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const migration = migrateLegacyResidentToManifest({
    brainDir: fx.brainDir,
    home23Root: fx.home23Root,
    requesterAgent: 'jerry',
    operationId: 'migration-race',
    minFreeBytes: 0,
    _testHooks: {
      async afterNodeCopy() {
        copiedResolve();
        await release;
      },
    },
  });
  await copied;
  const legacyDelta = path.join(fx.brainDir, 'memory-delta.jsonl');
  const legacyBytes = (await fsp.stat(legacyDelta)).size;
  const append = appendMemoryDelta(fx.brainDir, {
    nodes: [{ id: 'after', concept: 'after cutover', cluster: 'c' }],
    summary: { nodeCount: 3, edgeCount: 1, clusterCount: 1 },
  }, {
    lockRoot: path.join(fx.home23Root, 'runtime', 'brain-source-locks'),
    lockTimeoutMs: 10_000,
  });
  releaseResolve();
  const [migrated, appended] = await Promise.all([migration, append]);
  assert.equal(migrated.migrated, true);
  assert.ok(appended.manifest);
  assert.equal((await fsp.stat(legacyDelta)).size, legacyBytes);
  assert.equal(appended.manifest.currentRevision, migrated.revision + 1);
});

test('publication failures before manifest rename preserve legacy authority', async (t) => {
  for (const hook of ['afterNodeCopy', 'afterEdgeCopy', 'afterDeltaFsync', 'beforeManifestRename']) {
    await t.test(hook, async () => {
      const fx = await fixture();
      const before = (await fsp.readdir(fx.brainDir)).sort();
      await assert.rejects(
        migrateLegacyResidentToManifest({
          brainDir: fx.brainDir,
          home23Root: fx.home23Root,
          requesterAgent: 'jerry',
          operationId: `migration-fault-${hook}`,
          minFreeBytes: 0,
          _testHooks: { [hook]: async () => { throw new Error(`injected:${hook}`); } },
        }),
        new RegExp(`injected:${hook}`),
      );
      assert.equal((await resolveMemorySourceSelection(fx.brainDir)).authority, 'legacy-resident-sidecars');
      assert.deepEqual((await fsp.readdir(fx.brainDir)).sort(), before);
    });
  }
});

test('same-size projection corruption is rejected before manifest authority switches', async () => {
  const fx = await fixture();
  await assert.rejects(
    migrateLegacyResidentToManifest({
      brainDir: fx.brainDir,
      home23Root: fx.home23Root,
      requesterAgent: 'jerry',
      operationId: 'migration-corrupt-projection',
      minFreeBytes: 0,
      _testHooks: {
        async afterNodeCopy({ projectionRoot, projectionManifest }) {
          const edgePath = path.join(projectionRoot, projectionManifest.activeBase.edges.file);
          const bytes = await fsp.readFile(edgePath);
          bytes[Math.floor(bytes.length / 2)] ^= 0xff;
          await fsp.writeFile(edgePath, bytes);
        },
      },
    }),
    (error) => error?.code === 'source_changed',
  );
  assert.equal((await resolveMemorySourceSelection(fx.brainDir)).authority, 'legacy-resident-sidecars');
});

test('same-inode target mutation in the final publication hook is rejected', async () => {
  const fx = await fixture();
  await assert.rejects(
    migrateLegacyResidentToManifest({
      brainDir: fx.brainDir,
      home23Root: fx.home23Root,
      requesterAgent: 'jerry',
      operationId: 'migration-mutated-target',
      minFreeBytes: 0,
      _testHooks: {
        async beforeManifestRename({ targetFiles }) {
          const edgePath = path.join(fx.brainDir, targetFiles.edges);
          const bytes = await fsp.readFile(edgePath);
          bytes[Math.floor(bytes.length / 2)] ^= 0xff;
          await fsp.writeFile(edgePath, bytes);
        },
      },
    }),
    (error) => error?.code === 'source_changed',
  );
  assert.equal((await resolveMemorySourceSelection(fx.brainDir)).authority, 'legacy-resident-sidecars');
});

test('operation-root pathname turnover never deletes the replacement directory', async () => {
  const fx = await fixture();
  const operationId = 'migration-operation-turnover';
  const operationRoot = path.join(
    fx.home23Root,
    'instances',
    'jerry',
    'runtime',
    'brain-operations',
    operationId,
  );
  const movedRoot = `${operationRoot}.moved`;
  const sentinel = path.join(operationRoot, 'replacement-sentinel');
  await assert.rejects(
    migrateLegacyResidentToManifest({
      brainDir: fx.brainDir,
      home23Root: fx.home23Root,
      requesterAgent: 'jerry',
      operationId,
      minFreeBytes: 0,
      _testHooks: {
        async afterNodeCopy() {
          await fsp.rename(operationRoot, movedRoot);
          await fsp.mkdir(operationRoot);
          await fsp.writeFile(sentinel, 'replacement');
        },
      },
    }),
    (error) => ['source_changed', 'invalid_memory_source', 'source_unavailable'].includes(error?.code),
  );
  assert.equal(await fsp.readFile(sentinel, 'utf8'), 'replacement');
  assert.equal(await fsp.stat(movedRoot).then((stat) => stat.isDirectory()), true);
  assert.equal(await fsp.stat(path.join(fx.brainDir, 'memory-manifest.json'))
    .then(() => true, () => false), false);
});

test('target-file pathname turnover is rejected without deleting the replacement', async () => {
  const fx = await fixture();
  let replacementPath;
  await assert.rejects(
    migrateLegacyResidentToManifest({
      brainDir: fx.brainDir,
      home23Root: fx.home23Root,
      requesterAgent: 'jerry',
      operationId: 'migration-target-turnover',
      minFreeBytes: 0,
      _testHooks: {
        async afterNodeCopy({ targetFiles }) {
          replacementPath = path.join(fx.brainDir, targetFiles.nodes);
          await fsp.rm(replacementPath);
          await fsp.writeFile(replacementPath, 'replacement-target');
        },
      },
    }),
    (error) => error?.code === 'source_changed',
  );
  assert.equal(await fsp.readFile(replacementPath, 'utf8'), 'replacement-target');
  assert.equal(await fsp.stat(path.join(fx.brainDir, 'memory-manifest.json'))
    .then(() => true, () => false), false);
});

test('cancellation cleans operation scratch and preserves legacy authority', async () => {
  const fx = await fixture();
  const controller = new AbortController();
  const operationId = 'migration-abort';
  await assert.rejects(
    migrateLegacyResidentToManifest({
      brainDir: fx.brainDir,
      home23Root: fx.home23Root,
      requesterAgent: 'jerry',
      operationId,
      minFreeBytes: 0,
      signal: controller.signal,
      _testHooks: { afterNodeCopy: async () => controller.abort() },
    }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal((await resolveMemorySourceSelection(fx.brainDir)).authority, 'legacy-resident-sidecars');
  assert.equal(await fsp.stat(path.join(
    fx.home23Root,
    'instances',
    'jerry',
    'runtime',
    'brain-operations',
    operationId,
  )).then(() => true, () => false), false);
});

test('an existing operation root is never reused or deleted', async () => {
  const fx = await fixture();
  const operationId = 'migration-existing-operation';
  const operationRoot = path.join(
    fx.home23Root,
    'instances',
    'jerry',
    'runtime',
    'brain-operations',
    operationId,
  );
  await fsp.mkdir(operationRoot, { recursive: true });
  const sentinel = path.join(operationRoot, 'do-not-delete');
  await fsp.writeFile(sentinel, 'owned elsewhere');
  await assert.rejects(
    migrateLegacyResidentToManifest({
      brainDir: fx.brainDir,
      home23Root: fx.home23Root,
      requesterAgent: 'jerry',
      operationId,
      minFreeBytes: 0,
    }),
    (error) => error?.code === 'operation_exists',
  );
  assert.equal(await fsp.readFile(sentinel, 'utf8'), 'owned elsewhere');
  assert.equal((await resolveMemorySourceSelection(fx.brainDir)).authority, 'legacy-resident-sidecars');
});

test('migration refuses a symlinked legacy source without target writes', async () => {
  const fx = await fixture();
  const edges = path.join(fx.brainDir, 'memory-edges.jsonl.gz');
  await fsp.rm(edges);
  await fsp.symlink('memory-nodes.jsonl.gz', edges);
  const before = (await fsp.readdir(fx.brainDir)).sort();
  await assert.rejects(
    migrateLegacyResidentToManifest({
      brainDir: fx.brainDir,
      home23Root: fx.home23Root,
      requesterAgent: 'jerry',
      operationId: 'migration-symlink',
      minFreeBytes: 0,
    }),
    (error) => error?.code === 'invalid_memory_source',
  );
  assert.deepEqual((await fsp.readdir(fx.brainDir)).sort(), before);
  assert.equal(await fsp.stat(path.join(fx.brainDir, 'memory-manifest.json'))
    .then(() => true, () => false), false);
});

test('migration rejects a brain outside the requester installation identity', async () => {
  const fx = await fixture();
  const foreign = await tempDir('home23-legacy-migration-foreign-');
  await writeJsonlGzAtomic(path.join(foreign, 'memory-nodes.jsonl.gz'), []);
  await writeJsonlGzAtomic(path.join(foreign, 'memory-edges.jsonl.gz'), []);
  await assert.rejects(
    migrateLegacyResidentToManifest({
      brainDir: foreign,
      home23Root: fx.home23Root,
      requesterAgent: 'jerry',
      operationId: 'migration-foreign',
      minFreeBytes: 0,
    }),
    (error) => error?.code === 'invalid_request',
  );
  assert.equal(await fsp.stat(path.join(foreign, 'memory-manifest.json'))
    .then(() => true, () => false), false);
});
