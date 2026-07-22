# cosmo23 Fix 1.2 — brain-snapshot sidecar + every-cycle save-safety guard in Orchestrator.saveState

## Target current state

DEAD GUARD (only save protection in cosmo23, and it can never fire after cycle 1 — or at all on gz runs):

/Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js:8071 `const statePath = path.join(this.logsDir, 'state.json');`
orchestrator.js:8081 `if (totalNodes < 10 && nodesWithEmbeddings < 10 && this.cycleCount <= 1) {` — gated to cycles 0-1 only.
orchestrator.js:8084 `const existingData = await fs.readFile(statePath, 'utf8');` — reads UNCOMPRESSED state.json, but the save path (orchestrator.js:8107-8110) goes through `StateCompression.saveCompressed(statePath, ..., { compress: true })` which writes `filepath + '.gz'` (/Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/state-compression.js:51 `await fs.writeFile(filepath + '.gz', compressed);`). So on every real run readFile throws ENOENT, the empty catch at orchestrator.js:8096-8098 ("If we can't read existing state, proceed with save") swallows it, and the save proceeds. Dead code; zero protection.
orchestrator.js:8094 `return; // Don't save, preserve the merged state` — bare undefined return; saveState has NO structured result anywhere. Bottom catch (orchestrator.js:8140-8142) logs 'Save failed' and also returns undefined, so callers (incl. graceful-shutdown-handler.js:252 `await this.orchestrator.saveState();`) cannot distinguish saved/refused/failed.

NO SNAPSHOT SIDECAR IS EVER WRITTEN: cosmo23 only READS brain-snapshot.json — /Users/jtr/_JTR23_/release/home23/cosmo23/lib/memory-sidecar.js:24 `const SNAPSHOT_FILE = 'brain-snapshot.json';`, :251-257 `readBrainSnapshot()`, and the hydration guard at :345-348 (`const expectedNodes = Number(snapshot?.nodeCount || snapshot?.nodes?.count || 0);`) — but nothing in cosmo23 engine produces the file, so that hydration guard is inert too. `grep -rn "brain-snapshot" cosmo23 --include='*.js'` matches only lib/memory-sidecar.js.

Also relevant: state.json.gz written by cosmo23 is usually a manifest-backed SHELL with `memory.nodes = []` but `memory.nodeCount = N` (memoryShell at cosmo23/lib/memory-sidecar.js:124-137 spreads the summary), so even a "fixed" inline-length check against state.json.gz would fail open — the known-good count must come from snapshot/manifest/sidecars first. saveState callers: orchestrator.js:1180, 1744, 1794, 3210, 3752, 6028, 9075, 9080 + graceful-shutdown-handler.js:252; all ignore the return value today, so returning a structured result is non-breaking.

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/brain-snapshot.js

NEW FILE. Port of home23 donors engine/src/core/brain-snapshot.js + engine/src/core/brain-persistence-guard.js, merged into one cosmo23 module (CommonJS, no TS). Differences from donors, all deliberate: (1) snapshot written in the contract #2 shape { nodes, edges, savedAt, generation } PLUS nodeCount/edgeCount compatibility aliases so the existing hydration guard in cosmo23/lib/memory-sidecar.js:345 (`snapshot?.nodeCount`) starts working; (2) refusal reason renamed to 'catastrophic_node_drop' per contract #1 (donor said 'catastrophic_node_loss'); (3) resolution order is snapshot -> manifest -> streamed sidecar count -> legacy inline state per the task spec (donor was manifest-first; in cosmo23 both are written by the same save so they agree); (4) no delta counting — cosmo23's persistResearchState full-rewrites the base every save (rewriteMemoryBase), unlike home23's delta chain; (5) adds a 'state-file-shell' source that reads memory.nodeCount from manifest-backed shell states whose nodes array is intentionally empty. evaluateSaveSafety thresholds are the donor's verbatim: refuse iff existingNodes > 100 && currentNodes < existingNodes * 0.5 (strict <, dropFloor default 0.5).

