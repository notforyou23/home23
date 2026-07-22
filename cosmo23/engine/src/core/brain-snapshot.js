/**
 * HOME23 PATCH — brain-snapshot sidecar + every-cycle save-safety guard.
 *
 * Ported from the Home23 engine donors (engine/src/core/brain-snapshot.js and
 * engine/src/core/brain-persistence-guard.js). Two jobs:
 *
 * 1. brain-snapshot.json — a tiny, always-parseable record of the last
 *    known-good node/edge counts, written into the orchestrator's logsDir
 *    (the same directory as state.json.gz) after every successful save.
 *    Shape: { nodes, edges, savedAt, generation } plus nodeCount/edgeCount
 *    compatibility aliases so the existing lib/memory-sidecar.js hydration
 *    guard (which reads snapshot.nodeCount) keeps working.
 *
 * 2. resolveKnownGoodNodeCount + evaluateSaveSafety — the save guard.
 *    The old orchestrator guard only ran at cycleCount <= 1 and read the
 *    uncompressed state.json while saves write state.json.gz, so its
 *    readFile always threw and every save passed — dead code. This guard
 *    runs on EVERY save and never trusts a giant state.json.gz first:
 *    brain-snapshot.json -> memory-manifest.json -> streamed
 *    memory-nodes.jsonl.gz count -> legacy inline state as last resort.
 *
 * Threshold (ported verbatim from the donor evaluateSaveSafety): refuse
 * when existingNodes > 100 and currentNodes < existingNodes * 0.5.
 */

const fs = require('fs');
const path = require('path');
const {
  readJsonlGz,
  nodesPath,
  sidecarsExist,
} = require('../../../lib/memory-sidecar');
const { StateCompression } = require('./state-compression');

const SNAPSHOT_FILE = 'brain-snapshot.json';

function snapshotPath(brainDir) {
  return path.join(brainDir, SNAPSHOT_FILE);
}

/**
 * Write a snapshot atomically (tmp + rename). Best-effort — a sidecar write
 * failure must never block the state.json.gz save that just succeeded.
 */
function writeSnapshot(brainDir, snap) {
  try {
    const p = snapshotPath(brainDir);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2));
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the last snapshot. Returns null if missing or unparseable.
 */
