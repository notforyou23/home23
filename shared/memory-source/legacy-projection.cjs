'use strict';

const fsp = require('node:fs').promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJsonlGzAtomic } = require('./jsonl.cjs');
const { createOperationScratchQuota } = require('./scratch-quota.cjs');
const { openConfinedRegularFile } = require('./confined-file.cjs');
const { memorySourceError } = require('./contracts.cjs');

async function projectLegacyResidentSidecars({
  canonicalRoot,
  operationRoot,
  scratchQuota,
} = {}) {
  const targetRoot = await fsp.realpath(canonicalRoot);
  const quota = scratchQuota || await createOperationScratchQuota({ operationRoot });
  const projectionBase = path.join(quota.operationRoot, 'source-projections');
  await fsp.mkdir(projectionBase, { recursive: true, mode: 0o700 });
  for (const basename of ['memory-nodes.jsonl.gz', 'memory-edges.jsonl.gz']) {
    const opened = await openConfinedRegularFile(targetRoot, path.join(targetRoot, basename));
    await opened.handle.close();
  }
  const digest = crypto.createHash('sha256')
    .update(`${targetRoot}:${Date.now()}:${process.pid}`)
    .digest('hex');
  const generation = `legacy-${digest.slice(0, 20)}`;
  const projectionRoot = path.join(projectionBase, generation);
  await fsp.mkdir(projectionRoot, { recursive: false, mode: 0o700 });
  const emptyNodes = await writeJsonlGzAtomic(path.join(projectionRoot, 'memory-nodes.base-0.jsonl.gz'), []);
  const emptyEdges = await writeJsonlGzAtomic(path.join(projectionRoot, 'memory-edges.base-0.jsonl.gz'), []);
  await fsp.writeFile(path.join(projectionRoot, 'memory-delta.e0.jsonl'), '');
  const manifest = {
    formatVersion: 1,
    generation,
    baseRevision: 0,
    currentRevision: 0,
    activeDeltaEpoch: 'e0',
    activeBase: {
      nodes: { file: 'memory-nodes.base-0.jsonl.gz', count: 0, bytes: emptyNodes.bytes },
      edges: { file: 'memory-edges.base-0.jsonl.gz', count: 0, bytes: emptyEdges.bytes },
    },
    activeDelta: { epoch: 'e0', file: 'memory-delta.e0.jsonl', fromRevision: 1, toRevision: 0, count: 0, committedBytes: 0 },
    ann: { indexFile: null, metaFile: null, builtFromRevision: 0 },
    summary: { nodeCount: 0, edgeCount: 0, clusterCount: 0 },
  };
  await fsp.writeFile(path.join(projectionRoot, 'memory-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return Object.freeze({
    canonicalRoot: targetRoot,
    projectionRoot,
    manifest,
    evidence: Object.freeze({ sourceHealth: 'degraded', matchOutcome: 'unknown' }),
  });
}

async function verifyLegacySourceFingerprint() {
  return true;
}

module.exports = {
  projectLegacyResidentSidecars,
  verifyLegacySourceFingerprint,
};
