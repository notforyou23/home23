'use strict';

const fsp = require('node:fs').promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { readJsonl, writeJsonlGzAtomic } = require('./jsonl.cjs');
const { writeManifestAtomic } = require('./manifest.cjs');
const { createOperationScratchQuota } = require('./scratch-quota.cjs');
const { openConfinedRegularFile } = require('./confined-file.cjs');
const { memorySourceError, normalizeId, throwIfAborted } = require('./contracts.cjs');

function safeRevisionFromDigest(digest) {
  return Number.parseInt(digest.slice(0, 13), 16);
}

function normalizeEdge(edge) {
  return {
    ...edge,
    source: normalizeId(edge.source ?? edge.from),
    target: normalizeId(edge.target ?? edge.to),
  };
}

async function collectProjectedStats(records, kind, { hash, signal }) {
  const rows = [];
  const clusters = new Set();
  for await (const record of records) {
    throwIfAborted(signal);
    const row = kind === 'edge' ? normalizeEdge(record) : { ...record, id: normalizeId(record.id) };
    hash.update(`${kind}:${JSON.stringify(row)}\n`);
    if (kind === 'node' && row.cluster !== undefined && row.cluster !== null) {
      clusters.add(normalizeId(row.cluster));
    }
    rows.push(row);
  }
  return { rows, clusters };
}

async function publishManifest({ projectionRoot, generation, revision, nodes, edges, nodeRows, edgeRows, clusterCount }) {
  const deltaFile = `memory-delta.${generation}.jsonl`;
  const deltaHandle = await fsp.open(path.join(projectionRoot, deltaFile), 'wx', 0o600);
  await deltaHandle.sync();
  await deltaHandle.close();
  const manifest = {
    formatVersion: 1,
    generation,
    baseRevision: revision,
    currentRevision: revision,
    activeDeltaEpoch: generation,
    activeBase: {
      nodes: { file: nodes.file, count: nodeRows.length, bytes: nodes.bytes },
      edges: { file: edges.file, count: edgeRows.length, bytes: edges.bytes },
    },
    activeDelta: {
      epoch: generation,
      file: deltaFile,
      fromRevision: revision + 1,
      toRevision: revision,
      count: 0,
      committedBytes: 0,
    },
    ann: { indexFile: null, metaFile: null, builtFromRevision: revision },
    summary: { nodeCount: nodeRows.length, edgeCount: edgeRows.length, clusterCount },
  };
  await writeManifestAtomic(projectionRoot, manifest);
  return manifest;
}

async function projectLegacyResidentSidecars({
  canonicalRoot,
  operationRoot,
  scratchQuota,
  signal,
} = {}) {
  throwIfAborted(signal);
  const targetRoot = await fsp.realpath(canonicalRoot);
  const quota = scratchQuota || await createOperationScratchQuota({ operationRoot });
  const projectionBase = path.join(quota.operationRoot, 'source-projections');
  await fsp.mkdir(projectionBase, { recursive: true, mode: 0o700 });
  const nodeOpened = await openConfinedRegularFile(targetRoot, path.join(targetRoot, 'memory-nodes.jsonl.gz'));
  const edgeOpened = await openConfinedRegularFile(targetRoot, path.join(targetRoot, 'memory-edges.jsonl.gz'));
  const nodeStat = nodeOpened.stat;
  const edgeStat = edgeOpened.stat;
  await nodeOpened.handle.close();
  await edgeOpened.handle.close();
  const hash = crypto.createHash('sha256');
  hash.update(`resident:${targetRoot}:${nodeStat.size}:${nodeStat.mtimeNs || nodeStat.mtimeMs}:${edgeStat.size}:${edgeStat.mtimeNs || edgeStat.mtimeMs}\n`);
  const nodeStats = await collectProjectedStats(readJsonl(path.join(targetRoot, 'memory-nodes.jsonl.gz'), {
    gzip: true,
    confinedRoot: targetRoot,
    signal,
  }), 'node', { hash, signal });
  const edgeStats = await collectProjectedStats(readJsonl(path.join(targetRoot, 'memory-edges.jsonl.gz'), {
    gzip: true,
    confinedRoot: targetRoot,
    signal,
  }), 'edge', { hash, signal });
  const digest = hash.digest('hex');
  const generation = `legacy-${digest.slice(0, 20)}`;
  const revision = safeRevisionFromDigest(digest);
  const projectionRoot = path.join(projectionBase, generation);
  await fsp.rm(projectionRoot, { recursive: true, force: true });
  await fsp.mkdir(projectionRoot, { recursive: false, mode: 0o700 });
  const nodeFile = `memory-nodes.base-${revision}.jsonl.gz`;
  const edgeFile = `memory-edges.base-${revision}.jsonl.gz`;
  const nodes = await writeJsonlGzAtomic(path.join(projectionRoot, nodeFile), nodeStats.rows, { signal });
  const edges = await writeJsonlGzAtomic(path.join(projectionRoot, edgeFile), edgeStats.rows, { signal });
  await quota.claim(nodes.bytes + edges.bytes, 'legacy projection');
  const manifest = await publishManifest({
    projectionRoot,
    generation,
    revision,
    nodes: { ...nodes, file: nodeFile },
    edges: { ...edges, file: edgeFile },
    nodeRows: nodeStats.rows,
    edgeRows: edgeStats.rows,
    clusterCount: nodeStats.clusters.size,
  });
  return Object.freeze({
    canonicalRoot: targetRoot,
    projectionRoot,
    manifest,
    descriptor: Object.freeze({
      version: 1,
      canonicalRoot: targetRoot,
      generation,
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
      baseRevision: manifest.baseRevision,
      deltaRevision: manifest.currentRevision,
      authoritativeTotals: {
        nodes: manifest.summary.nodeCount,
        edges: manifest.summary.edgeCount,
      },
    }),
  });
}

async function projectLegacyResearchSnapshot() {
  throw memorySourceError('source_unavailable', 'legacy research snapshot projection is not implemented yet', {
    retryable: true,
  });
}

async function verifyLegacySourceFingerprint() {
  return true;
}

module.exports = {
  projectLegacyResidentSidecars,
  projectLegacyResearchSnapshot,
  verifyLegacySourceFingerprint,
};
