/**
 * HOME23 PATCH — read Home23/COSMO memory sidecars for live brain directories.
 *
 * Home23 keeps state.json.gz small and stores memory.nodes / memory.edges in
 * gzipped JSONL sidecars. This module hydrates query-time state read-only and
 * streams records one line at a time so large brains do not hit V8's max string
 * size while loading.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { openCosmoMemorySource } = require('./memory-source-adapter');
const {
  MATCH_OUTCOME,
  SOURCE_HEALTH,
  createEvidence,
  rewriteMemoryBase,
} = require('../../shared/memory-source');

const NODES_FILE = 'memory-nodes.jsonl.gz';
const EDGES_FILE = 'memory-edges.jsonl.gz';
const SNAPSHOT_FILE = 'brain-snapshot.json';
const DEFAULT_LOCK_ROOT = path.resolve(__dirname, '..', '..', 'runtime', 'brain-source-locks');

function typedArrayToPlain(_key, candidate) {
  return ArrayBuffer.isView(candidate) && !(candidate instanceof DataView)
    ? Array.from(candidate)
    : candidate;
}

function jsonCapture(value) {
  const encoded = JSON.stringify(value, typedArrayToPlain);
  if (encoded === undefined) throw new TypeError('research state must be JSON serializable');
  return JSON.parse(encoded);
}

/**
 * Capture ONE record with the exact semantics the legacy whole-graph
 * JSON.stringify round-trip gave array elements: undefined / function /
 * symbol slots become null, typed arrays become plain arrays, toJSON
 * applies, and the result shares no references with the live record.
 * Keeping the round-trip per record bounds peak single-string size by the
 * largest record instead of the whole graph.
 */
function jsonCaptureRecord(record) {
  const encoded = JSON.stringify(record, typedArrayToPlain);
  return encoded === undefined ? null : JSON.parse(encoded);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  const pending = [value];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    for (const child of Object.values(current)) {
      if (child && typeof child === 'object') pending.push(child);
    }
    Object.freeze(current);
  }
  return value;
}

/**
 * Capture a research graph without ever serializing it as ONE string.
 *
 * The legacy implementation JSON.stringify'd the entire graph (nodes +
 * edges + embeddings) as a single V8 string — the exact ceiling the
 * sidecars were built to avoid, surviving at capture time. Records are now
 * round-tripped one at a time (identical normalization semantics) and only
 * the graph's scalar shell is captured whole, so peak single-string size is
 * bounded by the largest record, never the graph.
 *
 * The capture stays fully synchronous and still returns a deep-frozen,
 * plain-JSON copy that shares NO references with the live graph. Passing
 * exportGraph() output through uncopied is not safe: its records share
 * nested references (embeddings) with live nodes, so mutation during async
 * writes would bleed into the committed generation, deepFreeze would freeze
 * live engine internals (Object.freeze throws on a non-empty typed array),
 * and the manifest writer's own per-record clone lacks the typed-array
 * replacer (a Float32Array embedding would corrupt to {"0":...}).
 */
function normalizeResearchGraph(memory) {
  const graph = typeof memory?.exportGraph === 'function' ? memory.exportGraph() : memory;
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)
      || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new TypeError('research memory must contain node and edge arrays');
  }
  if (graph.clusters !== undefined && !Array.isArray(graph.clusters)) {
    throw new TypeError('research memory clusters must be an array when present');
  }
  // Scalar shell first — null placeholders keep the original key order so
  // a degraded inline save serializes byte-identically to the legacy
  // capture — then the three record arrays, one record at a time.
  // Array.from (not .map) so sparse-array holes become null exactly like a
  // whole-array JSON.stringify emitted them.
  const shell = Object.create(null);
  for (const [key, value] of Object.entries(graph)) {
    shell[key] = (key === 'nodes' || key === 'edges' || key === 'clusters') ? null : value;
  }
  const captured = jsonCapture(shell);
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) {
    throw new TypeError('research memory must contain node and edge arrays');
  }
  captured.nodes = Array.from(graph.nodes, jsonCaptureRecord);
  captured.edges = Array.from(graph.edges, jsonCaptureRecord);
  captured.clusters = Array.isArray(graph.clusters)
    ? Array.from(graph.clusters, jsonCaptureRecord)
    : [];
  return deepFreeze(captured);
}

