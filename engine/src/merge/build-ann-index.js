/**
 * build-ann-index.js — Build a persistent HNSW ANN index from a pinned logical
 * memory source. The manifest revision, not sidecar mtime, is the freshness
 * authority used by dashboard search.
 */

'use strict';

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

const DIM = 768;
const HNSW_M = 16;
const HNSW_EF_CONSTRUCTION = 200;

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
  return {
    id: node.id,
    concept: typeof node.concept === 'string' ? node.concept.slice(0, 800) : '',
    tag: node.tag || null,
    weight: node.weight ?? null,
    activation: node.activation ?? null,
    cluster: node.cluster ?? null,
    created: node.created ?? null,
    source_class: node.source_class || provenance.sourceClass,
    salienceWeight: node.salienceWeight ?? provenance.salienceWeight,
    provenance: node.provenance || {
      sourceClass: provenance.sourceClass,
      reason: provenance.reason,
      retention: provenance.retention,
    },
  };
}

async function fsyncDirectory(dir) {
  const handle = await fsp.open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  const handle = await fsp.open(tmpPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmpPath, filePath);
  await fsyncDirectory(path.dirname(filePath));
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
    const labels = [];
    const vectors = [];
    let skipped = 0;
    let dimension = null;
    for await (const node of source.iterateNodes({ signal: deps.signal })) {
      throwIfAborted(deps.signal);
      const embedding = node?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        skipped += 1;
        continue;
      }
      if (dimension === null) dimension = embedding.length;
      if (embedding.length !== dimension) {
        skipped += 1;
        continue;
      }
      labels.push(projectLabel(node));
      vectors.push(embedding);
    }
    dimension = dimension || DIM;
    const revision = source.revision;
    const generation = source.manifest?.generation;
    const indexFile = `memory-ann.${revision}.index`;
    const metaFile = `memory-ann.${revision}.meta.json`;
    const indexPath = path.join(canonicalBrain, indexFile);
    const metaPath = path.join(canonicalBrain, metaFile);
    const indexTmpPath = `${indexPath}.tmp`;
    const index = createIndex(hnswlib, dimension, vectors.length + 1000);
    const started = Date.now();
    for (let indexPosition = 0; indexPosition < vectors.length; indexPosition += 1) {
      throwIfAborted(deps.signal);
      index.addPoint(vectors[indexPosition], indexPosition);
    }
    if (fs.existsSync(indexTmpPath)) await fsp.rm(indexTmpPath, { force: true });
    index.writeIndexSync(indexTmpPath);
    await fsp.rename(indexTmpPath, indexPath);
    await fsyncDirectory(canonicalBrain);
    const meta = {
      version: 1,
      dimension,
      dim: dimension,
      count: labels.length,
      skipped,
      M: HNSW_M,
      efConstruction: HNSW_EF_CONSTRUCTION,
      provider,
      model,
      generation,
      builtFromRevision: revision,
      builtAt: now().toISOString(),
      buildDurationMs: Date.now() - started,
      labels,
    };
    await writeJsonAtomic(metaPath, meta);
    const advanced = await advanceAnn(canonicalBrain, {
      expectedGeneration: generation,
      builtFromRevision: revision,
      indexFile,
      metaFile,
      lockRoot: context.lockRoot,
    });
    return {
      total: labels.length,
      skipped,
      indexPath,
      metaPath,
      generation,
      builtFromRevision: revision,
      advanced,
    };
  });
}

if (require.main === module) {
  const brainDir = process.argv[2] || path.join(__dirname, '../../../instances/jerry/brain');
  build(brainDir)
    .then((result) => {
      log('DONE', result.total, 'nodes indexed', result.advanced?.advanced ? 'fresh' : 'stale');
      process.exit(0);
    })
    .catch((error) => {
      console.error('[build-ann] FAILED:', error.message);
      process.exit(1);
    });
}

module.exports = { build, DIM };
