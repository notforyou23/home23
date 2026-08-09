'use strict';

const path = require('node:path');
const fsp = require('node:fs').promises;
const {
  openMemorySource,
  createDescriptor,
  readManifest,
  resolveMemorySourceSelection,
  appendMemoryRevision,
  rewriteMemoryBase,
  sourceDescriptorDigest,
  retireUnpinnedSources,
} = require('../../../shared/memory-source');

function defaultRebuildAnnIndex({ brainDir, home23Root }) {
  // The ANN meta binds to the manifest generation, and every base rewrite
  // mints a new generation — so a rebase ALWAYS invalidates the index by
  // design. Before this hook, the index was rebuilt only by the 04:30 cron
  // and the 6-hourly rebases kept killing it within hours; both agents ran
  // in degraded keyword-scan fallback most of every day (2026-07-17).
  // Every rewrite now brings its own rebuild. Deltas never trigger this:
  // the overlay covers post-build appends.
  const { spawn } = require('node:child_process');
  const builderPath = path.join(home23Root, 'engine', 'src', 'merge', 'build-ann-index.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=4096', builderPath, brainDir], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ann builder exited ${code}: ${(err || out).trim().slice(-300)}`));
        return;
      }
      const lastLine = out.trim().split('\n').pop() || '';
      try { resolve(JSON.parse(lastLine)); } catch { resolve({ status: 'ok', raw: lastLine.slice(-200) }); }
    });
  });
}

function scheduleAnnRebuild({
  brainDir,
  home23Root,
  rebuildAnn = defaultRebuildAnnIndex,
  schedule = queueMicrotask,
  logger = console,
}) {
  schedule(async () => {
    try {
      const receipt = await rebuildAnn({ brainDir, home23Root });
      logger.info?.('ANN index rebuilt after base rewrite', {
        brainDir,
        status: receipt?.status,
        indexed: receipt?.semanticCoverage?.indexed,
      });
    } catch (error) {
      logger.warn?.('ANN rebuild after base rewrite failed — 04:30 cron remains the backstop', {
        brainDir, error: error.message,
      });
    }
  });
}

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

function nodeSummaryRepairNeeded(left, right) {
  return Boolean(left && right
    && left.nodeCount !== right.nodeCount
    && left.edgeCount === right.edgeCount
    && left.clusterCount === right.clusterCount);
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
  fullRewriteDeltaBytes = 512 * 1024 * 1024,
  fullRewriteDeltaCount = 250_000,
  home23Root = path.resolve(__dirname, '../../..'),
  gzipLevel,
  schedule = queueMicrotask,
  retireUnpinnedSources: retire = retireUnpinnedSources,
  rebuildAnnIndex: rebuildAnn = defaultRebuildAnnIndex,
  logger = console,
  writer = { readManifest, appendMemoryRevision, rewriteMemoryBase },
}) {
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  const manifest = await writer.readManifest(brainDir);
  const legacySelection = !forceFull && !manifest
    ? await resolveMemorySourceSelection(brainDir).catch(() => null)
    : null;
  if (legacySelection?.authority === 'legacy-resident-sidecars') {
    const snapshot = typeof memory.capturePersistenceChangesSnapshot === 'function'
      ? memory.capturePersistenceChangesSnapshot()
      : memory.capturePersistenceSnapshot();
    const { appendMemoryDelta } = require('./memory-sidecar');
    const result = await appendMemoryDelta(brainDir, {
      ...snapshot.changes,
      summary: snapshot.summary,
    }, { lockRoot });
    const committed = result.count > 0;
    const cleaned = committed ? memory.markPersistenceCleanIfGeneration(snapshot.generation) : false;
    return {
      ...result,
      manifest: null,
      mode: committed ? 'legacy-delta' : 'reused',
      cleaned,
      persistedGeneration: snapshot.generation,
      persistedChanges: snapshot.changes,
    };
  }
  // A manifest without a parseable baseWrittenAt predates the stamp (or is
  // damaged) and is treated as overdue: better one extra full rewrite than a
  // delta that grows until cold load takes minutes. This clause was dead
  // until 2026-07-16 — rewriteMemoryBase never wrote baseWrittenAt, so the
  // periodic rewrite could not fire and jerry's delta reached 846k ops.
  const baseWrittenAtMs = manifest?.baseWrittenAt !== undefined
    ? Date.parse(manifest.baseWrittenAt)
    : NaN;
  // Age alone is not a sufficient bound: feeder bursts can emit millions of
  // edge removals in well under six hours. Fold a large delta before it fills
  // the data volume or makes every operation snapshot clone gigabytes.
  const deltaBytes = Number(manifest?.activeDelta?.committedBytes) || 0;
  const deltaCount = Number(manifest?.activeDelta?.count) || 0;
  const rewrite = forceFull || !manifest
    || !Number.isFinite(baseWrittenAtMs)
    || Date.now() - baseWrittenAtMs >= fullRewriteIntervalMs
    || deltaBytes >= fullRewriteDeltaBytes
    || deltaCount >= fullRewriteDeltaCount;
  // A manifest-backed delta/reuse save must not clone the complete resident
  // graph merely to discover that only its dirty generation is needed. At
  // Jerry scale that redundant full materialization can exhaust the engine
  // heap before appendMemoryRevision is reached. Full views remain mandatory
  // for initial/forced/periodic base rewrites; ordinary saves capture the same
  // immutable generation through the bounded changes-only surface.
  let snapshot = !rewrite && typeof memory.capturePersistenceChangesSnapshot === 'function'
    ? memory.capturePersistenceChangesSnapshot()
    : memory.capturePersistenceSnapshot();
  const capturedHasChanges = hasChanges(snapshot.changes);
  // A revisioned load materializes every logical node, so a clean resident
  // graph can safely repair a node-count drift caused by historical ID type
  // aliases. Edge and cluster disagreement may instead reflect hydration
  // filtering; keep that fail-closed until a real graph mutation describes it.
  const summaryRepair = Boolean(!rewrite && !capturedHasChanges && manifest
    && nodeSummaryRepairNeeded(manifest.summary, snapshot.summary));
  const summaryRepairExpected = summaryRepair
    ? {
        expectedGeneration: manifest.generation,
        expectedRevision: manifest.currentRevision,
        expectedDigest: sourceDescriptorDigest(createDescriptor(
          await fsp.realpath(brainDir),
          manifest,
        )),
      }
    : null;
  let result;
  let performedRewrite = rewrite;
  if (rewrite) {
    result = await writer.rewriteMemoryBase(brainDir, {
      nodes: snapshot.fullView.nodes,
      edges: snapshot.fullView.edges,
      summary: snapshot.summary,
    }, { lockRoot, level: gzipLevel });
  } else if (capturedHasChanges || summaryRepair) {
    try {
      result = await writer.appendMemoryRevision(brainDir, snapshot.changes, {
        lockRoot,
        summary: snapshot.summary,
        ...(summaryRepairExpected || {}),
      });
    } catch (error) {
      // A busy feeder can accumulate more than the writer's bounded 512 MiB
      // delta transaction before the next save. Retrying the same oversized
      // generation can never work and leaves all later state volatile. Fold
      // the resident graph into a fresh base instead; the generation CAS below
      // keeps mutations that arrive during the rewrite dirty for the next save.
      if (error?.code !== 'result_too_large' || error?.limitKind !== 'delta_commit') throw error;
      snapshot = memory.capturePersistenceSnapshot();
      performedRewrite = true;
      logger.warn?.('Memory delta commit exceeded writer limit — rewriting full base', {
        nodes: snapshot.summary.nodeCount,
        edges: snapshot.summary.edgeCount,
      });
      result = await writer.rewriteMemoryBase(brainDir, {
        nodes: snapshot.fullView.nodes,
        edges: snapshot.fullView.edges,
        summary: snapshot.summary,
      }, { lockRoot, level: gzipLevel });
    }
  } else {
    result = { manifest, count: 0 };
  }
  const committed = Boolean(result?.manifest && (performedRewrite || result.count > 0 || summaryRepair));
  const cleaned = committed && (performedRewrite || capturedHasChanges)
    ? memory.markPersistenceCleanIfGeneration(snapshot.generation)
    : false;
  if (performedRewrite && result?.manifest) {
    scheduleSourceRetirement({ brainDir, home23Root, lockRoot, retire, schedule, logger });
    scheduleAnnRebuild({ brainDir, home23Root, rebuildAnn, schedule, logger });
  }
  return {
    ...result,
    mode: performedRewrite ? 'full' : (result.count > 0 ? 'delta' : (summaryRepair ? 'summary-repair' : 'reused')),
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
