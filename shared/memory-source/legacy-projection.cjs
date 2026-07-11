'use strict';

const fsp = require('node:fs').promises;
const path = require('node:path');
const crypto = require('node:crypto');
const {
  createQuotaBackpressuredJsonlGzipWriter,
  readJsonl,
} = require('./jsonl.cjs');
const {
  findLegacyResidentSidecars,
  fsyncDirectory,
  readManifest,
  writeManifestAtomic,
} = require('./manifest.cjs');
const { createBoundedOverlayStore } = require('./overlay-store.cjs');
const { createOperationScratchQuota } = require('./scratch-quota.cjs');
const {
  edgeKeyFor,
  memorySourceError,
  normalizeId,
  rethrowAbort,
  throwIfAborted,
} = require('./contracts.cjs');

const MAX_ATTEMPTS = 3;
const MAX_CLUSTER_KEYS = 1_000_000;
const METADATA_GROWTH_BYTES = 1024 * 1024;

function safeRevisionFromDigest(digest) {
  return Number.parseInt(digest.slice(0, 13), 16);
}

function normalizeEdge(edge) {
  return Object.freeze({
    ...edge,
    source: normalizeId(edge.source ?? edge.from),
    target: normalizeId(edge.target ?? edge.to),
  });
}

function statFingerprint(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function sameFingerprint(left, right) {
  return Boolean(left && right
    && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']
      .every((key) => left[key] === right[key]));
}

function sameSourceFingerprint(left, right) {
  return Boolean(left && right
    && left.version === 1
    && right.version === 1
    && left.canonicalRoot === right.canonicalRoot
    && ['nodes', 'edges', 'delta'].every((key) => {
      if (left.files[key] === null || right.files[key] === null) {
        return left.files[key] === right.files[key];
      }
      return left.files[key].basename === right.files[key].basename
        && sameFingerprint(left.files[key].stat, right.files[key].stat);
    }));
}

function fingerprintDigest(fingerprint) {
  return crypto.createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
}

async function fingerprintLegacyResident(canonicalRoot) {
  const targetRoot = await fsp.realpath(canonicalRoot);
  const files = await findLegacyResidentSidecars(targetRoot);
  if (!files) {
    throw memorySourceError('source_unavailable', 'legacy resident sidecars are unavailable', {
      retryable: true,
    });
  }
  const describe = async (filePath, optional = false) => {
    try {
      const canonical = await fsp.realpath(filePath);
      if (canonical !== filePath || !canonical.startsWith(`${targetRoot}${path.sep}`)) {
        throw memorySourceError('invalid_memory_source', 'legacy sidecar path escaped target');
      }
      const stat = await fsp.stat(filePath, { bigint: true });
      if (!stat.isFile()) throw memorySourceError('invalid_memory_source', 'legacy sidecar is not regular');
      return Object.freeze({ basename: path.basename(filePath), stat: statFingerprint(stat) });
    } catch (error) {
      if (optional && error.code === 'ENOENT') return null;
      throw error;
    }
  };
  return Object.freeze({
    version: 1,
    canonicalRoot: targetRoot,
    files: Object.freeze({
      nodes: await describe(files.nodes),
      edges: await describe(files.edges),
      delta: await describe(files.delta, true),
    }),
  });
}

async function verifyLegacySourceFingerprint(canonicalRoot, expected) {
  try {
    return sameSourceFingerprint(await fingerprintLegacyResident(canonicalRoot), expected);
  } catch {
    return false;
  }
}

async function readPublishedProjection(projectionRoot, targetRoot, expectedFingerprint) {
  try {
    const [manifest, storedFingerprint] = await Promise.all([
      readManifest(projectionRoot),
      fsp.readFile(path.join(projectionRoot, 'source-fingerprint.json'), 'utf8')
        .then((text) => JSON.parse(text)),
    ]);
    if (!manifest || !sameSourceFingerprint(storedFingerprint, expectedFingerprint)) return null;
    return projectionResult({
      targetRoot,
      projectionRoot,
      manifest,
      sourceFingerprint: storedFingerprint,
    });
  } catch {
    return null;
  }
}

function projectionResult({ targetRoot, projectionRoot, manifest, sourceFingerprint }) {
  return Object.freeze({
    canonicalRoot: targetRoot,
    projectionRoot,
    manifest,
    sourceFingerprint: Object.freeze(sourceFingerprint),
    descriptor: Object.freeze({
      version: 1,
      canonicalRoot: targetRoot,
      generation: manifest.generation,
      baseRevision: manifest.baseRevision,
      cutoffRevision: manifest.currentRevision,
      activeBase: manifest.activeBase,
      activeDelta: manifest.activeDelta,
      summary: manifest.summary,
    }),
    evidence: Object.freeze({
      implementation: 'legacy-resident-sidecar-projection',
      sourceHealth: 'degraded',
      matchOutcome: 'unknown',
      freshness: 'unknown',
      baseRevision: manifest.baseRevision,
      deltaRevision: manifest.currentRevision,
      authoritativeTotals: Object.freeze({
        nodes: manifest.summary.nodeCount,
        edges: manifest.summary.edgeCount,
      }),
    }),
  });
}

async function removeOwnedAttempt(attemptRoot, identity) {
  const stat = await fsp.lstat(attemptRoot).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || stat.dev !== identity.dev || stat.ino !== identity.ino) {
    throw memorySourceError('invalid_memory_source', 'projection attempt identity changed');
  }
  await fsp.rm(attemptRoot, { recursive: true, force: false });
}