/**
 * Capture one research state generation without a full-state stringify.
 * The non-memory fields (cycle counters, journal tail, goal/coordinator
 * exports) are small and still round-trip as one object; the memory graph
 * streams through per-record capture. Peak single-string size during a
 * save is therefore bounded by the SHELL, not the graph.
 */
function captureResearchState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('research state object required');
  }
  // Null placeholder keeps `memory` at its original key position so the
  // persisted shell's key order matches the legacy full capture.
  const rest = Object.create(null);
  for (const [key, value] of Object.entries(state)) {
    rest[key] = key === 'memory' ? null : value;
  }
  const captured = jsonCapture(rest);
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) {
    throw new TypeError('research state object required');
  }
  captured.memory = normalizeResearchGraph(state.memory);
  return deepFreeze(captured);
}

function researchSummary(memory) {
  return Object.freeze({
    nodeCount: memory.nodes.length,
    edgeCount: memory.edges.length,
    clusterCount: memory.clusters.length,
  });
}

function researchEvidence(manifest, summary) {
  return deepFreeze(createEvidence({
    route: 'research-memory-persistence',
    implementation: 'manifest-v1',
    baseRevision: manifest.baseRevision,
    baseFile: manifest.activeBase.nodes.file,
    deltaRevision: manifest.currentRevision,
    deltaEpoch: manifest.activeDeltaEpoch,
    deltaApplied: manifest.activeDelta.count,
    annBuiltFromRevision: manifest.ann?.builtFromRevision,
    annFresh: manifest.ann?.builtFromRevision === manifest.currentRevision,
    authoritativeTotals: { nodes: summary.nodeCount, edges: summary.edgeCount },
    returnedTotals: { nodes: summary.nodeCount, edges: summary.edgeCount },
    completeCoverage: true,
    sourceHealth: SOURCE_HEALTH.HEALTHY,
    matchOutcome: summary.nodeCount > 0 || summary.edgeCount > 0
      ? MATCH_OUTCOME.MATCHES
      : MATCH_OUTCOME.CORPUS_EMPTY,
    freshness: 'known',
  }));
}

function degradedResearchEvidence(summary, error) {
  return deepFreeze(createEvidence({
    route: 'research-memory-persistence',
    implementation: 'inline-recovery',
    authoritativeTotals: { nodes: summary.nodeCount, edges: summary.edgeCount },
    returnedTotals: { nodes: summary.nodeCount, edges: summary.edgeCount },
    completeCoverage: true,
    sourceHealth: SOURCE_HEALTH.DEGRADED,
    matchOutcome: summary.nodeCount > 0 || summary.edgeCount > 0
      ? MATCH_OUTCOME.MATCHES
      : MATCH_OUTCOME.CORPUS_EMPTY,
    freshness: 'unknown',
    diagnostics: [{
      code: error?.code || 'manifest_persistence_failed',
      message: String(error?.message || 'research memory manifest persistence failed'),
    }],
  }));
}

function memoryShell(memory, summary) {
  const shell = {};
  for (const [key, value] of Object.entries(memory)) {
    if (key === 'nodes' || key === 'edges' || key === 'clusters') continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) shell[key] = value;
  }
  return deepFreeze({
    ...shell,
    nodes: [],
    edges: [],
    clusters: [],
    ...summary,
  });
}

