'use strict';

const path = require('node:path');
const fsp = require('node:fs').promises;
const {
  openMemorySource,
  readManifest,
  appendMemoryRevision,
  rewriteMemoryBase,
  retireUnpinnedSources,
} = require('../../../shared/memory-source');

function scheduleSourceRetirement({
  brainDir,
  home23Root,
  lockRoot,
  retire = retireUnpinnedSources,
  schedule = queueMicrotask,
  logger = console,
}) {
  schedule(async () => {
    try {
      await retire(brainDir, { home23Root, lockRoot });
    } catch (error) {
      logger.warn?.('Memory source retirement deferred', { brainDir, error: error.message });
    }
  });
}

function hasChanges(changes) {
  return changes.nodes.length > 0
    || changes.edges.length > 0
    || changes.removedNodeIds.length > 0
    || changes.removedEdgeKeys.length > 0;
}

async function persistMemoryRevision({
  brainDir,
  memory,
  forceFull = false,
  fullRewriteIntervalMs = 6 * 60 * 60 * 1000,
  home23Root = path.resolve(__dirname, '../../..'),
  gzipLevel,
  schedule = queueMicrotask,
  retireUnpinnedSources: retire = retireUnpinnedSources,
  logger = console,
  writer = { readManifest, appendMemoryRevision, rewriteMemoryBase },
}) {
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  const snapshot = memory.capturePersistenceSnapshot();
  const manifest = await writer.readManifest(brainDir);
  const rewrite = forceFull || !manifest
    || (manifest.baseWrittenAt && Date.now() - Date.parse(manifest.baseWrittenAt) >= fullRewriteIntervalMs);
  let result;
  if (rewrite) {
    result = await writer.rewriteMemoryBase(brainDir, {
      nodes: snapshot.fullView.nodes,
      edges: snapshot.fullView.edges,
      summary: snapshot.summary,
    }, { lockRoot, level: gzipLevel });
  } else if (hasChanges(snapshot.changes)) {
    result = await writer.appendMemoryRevision(brainDir, snapshot.changes, {
      lockRoot,
      summary: snapshot.summary,
    });
  } else {
    result = { manifest, count: 0 };
  }
  const committed = Boolean(result?.manifest && (rewrite || result.count > 0));
  const cleaned = committed ? memory.markPersistenceCleanIfGeneration(snapshot.generation) : false;
  if (rewrite && result?.manifest) {
    scheduleSourceRetirement({ brainDir, home23Root, lockRoot, retire, schedule, logger });
  }
  return {
    ...result,
    mode: rewrite ? 'full' : (result.count > 0 ? 'delta' : 'reused'),
    cleaned,
    persistedGeneration: snapshot.generation,
    persistedChanges: snapshot.changes,
  };
}

async function loadMemoryRevision(brainDir, {
  home23Root = path.resolve(__dirname, '../../..'),
  requesterAgent = 'local',
  operationId = `internal-load-${process.pid}-${Date.now()}`,
} = {}) {
  const operationRoot = path.join(home23Root, 'instances', requesterAgent, 'runtime', 'brain-operations', operationId);
  const source = await openMemorySource(brainDir, {
    requesterAgent,
    operationId,
    operationRoot,
    lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks'),
  });
  try {
    const nodes = [];
    const edges = [];
    for await (const node of source.iterateNodes()) nodes.push(node);
    for await (const edge of source.iterateEdges()) edges.push(edge);
    const summary = await source.summarize();
    return {
      nodes,
      edges,
      summary,
      revision: source.revision,
      evidence: source.getEvidence({
        completeCoverage: true,
        authoritativeTotals: { nodes: summary.nodes, edges: summary.edges },
        returnedTotals: { nodes: nodes.length, edges: edges.length },
      }),
    };
  } finally {
    await source.close();
    await fsp.rm(operationRoot, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  persistMemoryRevision,
  loadMemoryRevision,
  scheduleSourceRetirement,
};
