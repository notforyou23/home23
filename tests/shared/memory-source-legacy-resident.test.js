import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  createOperationScratchQuota,
  createMemorySourcePinProvider,
  openMemorySource,
  projectLegacyResidentSidecars,
  sourceDescriptorDigest,
  verifyLegacySourceFingerprint,
  writeJsonlGzAtomic,
} = require('../../shared/memory-source');

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function hashTree(root) {
  const rows = [];
  async function walk(directory, relative = '') {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(directory, entry.name);
      const name = path.join(relative, entry.name);
      const stat = await fsp.lstat(child);
      if (entry.isSymbolicLink()) rows.push([name, 'symlink', await fsp.readlink(child)]);
      else if (entry.isDirectory()) {
        rows.push([name, 'directory', stat.mode]);
        await walk(child, name);
      } else {
        rows.push([name, 'file', stat.size,
          crypto.createHash('sha256').update(await fsp.readFile(child)).digest('hex')]);
      }
    }
  }
  await walk(root);
  return rows;
}

async function makeLegacyFixture() {
  const targetRoot = await tempDir('home23-legacy-resident-target-');
  await writeJsonlGzAtomic(path.join(targetRoot, 'memory-nodes.jsonl.gz'), [
    { id: 'n1', concept: 'old', cluster: 'a' },
    { id: 'n2', concept: 'remove me', cluster: 'b' },
  ]);
  await writeJsonlGzAtomic(path.join(targetRoot, 'memory-edges.jsonl.gz'), [
    { source: 'n1', target: 'n2', weight: 0.5 },
  ]);
  await fsp.writeFile(path.join(targetRoot, 'memory-delta.jsonl'), [
    { op: 'upsert_node', record: { id: 'n1', concept: 'updated', cluster: 'c' } },
    { op: 'remove_node', id: 'n2' },
    { op: 'upsert_node', record: { id: 'n3', concept: 'new canary', cluster: 'c' } },
    { op: 'upsert_edge', record: { source: 'n1', target: 'n3', weight: 0.9 } },
  ].map((row) => `${JSON.stringify(row)}\n`).join(''));
  return targetRoot;
}