async function loadLegacyDelta({ targetRoot, fingerprint, overlay, signal }) {
  const delta = fingerprint.files.delta;
  if (!delta || Number(delta.stat.size) === 0) return;
  const byteLimit = Number(delta.stat.size);
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 0) {
    throw memorySourceError('result_too_large', 'legacy delta is too large', {
      status: 413,
      retryable: false,
    });
  }
  for await (const entry of readJsonl(path.join(targetRoot, delta.basename), {
    confinedRoot: targetRoot,
    byteLimit,
    requireCompletePrefix: true,
    allowTrailingBytes: true,
    signal,
  })) {
    throwIfAborted(signal);
    await overlay.apply(entry);
  }
}

function logicalNodeRecords({ targetRoot, fingerprint, overlay, signal, clusters }) {
  return (async function* nodes() {
    const pending = new Set();
    for await (const record of overlay.iterateNodeUpserts({ signal })) {
      pending.add(normalizeId(record.id));
    }
    for await (const record of readJsonl(path.join(targetRoot, fingerprint.files.nodes.basename), {
      gzip: true,
      confinedRoot: targetRoot,
      expectedInputBytes: Number(fingerprint.files.nodes.stat.size),
      signal,
    })) {
      throwIfAborted(signal);
      const id = normalizeId(record.id);
      pending.delete(id);
      if (overlay.hasRemovedNode(id)) continue;
      const projected = overlay.node(id) || Object.freeze({ ...record, id });
      if (projected.cluster !== undefined && projected.cluster !== null) {
        clusters.add(normalizeId(projected.cluster));
        if (clusters.size > MAX_CLUSTER_KEYS) {
          throw memorySourceError('result_too_large', 'legacy cluster count exceeds limit', {
            status: 413,
            retryable: false,
          });
        }
      }
      yield projected;
    }
    for await (const record of overlay.iterateNodeUpserts({ signal })) {
      const id = normalizeId(record.id);
      if (!pending.has(id) || overlay.hasRemovedNode(id)) continue;
      if (record.cluster !== undefined && record.cluster !== null) {
        clusters.add(normalizeId(record.cluster));
        if (clusters.size > MAX_CLUSTER_KEYS) {
          throw memorySourceError('result_too_large', 'legacy cluster count exceeds limit', {
            status: 413,
            retryable: false,
          });
        }
      }
      yield Object.freeze({ ...record, id });
    }
  })();
}

