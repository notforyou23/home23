'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { writeJsonlGzAtomic, limitError } = require('./jsonl.cjs');
const { readManifest, writeManifestAtomic, fsyncDirectory } = require('./manifest.cjs');
const {
  openConfinedRegularFile,
  portableFileIdentity,
  assertOpenedFilePathIdentity,
} = require('./confined-file.cjs');
const { withMemorySourceLock, discoverOperationPinFiles } = require('./pins.cjs');
const {
  memorySourceError,
  sourceDescriptorDigest,
  throwIfAborted,
} = require('./contracts.cjs');

async function inject(options, point) {
  if (options.faultAt === point) throw new Error(`injected:${point}`);
  await options._testHooks?.[point]?.();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateScalarSummaryOnly(summary) {
  if (!summary || Object.keys(summary).sort().join(',') !== 'clusterCount,edgeCount,nodeCount') {
    throw memorySourceError('invalid_request', 'scalar summary required');
  }
  const copy = {};
  for (const field of ['nodeCount', 'edgeCount', 'clusterCount']) {
    if (!Number.isSafeInteger(summary[field]) || summary[field] < 0) {
      throw memorySourceError('invalid_request', 'invalid scalar summary');
    }
    copy[field] = summary[field];
  }
  return Object.freeze(copy);
}

function normalizeCapturedChanges(changes = {}) {
  const copy = {};
  let count = 0;
  let bytes = 0;
  for (const key of ['nodes', 'edges', 'removedNodeIds', 'removedEdgeKeys']) {
    const rows = Array.isArray(changes[key]) ? changes[key] : [];
    copy[key] = rows.map((row) => {
      const cloned = cloneJson(row);
      const encodedBytes = Buffer.byteLength(JSON.stringify(cloned), 'utf8');
      if (encodedBytes > 16 * 1024 * 1024) throw limitError('delta_record', 16 * 1024 * 1024);
      count += 1;
      bytes += encodedBytes;
      if (count > 100000 || bytes > 512 * 1024 * 1024) {
        throw limitError('delta_commit', 512 * 1024 * 1024);
      }
      return cloned;
    });
  }
  return Object.freeze(copy);
}

function* changeRecords(changes) {
  for (const record of changes.nodes) yield { op: 'upsert_node', record };
  for (const record of changes.edges) yield { op: 'upsert_edge', record };
  for (const id of changes.removedNodeIds) yield { op: 'remove_node', id };
  for (const key of changes.removedEdgeKeys) yield { op: 'remove_edge', key };
}

function countChanges(changes) {
  return changes.nodes.length + changes.edges.length
    + changes.removedNodeIds.length + changes.removedEdgeKeys.length;
}

async function writeAllAt(handle, bytes, position) {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(
      bytes,
      written,
      bytes.length - written,
      position + written,
    );
    if (!Number.isInteger(result.bytesWritten) || result.bytesWritten <= 0) {
      throw memorySourceError('source_unavailable', 'delta write made no progress', {
        retryable: true,
      });
    }
    written += result.bytesWritten;
  }
}

async function appendMemoryRevision(brainDir, changes, options = {}) {
  const capturedChanges = normalizeCapturedChanges(changes);
  const capturedSummary = options.summary ? validateScalarSummaryOnly(options.summary) : null;
  await options.beforeLock?.();
  return withMemorySourceLock(brainDir, { lockRoot: options.lockRoot }, async () => {
    const manifest = await readManifest(brainDir);
    if (!manifest) throw memorySourceError('source_unavailable', 'memory manifest required', { retryable: true });
    const deltaPath = path.join(brainDir, manifest.activeDelta.file);
    const committedBytes = manifest.activeDelta.committedBytes;
    const opened = await openConfinedRegularFile(brainDir, deltaPath, {
      flags: fs.constants.O_RDWR,
    });
    const openedIdentity = portableFileIdentity(opened.stat);
    let revision = manifest.currentRevision;
    let sequence = manifest.activeDelta.count;
    let offset = committedBytes;
    try {
      if (Number(opened.stat.size) < committedBytes) {
        throw memorySourceError('source_unavailable', 'committed delta is truncated', { retryable: true });
      }
      await assertOpenedFilePathIdentity(opened, openedIdentity);
      await opened.handle.truncate(committedBytes);
      for (const record of changeRecords(capturedChanges)) {
        revision += 1;
        sequence += 1;
        const encoded = Buffer.from(`${JSON.stringify({
          epoch: manifest.activeDeltaEpoch,
          sequence,
          revision,
          ...record,
        })}\n`);
        await writeAllAt(opened.handle, encoded, offset);
        offset += encoded.length;
      }
      await opened.handle.sync();
      await inject(options, 'afterDeltaFsync');
      const bytes = offset;
      const committedStat = await opened.handle.stat({ bigint: true });
      if (Number(committedStat.size) !== bytes) {
        throw memorySourceError('source_changed', 'delta committed size changed', {
          retryable: true,
        });
      }
      const committedIdentity = portableFileIdentity(committedStat);
      await assertOpenedFilePathIdentity(opened, committedIdentity);
      const next = {
        ...manifest,
        currentRevision: revision,
        activeDelta: {
          ...manifest.activeDelta,
          toRevision: revision,
          count: sequence,
          committedBytes: bytes,
        },
        summary: capturedSummary || manifest.summary,
      };
      await inject(options, 'beforeManifestRename');
      await assertOpenedFilePathIdentity(opened, committedIdentity);
      await writeManifestAtomic(brainDir, next);
      const recordCount = countChanges(capturedChanges);
      return Object.freeze({
        epoch: next.activeDeltaEpoch,
        fromRevision: manifest.currentRevision + (recordCount ? 1 : 0),
        toRevision: revision,
        count: recordCount,
        bytes,
        manifest: next,
      });
    } finally {
      await opened.handle.close();
    }
  });
}

