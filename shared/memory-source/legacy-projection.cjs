'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const {
  createQuotaBackpressuredJsonlGzipWriter,
  readJsonl,
} = require('./jsonl.cjs');
const {
  fsyncDirectory,
  readManifest,
  writeManifestAtomic,
} = require('./manifest.cjs');
const { createBoundedOverlayStore } = require('./overlay-store.cjs');
const { createOperationScratchQuota } = require('./scratch-quota.cjs');
const {
  assertStableOpenedFile,
  assertOpenedFilePathIdentity,
  openConfinedRegularFile,
  portableFileIdentity,
  readConfinedFile,
} = require('./confined-file.cjs');
const {
  edgeKeyFor,
  memorySourceError,
  normalizeId,
  rethrowAbort,
  sourceDescriptorDigest,
  throwIfAborted,
} = require('./contracts.cjs');
const { OPENED_JSONL_FILE } = require('./private-capabilities.cjs');

const MAX_ATTEMPTS = 3;
const MAX_CLUSTER_KEYS = 1_000_000;
const MAX_CLUSTER_BYTES = 16 * 1024 * 1024;
const CLUSTER_ENTRY_OVERHEAD_BYTES = 32;
const METADATA_GROWTH_BYTES = 1024 * 1024;

function createBoundedClusterCounter({
  maxKeys = MAX_CLUSTER_KEYS,
  maxBytes = MAX_CLUSTER_BYTES,
} = {}) {
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 0
      || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw memorySourceError('invalid_request', 'invalid cluster counter budget');
  }
  const values = new Set();
  let retainedBytes = 0;
  return Object.freeze({
    add(value) {
      const key = normalizeId(value);
      if (values.has(key)) return false;
      const nextBytes = retainedBytes + Buffer.byteLength(key, 'utf8') + CLUSTER_ENTRY_OVERHEAD_BYTES;
      if (values.size >= maxKeys || nextBytes > maxBytes) {
        throw memorySourceError('result_too_large', 'legacy cluster count exceeds budget', {
          status: 413,
          retryable: false,
        });
      }
      values.add(key);
      retainedBytes = nextBytes;
      return true;
    },
    get size() { return values.size; },
    get retainedBytes() { return retainedBytes; },
  });
}

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

async function closeLegacyResidentFiles(openedFiles) {
  if (!(openedFiles instanceof Map)) return;
  await Promise.all([...new Set(openedFiles.values())].map(async (opened) => {
    await opened.handle.close().catch((error) => {
      if (error?.code !== 'EBADF') throw error;
    });
  }));
}

async function revalidateLegacyResidentFiles(openedFiles) {
  for (const opened of openedFiles.values()) {
    await assertStableOpenedFile(opened);
    await assertOpenedFilePathIdentity(opened, portableFileIdentity(opened.stat));
  }
}

async function openLegacyResidentFiles(canonicalRoot, { signal } = {}) {
  const targetRoot = await fsp.realpath(canonicalRoot);
  const openedFiles = new Map();
  try {
    for (const [role, basename, optional] of [
      ['nodes', 'memory-nodes.jsonl.gz', false],
      ['edges', 'memory-edges.jsonl.gz', false],
      ['delta', 'memory-delta.jsonl', true],
    ]) {
      const opened = await openConfinedRegularFile(
        targetRoot,
        path.join(targetRoot, basename),
        { flags: fs.constants.O_RDONLY, optional, signal },
      );
      if (opened) openedFiles.set(role, opened);
    }
    if (!openedFiles.has('nodes') || !openedFiles.has('edges')) {
      throw memorySourceError('source_unavailable', 'legacy resident sidecars are unavailable', {
        retryable: true,
      });
    }
    const describe = (role) => {
      const opened = openedFiles.get(role);
      return opened ? Object.freeze({
        basename: path.basename(opened.path),
        stat: statFingerprint(opened.stat),
      }) : null;
    };
    const fingerprint = Object.freeze({
      version: 1,
      canonicalRoot: targetRoot,
      files: Object.freeze({
        nodes: describe('nodes'),
        edges: describe('edges'),
        delta: describe('delta'),
      }),
    });
    await revalidateLegacyResidentFiles(openedFiles);
    return Object.freeze({ targetRoot, fingerprint, openedFiles });
  } catch (error) {
    await closeLegacyResidentFiles(openedFiles).catch(() => {});
    throw error;
  }
}