function logicalEdgeRecords({ targetRoot, fingerprint, overlay, signal }) {
  return (async function* edges() {
    const pending = new Set();
    for await (const record of overlay.iterateEdgeUpserts({ signal })) {
      pending.add(edgeKeyFor(record));
    }
    const eligible = (record) => !overlay.hasRemovedNode(record.source)
      && !overlay.hasRemovedNode(record.target);
    for await (const record of readJsonl(path.join(targetRoot, fingerprint.files.edges.basename), {
      gzip: true,
      confinedRoot: targetRoot,
      expectedInputBytes: Number(fingerprint.files.edges.stat.size),
      signal,
    })) {
      throwIfAborted(signal);
      const normalized = normalizeEdge(record);
      const key = edgeKeyFor(normalized);
      pending.delete(key);
      if (overlay.hasRemovedEdge(key) || !eligible(normalized)) continue;
      yield overlay.edge(key) || normalized;
    }
    for await (const record of overlay.iterateEdgeUpserts({ signal })) {
      const normalized = normalizeEdge(record);
      const key = edgeKeyFor(normalized);
      if (pending.has(key) && !overlay.hasRemovedEdge(key) && eligible(normalized)) yield normalized;
    }
  })();
}

async function publishMetadata({
  attemptRoot,
  quota,
  generation,
  revision,
  nodes,
  edges,
  clusterCount,
  sourceFingerprint,
}) {
  const deltaFile = `memory-delta.${generation}.jsonl`;
  const manifest = {
    formatVersion: 1,
    generation,
    baseRevision: revision,
    currentRevision: revision,
    activeDeltaEpoch: generation,
    activeBase: {
      nodes: { file: 'memory-nodes.base.jsonl.gz', count: nodes.count, bytes: nodes.bytes },
      edges: { file: 'memory-edges.base.jsonl.gz', count: edges.count, bytes: edges.bytes },
    },
    activeDelta: {
      epoch: generation,
      file: deltaFile,
      fromRevision: revision + 1,
      toRevision: revision,
      count: 0,
      committedBytes: 0,
    },
    ann: { indexFile: null, metaFile: null, builtFromRevision: null },
    summary: { nodeCount: nodes.count, edgeCount: edges.count, clusterCount },
  };
  await quota.withPhysicalGrowth(
    METADATA_GROWTH_BYTES,
    `legacy_projection_metadata_${crypto.randomUUID()}`,
    async ({ checkpoint }) => {
      const deltaHandle = await fsp.open(path.join(attemptRoot, deltaFile), 'wx', 0o600);
      try { await deltaHandle.sync(); } finally { await deltaHandle.close(); }
      const fingerprintHandle = await fsp.open(
        path.join(attemptRoot, 'source-fingerprint.json'),
        'wx',
        0o600,
      );
      try {
        await fingerprintHandle.writeFile(`${JSON.stringify(sourceFingerprint)}\n`);
        await fingerprintHandle.sync();
      } finally {
        await fingerprintHandle.close();
      }
      await writeManifestAtomic(attemptRoot, manifest);
      await fsyncDirectory(attemptRoot);
      await checkpoint();
    },
  );
  return manifest;
}