test('legacy resident projection streams base plus delta into an immutable logical base', async () => {
  const targetRoot = await makeLegacyFixture();
  const operationRoot = await tempDir('home23-legacy-resident-operation-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
  const before = await hashTree(targetRoot);
  try {
    const projected = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
    });
    assert.equal(projected.descriptor.version, 1);
    assert.equal(projected.descriptor.canonicalRoot, await fsp.realpath(targetRoot));
    assert.deepEqual(projected.descriptor.summary, {
      nodeCount: 2,
      edgeCount: 1,
      clusterCount: 1,
    });
    assert.equal(projected.projectionRoot.startsWith(
      path.join(quota.operationRoot, 'source-projections'),
    ), true);
    assert.equal(await verifyLegacySourceFingerprint(targetRoot, projected.sourceFingerprint), true);

    const source = await openMemorySource(targetRoot, {
      operationId: 'legacy-open',
      requesterAgent: 'jerry',
      operationRoot,
      scratchQuota: quota,
    });
    const nodes = [];
    const edges = [];
    for await (const node of source.iterateNodes()) nodes.push(node);
    for await (const edge of source.iterateEdges()) edges.push(edge);
    assert.deepEqual(nodes.map((node) => [node.id, node.concept]), [
      ['n1', 'updated'],
      ['n3', 'new canary'],
    ]);
    assert.deepEqual(edges.map((edge) => [edge.source, edge.target]), [['n1', 'n3']]);
    assert.equal(source.descriptor.canonicalRoot, await fsp.realpath(targetRoot));
    assert.equal(source.getEvidence().sourceHealth, 'degraded');
    await source.close();
    assert.deepEqual(await hashTree(targetRoot), before);
  } finally {
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('same legacy fingerprint reuses immutable publication and a changed source gets a new generation', async () => {
  const targetRoot = await makeLegacyFixture();
  const operationRoot = await tempDir('home23-legacy-resident-reuse-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
  try {
    const first = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot, operationRoot, scratchQuota: quota,
    });
    const firstIdentity = await fsp.stat(first.projectionRoot, { bigint: true });
    const second = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot, operationRoot, scratchQuota: quota,
    });
    const secondIdentity = await fsp.stat(second.projectionRoot, { bigint: true });
    assert.equal(second.projectionRoot, first.projectionRoot);
    assert.equal(secondIdentity.ino, firstIdentity.ino);

    await fsp.appendFile(path.join(targetRoot, 'memory-delta.jsonl'),
      `${JSON.stringify({ op: 'upsert_node', record: { id: 'n4', concept: 'later' } })}\n`);
    assert.equal(await verifyLegacySourceFingerprint(targetRoot, first.sourceFingerprint), false);
    const third = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot, operationRoot, scratchQuota: quota,
    });
    assert.notEqual(third.projectionRoot, first.projectionRoot);
    assert.equal(third.descriptor.summary.nodeCount, 3);
    assert.equal((await fsp.stat(first.projectionRoot, { bigint: true })).ino, firstIdentity.ino);
  } finally {
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('published legacy projection records deterministic manifest counts and file digests', async () => {
  const targetRoot = await makeLegacyFixture();
  const operationRoot = await tempDir('home23-legacy-resident-integrity-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
  try {
    const projected = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
    });
    const integrity = JSON.parse(await fsp.readFile(
      path.join(projected.projectionRoot, 'projection-integrity.json'),
      'utf8',
    ));
    assert.deepEqual(Object.keys(integrity).sort(), [
      'files',
      'generation',
      'manifestDigest',
      'version',
    ]);
    assert.equal(integrity.version, 1);
    assert.equal(integrity.generation, projected.manifest.generation);
    assert.equal(integrity.manifestDigest, sourceDescriptorDigest(projected.manifest));
    for (const [kind, entry] of Object.entries(integrity.files)) {
      const manifestEntry = kind === 'delta'
        ? projected.manifest.activeDelta
        : projected.manifest.activeBase[kind];
      assert.equal(entry.file, manifestEntry.file);
      assert.equal(entry.bytes, kind === 'delta' ? manifestEntry.committedBytes : manifestEntry.bytes);
      assert.equal(entry.count, manifestEntry.count);
      assert.equal(entry.sha256, crypto.createHash('sha256').update(
        await fsp.readFile(path.join(projected.projectionRoot, entry.file)),
      ).digest('hex'));
    }
  } finally {
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('legacy projection reuse rejects generation manifest count and file digest drift', async () => {
  const targetRoot = await makeLegacyFixture();
  const operationRoot = await tempDir('home23-legacy-resident-validate-reuse-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
  try {
    const projected = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
    });
    const manifestPath = path.join(projected.projectionRoot, 'memory-manifest.json');
    const originalManifestText = await fsp.readFile(manifestPath, 'utf8');
    const originalManifest = JSON.parse(originalManifestText);
    const nodePath = path.join(
      projected.projectionRoot,
      projected.manifest.activeBase.nodes.file,
    );
    const originalNodeBytes = await fsp.readFile(nodePath);

    const expectRejected = async (mutate, restore) => {
      await mutate();
      await assert.rejects(() => projectLegacyResidentSidecars({
        canonicalRoot: targetRoot,
        operationRoot,
        scratchQuota: quota,
      }), { code: 'invalid_memory_source' });
      await restore();
    };

    await expectRejected(async () => {
      await fsp.writeFile(manifestPath, `${JSON.stringify({
        ...originalManifest,
        generation: 'legacy-wrong-generation',
      }, null, 2)}\n`);
    }, async () => fsp.writeFile(manifestPath, originalManifestText));

    await expectRejected(async () => {
      await fsp.writeFile(manifestPath, `${JSON.stringify({
        ...originalManifest,
        activeBase: {
          ...originalManifest.activeBase,
          nodes: {
            ...originalManifest.activeBase.nodes,
            count: originalManifest.activeBase.nodes.count + 1,
          },
        },
        summary: {
          ...originalManifest.summary,
          nodeCount: originalManifest.summary.nodeCount + 1,
        },
      }, null, 2)}\n`);
    }, async () => fsp.writeFile(manifestPath, originalManifestText));

    await expectRejected(async () => {
      await fsp.writeFile(manifestPath, `${JSON.stringify({
        ...originalManifest,
        ann: {
          ...originalManifest.ann,
          builtFromRevision: originalManifest.currentRevision,
        },
      }, null, 2)}\n`);
    }, async () => fsp.writeFile(manifestPath, originalManifestText));

    await expectRejected(async () => {
      const corrupted = Buffer.from(originalNodeBytes);
      corrupted[corrupted.length - 1] ^= 0xff;
      await fsp.writeFile(nodePath, corrupted);
    }, async () => fsp.writeFile(nodePath, originalNodeBytes));

    const reused = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
    });
    assert.equal(reused.projectionRoot, projected.projectionRoot);
  } finally {
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('projection retries a source change and removes abandoned attempts', async () => {
  const targetRoot = await makeLegacyFixture();
  const operationRoot = await tempDir('home23-legacy-resident-retry-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
  let calls = 0;
  try {
    const projected = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
      maxAttempts: 3,
      _testHooks: {
        async beforeFingerprintVerification() {
          calls += 1;
          if (calls === 1) {
            await fsp.appendFile(path.join(targetRoot, 'memory-delta.jsonl'),
              `${JSON.stringify({ op: 'upsert_node', record: { id: 'n5', concept: 'retry' } })}\n`);
          }
        },
      },
    });
    assert.equal(calls, 2);
    assert.equal(projected.descriptor.summary.nodeCount, 3);
    const entries = await fsp.readdir(path.join(operationRoot, 'source-projections'));
    assert.deepEqual(entries, [path.basename(projected.projectionRoot)]);
  } finally {
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('projection retries an inode replacement instead of reopening the pathname', async () => {
  const targetRoot = await makeLegacyFixture();
  const operationRoot = await tempDir('home23-legacy-resident-inode-retry-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
  const nodesPath = path.join(targetRoot, 'memory-nodes.jsonl.gz');
  let calls = 0;
  try {
    const projected = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
      maxAttempts: 3,
      _testHooks: {
        async beforeFingerprintVerification() {
          calls += 1;
          if (calls === 1) {
            const displaced = `${nodesPath}.displaced`;
            await fsp.rename(nodesPath, displaced);
            await fsp.copyFile(displaced, nodesPath);
          }
        },
      },
    });
    assert.equal(calls, 2);
    const current = await fsp.stat(nodesPath, { bigint: true });
    assert.equal(projected.sourceFingerprint.files.nodes.stat.ino, String(current.ino));
    assert.deepEqual(projected.descriptor.summary, {
      nodeCount: 2,
      edgeCount: 1,
      clusterCount: 1,
    });
  } finally {
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('legacy coordinator pin retains its immutable projection after the target advances', async () => {
  const home23Root = await tempDir('home23-legacy-pin-home-');
  const targetRoot = await makeLegacyFixture();
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const operationId = 'brop_legacy_resident_pin';
  const operationRoot = path.join(
    await fsp.realpath(home23Root),
    'instances',
    'jerry',
    'runtime',
    'brain-operations',
    operationId,
  );
  try {
    const pinned = await provider.pin(targetRoot, operationId);
    assert.deepEqual(Object.keys(pinned).sort(), ['descriptor', 'digest']);
    assert.equal(pinned.descriptor.summary.nodeCount, 2);
    await fsp.appendFile(path.join(targetRoot, 'memory-delta.jsonl'),
      `${JSON.stringify({ op: 'upsert_node', record: { id: 'after-pin', concept: 'later' } })}\n`);
    assert.deepEqual(await provider.pin(targetRoot, operationId), pinned);

    const quota = await createOperationScratchQuota({ operationRoot });
    const source = await provider.openPinnedSource(pinned.descriptor, {
      operationId,
      operationRoot,
      scratchQuota: quota,
      expectedCanonicalRoot: await fsp.realpath(targetRoot),
      expectedRevision: pinned.descriptor.cutoffRevision,
      expectedDigest: pinned.digest,
    });
    const concepts = [];
    for await (const node of source.iterateNodes()) concepts.push(node.concept);
    assert.deepEqual(concepts, ['updated', 'new canary']);
    assert.equal(await source.isCurrent(), false);
    await source.release();
    await quota.close();
    await provider.releaseOperationPins(operationId);
    assert.equal(await fsp.access(path.join(operationRoot, 'source-projections'))
      .then(() => true).catch(() => false), false);
  } finally {
    await fsp.rm(home23Root, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('legacy coordinator pin rejects a physical projection outside its operation root', async () => {
  const home23Root = await tempDir('home23-legacy-pin-home-');
  const targetRoot = await makeLegacyFixture();
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const operationId = 'brop_legacy_projection_escape';
  const operationRoot = path.join(
    await fsp.realpath(home23Root),
    'instances',
    'jerry',
    'runtime',
    'brain-operations',
    operationId,
  );
  try {
    const pinned = await provider.pin(targetRoot, operationId);
    const recordPath = path.join(operationRoot, 'coordinator-source-pin.json');
    const record = JSON.parse(await fsp.readFile(recordPath, 'utf8'));
    record.physicalRoot = await fsp.realpath(targetRoot);
    await fsp.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);

    const quota = await createOperationScratchQuota({ operationRoot });
    const canonicalTarget = await fsp.realpath(targetRoot);
    await assert.rejects(() => provider.openPinnedSource(pinned.descriptor, {
      operationId,
      operationRoot,
      scratchQuota: quota,
      expectedCanonicalRoot: canonicalTarget,
      expectedRevision: pinned.descriptor.cutoffRevision,
      expectedDigest: pinned.digest,
    }), { code: 'source_changed' });
    await quota.close();
  } finally {
    await fsp.rm(home23Root, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('legacy coordinator pin rejects a replaced physical projection identity', async () => {
  const home23Root = await tempDir('home23-legacy-pin-home-');
  const targetRoot = await makeLegacyFixture();
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent: 'jerry' });
  const operationId = 'brop_legacy_projection_identity';
  const operationRoot = path.join(
    await fsp.realpath(home23Root),
    'instances',
    'jerry',
    'runtime',
    'brain-operations',
    operationId,
  );
  try {
    const pinned = await provider.pin(targetRoot, operationId);
    const record = JSON.parse(await fsp.readFile(
      path.join(operationRoot, 'coordinator-source-pin.json'),
      'utf8',
    ));
    const displacedRoot = `${record.physicalRoot}.displaced`;
    await fsp.rename(record.physicalRoot, displacedRoot);
    await fsp.cp(displacedRoot, record.physicalRoot, { recursive: true });

    const quota = await createOperationScratchQuota({ operationRoot });
    const canonicalTarget = await fsp.realpath(targetRoot);
    await assert.rejects(() => provider.openPinnedSource(pinned.descriptor, {
      operationId,
      operationRoot,
      scratchQuota: quota,
      expectedCanonicalRoot: canonicalTarget,
      expectedRevision: pinned.descriptor.cutoffRevision,
      expectedDigest: pinned.digest,
    }), { code: 'source_changed' });
    await quota.close();
  } finally {
    await fsp.rm(home23Root, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});