### Code
```js
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
 * snapshots use `nodeCount`/`edgeCount`. Accept both. Returns null when the
 * snapshot carries no usable count.
 */
function snapshotNodeCount(snapshot) {
  if (Number.isFinite(snapshot?.nodes)) return snapshot.nodes;
  if (Number.isFinite(snapshot?.nodeCount)) return snapshot.nodeCount;
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
 * Stream-count unique node ids in memory-nodes.jsonl.gz. cosmo23 rewrites
 * the base sidecar in full on every save (no delta files), so the base
 * count is authoritative.
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

  let existingState = null;
  try {
    existingState = await stateLoader(statePath);
  } catch {
    return { count: 0, source: 'fresh' };
  }
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

```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

Add the brain-snapshot import next to the existing memory-sidecar import (line 29). Verified: no existing identifiers named writeSnapshot / resolveKnownGoodNodeCount / evaluateSaveSafety anywhere in this file.

### Anchor
```
const { persistResearchState } = require('../../../lib/memory-sidecar');
```

### Code
```js
const { persistResearchState } = require('../../../lib/memory-sidecar');
const { writeSnapshot, resolveKnownGoodNodeCount, evaluateSaveSafety } = require('./brain-snapshot');
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

Replace the body of saveState() from `const statePath = ...` (line 8071) through the method's closing brace (line 8143). This (a) DELETES the dead cycles-0-1 guard, (b) resolves the known-good count and evaluates save safety on EVERY save BEFORE persistResearchState (so a refused save cannot rewrite the sidecar base with a shrunken graph), (c) writes brain-snapshot.json after every successful save, and (d) returns the contract #1 structured result from every path, also mirrored to this.lastSaveResult (new property, no collisions). NOTE for exact-match editing: the anchor below reproduces lines 8071-8143 verbatim; lines 8113 and 8139 in the original are blank lines carrying 6 trailing spaces ('      ') — if the exact match fails, strip/adjust those two whitespace-only lines. The guard-failure path fails CLOSED (refuses the save) exactly like the donor at engine/src/core/orchestrator.js:7348-7361.

### Anchor
```
    const statePath = path.join(this.logsDir, 'state.json');

    try {
      const nodesWithEmbeddings = state.memory?.nodes?.filter(n => n.embedding).length || 0;
      const totalNodes = state.memory?.nodes?.length || 0;

      // SAFEGUARD: Don't overwrite a properly merged state with a smaller state
      // If current state has more nodes than 10 (our merged state), preserve it
      // FIX (Jan 23, 2026): Only apply on cycle 0-1, not after cycles have progressed
      // This was blocking ALL saves on forked/merged brains!
      if (totalNodes < 10 && nodesWithEmbeddings < 10 && this.cycleCount <= 1) {
        // Check if there's an existing state file with more nodes
        try {
          const existingData = await fs.readFile(statePath, 'utf8');
          const existingState = JSON.parse(existingData);
          const existingNodes = existingState.memory?.nodes?.length || 0;

          if (existingNodes > totalNodes) {
            this.logger.warn('Preventing overwrite of merged state (cycle <= 1 only)', {
              currentNodes: totalNodes,
              existingNodes,
              cycle: this.cycleCount
            });
            return; // Don't save, preserve the merged state
          }
        } catch (error) {
          // If we can't read existing state, proceed with save
        }
      }

      // Publish the immutable memory generation before replacing the compressed
      // graph with its small manifest-backed shell. Manifest failure degrades
      // to the complete captured inline state, never a truncated shell.
      const persistence = await persistResearchState(this.logsDir, state, {
        lockRoot: this.config?.memorySource?.lockRoot,
        logger: this.logger,
        saveState: (capturedState) => StateCompression.saveCompressed(statePath, capturedState, {
          compress: true,
          pretty: false  // Compact JSON for better compression
        }),
      });
      const saveResult = persistence.saveResult;
      
      this.logger.info('State saved (GPT-5.2)', {
        cycle: this.cycleCount,
        nodesWithEmbeddings,
        totalNodes,
        memorySource: persistence.degraded ? 'inline' : 'manifest',
        memorySourceRevision: persistence.revision,
        compressed: saveResult.compressed,
        size: `${(saveResult.size / (1024 * 1024)).toFixed(2)}MB`,
        ...(saveResult.ratio && { compressionRatio: saveResult.ratio })
      });

      // Write human-readable progress file
      await this.writeProgressFile(state);

      // Rotate old backups (keep last 5)
      // Run in background to not slow down save
      StateCompression.rotateBackups(this.logsDir, 'state.backup', 5)
        .then(result => {
          if (result.removed > 0) {
            this.logger.info('Rotated old backups', result);
          }
        })
        .catch(error => {
          this.logger.warn('Backup rotation failed', { error: error.message });
        });
      
    } catch (error) {
      this.logger.error('Save failed', { error: error.message });
    }
  }
