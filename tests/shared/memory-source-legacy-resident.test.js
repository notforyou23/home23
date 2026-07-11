import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs, { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { constants as zlibConstants, gunzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
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

async function makeEmptyLegacyFixture() {
  const targetRoot = await tempDir('home23-legacy-resident-empty-target-');
  await writeJsonlGzAtomic(path.join(targetRoot, 'memory-nodes.jsonl.gz'), []);
  await writeJsonlGzAtomic(path.join(targetRoot, 'memory-edges.jsonl.gz'), []);
  return targetRoot;
}

async function makeCompressibleLegacyFixture(conceptBytes, { level } = {}) {
  const targetRoot = await tempDir('home23-legacy-resident-compressible-target-');
  await writeJsonlGzAtomic(path.join(targetRoot, 'memory-nodes.jsonl.gz'), [
    { id: 'large', concept: 'x'.repeat(conceptBytes), cluster: 'large' },
  ], { level });
  await writeJsonlGzAtomic(path.join(targetRoot, 'memory-edges.jsonl.gz'), [
    { source: 'large', target: 'large', weight: 1 },
  ]);
  return targetRoot;
}

async function countProjectionLedgerPublishesForDelta(entryCount) {
  const targetRoot = await tempDir('home23-legacy-resident-batch-target-');
  const operationRoot = await tempDir('home23-legacy-resident-batch-operation-');
  await writeJsonlGzAtomic(path.join(targetRoot, 'memory-nodes.jsonl.gz'), []);
  await writeJsonlGzAtomic(path.join(targetRoot, 'memory-edges.jsonl.gz'), []);
  await fsp.writeFile(path.join(targetRoot, 'memory-delta.jsonl'), Array.from(
    { length: entryCount },
    (_, index) => `${JSON.stringify({
      op: 'upsert_node',
      record: { id: `batched-${index}`, concept: `value-${index}` },
    })}\n`,
  ).join(''));
  let ledgerPublishes = 0;
  const quota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 32 * 1024 * 1024,
    _testHooks: {
      async afterLedgerPublish() {
        ledgerPublishes += 1;
      },
    },
  });
  try {
    const projected = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
      maxOverlayMemoryBytes: 0,
      maxOverlayDiskBytes: 16 * 1024 * 1024,
    });
    assert.equal(projected.descriptor.summary.nodeCount, entryCount);
    return ledgerPublishes;
  } finally {
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
}

test('legacy delta projection uses bounded durable batches instead of one quota cycle per record', async () => {
  const oneRecordPublishes = await countProjectionLedgerPublishesForDelta(1);
  const sixteenRecordPublishes = await countProjectionLedgerPublishesForDelta(16);
  assert.equal(
    sixteenRecordPublishes - oneRecordPublishes <= 6,
    true,
    `ledger publishes scaled per record: ${oneRecordPublishes} -> ${sixteenRecordPublishes}`,
  );
});

test('legacy base and delta preserve 64 KiB node IDs under a bounded heap', async () => {
  const probe = fileURLToPath(new URL('./memory-source-legacy-resident-heap-probe.cjs', import.meta.url));
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '--expose-gc',
    '--max-old-space-size=64',
    probe,
  ], {
    cwd: path.dirname(probe),
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});