async function fingerprintLegacyResident(canonicalRoot) {
  const opened = await openLegacyResidentFiles(canonicalRoot);
  try {
    return opened.fingerprint;
  } finally {
    await closeLegacyResidentFiles(opened.openedFiles);
  }
}

async function verifyLegacySourceFingerprint(canonicalRoot, expected) {
  try {
    return sameSourceFingerprint(await fingerprintLegacyResident(canonicalRoot), expected);
  } catch {
    return false;
  }
}

function exactKeys(value, keys) {
  const actual = Object.keys(value || {}).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function invalidPublishedProjection(message, cause) {
  return memorySourceError('invalid_memory_source', message, {
    retryable: false,
    ...(cause ? { cause } : {}),
  });
}

async function digestPublishedFile(projectionRoot, entry) {
  if (!entry || typeof entry.file !== 'string'
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || !validSha256(entry.sha256)) {
    throw invalidPublishedProjection('invalid projection file integrity');
  }
  const filePath = path.join(projectionRoot, entry.file);
  const opened = await openConfinedRegularFile(projectionRoot, filePath, {
    flags: fs.constants.O_RDONLY,
  });
  try {
    if (Number(opened.stat.size) !== entry.bytes) {
      throw invalidPublishedProjection('projection file size mismatch');
    }
    const hash = crypto.createHash('sha256');
    if (entry.bytes > 0) {
      const stream = fs.createReadStream(null, {
        fd: opened.handle.fd,
        autoClose: false,
        start: 0,
        end: entry.bytes - 1,
      });
      for await (const chunk of stream) hash.update(chunk);
    }
    if (hash.digest('hex') !== entry.sha256) {
      throw invalidPublishedProjection('projection file digest mismatch');
    }
    await assertStableOpenedFile(opened);
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

function validatePublishedManifest({ manifest, integrity, generation, revision }) {
  const deltaFile = `memory-delta.${generation}.jsonl`;
  if (manifest.generation !== generation
      || manifest.baseRevision !== revision
      || manifest.currentRevision !== revision
      || manifest.activeDeltaEpoch !== generation
      || manifest.activeBase.nodes.file !== 'memory-nodes.base.jsonl.gz'
      || manifest.activeBase.edges.file !== 'memory-edges.base.jsonl.gz'
      || manifest.activeDelta.epoch !== generation
      || manifest.activeDelta.file !== deltaFile
      || manifest.activeDelta.fromRevision !== revision + 1
      || manifest.activeDelta.toRevision !== revision
      || manifest.activeDelta.count !== 0
      || manifest.activeDelta.committedBytes !== 0
      || manifest.ann.indexFile !== null
      || manifest.ann.metaFile !== null
      || manifest.ann.builtFromRevision !== null
      || manifest.summary.nodeCount !== manifest.activeBase.nodes.count
      || manifest.summary.edgeCount !== manifest.activeBase.edges.count
      || manifest.summary.clusterCount > manifest.summary.nodeCount) {
    throw invalidPublishedProjection('deterministic projection manifest mismatch');
  }
  if (!exactKeys(integrity, ['version', 'generation', 'manifestDigest', 'files'])
      || integrity.version !== 1
      || integrity.generation !== generation
      || integrity.manifestDigest !== sourceDescriptorDigest(manifest)
      || !exactKeys(integrity.files, ['nodes', 'edges', 'delta'])) {
    throw invalidPublishedProjection('projection integrity metadata mismatch');
  }
  const expected = {
    nodes: manifest.activeBase.nodes,
    edges: manifest.activeBase.edges,
    delta: {
      file: manifest.activeDelta.file,
      count: manifest.activeDelta.count,
      bytes: manifest.activeDelta.committedBytes,
    },
  };
  for (const kind of ['nodes', 'edges', 'delta']) {
    const entry = integrity.files[kind];
    if (!exactKeys(entry, ['file', 'count', 'bytes', 'sha256'])
        || entry.file !== expected[kind].file
        || entry.count !== expected[kind].count
        || entry.bytes !== expected[kind].bytes
        || !validSha256(entry.sha256)) {
      throw invalidPublishedProjection('projection file metadata mismatch');
    }
  }
}

async function readPublishedProjection(projectionRoot, targetRoot, expectedFingerprint) {
  const existing = await fsp.lstat(projectionRoot).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing === null) return null;
  try {
    const canonicalProjection = await fsp.realpath(projectionRoot);
    if (existing.isSymbolicLink() || !existing.isDirectory()
        || canonicalProjection !== projectionRoot) {
      throw invalidPublishedProjection('projection root is not canonical');
    }
    const [manifest, storedFingerprintBytes, integrityBytes] = await Promise.all([
      readManifest(projectionRoot),
      readConfinedFile(
        projectionRoot,
        path.join(projectionRoot, 'source-fingerprint.json'),
        { maxBytes: 1024 * 1024 },
      ),
      readConfinedFile(
        projectionRoot,
        path.join(projectionRoot, 'projection-integrity.json'),
        { maxBytes: 1024 * 1024 },
      ),
    ]);
    const storedFingerprint = JSON.parse(storedFingerprintBytes.toString('utf8'));
    const integrity = JSON.parse(integrityBytes.toString('utf8'));
    const digest = fingerprintDigest(expectedFingerprint);
    const generation = `legacy-${digest.slice(0, 20)}`;
    const revision = safeRevisionFromDigest(digest);
    if (!manifest
        || path.basename(projectionRoot) !== generation
        || !sameSourceFingerprint(storedFingerprint, expectedFingerprint)) {
      throw invalidPublishedProjection('projection generation or fingerprint mismatch');
    }
    validatePublishedManifest({ manifest, integrity, generation, revision });
    await Promise.all([
      digestPublishedFile(projectionRoot, integrity.files.nodes),
      digestPublishedFile(projectionRoot, integrity.files.edges),
      digestPublishedFile(projectionRoot, integrity.files.delta),
    ]);
    return projectionResult({
      targetRoot,
      projectionRoot,
      manifest,
      sourceFingerprint: storedFingerprint,
    });
  } catch (error) {
    if (error?.code === 'invalid_memory_source') throw error;
    throw invalidPublishedProjection('published legacy projection failed validation', error);
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

async function loadLegacyDelta({ targetRoot, fingerprint, openedFiles, overlay, signal }) {
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
    [OPENED_JSONL_FILE]: openedFiles.get('delta'),
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

function logicalNodeRecords({
  targetRoot, fingerprint, openedFiles, overlay, signal, clusters,
}) {
  return (async function* nodes() {
    for await (const record of readJsonl(path.join(targetRoot, fingerprint.files.nodes.basename), {
      [OPENED_JSONL_FILE]: openedFiles.get('nodes'),
      gzip: true,
      confinedRoot: targetRoot,
      expectedInputBytes: Number(fingerprint.files.nodes.stat.size),
      signal,
    })) {
      throwIfAborted(signal);
      const id = normalizeId(record.id);
      if (overlay.hasRemovedNode(id)) continue;
      if (overlay.hasNodeUpsert(id)) continue;
      const projected = Object.freeze({ ...record, id });
      if (projected.cluster !== undefined && projected.cluster !== null) {
        clusters.add(projected.cluster);
      }
      yield projected;
    }
    for await (const record of overlay.iterateNodeUpserts({ signal })) {
      const id = normalizeId(record.id);
      if (overlay.hasRemovedNode(id)) continue;
      if (record.cluster !== undefined && record.cluster !== null) {
        clusters.add(record.cluster);
      }
      yield Object.freeze({ ...record, id });
    }
  })();
}

function logicalEdgeRecords({ targetRoot, fingerprint, openedFiles, overlay, signal }) {
  return (async function* edges() {
    const eligible = (record) => !overlay.hasRemovedNode(record.source)
      && !overlay.hasRemovedNode(record.target);
    for await (const record of readJsonl(path.join(targetRoot, fingerprint.files.edges.basename), {
      [OPENED_JSONL_FILE]: openedFiles.get('edges'),
      gzip: true,
      confinedRoot: targetRoot,
      expectedInputBytes: Number(fingerprint.files.edges.stat.size),
      signal,
    })) {
      throwIfAborted(signal);
      const normalized = normalizeEdge(record);
      const key = edgeKeyFor(normalized);
      if (overlay.hasRemovedEdge(key) || !eligible(normalized)) continue;
      if (overlay.hasEdgeUpsert(key)) continue;
      yield normalized;
    }
    for await (const record of overlay.iterateEdgeUpserts({ signal })) {
      const normalized = normalizeEdge(record);
      const key = edgeKeyFor(normalized);
      if (!overlay.hasRemovedEdge(key) && eligible(normalized)) yield normalized;
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
  const integrity = {
    version: 1,
    generation,
    manifestDigest: sourceDescriptorDigest(manifest),
    files: {
      nodes: {
        file: manifest.activeBase.nodes.file,
        count: nodes.count,
        bytes: nodes.bytes,
        sha256: nodes.sha256,
      },
      edges: {
        file: manifest.activeBase.edges.file,
        count: edges.count,
        bytes: edges.bytes,
        sha256: edges.sha256,
      },
      delta: {
        file: deltaFile,
        count: 0,
        bytes: 0,
        sha256: crypto.createHash('sha256').update('').digest('hex'),
      },
    },
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
      const integrityHandle = await fsp.open(
        path.join(attemptRoot, 'projection-integrity.json'),
        'wx',
        0o600,
      );
      try {
        await integrityHandle.writeFile(`${JSON.stringify(integrity)}\n`);
        await integrityHandle.sync();
      } finally {
        await integrityHandle.close();
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
      const stableSource = await openLegacyResidentFiles(targetRoot, { signal });
      try {
        const before = stableSource.fingerprint;
        const digest = fingerprintDigest(before);
        const generation = `legacy-${digest.slice(0, 20)}`;
        const revision = safeRevisionFromDigest(digest);
        const projectionRoot = path.join(projectionsRoot, generation);
        const published = await readPublishedProjection(projectionRoot, targetRoot, before);
        if (published) {
          await revalidateLegacyResidentFiles(stableSource.openedFiles);
          return published;
        }

        const attemptRoot = path.join(
          projectionsRoot,
          `.attempt-${process.pid}-${crypto.randomUUID()}`,
        );
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
          await loadLegacyDelta({
            targetRoot,
            fingerprint: before,
            openedFiles: stableSource.openedFiles,
            overlay,
            signal,
          });
          const clusters = createBoundedClusterCounter();
          nodesWriter = await createQuotaBackpressuredJsonlGzipWriter(
            path.join(attemptRoot, 'memory-nodes.base.jsonl.gz'),
            { operationRoot: quota.operationRoot, scratchQuota: quota, signal },
          );
          const nodes = await nodesWriter.writeAll(logicalNodeRecords({
            targetRoot,
            fingerprint: before,
            openedFiles: stableSource.openedFiles,
            overlay,
            signal,
            clusters,
          }));
          edgesWriter = await createQuotaBackpressuredJsonlGzipWriter(
            path.join(attemptRoot, 'memory-edges.base.jsonl.gz'),
            { operationRoot: quota.operationRoot, scratchQuota: quota, signal },
          );
          const edges = await edgesWriter.writeAll(logicalEdgeRecords({
            targetRoot,
            fingerprint: before,
            openedFiles: stableSource.openedFiles,
            overlay,
            signal,
          }));
          await overlay.close();
          await _testHooks.beforeFingerprintVerification?.({ attempt, targetRoot, attemptRoot });
          await revalidateLegacyResidentFiles(stableSource.openedFiles);
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
          await revalidateLegacyResidentFiles(stableSource.openedFiles);
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
            await revalidateLegacyResidentFiles(stableSource.openedFiles);
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
          throw error;
        }
      } catch (error) {
        rethrowAbort(error, signal);
        if (error?.code === 'source_changed') {
          lastChanged = error;
          continue;
        }
        throw error;
      } finally {
        await closeLegacyResidentFiles(stableSource.openedFiles);
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
  MAX_CLUSTER_BYTES,
  MAX_CLUSTER_KEYS,
  createBoundedClusterCounter,
  fingerprintLegacyResident,
  projectLegacyResidentSidecars,
  verifyLegacySourceFingerprint,
};
