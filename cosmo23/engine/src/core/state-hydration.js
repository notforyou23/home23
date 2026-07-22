/**
 * HOME23 PATCH (Fix 1.1) — orchestrator state hydration + fail-loud guard.
 *
 * saveState() routes through persistResearchState(), which commits the memory
 * graph to an immutable manifest generation (memory-manifest.json + base
 * sidecars) and stores only an EMPTY memory shell inside state.json.gz
 * (state.memorySource === 'manifest'). The orchestrator's loadState() must
 * therefore hydrate memory.nodes/memory.edges back from the manifest before
 * importing them — otherwise the first restart after a manifest-path save
 * boots with 0 nodes and silently overwrites the real brain on its next save.
 *
 * Hydration goes through the SAME streaming reader the query side uses
 * (lib/memory-sidecar.hydrateStateMemory → shared/memory-source), never a
 * single-string JSON parse of sidecar files.
 *
 * Fail-loud contract: if brain-snapshot.json or the manifest totals say the
 * brain has nodes > 0 but the loaded/hydrated graph has 0 nodes, throw
 * Error('BRAIN_LOAD_EMPTY: ...') — the engine must NOT continue as a fresh
 * brain.
 */

const fs = require('fs');
const path = require('path');

const { hydrateStateMemory } = require('../../../lib/memory-sidecar');

const SNAPSHOT_FILE = 'brain-snapshot.json';
const MANIFEST_FILE = 'memory-manifest.json';

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Node count claimed by a brain-snapshot.json sidecar.
 * Primary shape (interface contract #2): { nodes: number, edges: number,
 * savedAt: ISO string, generation: number|null }. Legacy Home23 snapshots
 * used { nodeCount, edgeCount } and some variants { nodes: { count } }.
 */
function snapshotNodeCount(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 0;
  if (typeof snapshot.nodes === 'number') return snapshot.nodes;
  if (typeof snapshot.nodes?.count === 'number') return snapshot.nodes.count;
  if (typeof snapshot.nodeCount === 'number') return snapshot.nodeCount;
  return 0;
}

/**
 * Best available authoritative node count for the guard: brain-snapshot.json,
 * memory-manifest.json summary, and the counters persistResearchState leaves
 * on the shell state (memory.nodeCount + memorySourceEvidence totals).
 */
function expectedNodeCount(logsDir, state) {
  const candidates = [
    snapshotNodeCount(readJsonFile(path.join(logsDir, SNAPSHOT_FILE))),
  ];
  const manifest = readJsonFile(path.join(logsDir, MANIFEST_FILE));
  if (typeof manifest?.summary?.nodeCount === 'number') {
    candidates.push(manifest.summary.nodeCount);
  }
  if (typeof state?.memory?.nodeCount === 'number') {
    candidates.push(state.memory.nodeCount);
  }
  const authoritative = state?.memorySourceEvidence?.authoritativeTotals?.nodes;
  if (typeof authoritative === 'number') {
    candidates.push(authoritative);
  }
  return Math.max(0, ...candidates.filter((value) => Number.isFinite(value)));
}

/**
 * The streaming reader normalizes node ids to strings, but manifest edge
 * records come back with their raw endpoints (numeric for numeric-id runs).
 * The orchestrator's edge import checks this.memory.nodes.has(edge.source),
 * which is a Map keyed by the hydrated (string) node ids — align edge
 * endpoints so a hydrated brain does not silently drop every edge.
 */
function normalizeHydratedEdges(memory) {
  if (!Array.isArray(memory?.edges)) return;
  memory.edges = memory.edges.map((edge) => {
    if (!edge || typeof edge !== 'object') return edge;
    const source = edge.source ?? edge.from;
    const target = edge.target ?? edge.to;
    if (source === null || source === undefined
        || target === null || target === undefined) {
      return edge;
    }
    return { ...edge, source: String(source), target: String(target) };
  });
}

/**
 * Hydrate a freshly loaded orchestrator state in place.
 *
 * - No manifest/sidecars on disk → returns the state untouched (legacy
 *   inline behavior, including genuinely fresh brains).
 * - Manifest/sidecars present and inline arrays empty → streams nodes/edges
 *   back into state.memory and updates state.memorySource.
 * - Authoritative totals (snapshot/manifest/shell counters) say nodes > 0
 *   but the resulting graph has 0 nodes → throws BRAIN_LOAD_EMPTY.
 *
 * @param {string} logsDir directory containing state.json.gz + manifest files
 * @param {object} state parsed state object from StateCompression.loadCompressed
 * @param {object} options { logger }
 * @returns {Promise<{state: object, hydrated: boolean, source: string,
 *                    nodes: number, edges: number, expectedNodes: number}>}
 */
async function hydrateOrchestratorState(logsDir, state, options = {}) {
  const logger = options.logger || console;
  const hydratedState = state || {};
  let hydration = null;
  let hydrationError = null;

  try {
    hydration = await hydrateStateMemory(logsDir, hydratedState, { logger });
    if (hydration.hydrated) {
      normalizeHydratedEdges(hydratedState.memory);
      // persistResearchState stamps memorySource: 'manifest' on the shell;
      // keep the marker truthful about where the loaded graph came from.
      hydratedState.memorySource = hydration.source;
    }
  } catch (error) {
    hydrationError = error;
    logger.warn?.('⚠️ Memory hydration from manifest/sidecars failed', {
      logsDir,
      error: error.message,
    });
  }

  const loadedNodes = Array.isArray(hydratedState?.memory?.nodes)
    ? hydratedState.memory.nodes.length
    : 0;
  const loadedEdges = Array.isArray(hydratedState?.memory?.edges)
    ? hydratedState.memory.edges.length
    : 0;
  const expectedNodes = expectedNodeCount(logsDir, hydratedState);

  if (expectedNodes > 0 && loadedNodes === 0) {
    const detail = hydrationError
      ? ` Hydration error: ${hydrationError.message}.`
      : '';
    const error = new Error(
      `BRAIN_LOAD_EMPTY: brain-snapshot/manifest for ${logsDir} expects `
      + `${expectedNodes} nodes but the loaded/hydrated graph has 0. Refusing `
      + 'to boot as a fresh brain — the manifest generation and memory '
      + `sidecars are the authoritative data. Do NOT restart until this is investigated.${detail}`,
    );
    // The halt contract rides on the code property; the message prefix is a
    // human-readable fallback that message-wrapping intermediaries may lose.
    error.code = 'BRAIN_LOAD_EMPTY';
    throw error;
  }

  return {
    state: hydratedState,
    hydrated: Boolean(hydration?.hydrated),
    source: hydration?.source || 'inline',
    nodes: loadedNodes,
    edges: loadedEdges,
    expectedNodes,
  };
}

module.exports = {
  SNAPSHOT_FILE,
  MANIFEST_FILE,
  hydrateOrchestratorState,
  expectedNodeCount,
  snapshotNodeCount,
};
