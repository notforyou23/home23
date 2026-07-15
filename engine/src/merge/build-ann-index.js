/**
 * build-ann-index.js — Build a persistent HNSW ANN index from a pinned logical
 * memory source. The manifest revision, not sidecar mtime, is the freshness
 * authority used by dashboard search.
 */

'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { classifyMemoryProvenance } = require('../memory/provenance-salience');
const {
  advanceAnnBuiltFromRevision,
  withEphemeralMemorySource,
  memorySourceError,
  throwIfAborted,
} = require('../../../shared/memory-source');
const { projectAnnLabel } = require('../../../shared/ann-label-contract.cjs');
const { projectMemoryAuthority } = require('../../../shared/memory-authority.cjs');

const DIM = 768;
const HNSW_M = 16;
const HNSW_EF_CONSTRUCTION = 200;
const MAX_REUSE_METADATA_BYTES = 256 * 1024 * 1024;

function log(...a) { console.log('[build-ann]', ...a); }

function defaultRequesterAgent(brainDir) {
  const parent = path.basename(path.dirname(path.resolve(brainDir)));
  return parent && parent !== path.sep ? parent : 'agent';
}

function defaultHome23Root(brainDir) {
  const resolved = path.resolve(brainDir);
  const marker = `${path.sep}instances${path.sep}`;
  const index = resolved.lastIndexOf(marker);
  if (index > 0) return resolved.slice(0, index);
  return path.resolve(__dirname, '..', '..', '..');
}

async function defaultResolveTargetContext(brainDir, requesterAgent) {
  const canonicalRoot = await fsp.realpath(brainDir);
  return {
    catalogRevision: 'local',
    accessMode: 'own',
    target: {
      id: requesterAgent,
      brainId: requesterAgent,
      ownerAgent: requesterAgent,
      requesterAgent,
      canonicalRoot,
      kind: 'resident',
      sourceType: 'brain',
    },
  };
}

function createIndex(hnswlib, dimension, capacity) {
  const index = new hnswlib.HierarchicalNSW('cosine', dimension);
  index.initIndex(Math.max(1, capacity), HNSW_M, HNSW_EF_CONSTRUCTION);
  return index;
}

function projectLabel(node) {
  const provenance = classifyMemoryProvenance(node);
  const authority = projectMemoryAuthority(node);
  try {
    return projectAnnLabel({
      ...node,
      retrievalDomain: authority.retrievalDomain,
      authorityClass: authority.authorityClass,
      semanticTime: authority.semanticTime,
      status: node?.status || node?.metadata?.status
        || (authority.retrievalDomain === 'closed_incidents' ? 'closed' : null),
      evidencePresent: authority.sourceChain.length > 0,
    }, {
      fallbackSourceClass: provenance.sourceClass,
      fallbackSalienceWeight: provenance.salienceWeight,
    });
  } catch (cause) {
    throw memorySourceError('invalid_memory_source', 'node cannot be represented in ANN metadata', {
      retryable: false,
      nodeId: typeof node?.id === 'string' && node.id.length <= 256 ? node.id : null,
      cause,
    });
  }
}

async function fsyncDirectory(dir) {
  const handle = await fsp.open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function uniqueTempPath(filePath) {
  return `${filePath}.tmp.${process.pid}.${randomUUID()}`;
}

function fileIdentity(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

function sameFileIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

async function reserveOwnedTemp(filePath) {
  const handle = await fsp.open(filePath, 'wx', 0o600);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) {
      throw memorySourceError('invalid_memory_source', 'ANN temp is not a regular file', {
        retryable: false,
      });
    }
    return fileIdentity(stat);
  } finally {
    await handle.close();
  }
}

async function writeJsonOwnedTemp(filePath, identity, value) {
  const handle = await fsp.open(filePath, 'r+');
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || !sameFileIdentity(fileIdentity(stat), identity)) {
      throw memorySourceError('source_changed', 'ANN temp identity changed before write', {
        retryable: true,
      });
    }
    await handle.truncate(0);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertOwnedFileIdentity(filePath, identity);
}

async function captureOwnedFileIdentity(filePath) {
  const stat = await fsp.lstat(filePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw memorySourceError('invalid_memory_source', 'ANN output is not a regular file', {
      retryable: false,
    });
  }
  return fileIdentity(stat);
}

async function assertOwnedFileIdentity(filePath, identity) {
  const actual = await captureOwnedFileIdentity(filePath);
  if (!sameFileIdentity(actual, identity)) {
    throw memorySourceError('source_changed', 'ANN output identity changed', {
      retryable: true,
    });
  }
}