```

### Code
```js
    const statePath = path.join(this.logsDir, 'state.json');
    const totalNodes = state.memory?.nodes?.length || 0;
    const totalEdges = state.memory?.edges?.length || 0;
    const nodesWithEmbeddings = state.memory?.nodes?.filter(n => n.embedding).length || 0;

    // SAFEGUARD (every save): resolve the last-known-good node count without
    // trusting a giant state.json.gz first, then refuse any save that would
    // wipe out more than half of a >100-node brain. Replaces the dead
    // cycle<=1 guard that read the uncompressed state.json (saves write
    // state.json.gz, so its readFile always threw and every save passed).
    let knownGood;
    try {
      knownGood = await resolveKnownGoodNodeCount(this.logsDir, statePath);
    } catch (error) {
      this.logger.error('🛑 REFUSING STATE SAVE — persistence guard could not establish known-good baseline', {
        error: error.message,
        currentNodes: totalNodes,
        cycle: this.cycleCount
      });
      this.lastSaveResult = {
        saved: false,
        reason: 'persistence_guard_failed',
        error: error.message,
        currentNodes: totalNodes,
        existingNodes: null,
        cycle: this.cycleCount
      };
      return this.lastSaveResult;
    }

    const safety = evaluateSaveSafety({
      currentNodes: totalNodes,
      existingNodes: knownGood.count,
      source: knownGood.source,
      cycle: this.cycleCount
    });
    if (!safety.ok) {
      this.logger.error('🛑 REFUSING STATE SAVE — catastrophic node drop detected', {
        currentNodes: safety.currentNodes,
        existingNodes: safety.existingNodes,
        safeguardSource: safety.source,
        dropPercent: safety.dropPercent,
        cycle: safety.cycle
      });
      this.lastSaveResult = {
        saved: false,
        reason: 'catastrophic_node_drop',
        currentNodes: safety.currentNodes,
        existingNodes: safety.existingNodes,
        dropPercent: safety.dropPercent,
        safeguardSource: safety.source,
        cycle: safety.cycle
      };
      return this.lastSaveResult; // Don't save, preserve the existing brain
    }

    try {
      // Publish the immutable memory generation before replacing the compressed
      // graph with its small manifest-backed shell. Manifest failure degrades
      // to the complete captured inline state, never a truncated shell.
      const persistence = await persistResearchState(this.logsDir, state, {
        lockRoot: this.config?.memorySource?.lockRoot,
        logger: this.logger,
        saveState: (capturedState) => StateCompression.saveCompressed(statePath, capturedState, {
          compress: true,
          pretty: false  // Compact JSON for better compression
        }),
      });
      const saveResult = persistence.saveResult;

      // Stamp the last-known-good sidecar AFTER the successful save. Contract
      // shape { nodes, edges, savedAt, generation }; nodeCount/edgeCount are
      // compatibility aliases for the lib/memory-sidecar.js hydration guard.
      writeSnapshot(this.logsDir, {
        nodes: totalNodes,
        edges: totalEdges,
        savedAt: new Date().toISOString(),
        generation: Number.isSafeInteger(persistence.revision) ? persistence.revision : null,
        nodeCount: totalNodes,
        edgeCount: totalEdges,
        cycle: this.cycleCount
      });

      this.logger.info('State saved (GPT-5.2)', {
        cycle: this.cycleCount,
        nodesWithEmbeddings,
        totalNodes,
        memorySource: persistence.degraded ? 'inline' : 'manifest',
        memorySourceRevision: persistence.revision,
        compressed: saveResult.compressed,
        size: `${(saveResult.size / (1024 * 1024)).toFixed(2)}MB`,
        ...(saveResult.ratio && { compressionRatio: saveResult.ratio })
      });

      // Write human-readable progress file
      await this.writeProgressFile(state);

      // Rotate old backups (keep last 5)
      // Run in background to not slow down save
      StateCompression.rotateBackups(this.logsDir, 'state.backup', 5)
        .then(result => {
          if (result.removed > 0) {
            this.logger.info('Rotated old backups', result);
          }
        })
        .catch(error => {
          this.logger.warn('Backup rotation failed', { error: error.message });
        });

      this.lastSaveResult = {
        saved: true,
        reason: null,
        currentNodes: totalNodes,
        existingNodes: knownGood.count
      };
      return this.lastSaveResult;
    } catch (error) {
      this.logger.error('Save failed', { error: error.message });
      this.lastSaveResult = {
        saved: false,
        reason: `save_error:${error.message}`,
        currentNodes: totalNodes,
        existingNodes: knownGood.count
      };
      return this.lastSaveResult;
    }
  }
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/package.json