test('legacy delta projection obeys compressed-input and decoded-stream limits', async (t) => {
  const targetRoot = await tempDir('home23-legacy-resident-delta-limit-target-');
  await writeJsonlGzAtomic(path.join(targetRoot, 'memory-nodes.jsonl.gz'), []);
  await writeJsonlGzAtomic(path.join(targetRoot, 'memory-edges.jsonl.gz'), []);
  await fsp.writeFile(path.join(targetRoot, 'memory-delta.jsonl'), `${JSON.stringify({
    op: 'upsert_node',
    record: { id: 'bounded-delta', concept: 'x'.repeat(1024) },
  })}\n`);
  try {
    for (const scenario of [
      {
        name: 'input',
        options: { maxInputBytes: 64, maxDecompressedBytes: 8 * 1024 },
        limitKind: 'input',
      },
      {
        name: 'decoded',
        options: { maxInputBytes: 8 * 1024, maxDecompressedBytes: 64 },
        limitKind: 'decompressed',
      },
    ]) {
      await t.test(scenario.name, async () => {
        const operationRoot = await tempDir('home23-legacy-resident-delta-limit-operation-');
        const quota = await createOperationScratchQuota({
          operationRoot,
          maxBytes: 64 * 1024 * 1024,
        });
        try {
          await assert.rejects(
            () => projectLegacyResidentSidecars({
              canonicalRoot: targetRoot,
              operationRoot,
              scratchQuota: quota,
              ...scenario.options,
            }),
            (error) => error?.code === 'result_too_large'
              && error?.limitKind === scenario.limitKind
              && error?.limit === 64,
          );
        } finally {
          await quota.close();
          await fsp.rm(operationRoot, { recursive: true, force: true });
        }
      });
    }
  } finally {
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('legacy projection accepts an explicit finite decompression cap above the generic reader default', async () => {
  const targetRoot = await makeLegacyFixture();
  const operationRoot = await tempDir('home23-legacy-resident-large-cap-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
  const maxDecompressedBytes = (2 * 1024 * 1024 * 1024) + 1;
  try {
    const projected = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
      maxDecompressedBytes,
    });
    assert.equal(Number.isSafeInteger(maxDecompressedBytes), true);
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

test('legacy projection fails when a source is one byte over its explicit decompression cap', async () => {
  const targetRoot = await makeLegacyFixture();
  const operationRoot = await tempDir('home23-legacy-resident-lower-cap-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
  const nodesBytes = gunzipSync(await fsp.readFile(
    path.join(targetRoot, 'memory-nodes.jsonl.gz'),
  )).length;
  try {
    await assert.rejects(() => projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
      maxDecompressedBytes: nodesBytes - 1,
    }), {
      code: 'result_too_large',
      status: 413,
      retryable: false,
      limitKind: 'decompressed',
      limit: nodesBytes - 1,
    });
  } finally {
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('legacy projection accepts an exact compressed cap and fails one byte below it', async () => {
  const targetRoot = await makeLegacyFixture();
  const nodeFile = path.join(targetRoot, 'memory-nodes.jsonl.gz');
  const edgeFile = path.join(targetRoot, 'memory-edges.jsonl.gz');
  const deltaFile = path.join(targetRoot, 'memory-delta.jsonl');
  const maxInputBytes = Math.max(
    (await fsp.stat(nodeFile)).size,
    (await fsp.stat(edgeFile)).size,
    (await fsp.stat(deltaFile)).size,
  );
  const rejectedRoot = await tempDir('home23-legacy-resident-compressed-reject-');
  const rejectedQuota = await createOperationScratchQuota({
    operationRoot: rejectedRoot,
    maxBytes: 64 * 1024 * 1024,
  });
  const acceptedRoot = await tempDir('home23-legacy-resident-compressed-accept-');
  const acceptedQuota = await createOperationScratchQuota({
    operationRoot: acceptedRoot,
    maxBytes: 64 * 1024 * 1024,
  });
  try {
    await assert.rejects(() => projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot: rejectedRoot,
      scratchQuota: rejectedQuota,
      maxInputBytes: maxInputBytes - 1,
    }), {
      code: 'result_too_large',
      status: 413,
      retryable: false,
      limitKind: 'input',
      limit: maxInputBytes - 1,
    });
    const projected = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot: acceptedRoot,
      scratchQuota: acceptedQuota,
      maxInputBytes,
    });
    assert.equal(projected.descriptor.summary.nodeCount, 2);
  } finally {
    await rejectedQuota.close();
    await acceptedQuota.close();
    await fsp.rm(rejectedRoot, { recursive: true, force: true });
    await fsp.rm(acceptedRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('legacy open separates original source caps from generated projection read caps', async () => {
  const targetRoot = await makeCompressibleLegacyFixture(1024 * 1024, {
    level: zlibConstants.Z_BEST_COMPRESSION,
  });
  const operationRoot = await tempDir('home23-legacy-resident-projection-read-cap-');
  const quota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 64 * 1024 * 1024,
  });
  const sourceInputCap = Math.max(
    (await fsp.stat(path.join(targetRoot, 'memory-nodes.jsonl.gz'))).size,
    (await fsp.stat(path.join(targetRoot, 'memory-edges.jsonl.gz'))).size,
  );
  let source = null;
  try {
    source = await openMemorySource(targetRoot, {
      operationRoot,
      scratchQuota: quota,
      maxInputBytes: sourceInputCap,
      maxDecompressedBytes: 2 * 1024 * 1024,
    });
    assert.equal(source.manifest.activeBase.nodes.bytes > sourceInputCap, true);
    const nodeIds = [];
    for await (const node of source.iterateNodes()) nodeIds.push(node.id);
    assert.deepEqual(nodeIds, ['large']);
  } finally {
    await source?.close();
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('legacy projection derives its finite decompression cap from the operation scratch quota', async () => {
  const maxBytes = 4 * 1024 * 1024;
  const targetRoot = await makeCompressibleLegacyFixture(maxBytes + 1);
  const operationRoot = await tempDir('home23-legacy-resident-quota-cap-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes });
  try {
    await assert.rejects(() => projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
    }), {
      code: 'result_too_large',
      status: 413,
      retryable: false,
      limitKind: 'decompressed',
      limit: maxBytes,
    });
  } finally {
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('legacy projection derives its finite compressed cap from the operation scratch quota', async () => {
  const maxBytes = 4 * 1024 * 1024;
  const targetRoot = await makeCompressibleLegacyFixture(maxBytes + 1, {
    level: zlibConstants.Z_NO_COMPRESSION,
  });
  const operationRoot = await tempDir('home23-legacy-resident-quota-input-cap-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes });
  try {
    await assert.rejects(() => projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
    }), {
      code: 'result_too_large',
      status: 413,
      retryable: false,
      limitKind: 'input',
      limit: maxBytes,
    });
  } finally {
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('legacy projection rejects invalid or above-maximum source caps', async () => {
  const hardMax = 8 * 1024 * 1024 * 1024;
  for (const limits of [
    { maxDecompressedBytes: 0 },
    { maxDecompressedBytes: -1 },
    { maxDecompressedBytes: 1.5 },
    { maxDecompressedBytes: hardMax + 1 },
    { maxInputBytes: 0 },
    { maxInputBytes: hardMax + 1 },
  ]) {
    const targetRoot = await makeLegacyFixture();
    const operationRoot = await tempDir('home23-legacy-resident-invalid-cap-');
    const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
    try {
      await assert.rejects(() => projectLegacyResidentSidecars({
        canonicalRoot: targetRoot,
        operationRoot,
        scratchQuota: quota,
        ...limits,
      }), { code: 'invalid_request' });
    } finally {
      await quota.close();
      await fsp.rm(operationRoot, { recursive: true, force: true });
      await fsp.rm(targetRoot, { recursive: true, force: true });
    }
  }
});

test('manifest iteration accepts an explicit finite decompression cap above the generic reader default', async () => {
  const targetRoot = await makeLegacyFixture();
  const operationRoot = await tempDir('home23-legacy-manifest-large-cap-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
  let source = null;
  try {
    const projected = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
    });
    source = await openMemorySource(projected.projectionRoot, {
      maxDecompressedBytes: (2 * 1024 * 1024 * 1024) + 1,
    });
    const nodes = [];
    for await (const node of source.iterateNodes()) nodes.push(node.id);
    assert.deepEqual(nodes, ['n1', 'n3']);
  } finally {
    await source?.close();
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('manifest iteration fails when its projected base is one byte over an explicit cap', async () => {
  const targetRoot = await makeLegacyFixture();
  const operationRoot = await tempDir('home23-legacy-manifest-lower-cap-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
  let source = null;
  try {
    const projected = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
    });
    const nodesFile = path.join(
      projected.projectionRoot,
      projected.manifest.activeBase.nodes.file,
    );
    const nodesBytes = gunzipSync(await fsp.readFile(nodesFile)).length;
    source = await openMemorySource(projected.projectionRoot, {
      maxDecompressedBytes: nodesBytes - 1,
    });
    await assert.rejects(async () => {
      for await (const _node of source.iterateNodes()) { /* consume */ }
    }, {
      code: 'result_too_large',
      status: 413,
      retryable: false,
      limitKind: 'decompressed',
      limit: nodesBytes - 1,
    });
  } finally {
    await source?.close();
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('manifest iteration accepts an exact compressed cap and fails one byte below it', async () => {
  const targetRoot = await makeLegacyFixture();
  const operationRoot = await tempDir('home23-legacy-manifest-input-cap-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
  let acceptedSource = null;
  let rejectedSource = null;
  try {
    const projected = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
    });
    const maxInputBytes = projected.manifest.activeBase.nodes.bytes;
    rejectedSource = await openMemorySource(projected.projectionRoot, {
      maxInputBytes: maxInputBytes - 1,
    });
    await assert.rejects(async () => {
      for await (const _node of rejectedSource.iterateNodes()) { /* consume */ }
    }, {
      code: 'result_too_large',
      status: 413,
      retryable: false,
      limitKind: 'input',
      limit: maxInputBytes - 1,
    });
    acceptedSource = await openMemorySource(projected.projectionRoot, { maxInputBytes });
    const nodes = [];
    for await (const node of acceptedSource.iterateNodes()) nodes.push(node.id);
    assert.deepEqual(nodes, ['n1', 'n3']);
  } finally {
    await rejectedSource?.close();
    await acceptedSource?.close();
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('legacy open reuses a projection but keeps the operation quota as its iteration cap', async () => {
  const maxBytes = 4 * 1024 * 1024;
  const targetRoot = await makeCompressibleLegacyFixture(maxBytes + 1);
  const operationRoot = await tempDir('home23-legacy-open-quota-cap-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes });
  let source = null;
  try {
    await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
      maxDecompressedBytes: maxBytes * 2,
    });
    source = await openMemorySource(targetRoot, {
      operationRoot,
      scratchQuota: quota,
    });
    await assert.rejects(async () => {
      for await (const _node of source.iterateNodes()) { /* consume */ }
    }, {
      code: 'result_too_large',
      status: 413,
      retryable: false,
      limitKind: 'decompressed',
      limit: maxBytes,
    });
  } finally {
    await source?.close();
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('manifest open rejects invalid or above-maximum source caps before iteration', async () => {
  const targetRoot = await makeLegacyFixture();
  const operationRoot = await tempDir('home23-legacy-manifest-invalid-cap-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
  let unexpectedlyOpened = null;
  try {
    const projected = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
    });
    const hardMax = 8 * 1024 * 1024 * 1024;
    for (const limits of [
      { maxDecompressedBytes: 0 },
      { maxDecompressedBytes: hardMax + 1 },
      { maxInputBytes: 0 },
      { maxInputBytes: hardMax + 1 },
    ]) {
      await assert.rejects(async () => {
        unexpectedlyOpened = await openMemorySource(projected.projectionRoot, limits);
      }, { code: 'invalid_request' });
    }
  } finally {
    await unexpectedlyOpened?.close();
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

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
    assert.equal(projected.evidence.sourceHealth, 'degraded');
    assert.equal(projected.evidence.freshness, 'unknown');

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
    const evidence = source.getEvidence();
    assert.equal(evidence.sourceHealth, 'degraded');
    assert.equal(evidence.freshness, 'unknown');
    const noMatch = await source.searchKeyword({ query: 'definitely absent', topK: 100 });
    assert.deepEqual(noMatch.results, []);
    assert.equal(noMatch.evidence.sourceHealth, 'degraded');
    assert.equal(noMatch.evidence.freshness, 'unknown');
    assert.equal(noMatch.evidence.completeCoverage, true);
    assert.equal(noMatch.evidence.matchOutcome, 'unknown');
    await source.close();
    assert.deepEqual(await hashTree(targetRoot), before);
  } finally {
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('empty legacy resident projection cannot claim corpus empty from degraded coverage', async () => {
  const targetRoot = await makeEmptyLegacyFixture();
  const operationRoot = await tempDir('home23-legacy-resident-empty-operation-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
  try {
    const source = await openMemorySource(targetRoot, {
      operationId: 'legacy-empty-open',
      requesterAgent: 'jerry',
      operationRoot,
      scratchQuota: quota,
    });
    const result = await source.searchKeyword({ query: 'anything', topK: 100 });
    assert.deepEqual(result.results, []);
    assert.deepEqual(result.evidence.authoritativeTotals, { nodes: 0, edges: 0 });
    assert.equal(result.evidence.sourceHealth, 'degraded');
    assert.equal(result.evidence.freshness, 'unknown');
    assert.equal(result.evidence.completeCoverage, true);
    assert.equal(result.evidence.matchOutcome, 'unknown');
    await source.close();
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

test('tight source input cap still reuses a larger immutable projection output', async () => {
  const targetRoot = await makeCompressibleLegacyFixture(256 * 1024, {
    level: zlibConstants.Z_BEST_COMPRESSION,
  });
  const operationRoot = await tempDir('home23-legacy-resident-tight-source-reuse-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
  const nodesPath = path.join(targetRoot, 'memory-nodes.jsonl.gz');
  const edgesPath = path.join(targetRoot, 'memory-edges.jsonl.gz');
  const maxInputBytes = Math.max(
    (await fsp.stat(nodesPath)).size,
    (await fsp.stat(edgesPath)).size,
  );
  const maxDecompressedBytes = Math.max(
    gunzipSync(await fsp.readFile(nodesPath)).length,
    gunzipSync(await fsp.readFile(edgesPath)).length,
  );
  try {
    const first = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
      maxInputBytes,
      maxDecompressedBytes,
    });
    assert.equal(first.manifest.activeBase.nodes.bytes > maxInputBytes, true);

    const second = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
      maxInputBytes,
      maxDecompressedBytes,
    });
    assert.equal(second.projectionRoot, first.projectionRoot);
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

test('legacy projection reuse rejects an oversized published file before hashing it', async () => {
  const targetRoot = await makeLegacyFixture();
  const operationRoot = await tempDir('home23-legacy-resident-reuse-cap-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
  const originalCreateReadStream = fs.createReadStream;
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
    const cappedEntry = integrity.files.nodes;
    assert.ok(cappedEntry, 'fixture must publish a nonempty digest file');
    const cappedIdentity = await fsp.stat(
      path.join(projected.projectionRoot, cappedEntry.file),
      { bigint: true },
    );
    let validationHashStarts = 0;
    fs.createReadStream = function createReadStreamTrap(...args) {
      validationHashStarts += 1;
      return originalCreateReadStream.apply(this, args);
    };
    const validationQuota = {
      operationRoot: quota.operationRoot,
      maxBytes: cappedEntry.bytes - 1,
      assertOperationRoot: (...args) => quota.assertOperationRoot(...args),
    };

    await assert.rejects(() => projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: validationQuota,
      maxInputBytes: 64 * 1024 * 1024,
      maxDecompressedBytes: 64 * 1024 * 1024,
    }), {
      code: 'result_too_large',
      status: 413,
      retryable: false,
      limitKind: 'input',
      limit: cappedEntry.bytes - 1,
    });
    assert.equal(validationHashStarts, 0);
    assert.equal(
      (await fsp.stat(path.join(projected.projectionRoot, cappedEntry.file), { bigint: true })).ino,
      cappedIdentity.ino,
    );
  } finally {
    fs.createReadStream = originalCreateReadStream;
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('abort interrupts an in-progress published projection digest during reuse', {
  timeout: 10_000,
}, async () => {
  const targetRoot = await makeLegacyFixture();
  const operationRoot = await tempDir('home23-legacy-resident-reuse-abort-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
  const controller = new AbortController();
  const reason = Object.assign(new Error('stop published projection validation'), {
    name: 'AbortError',
    code: 'cancelled',
  });
  const originalCreateReadStream = fs.createReadStream;
  const blockedStreams = [];
  let blockedFd = null;
  let resolveValidationStarted;
  const validationStarted = new Promise((resolve) => { resolveValidationStarted = resolve; });
  let resolveDigestClosed;
  const digestClosed = new Promise((resolve) => { resolveDigestClosed = resolve; });
  let settled;
  try {
    const projected = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
    });
    const digestTarget = path.join(
      projected.projectionRoot,
      projected.manifest.activeBase.nodes.file,
    );
    const digestIdentity = await fsp.stat(digestTarget, { bigint: true });
    fs.createReadStream = function createBlockedDigest(...args) {
      const fd = args[1]?.fd;
      if (Number.isInteger(fd)) {
        const opened = fs.fstatSync(fd, { bigint: true });
        if (opened.dev === digestIdentity.dev && opened.ino === digestIdentity.ino) {
          blockedFd = fd;
          let sent = false;
          const stream = new Readable({
            read() {
              if (sent) return;
              sent = true;
              this.push(Buffer.from([0]));
              resolveValidationStarted();
              controller.abort(reason);
            },
          });
          stream.once('close', resolveDigestClosed);
          blockedStreams.push(stream);
          return stream;
        }
      }
      return originalCreateReadStream.apply(this, args);
    };

    const operation = projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
      signal: controller.signal,
    });
    settled = operation.then(
      (value) => ({ kind: 'fulfilled', value }),
      (error) => ({ kind: 'rejected', error }),
    );
    const startOutcome = await Promise.race([
      validationStarted.then(() => ({ kind: 'started' })),
      settled,
      new Promise((resolve) => setTimeout(
        () => resolve({ kind: 'start_timeout' }),
        5_000,
      )),
    ]);
    const closeOutcome = startOutcome.kind === 'started'
      ? await Promise.race([
        digestClosed.then(() => ({ kind: 'closed' })),
        new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 500)),
      ])
      : startOutcome;

    for (const stream of blockedStreams) {
      if (!stream.destroyed) stream.push(null);
    }
    const finalOutcome = await settled;
    assert.equal(startOutcome.kind, 'started');
    assert.equal(closeOutcome.kind, 'closed', 'digest ignored AbortSignal until its stream ended');
    assert.throws(() => fs.fstatSync(blockedFd), { code: 'EBADF' });
    assert.equal(finalOutcome.kind, 'rejected');
    assert.equal(finalOutcome.error, reason);
  } finally {
    fs.createReadStream = originalCreateReadStream;
    controller.abort(reason);
    for (const stream of blockedStreams) {
      if (!stream.destroyed) stream.push(null);
    }
    if (settled) await settled;
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  }
});

test('published projection reuse rejects a pathname replacement during digest validation', async () => {
  const targetRoot = await makeLegacyFixture();
  const operationRoot = await tempDir('home23-legacy-resident-reuse-path-race-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
  const originalCreateReadStream = fs.createReadStream;
  let fileHandlePrototype = null;
  let originalHandleStat = null;
  let replacementPromise = null;
  try {
    const projected = await projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
    });
    const digestTarget = path.join(
      projected.projectionRoot,
      projected.manifest.activeBase.nodes.file,
    );
    const digestBytes = await fsp.readFile(digestTarget);
    const digestIdentity = await fsp.stat(digestTarget, { bigint: true });
    const displaced = `${digestTarget}.displaced`;
    let digestFd = null;
    const probe = await fsp.open(digestTarget, 'r');
    fileHandlePrototype = Object.getPrototypeOf(probe);
    originalHandleStat = fileHandlePrototype.stat;
    await probe.close();
    fs.createReadStream = function captureDigestFd(...args) {
      const fd = args[1]?.fd;
      if (Number.isInteger(fd)) {
        const opened = fs.fstatSync(fd, { bigint: true });
        if (opened.dev === digestIdentity.dev && opened.ino === digestIdentity.ino) {
          digestFd = fd;
        }
      }
      return originalCreateReadStream.apply(this, args);
    };
    fileHandlePrototype.stat = async function replacePathAfterStableStat(...args) {
      const stat = await originalHandleStat.apply(this, args);
      if (replacementPromise === null && this.fd === digestFd) {
        replacementPromise = (async () => {
          await fsp.rename(digestTarget, displaced);
          await fsp.writeFile(digestTarget, digestBytes);
        })();
        await replacementPromise;
      }
      return stat;
    };

    await assert.rejects(() => projectLegacyResidentSidecars({
      canonicalRoot: targetRoot,
      operationRoot,
      scratchQuota: quota,
    }), { code: 'invalid_memory_source' });
    await replacementPromise;
    assert.notEqual((await fsp.stat(digestTarget, { bigint: true })).ino, digestIdentity.ino);
  } finally {
    fs.createReadStream = originalCreateReadStream;
    if (fileHandlePrototype && originalHandleStat) fileHandlePrototype.stat = originalHandleStat;
    await replacementPromise?.catch(() => {});
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

test('optional legacy delta appearance before publication retries and includes it', async (t) => {
  const targetRoot = await makeLegacyFixture();
  const operationRoot = await tempDir('home23-legacy-resident-delta-appears-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
  const deltaPath = path.join(targetRoot, 'memory-delta.jsonl');
  await fsp.rm(deltaPath);
  let checks = 0;
  t.after(async () => {
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  });

  const projected = await projectLegacyResidentSidecars({
    canonicalRoot: targetRoot,
    operationRoot,
    scratchQuota: quota,
    maxAttempts: 3,
    _testHooks: {
      async beforeFingerprintVerification() {
        checks += 1;
        if (checks === 1) {
          await fsp.writeFile(deltaPath, `${JSON.stringify({
            op: 'upsert_node',
            record: { id: 'appeared', concept: 'optional delta appeared', cluster: 'c' },
          })}\n`);
        }
      },
    },
  });

  assert.equal(checks, 2);
  assert.notEqual(projected.sourceFingerprint.files.delta, null);
  assert.equal(projected.descriptor.summary.nodeCount, 3);
  const source = await openMemorySource(projected.projectionRoot);
  try {
    const nodes = [];
    for await (const node of source.iterateNodes()) nodes.push(node.id);
    assert.equal(nodes.includes('appeared'), true);
  } finally {
    await source.close();
  }
});

test('optional legacy delta disappearance before publication retries without it', async (t) => {
  const targetRoot = await makeLegacyFixture();
  const operationRoot = await tempDir('home23-legacy-resident-delta-disappears-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
  const deltaPath = path.join(targetRoot, 'memory-delta.jsonl');
  let checks = 0;
  t.after(async () => {
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  });

  const projected = await projectLegacyResidentSidecars({
    canonicalRoot: targetRoot,
    operationRoot,
    scratchQuota: quota,
    maxAttempts: 3,
    _testHooks: {
      async beforeFingerprintVerification() {
        checks += 1;
        if (checks === 1) await fsp.rm(deltaPath);
      },
    },
  });

  assert.equal(checks, 2);
  assert.equal(projected.sourceFingerprint.files.delta, null);
  assert.equal(projected.descriptor.summary.nodeCount, 2);
});

test('abort from resident final source hook publishes no projection', async (t) => {
  const targetRoot = await makeLegacyFixture();
  const operationRoot = await tempDir('home23-legacy-resident-final-abort-');
  const quota = await createOperationScratchQuota({ operationRoot, maxBytes: 64 * 1024 * 1024 });
  const controller = new AbortController();
  const reason = Object.assign(new Error('stop before resident publication'), {
    name: 'AbortError',
    code: 'cancelled',
  });
  t.after(async () => {
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  });

  await assert.rejects(() => projectLegacyResidentSidecars({
    canonicalRoot: targetRoot,
    operationRoot,
    scratchQuota: quota,
    signal: controller.signal,
    _testHooks: {
      async beforeFingerprintVerification() { controller.abort(reason); },
    },
  }), (error) => error === reason);
  assert.deepEqual(
    await fsp.readdir(path.join(operationRoot, 'source-projections')).catch(() => []),
    [],
  );
});

test('same-signal abort after resident writers reconciles projection scratch usage', async (t) => {
  const targetRoot = await makeLegacyFixture();
  const operationRoot = await tempDir('home23-legacy-resident-shared-abort-');
  const controller = new AbortController();
  const quota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 64 * 1024 * 1024,
    signal: controller.signal,
  });
  const baselineLedger = JSON.parse(await fsp.readFile(
    path.join(operationRoot, '.scratch-quota.json'),
    'utf8',
  ));
  const reason = Object.assign(new Error('stop after resident writers finish'), {
    name: 'AbortError',
    code: 'cancelled',
  });
  t.after(async () => {
    quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(targetRoot, { recursive: true, force: true });
  });

  await assert.rejects(() => projectLegacyResidentSidecars({
    canonicalRoot: targetRoot,
    operationRoot,
    scratchQuota: quota,
    signal: controller.signal,
    _testHooks: {
      async beforeFingerprintVerification() { controller.abort(reason); },
    },
  }), (error) => error === reason);

  assert.deepEqual(
    await fsp.readdir(path.join(operationRoot, 'source-projections')).catch(() => []),
    [],
  );
  const ledger = JSON.parse(await fsp.readFile(
    path.join(operationRoot, '.scratch-quota.json'),
    'utf8',
  ));
  assert.deepEqual(ledger.reservations, {});
  assert.equal(ledger.actualPrivateBytes, 0);
  assert.equal(ledger.usedBytes, baselineLedger.usedBytes);
  assert.equal(quota.usedBytes, baselineLedger.usedBytes);
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
    'operations',
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
    'operations',
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
    'operations',
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