function normalizeCapturedView(input) {
  if (!input || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    throw memorySourceError('invalid_request', 'immutable captured view required');
  }
  const nodes = input.nodes.map(cloneJson);
  const edges = input.edges.map(cloneJson);
  const summary = validateScalarSummaryOnly(input.summary);
  if (summary.nodeCount !== nodes.length || summary.edgeCount !== edges.length
      || summary.clusterCount > summary.nodeCount) {
    throw memorySourceError('invalid_request', 'captured summary mismatch');
  }
  return Object.freeze({
    nodes: Object.freeze(nodes.map(Object.freeze)),
    edges: Object.freeze(edges.map(Object.freeze)),
    summary,
  });
}

async function rewriteMemoryBase(brainDir, capturedView, options = {}) {
  const view = normalizeCapturedView(capturedView);
  await options.beforeLock?.();
  return withMemorySourceLock(brainDir, { lockRoot: options.lockRoot }, async () => {
    const previous = await readManifest(brainDir);
    const baseRevision = (previous?.currentRevision || 0) + 1;
    const generation = `g-${baseRevision}-${randomUUID()}`;
    const epoch = `e-${baseRevision + 1}-${randomUUID()}`;
    const nodeFile = `memory-nodes.base-${baseRevision}.jsonl.gz`;
    const edgeFile = `memory-edges.base-${baseRevision}.jsonl.gz`;
    const deltaFile = `memory-delta.${epoch}.jsonl`;
    const nodes = await writeJsonlGzAtomic(path.join(brainDir, nodeFile), view.nodes, options);
    const edges = await writeJsonlGzAtomic(path.join(brainDir, edgeFile), view.edges, options);
    const deltaHandle = await fsp.open(path.join(brainDir, deltaFile), 'wx', 0o600);
    await deltaHandle.sync();
    await deltaHandle.close();
    await fsyncDirectory(brainDir);
    await inject(options, 'afterBaseFiles');
    const manifest = {
      formatVersion: 1,
      generation,
      baseRevision,
      currentRevision: baseRevision,
      activeDeltaEpoch: epoch,
      activeBase: {
        nodes: { file: nodeFile, count: nodes.count, bytes: nodes.bytes },
        edges: { file: edgeFile, count: edges.count, bytes: edges.bytes },
      },
      activeDelta: {
        epoch,
        file: deltaFile,
        fromRevision: baseRevision + 1,
        toRevision: baseRevision,
        count: 0,
        committedBytes: 0,
      },
      ann: { indexFile: null, metaFile: null, builtFromRevision: null },
      summary: view.summary,
    };
    await inject(options, 'beforeManifestRename');
    await writeManifestAtomic(brainDir, manifest);
    return Object.freeze({ baseRevision, deltaEpoch: epoch, nodes, edges, manifest });
  });
}

async function advanceAnnBuiltFromRevision(brainDir, update = {}) {
  return withMemorySourceLock(brainDir, { lockRoot: update.lockRoot }, async () => {
    const manifest = await readManifest(brainDir);
    if (!manifest || manifest.generation !== update.expectedGeneration) {
      return { advanced: false, reason: 'source_changed', manifest };
    }
    if (!Number.isSafeInteger(update.builtFromRevision)
        || update.builtFromRevision > manifest.currentRevision) {
      throw memorySourceError('invalid_request', 'invalid ANN revision');
    }
    const next = {
      ...manifest,
      ann: {
        indexFile: update.indexFile,
        metaFile: update.metaFile,
        builtFromRevision: update.builtFromRevision,
      },
    };
    await writeManifestAtomic(brainDir, next);
    return { advanced: true, manifest: next };
  });
}