function readSnapshot(brainDir) {
  try {
    const p = snapshotPath(brainDir);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Contract shape stores counts as `nodes`/`edges`; older Home23-style
 * snapshots use `nodeCount`/`edgeCount`. Accept both. Counts are clamped to
 * safe non-negative integers — a corrupt-but-parseable snapshot carrying a
 * negative or fractional count must not become the guard baseline. Returns
 * null when the snapshot carries no usable count, so resolution falls
 * through to the manifest tier.
 */
function snapshotNodeCount(snapshot) {
  if (Number.isSafeInteger(snapshot?.nodes) && snapshot.nodes >= 0) return snapshot.nodes;
  if (Number.isSafeInteger(snapshot?.nodeCount) && snapshot.nodeCount >= 0) return snapshot.nodeCount;
  return null;
}

async function safeReadManifest(brainDir) {
  try {
    const { readManifest } = require('../../../../shared/memory-source');
    return await readManifest(brainDir);
  } catch {
    return null;
  }
}

/**
 * Stream-count unique node ids in memory-nodes.jsonl.gz. This tier only
 * matters for legacy-resident layouts: manifest-backed runs name their
 * bases memory-nodes.base-N.jsonl.gz (this path does not exist there), and
 * with delta compaction armed (Fix 3.4) a base-only count would undercount
 * anyway — the manifest tier ABOVE this one carries the authoritative
 * summary totals, refreshed by every delta append.
 */
async function countSidecarNodes(brainDir) {
  const nodeIds = new Set();
  let anonymousCount = 0;
  await readJsonlGz(nodesPath(brainDir), (node) => {
    if (node?.id !== undefined) nodeIds.add(String(node.id));
    else anonymousCount += 1;
  });
  return nodeIds.size + anonymousCount;
}

/**
 * Resolve the last-known-good node count without trusting state.json.gz
 * first. Order: brain-snapshot.json -> memory-manifest.json -> streamed
 * sidecar count -> legacy inline state.json(.gz). A fresh run with none of
 * these resolves to { count: 0, source: 'fresh' } and the guard passes.
 */
async function resolveKnownGoodNodeCount(brainDir, statePath, options = {}) {
  const snapshotReader = options.readSnapshot || readSnapshot;
  const stateLoader = options.loadCompressed || StateCompression.loadCompressed;
  const sidecarCounter = options.countSidecarNodes || countSidecarNodes;
  const sidecarExists = options.sidecarsExist || sidecarsExist;
  const manifestReader = options.readManifest || safeReadManifest;

  const snapshot = snapshotReader(brainDir);
  const snapshotCount = snapshotNodeCount(snapshot);
  if (snapshotCount !== null) {
    return { count: snapshotCount, source: 'snapshot' };
  }

  const manifest = await manifestReader(brainDir);
  if (Number.isFinite(manifest?.summary?.nodeCount)) {
    return { count: manifest.summary.nodeCount, source: 'memory-manifest' };
  }

  if (sidecarExists(brainDir)) {
    const sidecarCount = await sidecarCounter(brainDir);
    if (Number.isFinite(sidecarCount) && sidecarCount > 0) {
      return { count: sidecarCount, source: 'memory-sidecar' };
    }
  }

  // Task 1's StateCompression.loadCompressed no longer throws on a missing
  // state file — it returns a structured empty state and delegates empty-brain
  // refusal to this guard. Classify "no state file at all" as a fresh run
  // BEFORE loading, so 'fresh' stays distinguishable from an on-disk state
  // that genuinely holds zero nodes.
  if (!fs.existsSync(statePath) && !fs.existsSync(statePath + '.gz')) {
    return { count: 0, source: 'fresh' };
  }

  // A state file EXISTS past this point (pre-check above). If it cannot be
  // read or parsed (corrupt .gz with an unparseable uncompressed fallback,
  // EACCES/EIO), let the error propagate — the orchestrator's guard-resolution
  // catch fails closed with a 'persistence_guard_failed' refusal. Mapping
  // this to 'fresh' (count 0) would let the guard bless an overwrite of a
  // real brain, the exact refuse-rather-than-destroy scenario.
  const existingState = await stateLoader(statePath);
  const inlineCount = existingState?.memory?.nodes?.length || 0;
  if (inlineCount > 0) {
    return { count: inlineCount, source: 'state-file' };
  }
  if (Number.isFinite(existingState?.memory?.nodeCount)) {
    // Manifest-backed shell: the nodes array is intentionally empty but the
    // authoritative summary counts are spread into memory (memoryShell in
    // lib/memory-sidecar.js). Trusting nodes.length here would fail open.
    return { count: existingState.memory.nodeCount, source: 'state-file-shell' };
  }
  return { count: 0, source: 'state-file' };
}

/**
 * Donor thresholds, ported exactly: refuse when the on-disk brain had more
 * than 100 nodes and the in-memory graph now holds less than half of them.
 */
function evaluateSaveSafety({ currentNodes, existingNodes, source, cycle, dropFloor = 0.5 }) {
  if (existingNodes > 100 && currentNodes < existingNodes * dropFloor) {
    return {
      ok: false,
      reason: 'catastrophic_node_drop',
      currentNodes,
      existingNodes,
      source,
      cycle,
      dropPercent: Number(((1 - currentNodes / existingNodes) * 100).toFixed(1)),
    };
  }

  return {
    ok: true,
    currentNodes,
    existingNodes,
    source,
    cycle,
  };
}

module.exports = {
  SNAPSHOT_FILE,
  snapshotPath,
  writeSnapshot,
  readSnapshot,
  snapshotNodeCount,
  countSidecarNodes,
  resolveKnownGoodNodeCount,
  evaluateSaveSafety,
};