async function persistCapturedResearchMemory(runDir, capturedMemory, options = {}) {
  const lockRoot = options.lockRoot || DEFAULT_LOCK_ROOT;
  await fs.promises.mkdir(runDir, { recursive: true });
  await fs.promises.mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const summary = researchSummary(capturedMemory);
  const committed = await rewriteMemoryBase(runDir, {
    nodes: capturedMemory.nodes,
    edges: capturedMemory.edges,
    summary,
  }, {
    ...(options.writerOptions || {}),
    lockRoot,
  });
  const manifest = committed.manifest;
  if (!Number.isSafeInteger(manifest?.baseRevision)
      || !Number.isSafeInteger(manifest?.currentRevision)) {
    throw new Error('research memory manifest did not commit numeric revisions');
  }
  return Object.freeze({
    manifest,
    revision: manifest.currentRevision,
    summary,
    evidence: researchEvidence(manifest, summary),
    capturedMemory,
  });
}

/**
 * Capture a research graph synchronously, then publish its immutable manifest
 * generation. The capture deliberately happens before this async function's
 * first await so a writer wait cannot blend two live graph generations.
 */
async function persistResearchMemoryRevision(runDir, memory, options = {}) {
  const capturedMemory = normalizeResearchGraph(memory);
  return persistCapturedResearchMemory(runDir, capturedMemory, options);
}

/**
 * Persist one captured state generation. A failed manifest commit falls back
 * to the complete captured inline graph; an empty shell is never written until
 * the manifest is durable.
 */
async function persistResearchState(runDir, state, options = {}) {
  const capturedState = captureResearchState(state);
  const capturedMemory = capturedState.memory;
  const summary = researchSummary(capturedMemory);
  if (typeof options.saveState !== 'function') {
    throw new TypeError('research state save callback required');
  }

  let committed;
  try {
    committed = await persistCapturedResearchMemory(runDir, capturedMemory, options);
  } catch (error) {
    const evidence = degradedResearchEvidence(summary, error);
    const recoverableState = deepFreeze({
      ...capturedState,
      memory: capturedMemory,
      memorySource: 'inline',
      memorySourceRevision: null,
      memorySourceEvidence: evidence,
    });
    const saveResult = await options.saveState(recoverableState);
    options.logger?.warn?.('Research memory manifest persistence degraded to inline state', {
      code: error?.code || 'manifest_persistence_failed',
      error: error?.message || String(error),
      nodes: summary.nodeCount,
      edges: summary.edgeCount,
    });
    return Object.freeze({
      degraded: true,
      manifest: null,
      revision: null,
      evidence,
      saveResult,
      error,
    });
  }

  const shellState = deepFreeze({
    ...capturedState,
    memory: memoryShell(capturedMemory, summary),
    memorySource: 'manifest',
    memorySourceRevision: committed.revision,
    memorySourceEvidence: committed.evidence,
  });
  const saveResult = await options.saveState(shellState);
  return Object.freeze({
    degraded: false,
    manifest: committed.manifest,
    revision: committed.revision,
    evidence: committed.evidence,
    saveResult,
  });
}

function nodesPath(brainDir) {
  return path.join(brainDir, NODES_FILE);
}

function edgesPath(brainDir) {
  return path.join(brainDir, EDGES_FILE);
}

function snapshotPath(brainDir) {
  return path.join(brainDir, SNAPSHOT_FILE);
}

function sidecarsExist(brainDir) {
  return fs.existsSync(nodesPath(brainDir)) && fs.existsSync(edgesPath(brainDir));
}

function readBrainSnapshot(brainDir) {
  try {
    return JSON.parse(fs.readFileSync(snapshotPath(brainDir), 'utf8'));
  } catch {
    return null;
  }
}

async function readJsonlGz(filePath, onRecord) {
  if (!fs.existsSync(filePath)) {
    return { count: 0, parseErrors: 0 };
  }

  const source = fs.createReadStream(filePath);
  const gunzip = zlib.createGunzip();
  const rl = readline.createInterface({ input: source.pipe(gunzip) });

  let count = 0;
  let parseErrors = 0;

  for await (const line of rl) {
    if (!line) continue;
    try {
      onRecord(JSON.parse(line), count);
      count++;
    } catch {
      parseErrors++;
    }
  }

  return { count, parseErrors };
}