async function projectLegacyResidentSidecars({
  canonicalRoot,
  operationRoot,
  scratchQuota,
  signal,
  maxAttempts = MAX_ATTEMPTS,
  maxOverlayMemoryBytes,
  maxOverlayDiskBytes,
  _testHooks = {},
} = {}) {
  throwIfAborted(signal);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw memorySourceError('invalid_request', 'invalid legacy projection attempt limit');
  }
  const targetRoot = await fsp.realpath(canonicalRoot);
  const ownsQuota = !scratchQuota;
  const quota = scratchQuota || await createOperationScratchQuota({ operationRoot, signal });
  if (await quota.assertOperationRoot(operationRoot) !== true) {
    throw memorySourceError('source_operation_required', 'exact operation scratch quota required');
  }
  const projectionsRoot = path.join(quota.operationRoot, 'source-projections');
  await fsp.mkdir(projectionsRoot, { recursive: true, mode: 0o700 });
  let lastChanged = null;
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      throwIfAborted(signal);
      const before = await fingerprintLegacyResident(targetRoot);
      const digest = fingerprintDigest(before);
      const generation = `legacy-${digest.slice(0, 20)}`;
      const revision = safeRevisionFromDigest(digest);
      const projectionRoot = path.join(projectionsRoot, generation);
      const published = await readPublishedProjection(projectionRoot, targetRoot, before);
      if (published) return published;

      const attemptRoot = path.join(projectionsRoot, `.attempt-${process.pid}-${crypto.randomUUID()}`);
      await fsp.mkdir(attemptRoot, { recursive: false, mode: 0o700 });
      const attemptIdentity = await fsp.lstat(attemptRoot);
      const overlay = await createBoundedOverlayStore({
        operationRoot: quota.operationRoot,
        scratchQuota: quota,
        signal,
        maxMemoryBytes: maxOverlayMemoryBytes,
        maxDiskBytes: maxOverlayDiskBytes,
      });
      let nodesWriter = null;
      let edgesWriter = null;
      try {
        await loadLegacyDelta({ targetRoot, fingerprint: before, overlay, signal });
        const clusters = new Set();
        nodesWriter = await createQuotaBackpressuredJsonlGzipWriter(
          path.join(attemptRoot, 'memory-nodes.base.jsonl.gz'),
          { operationRoot: quota.operationRoot, scratchQuota: quota, signal },
        );
        const nodes = await nodesWriter.writeAll(logicalNodeRecords({
          targetRoot, fingerprint: before, overlay, signal, clusters,
        }));
        edgesWriter = await createQuotaBackpressuredJsonlGzipWriter(
          path.join(attemptRoot, 'memory-edges.base.jsonl.gz'),
          { operationRoot: quota.operationRoot, scratchQuota: quota, signal },
        );
        const edges = await edgesWriter.writeAll(logicalEdgeRecords({
          targetRoot, fingerprint: before, overlay, signal,
        }));
        await overlay.close();
        await _testHooks.beforeFingerprintVerification?.({ attempt, targetRoot, attemptRoot });
        const after = await fingerprintLegacyResident(targetRoot);
        if (!sameSourceFingerprint(before, after)) {
          lastChanged = memorySourceError(
            'source_changed',
            'legacy resident sidecars changed during projection',
            { retryable: true },
          );
          await nodesWriter.cleanup();
          await edgesWriter.cleanup();
          await removeOwnedAttempt(attemptRoot, attemptIdentity);
          await quota.reconcile();
          continue;
        }
        const manifest = await publishMetadata({
          attemptRoot,
          quota,
          generation,
          revision,
          nodes,
          edges,
          clusterCount: clusters.size,
          sourceFingerprint: before,
        });
        try {
          await fsp.rename(attemptRoot, projectionRoot);
          await fsyncDirectory(projectionsRoot);
        } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
          const winner = await readPublishedProjection(projectionRoot, targetRoot, before);
          if (!winner) {
            throw memorySourceError('invalid_memory_source', 'projection publication conflict');
          }
          await nodesWriter.cleanup();
          await edgesWriter.cleanup();
          await removeOwnedAttempt(attemptRoot, attemptIdentity);
          await quota.reconcile();
          return winner;
        }
        return projectionResult({
          targetRoot,
          projectionRoot,
          manifest,
          sourceFingerprint: before,
        });
      } catch (error) {
        await overlay.close().catch(() => {});
        await nodesWriter?.cleanup?.().catch(() => {});
        await edgesWriter?.cleanup?.().catch(() => {});
        await removeOwnedAttempt(attemptRoot, attemptIdentity).catch(() => {});
        await quota.reconcile().catch(() => {});
        rethrowAbort(error, signal);
        throw error;
      }
    }
    throw lastChanged || memorySourceError(
      'source_changed',
      'legacy resident sidecars changed during projection',
      { retryable: true },
    );
  } finally {
    if (ownsQuota) await quota.close();
  }
}

module.exports = {
  fingerprintLegacyResident,
  projectLegacyResidentSidecars,
  verifyLegacySourceFingerprint,
};
