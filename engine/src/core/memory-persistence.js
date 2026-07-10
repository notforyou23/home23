'use strict';

const path = require('node:path');
const fsp = require('node:fs').promises;
const {
  openMemorySource,
  readManifest,
  resolveMemorySourceSelection,
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

function normalizeMemoryId(value) {
  return String(value);
}

function compatibilityEdgeKey(edge) {
  if (edge?.key) return String(edge.key);
  const source = edge?.source ?? edge?.from;
  const target = edge?.target ?? edge?.to;
  const sortedPair = [source, target].sort((a, b) => String(a).localeCompare(String(b)));
  return sortedPair.join('->');
}

async function loadLegacyResidentSidecars(brainDir) {
  const { readMemorySidecars, readMemoryDeltas } = require('./memory-sidecar');
  const nodesById = new Map();
  const edgesByKey = new Map();

  const base = await readMemorySidecars(brainDir, {
    onNode(node) {
      if (node && node.id !== undefined && node.id !== null) {
        nodesById.set(normalizeMemoryId(node.id), node);
      }
    },
    onEdge(edge) {
      if (edge) edgesByKey.set(compatibilityEdgeKey(edge), edge);
    },
  });

  const delta = await readMemoryDeltas(brainDir, {
    onNode(node) {
      if (node && node.id !== undefined && node.id !== null) {
        nodesById.set(normalizeMemoryId(node.id), node);
      }
    },
    onEdge(edge) {
      if (edge) edgesByKey.set(compatibilityEdgeKey(edge), edge);
    },
    onRemoveNode(id) {
      const normalized = normalizeMemoryId(id);
      nodesById.delete(normalized);
      for (const [key, edge] of edgesByKey) {
        if (normalizeMemoryId(edge?.source ?? edge?.from) === normalized
            || normalizeMemoryId(edge?.target ?? edge?.to) === normalized) {
          edgesByKey.delete(key);
        }
      }
    },
    onRemoveEdge(key) {
      edgesByKey.delete(String(key));
    },
  });

  const nodes = Array.from(nodesById.values());
  const edges = Array.from(edgesByKey.values());
  const clusters = new Set(nodes
    .map((node) => node?.cluster)
    .filter((cluster) => cluster !== null && cluster !== undefined));
  return {
    nodes,
    edges,
    summary: {
      nodes: nodes.length,
      edges: edges.length,
      clusters: clusters.size,
    },
    revision: null,
    evidence: {
      selectedAgent: null,
      selectedBrain: null,
      route: 'legacy-resident-sidecars',
      implementation: 'legacy-resident-sidecar-compatibility',
      baseWatermark: { revision: null, file: 'memory-nodes.jsonl.gz' },
      deltaWatermark: {
        revision: null,
        epoch: null,
        appliedRecords: delta.count || 0,
      },
      indexWatermark: { builtFromRevision: null, fresh: false },
      authoritativeTotals: { nodes: nodes.length, edges: edges.length },
      returnedTotals: { nodes: nodes.length, edges: edges.length },
      sourceHealth: (base.nodes.parseErrors || base.edges.parseErrors || delta.parseErrors) ? 'degraded' : 'healthy',
      matchOutcome: 'collected',
      fallback: 'legacy-resident-sidecars',
      diagnostics: [
        ...(base.nodes.parseErrors ? [`node_parse_errors:${base.nodes.parseErrors}`] : []),
        ...(base.edges.parseErrors ? [`edge_parse_errors:${base.edges.parseErrors}`] : []),
        ...(delta.parseErrors ? [`delta_parse_errors:${delta.parseErrors}`] : []),
      ],
      diagnosticsDropped: 0,
    },
  };
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
  const selection = await resolveMemorySourceSelection(brainDir).catch(() => null);
  if (selection?.authority === 'legacy-resident-sidecars') {
    return loadLegacyResidentSidecars(brainDir);
  }

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
