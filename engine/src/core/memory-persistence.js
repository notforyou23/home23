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
  rewriteMemoryBaseFromSnapshot,
  compactMemoryBase,
  removeStaleBaseStaging,
  sourceDescriptorDigest,
  retireUnpinnedSources,
} = require('../../../shared/memory-source');

// A compaction that fails deterministically (retryable !== true) must not
// restage a whole base and re-append every dirty record on each save: from
// 2026-09-24 Forrest did that ~900 times, growing its delta to 1.96 GB while
// every state save was refused. Keyed by brain; retryable failures such as a
// busy lock or a concurrent append still retry on the next save.
const compactionBackoff = new Map();

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

// Only countedMemoryView's final validation carries graphCounts with
// retryable:false; it proves the committed rows disagree with the summary.
function isGraphSummaryMismatch(error) {
  return error?.code === 'source_unavailable' && error.retryable === false
    && Boolean(error.graphCounts);
}

// The resident rewrite replaces disk rows, so it must pass the same
// catastrophic-loss floor as every state save, measured against the larger of
// the committed summary and the rows actually on disk. Edges get the same
// floor: an edge map lost by a bug must not be published as authority.
function residentRewriteRefusal(residentSummary, graphCounts, manifestSummary) {
  const { evaluateSaveSafety } = require('./brain-persistence-guard');
  for (const [kind, current, existing] of [
    ['nodes', residentSummary.nodeCount, Math.max(graphCounts.nodes, manifestSummary.nodeCount)],
    ['edges', residentSummary.edgeCount, Math.max(graphCounts.edges, manifestSummary.edgeCount)],
  ]) {
    const safety = evaluateSaveSafety({ currentNodes: current, existingNodes: existing, source: `disk-${kind}` });
    if (!safety.ok) return { kind, current, existing, dropPercent: safety.dropPercent };
  }
  return null;
}