Register the new test in the cosmo23 node:test group of the "test" script (contract #7). The anchor string occurs exactly once in package.json (verified with grep -c).

### Anchor
```
tests/cosmo23/research-memory-manifest.test.cjs tests/engine/dashboard/mcp-availability.test.js
```

### Code
```js
tests/cosmo23/research-memory-manifest.test.cjs tests/cosmo23/brain-snapshot-guard.test.cjs tests/engine/dashboard/mcp-availability.test.js
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/package-test-registration.test.cjs

Add the new suite to the registration-enforcement list so the exactly-once registration is enforced going forward (list is at lines 15-57; insert after the brain-operation-worker entry).

### Anchor
```
    'tests/cosmo23/brain-operation-worker.test.cjs',
```

### Code
```js
    'tests/cosmo23/brain-operation-worker.test.cjs',
    'tests/cosmo23/brain-snapshot-guard.test.cjs',
```

## TEST FILE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/brain-snapshot-guard.test.cjs

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  SNAPSHOT_FILE,
  snapshotPath,
  writeSnapshot,
  readSnapshot,
  snapshotNodeCount,
  countSidecarNodes,
  resolveKnownGoodNodeCount,
  evaluateSaveSafety,
} = require('../../cosmo23/engine/src/core/brain-snapshot');
const { Orchestrator } = require('../../cosmo23/engine/src/core/orchestrator');

function makeBrainDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cosmo23-brain-snapshot-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJsonlGz(filePath, records) {
  const lines = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  fs.writeFileSync(filePath, zlib.gzipSync(Buffer.from(lines, 'utf8')));
}

function writeCompressedState(brainDir, stateObject) {
  fs.writeFileSync(
    path.join(brainDir, 'state.json.gz'),
    zlib.gzipSync(Buffer.from(JSON.stringify(stateObject), 'utf8')),
  );
}

function readCompressedState(brainDir) {
  const bytes = fs.readFileSync(path.join(brainDir, 'state.json.gz'));
  return JSON.parse(zlib.gunzipSync(bytes).toString('utf8'));
}

function memoryGraph(label, count) {
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `${label}-n${index + 1}`,
    concept: `${label} concept ${index + 1}`,
    tag: 'research',
    embedding: [index / count, 1 - (index / count)],
    weight: 1,
  }));
  return {
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      source: nodes[index].id,
      target: node.id,
      weight: 0.75,
      type: 'related',
    })),
    clusters: [{ id: `${label}-c1`, size: nodes.length, nodes: nodes.map(({ id }) => id) }],
    nextNodeId: count + 1,
    nextClusterId: 2,
  };
}

function makeOrchestratorFake(runDir, lockRoot, graph, cycleCount, logs) {
  return {
    evaluation: null,
    cycleCount,
    journal: [],
    memory: { exportGraph: () => graph },
    goals: { export: () => [], goals: new Map(), completedGoals: [] },
    roles: { getRoles: () => [] },
    reflection: { export: () => ({}) },
    oscillator: { getStats: () => ({}) },
    stateModulator: { getState: () => ({}) },
    temporal: null,
    coordinator: null,
    agentExecutor: null,
    forkSystem: null,
    topicQueue: null,
    goalCurator: null,
    executiveRing: null,
    guidedMissionPlan: null,
    completionTracker: null,
    planProgressEvents: [],
    lastSummarization: 0,
    reasoningHistory: [],
    webSearchCount: 0,
    goalAllocator: null,
    clusterSync: null,
    clusterCoordinator: null,
    sessionNumber: 0,
    logsDir: runDir,
    logger: {
      info(message, fields) { logs.push({ level: 'info', message, fields }); },
      warn(message, fields) { logs.push({ level: 'warn', message, fields }); },
      error(message, fields) { logs.push({ level: 'error', message, fields }); },
    },
    config: { memorySource: { lockRoot } },
    generateSessionSummary: () => ({ cycleCount }),
    getProgressMarkers: () => [],
    writeProgressFile: async () => {},
  };
}

test('writeSnapshot/readSnapshot round-trip the contract shape atomically in the state dir', (t) => {
  const dir = makeBrainDir(t, 'roundtrip');
  const snap = {
    nodes: 65100,
    edges: 110900,
    savedAt: '2026-07-21T12:00:00.000Z',
    generation: 42,
    nodeCount: 65100,
    edgeCount: 110900,
  };
  assert.equal(writeSnapshot(dir, snap), true);
  assert.equal(path.dirname(snapshotPath(dir)), dir);
  assert.equal(path.basename(snapshotPath(dir)), SNAPSHOT_FILE);
  assert.equal(fs.existsSync(snapshotPath(dir) + '.tmp'), false, 'atomic tmp file must be renamed away');
  assert.deepEqual(readSnapshot(dir), snap);
});

test('readSnapshot returns null for missing or corrupt sidecars', (t) => {
  const dir = makeBrainDir(t, 'corrupt');
  assert.equal(readSnapshot(dir), null);
  fs.writeFileSync(snapshotPath(dir), '{not json');
  assert.equal(readSnapshot(dir), null);
});

test('snapshotNodeCount accepts both the contract shape and legacy nodeCount shape', () => {
  assert.equal(snapshotNodeCount({ nodes: 5, edges: 9 }), 5);
  assert.equal(snapshotNodeCount({ nodeCount: 7, edgeCount: 11 }), 7);
  assert.equal(snapshotNodeCount({}), null);
  assert.equal(snapshotNodeCount(null), null);
});

test('resolveKnownGoodNodeCount prefers brain-snapshot.json over sidecars', async (t) => {
  const dir = makeBrainDir(t, 'precedence');
  writeSnapshot(dir, { nodes: 500, edges: 900, savedAt: new Date().toISOString(), generation: 7 });
  writeJsonlGz(path.join(dir, 'memory-nodes.jsonl.gz'), [{ id: 1 }, { id: 2 }]);
  writeJsonlGz(path.join(dir, 'memory-edges.jsonl.gz'), []);
  const resolved = await resolveKnownGoodNodeCount(dir, path.join(dir, 'state.json'));
  assert.deepEqual({ count: resolved.count, source: resolved.source }, { count: 500, source: 'snapshot' });
});

test('resolveKnownGoodNodeCount accepts legacy nodeCount-shaped snapshots', async (t) => {
  const dir = makeBrainDir(t, 'legacy-snapshot');
  writeSnapshot(dir, { savedAt: new Date().toISOString(), cycle: 12, nodeCount: 321, edgeCount: 654, fileSize: 1000 });
  const resolved = await resolveKnownGoodNodeCount(dir, path.join(dir, 'state.json'));
  assert.deepEqual({ count: resolved.count, source: resolved.source }, { count: 321, source: 'snapshot' });
});

test('resolveKnownGoodNodeCount uses the manifest summary when no snapshot exists', async (t) => {
  const dir = makeBrainDir(t, 'manifest');
  const resolved = await resolveKnownGoodNodeCount(dir, path.join(dir, 'state.json'), {
    readManifest: async () => ({ summary: { nodeCount: 42, edgeCount: 10, clusterCount: 1 } }),
  });
  assert.deepEqual({ count: resolved.count, source: resolved.source }, { count: 42, source: 'memory-manifest' });
});

test('resolveKnownGoodNodeCount streams the node sidecar when snapshot and manifest are missing', async (t) => {
  const dir = makeBrainDir(t, 'sidecar');
  writeJsonlGz(path.join(dir, 'memory-nodes.jsonl.gz'), [
    { id: 'a', concept: 'one' },
    { id: 'b', concept: 'two' },
    { id: 'b', concept: 'duplicate id counted once' },
    { concept: 'anonymous record still counted' },
  ]);
  writeJsonlGz(path.join(dir, 'memory-edges.jsonl.gz'), [{ source: 'a', target: 'b' }]);
  const resolved = await resolveKnownGoodNodeCount(dir, path.join(dir, 'state.json'));
  assert.deepEqual({ count: resolved.count, source: resolved.source }, { count: 3, source: 'memory-sidecar' });
  assert.equal(await countSidecarNodes(dir), 3);
});

test('resolveKnownGoodNodeCount falls back to legacy inline state.json.gz', async (t) => {
  const dir = makeBrainDir(t, 'inline');
  writeCompressedState(dir, { memory: { nodes: [{ id: 1 }, { id: 2 }, { id: 3 }], edges: [] } });
  const resolved = await resolveKnownGoodNodeCount(dir, path.join(dir, 'state.json'));
  assert.deepEqual({ count: resolved.count, source: resolved.source }, { count: 3, source: 'state-file' });
});

test('resolveKnownGoodNodeCount reads shell-state summary counts instead of trusting empty arrays', async (t) => {
  const dir = makeBrainDir(t, 'shell');
  writeCompressedState(dir, {
    memory: { nodes: [], edges: [], clusters: [], nodeCount: 65100, edgeCount: 110900, clusterCount: 12 },
    memorySource: 'manifest',
  });
  const resolved = await resolveKnownGoodNodeCount(dir, path.join(dir, 'state.json'));
  assert.deepEqual({ count: resolved.count, source: resolved.source }, { count: 65100, source: 'state-file-shell' });
});

test('resolveKnownGoodNodeCount treats a completely fresh run as zero known-good nodes', async (t) => {
  const dir = makeBrainDir(t, 'fresh');
  const resolved = await resolveKnownGoodNodeCount(dir, path.join(dir, 'state.json'));
  assert.deepEqual({ count: resolved.count, source: resolved.source }, { count: 0, source: 'fresh' });
});

test('evaluateSaveSafety refuses a 90 percent drop and passes growth, small brains, and the exact floor', () => {
  const refused = evaluateSaveSafety({ currentNodes: 100, existingNodes: 1000, source: 'snapshot', cycle: 7 });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'catastrophic_node_drop');
  assert.equal(refused.dropPercent, 90);
  assert.equal(refused.currentNodes, 100);
  assert.equal(refused.existingNodes, 1000);

  const growth = evaluateSaveSafety({ currentNodes: 1200, existingNodes: 1000, source: 'snapshot', cycle: 8 });
  assert.equal(growth.ok, true);

  // Brains at or below 100 nodes never trip the guard (donor threshold: existingNodes > 100).
  const small = evaluateSaveSafety({ currentNodes: 0, existingNodes: 100, source: 'snapshot', cycle: 9 });
  assert.equal(small.ok, true);

  // Exactly at the 50% floor passes (strict less-than in the donor).
  const atFloor = evaluateSaveSafety({ currentNodes: 500, existingNodes: 1000, source: 'snapshot', cycle: 10 });
  assert.equal(atFloor.ok, true);

  const justUnder = evaluateSaveSafety({ currentNodes: 499, existingNodes: 1000, source: 'snapshot', cycle: 11 });
  assert.equal(justUnder.ok, false);
});

test('real saveState: growth stamps brain-snapshot.json and a 90 percent drop at cycle 50 is refused', async (t) => {
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-guard-save-'));
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  const runDir = path.join(home23Root, 'brains', 'runs', 'guard-run');
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(lockRoot, { recursive: true });
  const logs = [];

  // First save on a fresh run dir: baseline is zero, save passes and stamps the snapshot.
  const first = await Orchestrator.prototype.saveState.call(
    makeOrchestratorFake(runDir, lockRoot, memoryGraph('grow', 200), 2, logs),
  );
  assert.equal(first.saved, true);
  assert.equal(first.reason, null);
  assert.equal(first.currentNodes, 200);
  assert.equal(first.existingNodes, 0);

  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'memory-manifest.json'), 'utf8'));
  const stamped = readSnapshot(runDir);
  assert.equal(stamped.nodes, 200);
  assert.equal(stamped.edges, 199);
  assert.equal(stamped.generation, manifest.currentRevision);
  assert.equal(stamped.nodeCount, 200, 'compatibility alias for lib/memory-sidecar hydration');
  assert.equal(stamped.edgeCount, 199);
  assert.ok(Number.isFinite(Date.parse(stamped.savedAt)));

  // 90% drop at cycle 50 (the old dead guard only ran at cycle <= 1): refused, nothing rewritten.
  const stateBefore = fs.readFileSync(path.join(runDir, 'state.json.gz'));
  const manifestBefore = fs.readFileSync(path.join(runDir, 'memory-manifest.json'));
  const refused = await Orchestrator.prototype.saveState.call(
    makeOrchestratorFake(runDir, lockRoot, memoryGraph('drop', 20), 50, logs),
  );
  assert.equal(refused.saved, false);
  assert.equal(refused.reason, 'catastrophic_node_drop');
  assert.equal(refused.currentNodes, 20);
  assert.equal(refused.existingNodes, 200);
  assert.equal(refused.dropPercent, 90);
  assert.ok(
    logs.some((entry) => entry.level === 'error' && /REFUSING STATE SAVE/.test(entry.message)),
    'refusal must be logged loudly',
  );
  assert.deepEqual(
    fs.readFileSync(path.join(runDir, 'state.json.gz')),
    stateBefore,
    'refused save must not rewrite state.json.gz',
  );
  assert.deepEqual(
    fs.readFileSync(path.join(runDir, 'memory-manifest.json')),
    manifestBefore,
    'refused save must not rewrite the memory manifest',
  );
  assert.equal(readSnapshot(runDir).nodes, 200, 'refused save must not touch the snapshot');

  // Normal growth save afterwards passes and re-stamps the snapshot.
  const second = await Orchestrator.prototype.saveState.call(
    makeOrchestratorFake(runDir, lockRoot, memoryGraph('regrow', 210), 51, logs),
  );
  assert.equal(second.saved, true);
  assert.equal(second.reason, null);
  assert.equal(second.existingNodes, 200);
  const restamped = readSnapshot(runDir);
  assert.equal(restamped.nodes, 210);
  assert.equal(restamped.edges, 209);
  assert.equal(readCompressedState(runDir).memory.nodeCount, 210);
});

```

## API NOTES

DONOR-VS-TARGET MISMATCHES AND WIRING NOTES:

1. Reason string: the donor (engine/src/core/brain-persistence-guard.js:64) uses 'catastrophic_node_loss'; contract #1 mandates 'catastrophic_node_drop' — the port uses the contract string. Thresholds ported EXACTLY: refuse iff existingNodes > 100 && currentNodes < existingNodes * 0.5 (strict <, dropFloor param default 0.5).

2. Snapshot shape: donor writes { savedAt, cycle, nodeCount, edgeCount, fileSize }; contract #2 mandates { nodes, edges, savedAt, generation }. The port writes the contract shape PLUS nodeCount/edgeCount (and cycle) as compatibility aliases, because cosmo23/lib/memory-sidecar.js:345 hydration guard reads `Number(snapshot?.nodeCount || snapshot?.nodes?.count || 0)` — a contract-only snapshot would silently read as 0 there and disarm the existing hydration check. Fix 1.3/1.4 (loadState/fail-loud guard) should either keep relying on these aliases or switch that read to the exported `snapshotNodeCount()` helper, which accepts both shapes. Extra keys do not violate contract #2.

3. Resolution order: donor is manifest-first (orchestrator donor wiring at engine/src/core/orchestrator.js:7278-7302); the task spec and this port are snapshot-first (snapshot -> manifest -> streamed sidecar count -> legacy inline). In cosmo23 both artifacts are written by the same save so they agree; snapshot-first also avoids shared readManifest's throwing validation path (it throws memorySourceError on malformed manifests — wrapped in try/catch -> null here). Added source 'state-file-shell': cosmo23 shell states have memory.nodes=[] but memory.nodeCount=N (memoryShell, cosmo23/lib/memory-sidecar.js:124-137); trusting nodes.length alone on the legacy fallback would fail open.

4. No delta counting: home23's countSidecarNodes replays readMemoryDeltas; cosmo23's persistResearchState full-rewrites the base via rewriteMemoryBase on every save (no delta files), so the base stream count is authoritative and the port omits delta replay deliberately.

5. Require paths verified: cosmo23/engine/src/core -> '../../../lib/memory-sidecar' (same as orchestrator.js:29) and -> '../../../../shared/memory-source' for readManifest (same depth convention as cosmo23/engine/src/agents/agent-executor.js:16). No circular requires (memory-sidecar never requires core/).

6. Contract #1 compliance: saveState now returns the structured result from EVERY path and never throws for guard refusals; guard-baseline resolution failure fails CLOSED with reason 'persistence_guard_failed' (a guard-refusal reason, mirroring the donor at engine/src/core/orchestrator.js:7348-7361); persistence/save exceptions return reason 'save_error:<message>'. Result is also mirrored to this.lastSaveResult (new property — verified no collisions) for the Fix that wires graceful shutdown (contract #5: graceful-shutdown-handler.js:252 should become `const result = await this.orchestrator.saveState();` and only markCleanShutdown when result.saved === true). Existing callers (orchestrator.js:1180, 1744, 1794, 3210, 3752, 6028, 9075, 9080) ignore the return today — non-breaking.

7. Ordering guarantee: the guard runs BEFORE persistResearchState, so a refused save can no longer rewrite the sidecar base (rewriteMemoryBase full-rewrites on every save — running the guard after would destroy the last good sidecar even when the state.json.gz write is refused). evaluation.save() still runs before the guard (metrics only, no brain data) — unchanged behavior.

8. Degraded saves: when the manifest commit fails, persistResearchState falls back to full inline state and saveState still succeeds — the snapshot is stamped with generation: null (persistence.revision is null on the degraded path), matching contract #2's `generation: number|null`.

9. Behavior change to flag: like the donor, there is NO bypass — a legitimate >50% prune of a >100-node brain will be refused every cycle. Fresh runs resolve to { count: 0, source: 'fresh' } and always pass.

10. Existing tests unaffected: tests/cosmo23/research-memory-manifest.test.cjs drives the real saveState via Orchestrator.prototype.saveState.call(fake) on fresh tmpdirs with <=12-node graphs (guard needs existingNodes > 100), and its no-error-logs assertion holds since fresh dirs never refuse. The new test file reuses that exact fixture pattern.

11. RISKS: (a) tests/cosmo23/memory-sidecar.test.cjs exists but is NOT in the package.json chain — do not copy its registration status; the new file IS registered in both package.json and package-test-registration.test.cjs per contract #7. (b) docs/design/COSMO23-VENDORED-PATCHES.md currently runs through Patch 70 (2026-07-21) — the "Patch 20 is current" note in CLAUDE.local.md is stale; the implementer must append a new patch entry (Patch 71) documenting this cosmo23 edit so it survives upstream resyncs. (c) The saveState anchor block (orchestrator.js:8071-8143) contains two whitespace-only lines with 6 trailing spaces (original lines 8113 and 8139) — exact-match edits must preserve them or edit line-wise.