async function compareAndSwapSourceRevision(brainDir, update = {}) {
  if (typeof update.expectedGeneration !== 'string' || update.expectedGeneration.length === 0
      || !Number.isSafeInteger(update.expectedRevision) || update.expectedRevision < 0
      || typeof update.expectedDigest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(update.expectedDigest)
      || typeof update.commit !== 'function'
      || (update.authorize !== undefined && typeof update.authorize !== 'function')
      || (update.rollback !== undefined && typeof update.rollback !== 'function')) {
    throw memorySourceError('invalid_request', 'exact source CAS contract required');
  }
  throwIfAborted(update.signal);
  const result = await withMemorySourceLock(brainDir, {
    lockRoot: update.lockRoot,
    signal: update.signal,
  }, async () => {
    throwIfAborted(update.signal);
    const manifest = await readManifest(brainDir);
    const descriptor = manifest ? {
      version: 1,
      canonicalRoot: await fsp.realpath(brainDir),
      generation: manifest.generation,
      baseRevision: manifest.baseRevision,
      cutoffRevision: manifest.currentRevision,
      activeBase: manifest.activeBase,
      activeDelta: manifest.activeDelta,
      summary: manifest.summary,
    } : null;
    if (!manifest || manifest.generation !== update.expectedGeneration
        || manifest.currentRevision !== update.expectedRevision
        || sourceDescriptorDigest(descriptor) !== update.expectedDigest) {
      return { committed: false, reason: 'source_changed', manifest };
    }
    if (update.authorize) await update.authorize();
    throwIfAborted(update.signal);
    let value;
    let commitReturned = false;
    try {
      value = await update.commit();
      commitReturned = true;
      throwIfAborted(update.signal);
    } catch (error) {
      if (commitReturned && update.rollback) {
        await update.rollback(value).catch((cause) => {
          throw memorySourceError('source_rollback_failed', 'source CAS rollback failed', {
            cause,
            retryable: false,
          });
        });
      }
      throw error;
    }
    return { committed: true, manifest, value };
  });
  if (result.committed === true && update.signal?.aborted && update.rollback) {
    await withMemorySourceLock(brainDir, { lockRoot: update.lockRoot }, async () => {
      await update.rollback(result.value);
    }).catch((cause) => {
      throw memorySourceError('source_rollback_failed', 'source CAS rollback failed', {
        cause,
        retryable: false,
      });
    });
    throw update.signal.reason || memorySourceError('cancelled', 'source CAS cancelled');
  }
  return result;
}

async function retireUnpinnedSources(brainDir, options = {}) {
  return withMemorySourceLock(brainDir, { lockRoot: options.lockRoot }, async () => {
    const manifest = await readManifest(brainDir);
    if (!manifest) return { retired: [], retained: [], reason: 'manifest_missing' };
    const pinEntries = options.pinFiles || (options.home23Root
      ? await discoverOperationPinFiles(options.home23Root)
      : []);
    const protectedFiles = new Set([
      'memory-manifest.json',
      manifest.activeBase.nodes.file,
      manifest.activeBase.edges.file,
      manifest.activeDelta.file,
      manifest.ann.indexFile,
      manifest.ann.metaFile,
    ].filter(Boolean));
    for (const entry of pinEntries) {
      const filePath = typeof entry === 'string' ? entry : entry.path;
      if (!filePath) continue;
      const record = JSON.parse(await fsp.readFile(filePath, 'utf8').catch(() => '{}'));
      if (record.canonicalRoot !== await fsp.realpath(brainDir)) continue;
      for (const file of record.files || record.protectedFiles || []) protectedFiles.add(file);
      if (record.generation) {
        for (const name of await fsp.readdir(brainDir)) {
          if (name.includes(record.generation)) protectedFiles.add(name);
        }
      }
    }
    const retired = [];
    const retained = [];
    for (const name of await fsp.readdir(brainDir)) {
      if (!/^memory-(nodes|edges)\.base-|^memory-delta\.|^memory-ann\./.test(name)) continue;
      if (protectedFiles.has(name)) retained.push(name);
      else {
        await fsp.rm(path.join(brainDir, name), { force: true });
        retired.push(name);
      }
    }
    return { retired: retired.sort(), retained: retained.sort() };
  });
}

module.exports = {
  appendMemoryRevision,
  rewriteMemoryBase,
  advanceAnnBuiltFromRevision,
  compareAndSwapSourceRevision,
  retireUnpinnedSources,
  normalizeCapturedView,
};