async function syncOwnedFile(filePath, identity) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || !sameFileIdentity(fileIdentity(stat), identity)) {
      throw memorySourceError('source_changed', 'ANN temp identity changed before sync', {
        retryable: true,
      });
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertOwnedFileIdentity(filePath, identity);
}

async function removeOwnedFile(filePath, identity) {
  const stat = await fsp.lstat(filePath, { bigint: true }).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink()
      || stat.dev !== identity.dev || stat.ino !== identity.ino) {
    throw memorySourceError('source_changed', 'ANN output identity changed before cleanup', {
      retryable: true,
    });
  }
  await fsp.rm(filePath, { force: false });
}

async function assertOutputAbsent(filePath) {
  const stat = await fsp.lstat(filePath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return;
  throw memorySourceError('source_changed', 'revisioned ANN output already exists', {
    retryable: true,
    output: path.basename(filePath),
  });
}

async function linkOwnedTemp(tempPath, finalPath) {
  try {
    await fsp.link(tempPath, finalPath);
  } catch (cause) {
    if (cause?.code === 'EEXIST') {
      throw memorySourceError('source_changed', 'revisioned ANN output already exists', {
        retryable: true,
        output: path.basename(finalPath),
      });
    }
    throw memorySourceError('source_unavailable', 'ANN output publication failed', {
      retryable: true,
      cause,
      output: path.basename(finalPath),
    });
  }
}

async function cleanupOwnedFiles(entries) {
  const errors = [];
  for (const { filePath, identity } of entries) {
    if (!identity) continue;
    try {
      await removeOwnedFile(filePath, identity);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function validateReusableAnn({ metaPath, indexPath, hnswlib, generation, revision, sourceNodeCount }) {
  const stat = await fsp.lstat(metaPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REUSE_METADATA_BYTES) {
    throw memorySourceError('source_unavailable', 'fresh ANN metadata is unsafe or oversized', {
      retryable: true,
    });
  }
  let meta;
  try {
    meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
  } catch (cause) {
    throw memorySourceError('source_unavailable', 'fresh ANN metadata is malformed', {
      retryable: true,
      cause,
    });
  }
  const labelCount = meta.labelCount ?? meta.count;
  if (meta.generation !== generation || meta.builtFromRevision !== revision
      || !Number.isSafeInteger(meta.dimension) || meta.dimension < 1
      || !Number.isSafeInteger(meta.count) || meta.count < 0
      || !Number.isSafeInteger(meta.skipped) || meta.skipped < 0
      || !Number.isSafeInteger(labelCount) || labelCount < 0
      || (meta.skipped > 0 && meta.labelCount === undefined)
      || meta.count + meta.skipped !== sourceNodeCount
      || (meta.labelCount !== undefined && labelCount !== sourceNodeCount)
      || !Array.isArray(meta.labels) || meta.labels.length !== labelCount) {
    throw memorySourceError('source_unavailable', 'fresh ANN metadata does not match source', {
      retryable: true,
    });
  }
  try {
    for (const label of meta.labels) projectAnnLabel(label);
  } catch (cause) {
    throw memorySourceError('source_unavailable', 'fresh ANN metadata labels are invalid', {
      retryable: true,
      cause,
    });
  }
  try {
    const runtime = new hnswlib.HierarchicalNSW('cosine', meta.dimension);
    runtime.readIndexSync(indexPath);
    if (typeof runtime.getCurrentCount === 'function'
        && runtime.getCurrentCount() !== meta.count) {
      throw new Error('HNSW count mismatch');
    }
  } catch (cause) {
    throw memorySourceError('source_unavailable', 'fresh ANN index is unreadable', {
      retryable: true,
      cause,
    });
  }
  return { count: meta.count, skipped: meta.skipped };
}

function assertNativeAnnSource(source) {
  const sourceMode = source?.manifest?.sourceMode;
  const implementation = source?.evidence?.implementation;
  const hasNativeManifest = source?.manifest?.formatVersion === 1
    && sourceMode !== 'legacy_projection'
    && (sourceMode === undefined || sourceMode === 'memory_manifest')
    && (implementation === undefined || implementation === 'manifest-v1');
  if (hasNativeManifest) return;
  throw memorySourceError('invalid_memory_source', 'ANN build requires native manifest authority', {
    retryable: false,
    sourceMode: sourceMode || (implementation === 'legacy-resident-sidecar-projection'
      ? 'legacy_projection' : 'unknown'),
  });
}

async function build(brainDir, deps = {}) {
  const home23Root = deps.home23Root || defaultHome23Root(brainDir);
  const requesterAgent = deps.requesterAgent || defaultRequesterAgent(brainDir);
  const resolveTargetContext = deps.resolveTargetContext
    || (() => defaultResolveTargetContext(brainDir, requesterAgent));
  const resolved = await resolveTargetContext({});
  const canonicalBrain = await fsp.realpath(brainDir);
  if (resolved.target?.canonicalRoot !== canonicalBrain) {
    throw memorySourceError('source_changed', 'ANN target/source mismatch', { retryable: true });
  }
  const hnswlib = deps.hnswlib || require('hnswlib-node');
  const withEphemeralSource = deps.withEphemeralMemorySource || withEphemeralMemorySource;
  const advanceAnn = deps.advanceAnnBuiltFromRevision || advanceAnnBuiltFromRevision;
  const provider = deps.provider || process.env.EMBEDDING_PROVIDER || 'local';
  const model = deps.model || process.env.EMBEDDING_MODEL || 'nomic-embed-text';
  const now = deps.now || (() => new Date());

  return withEphemeralSource({
    brainDir,
    home23Root,
    requesterAgent,
    identity: {
      requesterAgent,
      targetAgent: resolved.target.ownerAgent || resolved.target.requesterAgent || requesterAgent,
      brainId: resolved.target.id || resolved.target.brainId || requesterAgent,
      canonicalRoot: canonicalBrain,
      catalogRevision: resolved.catalogRevision || 'local',
      kind: resolved.target.kind || 'resident',
      sourceType: resolved.target.sourceType || 'brain',
      accessMode: resolved.accessMode || 'own',
    },
    signal: deps.signal,
    prefix: 'ann-build',
  }, async (source, context) => {
    throwIfAborted(deps.signal);
    assertNativeAnnSource(source);
    const revision = source.revision;
    const generation = source.manifest?.generation;
    const baseRevision = source.manifest?.baseRevision;
    const deltaEpoch = source.manifest?.activeDeltaEpoch;
    const capacity = source.manifest?.summary?.nodeCount;
    if (!Number.isSafeInteger(capacity) || capacity < 0) {
      throw memorySourceError('invalid_memory_source', 'invalid ANN manifest capacity', {
        retryable: false,
      });
    }
    const pinnedAnn = source.manifest?.ann;
    if (pinnedAnn?.builtFromRevision === revision
        && typeof pinnedAnn.indexFile === 'string'
        && typeof pinnedAnn.metaFile === 'string') {
      const pinnedIndexPath = path.join(canonicalBrain, pinnedAnn.indexFile);
      const pinnedMetaPath = path.join(canonicalBrain, pinnedAnn.metaFile);
      await captureOwnedFileIdentity(pinnedIndexPath);
      await captureOwnedFileIdentity(pinnedMetaPath);
      const counts = await validateReusableAnn({
        metaPath: pinnedMetaPath,
        indexPath: pinnedIndexPath,
        hnswlib,
        generation,
        revision,
        sourceNodeCount: capacity,
      });
      return {
        total: counts.count,
        skipped: counts.skipped,
        indexPath: pinnedIndexPath,
        metaPath: pinnedMetaPath,
        generation,
        builtFromRevision: revision,
        reused: true,
        advanced: { advanced: true, reason: 'already_fresh' },
        coverage: 'fresh',
        currentRevision: revision,
        bridgeableGap: 0,
        semanticCoverage: { indexed: counts.count, skipped: counts.skipped },
        stageDurations: { totalMs: 0 },
      };
    }
    const indexFile = `memory-ann.${revision}.index`;
    const metaFile = `memory-ann.${revision}.meta.json`;
    const indexPath = path.join(canonicalBrain, indexFile);
    const metaPath = path.join(canonicalBrain, metaFile);
    await assertOutputAbsent(indexPath);
    await assertOutputAbsent(metaPath);
    const indexTmpPath = uniqueTempPath(indexPath);
    const metaTmpPath = uniqueTempPath(metaPath);
    const labels = [];
    const skippedLabels = [];
    let skipped = 0;
    let dimension = null;
    let index = null;
    const started = Date.now();
    let indexTmpIdentity = null;
    let metaTmpIdentity = null;
    let indexIdentity = null;
    let metaIdentity = null;
    try {
      for await (const node of source.iterateNodes({ signal: deps.signal })) {
        throwIfAborted(deps.signal);
        const embedding = node?.embedding;
        if (!Array.isArray(embedding) || embedding.length === 0) {
          skipped += 1;
          skippedLabels.push(projectLabel(node));
          continue;
        }
        if (dimension === null) {
          dimension = embedding.length;
          index = createIndex(hnswlib, dimension, capacity);
        }
        if (embedding.length !== dimension) {
          skipped += 1;
          skippedLabels.push(projectLabel(node));
          continue;
        }
        const label = projectLabel(node);
        index.addPoint(embedding, labels.length);
        labels.push(label);
      }
      if (!index) {
        dimension = DIM;
        index = createIndex(hnswlib, dimension, capacity);
      }
      indexTmpIdentity = await reserveOwnedTemp(indexTmpPath);
      index.writeIndexSync(indexTmpPath);
      await syncOwnedFile(indexTmpPath, indexTmpIdentity);
      await linkOwnedTemp(indexTmpPath, indexPath);
      indexIdentity = indexTmpIdentity;
      await assertOwnedFileIdentity(indexPath, indexIdentity);
      await removeOwnedFile(indexTmpPath, indexTmpIdentity);
      indexTmpIdentity = null;
      await fsyncDirectory(canonicalBrain);
      const allLabels = labels.concat(skippedLabels);
      const meta = {
        version: 1,
        dimension,
        dim: dimension,
        count: labels.length,
        labelCount: allLabels.length,
        sourceNodeCount: capacity,
        skipped,
        M: HNSW_M,
        efConstruction: HNSW_EF_CONSTRUCTION,
        provider,
        model,
        generation,
        builtFromRevision: revision,
        builtAt: now().toISOString(),
        buildDurationMs: Date.now() - started,
        labels: allLabels,
      };
      metaTmpIdentity = await reserveOwnedTemp(metaTmpPath);
      await writeJsonOwnedTemp(metaTmpPath, metaTmpIdentity, meta);
      await linkOwnedTemp(metaTmpPath, metaPath);
      metaIdentity = metaTmpIdentity;
      await assertOwnedFileIdentity(metaPath, metaIdentity);
      await removeOwnedFile(metaTmpPath, metaTmpIdentity);
      metaTmpIdentity = null;
      await fsyncDirectory(canonicalBrain);
      const advanced = await advanceAnn(canonicalBrain, {
        expectedGeneration: generation,
        expectedBaseRevision: baseRevision,
        expectedDeltaEpoch: deltaEpoch,
        builtFromRevision: revision,
        indexFile,
        metaFile,
        lockRoot: context.lockRoot,
      });
      if (advanced?.advanced !== true) {
        throw memorySourceError('source_changed', 'ANN watermark was not advanced', {
          retryable: true,
          advanced,
        });
      }
      const publishedCurrentRevision = advanced.manifest?.currentRevision ?? revision;
      const coverage = advanced.coverage
        || (publishedCurrentRevision === revision ? 'fresh' : 'overlay-covered');
      return {
        total: labels.length,
        skipped,
        indexPath,
        metaPath,
        generation,
        builtFromRevision: revision,
        advanced,
        coverage,
        currentRevision: publishedCurrentRevision,
        bridgeableGap: publishedCurrentRevision - revision,
        semanticCoverage: { indexed: labels.length, skipped },
        stageDurations: { totalMs: Date.now() - started },
      };
    } catch (error) {
      const cleanupErrors = await cleanupOwnedFiles([
        { filePath: metaPath, identity: metaIdentity },
        { filePath: indexPath, identity: indexIdentity },
        { filePath: metaTmpPath, identity: metaTmpIdentity },
        { filePath: indexTmpPath, identity: indexTmpIdentity },
      ]);
      if (cleanupErrors.length > 0) {
        throw memorySourceError('source_changed', 'ANN build failed and output cleanup was unsafe', {
          retryable: true,
          cause: error,
          cleanupErrors,
        });
      }
      throw error;
    }
  });
}

if (require.main === module) {
  const brainDir = process.argv[2] || path.join(__dirname, '../../../instances/jerry/brain');
  build(brainDir)
    .then((result) => {
      console.log(JSON.stringify({
        event: 'ann_rebuild_receipt',
        status: result.coverage,
        builtRevision: result.builtFromRevision,
        currentRevision: result.currentRevision,
        bridgeableGap: result.bridgeableGap,
        indexCount: result.total,
        stageDurations: result.stageDurations,
        semanticCoverage: result.semanticCoverage,
        reused: result.reused === true,
      }));
      process.exit(0);
    })
    .catch((error) => {
      console.error('[build-ann] FAILED:', error.message);
      process.exit(1);
    });
}

module.exports = { build, DIM };
