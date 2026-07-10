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

const NODES_FILE = 'memory-nodes.jsonl.gz';
const EDGES_FILE = 'memory-edges.jsonl.gz';
const SNAPSHOT_FILE = 'brain-snapshot.json';

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
  hydrateStateMemory
};