async function removeStaleStaging({ writer, brainDir, lockRoot, olderThanMs, logger }) {
  if (typeof writer.removeStaleBaseStaging !== 'function') return;
  try {
    const { removed } = await writer.removeStaleBaseStaging(brainDir, { lockRoot, olderThanMs });
    if (removed.length) logger.info?.('Removed stale memory base staging files', { brainDir, removed });
  } catch (error) {
    logger.warn?.('Stale memory base staging cleanup deferred', { brainDir, error: error.message });
  }
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
  compactionBackoffMs = 60 * 60 * 1000,
  staleStagingAgeMs = 15 * 60 * 1000,
  now = Date.now,
  home23Root = path.resolve(__dirname, '../../..'),
  gzipLevel,
  schedule = queueMicrotask,
  retireUnpinnedSources: retire = retireUnpinnedSources,
  rebuildAnnIndex: rebuildAnn = defaultRebuildAnnIndex,
  logger = console,
  writer = {
    readManifest, appendMemoryRevision, rewriteMemoryBase, rewriteMemoryBaseFromSnapshot, compactMemoryBase,
    removeStaleBaseStaging,
  },
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
  const rewriteDue = forceFull || !manifest
    || !Number.isFinite(baseWrittenAtMs)
    || now() - baseWrittenAtMs >= fullRewriteIntervalMs
    || deltaBytes >= fullRewriteDeltaBytes
    || deltaCount >= fullRewriteDeltaCount;
  // Only routine rebases wait out a back-off. The save continues as an
  // ordinary delta so memory stays durable, and reports the debt.
  const backoffKey = path.resolve(brainDir);
  const backoff = compactionBackoff.get(backoffKey);
  const deferredDebt = rewriteDue && !forceFull && manifest && backoff && now() < backoff.until
    ? { reason: 'compaction_backoff', error: backoff.error, retryAfter: new Date(backoff.until).toISOString() }
    : null;
  const rewrite = rewriteDue && !deferredDebt;
  // Routine rebases stream committed persistence, after appending this captured
  // dirty generation. Cloning the full resident graph for an overdue base can
  // otherwise OOM at every save and every subsequent crash-recovery boot.
  // Explicit full saves and first writes still persist a complete graph,
  // streaming it when supported. Older injected writers keep their contract.
  const canCompact = rewrite && !forceFull && Boolean(manifest)
    && typeof writer.compactMemoryBase === 'function';
  const canStreamSnapshot = typeof memory.capturePersistenceStreamingSnapshot === 'function'
    && typeof writer.rewriteMemoryBaseFromSnapshot === 'function';
  const dirtyRecordCount = (memory.dirtyNodeIds?.size || 0)
    + (memory.dirtyEdgeKeys?.size || 0)
    + (memory.deletedNodeIds?.size || 0)
    + (memory.deletedEdgeKeys?.size || 0);
  // Daily decay may dirty the entire graph at once. Choose streaming BEFORE
  // changes-only capture: a changes snapshot of all dirty nodes is still a
  // full graph allocation, repeated by delta normalization in the writer.
  let streamingSnapshot = canStreamSnapshot && ((rewrite && !canCompact) || dirtyRecordCount >= 1024);
  let streamCompaction = canCompact && !streamingSnapshot;
  // Base files are staged outside the source lock, and only a killed process
  // leaves a staging file behind (Forrest kept a 304 MB orphan from 23 Sep).
  // A live writer keeps touching its file, so before staging another base
  // remove only files untouched for a margin before this attempt began. It runs
  // before capture so the lock wait cannot invalidate a streaming snapshot.
  if (rewrite || streamingSnapshot) {
    await removeStaleStaging({ writer, brainDir, lockRoot, olderThanMs: now() - staleStagingAgeMs, logger });
  }
  let snapshot = streamingSnapshot
    ? memory.capturePersistenceStreamingSnapshot()
    : (!rewrite || streamCompaction) && typeof memory.capturePersistenceChangesSnapshot === 'function'
      ? memory.capturePersistenceChangesSnapshot()
      : memory.capturePersistenceSnapshot();
  const capturedHasChanges = snapshot.changes ? hasChanges(snapshot.changes) : dirtyRecordCount > 0;
  // A revisioned load materializes every logical node, so a clean resident
  // graph can safely repair a node-count drift caused by historical ID type
  // aliases. Edge and cluster disagreement may instead reflect hydration
  // filtering; keep that fail-closed until a real graph mutation describes it.
  const summaryRepair = Boolean(!streamingSnapshot && (!rewrite || streamCompaction) && !capturedHasChanges && manifest
    && nodeSummaryRepairNeeded(manifest.summary, snapshot.summary));
  // Resident loading canonicalizes historical numeric/string ID aliases. A
  // clean node-count repair therefore needs those canonical rows atomically:
  // changing only the summary would leave duplicate physical rows and cause
  // the counted disk compactor to reject every retry. Preserve the original
  // descriptor below and publish the repaired rows and counts together.
  const canonicalResidentRewrite = summaryRepair && (canStreamSnapshot || streamCompaction);
  if (canonicalResidentRewrite) {
    streamCompaction = false;
    streamingSnapshot = canStreamSnapshot;
    snapshot = streamingSnapshot
      ? memory.capturePersistenceStreamingSnapshot()
      : memory.capturePersistenceSnapshot();
  }
  const capturedSourceExpected = summaryRepair || streamCompaction || canStreamSnapshot
    ? manifest ? {
        expectedGeneration: manifest.generation,
        expectedRevision: manifest.currentRevision,
        expectedDigest: sourceDescriptorDigest(createDescriptor(
          await fsp.realpath(brainDir),
          manifest,
        )),
      } : { expectedSourceAbsent: true }
    : null;
  let result;
  let performedRewrite = false;
  if (streamingSnapshot || (rewrite && !streamCompaction)) {
    result = streamingSnapshot
      ? await writer.rewriteMemoryBaseFromSnapshot(brainDir, snapshot, {
        lockRoot, level: gzipLevel, ...capturedSourceExpected,
      })
      : await writer.rewriteMemoryBase(brainDir, {
        nodes: snapshot.fullView.nodes,
        edges: snapshot.fullView.edges,
        summary: snapshot.summary,
      }, { lockRoot, level: gzipLevel });
    performedRewrite = true;
  } else if (capturedHasChanges || summaryRepair) {
    try {
      result = await writer.appendMemoryRevision(brainDir, snapshot.changes, {
        lockRoot,
        summary: snapshot.summary,
        ...(summaryRepair || streamCompaction ? capturedSourceExpected : {}),
      });
    } catch (error) {
      // A busy feeder can accumulate more than the writer's bounded 512 MiB
      // delta transaction before the next save. Retrying the same oversized
      // generation can never work and leaves all later state volatile. Fold
      // the resident graph into a fresh base instead; the generation CAS below
      // keeps mutations that arrive during the rewrite dirty for the next save.
      if (error?.code !== 'result_too_large' || error?.limitKind !== 'delta_commit') throw error;
      streamingSnapshot = canStreamSnapshot;
      snapshot = streamingSnapshot
        ? memory.capturePersistenceStreamingSnapshot()
        : memory.capturePersistenceSnapshot();
      performedRewrite = true;
      logger.warn?.('Memory delta commit exceeded writer limit — rewriting full base', {
        nodes: snapshot.summary.nodeCount,
        edges: snapshot.summary.edgeCount,
      });
      result = streamingSnapshot
        ? await writer.rewriteMemoryBaseFromSnapshot(brainDir, snapshot, {
          lockRoot, level: gzipLevel, ...capturedSourceExpected,
        })
        : await writer.rewriteMemoryBase(brainDir, {
          nodes: snapshot.fullView.nodes,
          edges: snapshot.fullView.edges,
          summary: snapshot.summary,
        }, { lockRoot, level: gzipLevel });
    }
  } else {
    result = { manifest, count: 0 };
  }
  if (streamCompaction && !performedRewrite) {
    // Compact exactly the revision acknowledged by append (or by the initial
    // read for reuse), never a concurrent writer's newer generation. Do not
    // clear dirty markers until both operations succeed; retries remain safe
    // if the append committed but compaction failed.
    const committedResult = result;
    const committedManifest = result.manifest;
    const committedSource = {
      expectedGeneration: committedManifest.generation,
      expectedRevision: committedManifest.currentRevision,
      expectedDigest: sourceDescriptorDigest(createDescriptor(
        await fsp.realpath(brainDir),
        committedManifest,
      )),
    };
    try {
      result = await writer.compactMemoryBase(brainDir, {
        home23Root, lockRoot, level: gzipLevel, ...committedSource,
      });
    } catch (compactionError) {
      compactionError.manifestSummary ??= committedManifest.summary;
      let failure = compactionError;
      let memoryDurable = true;
      // Committed rows that disagree with the summary can never compact:
      // Forrest's base+delta held 65,372 edges against a summary of 65,352,
      // because hydration drops the 20 whose endpoint node is missing. The
      // summary was written from the resident graph, so publish that graph
      // instead, under the same CAS a forced or first write uses. Mutations
      // during the stream abort it retryably; later ones stay dirty.
      if (canStreamSnapshot && isGraphSummaryMismatch(compactionError)) {
        try {
          const resident = memory.capturePersistenceStreamingSnapshot();
          const diagnostics = {
            manifestSummary: committedManifest.summary,
            graphCounts: compactionError.graphCounts,
            residentSummary: resident.summary,
          };
          const refusal = residentRewriteRefusal(resident.summary, compactionError.graphCounts, committedManifest.summary);
          if (refusal) {
            // Fail closed as a state save would: no memoryCommitted, so the
            // orchestrator keeps refusing to save over a graph this depleted.
            memoryDurable = false;
            failure = Object.assign(new Error('resident rewrite refused — catastrophic graph loss'), {
              code: 'catastrophic_graph_loss', retryable: false, refusal, ...diagnostics, cause: compactionError,
            });
          } else {
            logger.warn?.('Memory compaction summary mismatch — rewriting base from resident graph', diagnostics);
            result = await writer.rewriteMemoryBaseFromSnapshot(brainDir, resident, {
              lockRoot, level: gzipLevel, ...committedSource,
            });
            snapshot = resident;
            streamCompaction = false;
            failure = null;
          }
        } catch (rewriteError) {
          failure = rewriteError;
          failure.graphCounts ??= compactionError.graphCounts;
          failure.manifestSummary ??= committedManifest.summary;
        }
      }
      if (failure) {
        // Back off on the error that ended this attempt: when the fallback
        // ran, a retryable resident-rewrite failure (a mutation during its
        // stream, a busy lock) retries on the next save, not in an hour.
        const retryAfter = failure.retryable !== true ? now() + compactionBackoffMs : null;
        if (retryAfter) compactionBackoff.set(backoffKey, { until: retryAfter, error: failure.message });
        if (memoryDurable) {
          // The append (or a clean reuse) is durable at committedManifest, so
          // callers may save state exactly as after an ordinary delta. Dirty
          // markers stay set, matching the failed-compaction contract above.
          failure.memoryCommitted = {
            ...committedResult,
            mode: committedResult.count > 0 ? 'delta' : 'reused',
            cleaned: false,
            persistedGeneration: snapshot.generation,
            persistedChanges: snapshot.changes || null,
            persistedChangesCaptured: Boolean(snapshot.changes),
            maintenanceDebt: {
              reason: 'compaction_failed',
              error: failure.message,
              retryAfter: retryAfter ? new Date(retryAfter).toISOString() : null,
              graphCounts: failure.graphCounts ?? null,
              manifestSummary: committedManifest.summary,
            },
          };
        }
        throw failure;
      }
    }
    performedRewrite = true;
  }
  const committed = Boolean(result?.manifest && (performedRewrite || result.count > 0 || summaryRepair));
  const cleaned = committed && ((performedRewrite && !streamCompaction && !canonicalResidentRewrite) || capturedHasChanges)
    ? memory.markPersistenceCleanIfGeneration(snapshot.generation)
    : false;
  if (performedRewrite && result?.manifest) {
    compactionBackoff.delete(backoffKey);
    scheduleSourceRetirement({ brainDir, home23Root, lockRoot, retire, schedule, logger });
    scheduleAnnRebuild({ brainDir, home23Root, rebuildAnn, schedule, logger });
  }
  return {
    ...result,
    mode: performedRewrite ? 'full' : (result.count > 0 ? 'delta' : (summaryRepair ? 'summary-repair' : 'reused')),
    cleaned,
    persistedGeneration: snapshot.generation,
    persistedChanges: snapshot.changes || null,
    persistedChangesCaptured: Boolean(snapshot.changes),
    ...(deferredDebt && !performedRewrite && { maintenanceDebt: deferredDebt }),
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