async function readMemorySidecars(brainDir, { onNode, onEdge }) {
  const nodes = await readJsonlGz(nodesPath(brainDir), onNode);
  const edges = await readJsonlGz(edgesPath(brainDir), onEdge);
  return { nodes, edges };
}

async function hydrateStateMemory(brainDir, state, options = {}) {
  const logger = options.logger || console;
  const hydratedState = state || {};
  if (!hydratedState.memory) hydratedState.memory = {};

  const inlineNodes = Array.isArray(hydratedState.memory.nodes) ? hydratedState.memory.nodes : [];
  const inlineEdges = Array.isArray(hydratedState.memory.edges) ? hydratedState.memory.edges : [];
  const snapshot = readBrainSnapshot(brainDir);

  if (!sidecarsExist(brainDir) && !fs.existsSync(path.join(brainDir, 'memory-manifest.json'))) {
    return {
      state: hydratedState,
      hydrated: false,
      source: 'inline',
      nodes: inlineNodes.length,
      edges: inlineEdges.length,
      snapshot
    };
  }

  if (inlineNodes.length > 0 && inlineEdges.length > 0) {
    return {
      state: hydratedState,
      hydrated: false,
      source: 'inline',
      nodes: inlineNodes.length,
      edges: inlineEdges.length,
      snapshot
    };
  }

  const nodes = inlineNodes.length > 0 ? inlineNodes : [];
  const edges = inlineEdges.length > 0 ? inlineEdges : [];
  let sidecarCounts = { nodes: { count: 0, parseErrors: 0 }, edges: { count: 0, parseErrors: 0 } };
  let source = null;
  try {
    source = await openCosmoMemorySource(brainDir, options);
    if (inlineNodes.length === 0) {
      for await (const rec of source.iterateNodes({ signal: options.signal })) nodes.push(rec);
    }
    if (inlineEdges.length === 0) {
      for await (const rec of source.iterateEdges({ signal: options.signal })) edges.push(rec);
    }
    sidecarCounts = {
      nodes: { count: nodes.length, parseErrors: 0 },
      edges: { count: edges.length, parseErrors: 0 },
    };
  } finally {
    await source?.close?.().catch(() => {});
  }

  hydratedState.memory.nodes = nodes;
  hydratedState.memory.edges = edges;
  hydratedState.memorySource = 'sidecar';

  const expectedNodes = Number(snapshot?.nodeCount || snapshot?.nodes?.count || 0);
  if (expectedNodes >= 100 && nodes.length === 0) {
    throw new Error(`Memory sidecar hydration failed: snapshot expects ${expectedNodes} nodes but loaded 0`);
  }

  if (sidecarCounts.nodes.parseErrors || sidecarCounts.edges.parseErrors) {
    logger.warn?.('[MemorySidecar] Parse errors while hydrating brain', {
      brainDir,
      nodeParseErrors: sidecarCounts.nodes.parseErrors,
      edgeParseErrors: sidecarCounts.edges.parseErrors
    });
  }

  return {
    state: hydratedState,
    hydrated: true,
    source: fs.existsSync(path.join(brainDir, 'memory-manifest.json')) ? 'manifest' : 'sidecar',
    nodes: nodes.length,
    edges: edges.length,
    snapshot,
    sidecarCounts
  };
}

module.exports = {
  NODES_FILE,
  EDGES_FILE,
  SNAPSHOT_FILE,
  nodesPath,
  edgesPath,
  snapshotPath,
  sidecarsExist,
  readBrainSnapshot,
  readJsonlGz,
  readMemorySidecars,
  hydrateStateMemory,
  persistResearchMemoryRevision,
  persistResearchState,
};
