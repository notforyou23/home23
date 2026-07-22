# cosmo23 memory persistence — Fix 3.4: config-gated delta compaction (default OFF) in lib/memory-sidecar.js persistResearchState, backed by new NetworkMemory changes-only dirty capture and orchestrator wiring + event-ledger receipts

## Target current state

/Users/jtr/_JTR23_/release/home23/cosmo23/lib/memory-sidecar.js `persistResearchState` → `persistCapturedResearchMemory` calls `rewriteMemoryBase` on EVERY save — a full O(graph) gzip rewrite of both base sidecars each cycle (structurally immune to unbounded deltas, increasingly wasteful as brains grow). Verified facts about the CURRENT tree: (1) cosmo23 NetworkMemory (engine/src/memory/network-memory.js) HAS dirty tracking from commit 8e4c9587 — `dirtyNodeIds`/`dirtyEdgeKeys` PLUS `deletedNodeIds`/`deletedEdgeKeys` tombstone sets, `persistenceGeneration`, barrier-enforced mutators, `capturePersistenceSnapshot()` (full view + changes) and `markPersistenceCleanIfGeneration()` — but NOTHING in production consumes or clears the dirty sets (only engine/tests/unit/cluster-aware-memory.test.js touches them); it LACKS the donor's bounded `capturePersistenceChangesSnapshot()`. (2) The shared writer (shared/memory-source/writer.cjs) exposes `appendMemoryRevision(brainDir, {nodes,edges,removedNodeIds,removedEdgeKeys}, {lockRoot, summary, expectedGeneration/expectedRevision/expectedDigest})` with tombstone ops `remove_node`/`remove_edge`, hash-chained records, and an exact-expected-source CAS; `rewriteMemoryBase` stamps `baseWrittenAt` (writer.cjs:406). (3) The read path already replays deltas with NO change needed: `hydrateStateMemory` → `openCosmoMemorySource` (manifest-v1 authority) → shared reader.cjs, which loads `manifest.activeDelta` into a bounded overlay and applies upserts/removals during `iterateNodes`/`iterateEdges` — proven live in validation (delta save then hydrate returned the full mutated graph). (4) brain-snapshot.js `resolveKnownGoodNodeCount` tier order is snapshot → memory-manifest (manifest.summary.nodeCount, which every delta append refreshes via options.summary) → streamed base sidecar count → legacy state; the sidecar-count tier's "no delta files" comment goes stale with deltas on, but that tier is legacy-layout-only (manifest-v1 bases are memory-nodes.base-N.jsonl.gz, so nodesPath() doesn't exist there) and both authoritative tiers sit ABOVE it — guard stays correct. (5) orchestrator.js `_saveStateUnlocked` (~line 8617) passes `state.memory = this.memory.exportGraph()` — a PROJECTION dropping summary/keyPhrase/metadata/type — so delta records must project identically or hydrated node shape would depend on which save path last wrote it. (6) orchestrator loadState (~line 9020) repopulates `this.memory.nodes/edges` directly, bypassing the barrier: regenerates embeddings in place, skips corrupted edges — so post-restart dirty sets are empty while in-memory counts can drift from the manifest; the design must fail-safe to full rewrite on that. (7) `this.config.memory` is currently unused in the cosmo23 orchestrator (only memoryGovernance/memorySource exist) — top-level `memory:` config block is free. Ledger pattern: `this.eventLedger?.log('name', {...})`, fire-and-forget, never awaited.

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/lib/memory-sidecar.js

Edit 1 of 3 — widen the shared/memory-source import to the delta writer + CAS surfaces. Anchor is the whole 6-line require block (grep-unique, no trailing whitespace). NOTE: a sibling Fix-3.x proposal may rework normalizeResearchGraph/captureResearchState in this same file (per-record capture); this anchor and both edits below sit OUTSIDE those functions and were verified to apply cleanly on both variants.

### Anchor
```
const {
  MATCH_OUTCOME,
  SOURCE_HEALTH,
  createEvidence,
  rewriteMemoryBase,
} = require('../../shared/memory-source');
```

### Code
```js
const {
  MATCH_OUTCOME,
  SOURCE_HEALTH,
  appendMemoryRevision,
  createDescriptor,
  createEvidence,
  readManifest,
  rewriteMemoryBase,
  sourceDescriptorDigest,
} = require('../../shared/memory-source');
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/lib/memory-sidecar.js

Edit 2 of 3 — replace the entire persistCapturedResearchMemory function (anchor = the full current function, grep-unique, no trailing whitespace) with the gated implementation plus its module-level helpers. Gate OFF / below minNodes / no liveMemory → planDeltaCompaction returns null and the function runs the byte-identical legacy full-rewrite path (same statements, same return keys — pinned by test 1). Armed: dirty snapshot captured synchronously before the first await (same turn as graph capture, so generations cannot blend); delta append is CAS-guarded by the manifest identity of THIS process's previous save (expectedGeneration/Revision/Digest through appendMemoryRevision, plus a deterministic pre-check); full rewrite forced on ANY doubt — no expected lineage (first save each boot), summary drift, baseWrittenAt missing/older than fullRewriteIntervalMs (donor parity, jerry 2026-07-16 fix), count drift the dirty records cannot explain (catches loadState's barrier-bypassing repopulation), or a refused append. markPersistenceCleanIfGeneration consumes dirt only when the persisted generation is the live one. Every armed save logs mode+counts and returns a frozen compaction receipt + the next deltaExpected.

### Anchor
```
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
```

### Code
```js
/**
 * HOME23 Fix 3.4 — config-gated memory delta compaction (default OFF).
 *
 * With memory.deltaCompaction.enabled AND a graph of at least minNodes
 * (default 10000), ordinary saves append changes-only records into the
 * manifest's active delta chain instead of rewriting the full base sidecars
 * every cycle. A full base rewrite still happens when the base is older
 * than fullRewriteIntervalMs (default 6h — donor parity with Home23
 * engine/src/core/memory-persistence.js persistMemoryRevision) and on ANY
 * doubt about dirty-set integrity: no proven manifest lineage, summary
 * drift between the captured export and the live dirty snapshot, count
 * drift the dirty records cannot explain, or a refused CAS append. Gate
 * off or below threshold, every save takes exactly the legacy full-rewrite
 * path below. The shared reader already replays the delta chain during
 * hydration (openCosmoMemorySource → shared/memory-source reader overlay),
 * so the read path needs no change.
 */
const DELTA_COMPACTION_MIN_NODES_DEFAULT = 10000;
const DELTA_COMPACTION_FULL_REWRITE_INTERVAL_MS_DEFAULT = 6 * 60 * 60 * 1000;

function resolveDeltaCompactionConfig(raw) {
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return null;
  const minNodes = Number.isSafeInteger(raw.minNodes) && raw.minNodes >= 0
    ? raw.minNodes
    : DELTA_COMPACTION_MIN_NODES_DEFAULT;
  const fullRewriteIntervalMs = Number.isFinite(raw.fullRewriteIntervalMs) && raw.fullRewriteIntervalMs > 0
    ? raw.fullRewriteIntervalMs
    : DELTA_COMPACTION_FULL_REWRITE_INTERVAL_MS_DEFAULT;
  return Object.freeze({ minNodes, fullRewriteIntervalMs });
}

function normalizeDeltaExpected(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.generation !== 'string' || raw.generation.length === 0) return null;
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 0) return null;
  if (typeof raw.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(raw.digest)) return null;
  return Object.freeze({ generation: raw.generation, revision: raw.revision, digest: raw.digest });
}

function summariesExactlyEqual(left, right) {
  return Boolean(left && right
    && left.nodeCount === right.nodeCount
    && left.edgeCount === right.edgeCount
    && left.clusterCount === right.clusterCount);
}

function deltaChangeCounts(changes) {
  return {
    upsertNodes: changes.nodes.length,
    upsertEdges: changes.edges.length,
    removedNodes: changes.removedNodeIds.length,
    removedEdges: changes.removedEdgeKeys.length,
  };
}

/**
 * Every node/edge count movement since the last committed summary must be
 * attributable to the dirty records about to be appended. Anything else
 * means a mutation bypassed the persistence barrier (e.g. loadState's
 * direct map population dropping corrupted edges) or the manifest is not
 * this graph's lineage — only a full rewrite is trustworthy then.
 */
function deltaDriftExplained(summary, manifestSummary, changes) {
  if (!manifestSummary) return false;
  const nodeDrift = summary.nodeCount - manifestSummary.nodeCount;
  const edgeDrift = summary.edgeCount - manifestSummary.edgeCount;
  return nodeDrift <= changes.nodes.length
    && nodeDrift >= -changes.removedNodeIds.length
    && edgeDrift <= changes.edges.length
    && edgeDrift >= -changes.removedEdgeKeys.length;
}

function planDeltaCompaction(summary, options) {
  const config = resolveDeltaCompactionConfig(options.deltaCompaction);
  if (!config) return null;
  const live = options.liveMemory;
  if (!live
      || typeof live.capturePersistenceChangesSnapshot !== 'function'
      || typeof live.markPersistenceCleanIfGeneration !== 'function') {
    return null;
  }
  if (summary.nodeCount < config.minNodes) return null;
  const expected = normalizeDeltaExpected(options.deltaExpected);
  let snapshot = null;
  try {
    snapshot = live.capturePersistenceChangesSnapshot();
  } catch {
    return { config, live, snapshot: null, expected, reason: 'changes_capture_failed' };
  }
  let reason = null;
  if (!snapshot || !snapshot.changes || !summariesExactlyEqual(snapshot.summary, summary)) {
    reason = 'summary_drift';
  } else if (!expected) {
    // First armed save of this process (or the previous save degraded):
    // there is no proven manifest lineage to append onto, so rebase.
    reason = 'no_expected_source';
  }
  return { config, live, snapshot, expected, reason };
}

async function readCommittedManifestOrNull(runDir) {
  try {
    return await readManifest(runDir);
  } catch {
    return null;
  }
}

async function manifestDescriptorDigest(runDir, manifest) {
  return sourceDescriptorDigest(createDescriptor(await fs.promises.realpath(runDir), manifest));
}

async function persistCapturedResearchMemory(runDir, capturedMemory, options = {}) {
  const lockRoot = options.lockRoot || DEFAULT_LOCK_ROOT;
  const summary = researchSummary(capturedMemory);
  // Delta planning happens synchronously, in the same turn that captured
  // capturedMemory — a later dirty-set snapshot could describe a different
  // live generation and blend two generations into one delta append.
  const plan = planDeltaCompaction(summary, options);
  await fs.promises.mkdir(runDir, { recursive: true });
  await fs.promises.mkdir(lockRoot, { recursive: true, mode: 0o700 });

  let mode = 'full';
  let rebaseReason = plan ? plan.reason : null;
  let manifest = null;
  let appendCounts = null;

  if (plan && !plan.reason) {
    const current = await readCommittedManifestOrNull(runDir);
    const changes = plan.snapshot.changes;
    const totalChanges = changes.nodes.length + changes.edges.length
      + changes.removedNodeIds.length + changes.removedEdgeKeys.length;
    const baseWrittenAtMs = current?.baseWrittenAt !== undefined
      ? Date.parse(current.baseWrittenAt)
      : NaN;
    if (!current) {
      rebaseReason = 'manifest_missing';
    } else if (current.generation !== plan.expected.generation
        || current.currentRevision !== plan.expected.revision
        || await manifestDescriptorDigest(runDir, current) !== plan.expected.digest) {
      rebaseReason = 'expected_source_changed';
    } else if (!Number.isFinite(baseWrittenAtMs)
        || Date.now() - baseWrittenAtMs >= plan.config.fullRewriteIntervalMs) {
      // A manifest without a parseable baseWrittenAt is treated as overdue
      // (donor parity): one extra full rewrite beats a delta chain that
      // grows until cold load takes minutes.
      rebaseReason = 'base_overdue';
    } else if (!deltaDriftExplained(summary, current.summary, changes)) {
      rebaseReason = 'summary_reconciliation_failed';
    } else if (totalChanges === 0) {
      mode = 'reused';
      manifest = current;
    } else {
      try {
        const appended = await appendMemoryRevision(runDir, changes, {
          ...(options.writerOptions || {}),
          lockRoot,
          summary,
          expectedGeneration: plan.expected.generation,
          expectedRevision: plan.expected.revision,
          expectedDigest: plan.expected.digest,
        });
        mode = 'delta';
        manifest = appended.manifest;
        appendCounts = { ...deltaChangeCounts(changes), records: appended.count, bytes: appended.bytes };
      } catch (error) {
        // Fail safe: ANY append doubt falls back to the full O(graph)
        // rewrite every save performed before this gate existed.
        rebaseReason = 'append_refused';
        options.logger?.warn?.('Research memory delta append refused — rebasing with a full rewrite', {
          code: error?.code || 'append_failed',
          error: error?.message || String(error),
          nodes: summary.nodeCount,
          edges: summary.edgeCount,
        });
      }
    }
  }

  if (mode === 'full') {
    const committed = await rewriteMemoryBase(runDir, {
      nodes: capturedMemory.nodes,
      edges: capturedMemory.edges,
      summary,
    }, {
      ...(options.writerOptions || {}),
      lockRoot,
    });
    manifest = committed.manifest;
  }
  if (!Number.isSafeInteger(manifest?.baseRevision)
      || !Number.isSafeInteger(manifest?.currentRevision)) {
    throw new Error('research memory manifest did not commit numeric revisions');
  }

  let compaction;
  let deltaExpected;
  if (plan) {
    // Consume the dirty sets only when this exact live generation is the
    // one now durable (delta append, or a full rewrite of a capture the
    // snapshot matched). A mid-save mutation advances the generation and
    // markPersistenceCleanIfGeneration refuses, keeping that dirt for the
    // next save. Snapshots that never matched the capture are never
    // cleaned — their dirt re-persists (redundant but safe) later.
    const snapshotMatchedCapture = Boolean(plan.snapshot
      && summariesExactlyEqual(plan.snapshot.summary, summary));
    const cleaned = snapshotMatchedCapture
      ? plan.live.markPersistenceCleanIfGeneration(plan.snapshot.generation)
      : false;
    compaction = Object.freeze({
      mode,
      ...(rebaseReason ? { reason: rebaseReason } : {}),
      cleaned,
      ...(appendCounts ? { counts: Object.freeze(appendCounts) } : {}),
    });
    deltaExpected = Object.freeze({
      generation: manifest.generation,
      revision: manifest.currentRevision,
      digest: await manifestDescriptorDigest(runDir, manifest),
    });
    options.logger?.info?.('Research memory delta compaction save', {
      mode,
      ...(rebaseReason ? { reason: rebaseReason } : {}),
      cleaned,
      revision: manifest.currentRevision,
      nodes: summary.nodeCount,
      edges: summary.edgeCount,
      ...(appendCounts || {}),
    });
  }

  return Object.freeze({
    manifest,
    revision: manifest.currentRevision,
    summary,
    evidence: researchEvidence(manifest, summary),
    capturedMemory,
    ...(plan ? { compaction, deltaExpected } : {}),
  });
}
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/lib/memory-sidecar.js

Edit 3 of 3 — pass the compaction receipt and next-save lineage through persistResearchState's success return. Anchor is the exact current success-return block (grep-unique, no trailing whitespace). Gate-off return shape is unchanged (keys only appear when committed.compaction exists). The degraded path is untouched: a failed armed append falls back to full rewrite inside persistCapturedResearchMemory, and only a failed full rewrite reaches the existing inline-recovery catch.

### Anchor
```
  const saveResult = await options.saveState(shellState);
  return Object.freeze({
    degraded: false,
    manifest: committed.manifest,
    revision: committed.revision,
    evidence: committed.evidence,
    saveResult,
  });
}
```

### Code
```js
  const saveResult = await options.saveState(shellState);
  return Object.freeze({
    degraded: false,
    manifest: committed.manifest,
    revision: committed.revision,
    evidence: committed.evidence,
    saveResult,
    // Present only when delta compaction was armed for this save: the
    // compaction receipt and the manifest identity the NEXT save must pass
    // back as options.deltaExpected to append onto this lineage.
    ...(committed.compaction ? { compaction: committed.compaction, deltaExpected: committed.deltaExpected } : {}),
  });
}
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/memory/network-memory.js

Edit 1 of 2 — module-level persisted-graph projection helpers, appended immediately after summarizePersistenceView (anchor = the whole function, grep-unique, no trailing whitespace). CRITICAL: field lists are copied verbatim from exportGraph() (node: id..consolidatedAt; edge: source..accessed with the same legacy key-parse fallback) so delta-written records hydrate with the same shape full saves persist — cosmo23's exportGraph DROPS summary/keyPhrase/metadata/type and raw-node clones would smuggle them in. Do NOT refactor exportGraph itself (hot always-on path); the parity is pinned by the test.

### Anchor
```
function summarizePersistenceView(nodes, edges) {
  const clusters = new Set(
    nodes
      .map((node) => node.cluster)
      .filter((cluster) => cluster !== null && cluster !== undefined),
  );
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    clusterCount: clusters.size,
  };
}
```

### Code
```js
function summarizePersistenceView(nodes, edges) {
  const clusters = new Set(
    nodes
      .map((node) => node.cluster)
      .filter((cluster) => cluster !== null && cluster !== undefined),
  );
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    clusterCount: clusters.size,
  };
}

/**
 * Persisted-graph projections (Fix 3.4 delta compaction). Delta appends put
 * dirty records into the manifest delta chain; those records MUST match
 * what a full save persists — exportGraph()'s exact field set — or the
 * hydrated brain would change shape depending on which save path last
 * touched a node (full saves drop summary/keyPhrase/metadata/type today).
 * Keep these field lists in exact sync with exportGraph();
 * tests/cosmo23/research-memory-delta-compaction.test.cjs pins the parity.
 */
function projectExportedNodeRecord(n) {
  return {
    id: n.id,
    concept: n.concept,
    tag: n.tag,
    embedding: n.embedding,
    weight: n.weight,
    activation: n.activation,
    cluster: n.cluster,
    accessCount: n.accessCount,
    created: n.created,
    accessed: n.accessed,
    consolidatedAt: n.consolidatedAt
  };
}

function projectExportedEdgeRecord(edgeKey, edge) {
  let source;
  let target;
  if (edge.source !== undefined && edge.target !== undefined) {
    source = edge.source;
    target = edge.target;
  } else {
    const parts = String(edgeKey).split('->');
    source = Number.isNaN(Number(parts[0])) ? parts[0] : Number(parts[0]);
    target = Number.isNaN(Number(parts[1])) ? parts[1] : Number(parts[1]);
  }
  return {
    source,
    target,
    weight: edge.weight,
    type: edge.type,
    created: edge.created,
    accessed: edge.accessed
  };
}
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/memory/network-memory.js

Edit 2 of 2 — add capturePersistenceChangesSnapshot() to the NetworkMemory class, inserted immediately BEFORE markPersistenceCleanIfGeneration (anchor = that method's opening line with its exact 2-space indent, grep-unique, no trailing whitespace). Donor-pattern port of Home23 network-memory.js:1755 with two deliberate cosmo23-native divergences (verified by reading, per the donor-mismatch rule): records go through the exportGraph projection (not Home23's serializeNodePersistenceRecord full clone), and summary.clusterCount is this.clusters.size (matching researchSummary over exportGraph output) rather than the distinct-node.cluster count summarizePersistenceView uses — the persistence layer compares this summary against its captured export for eligibility, so both must count the same way. clonePersistenceValue makes records JSON-safe (Dates→ISO, typed arrays→plain arrays). Never materializes fullView — bounded work at large-brain scale.

### Anchor
```
  markPersistenceCleanIfGeneration(expectedGeneration) {
```

### Code
```js
  /**
   * Changes-only capture for manifest delta appends (Fix 3.4). Unlike
   * capturePersistenceSnapshot() this never materializes the full graph —
   * bounded work at large-brain scale is the whole point of delta
   * compaction — and it projects records through the exportGraph() field
   * set so delta-written and base-written records hydrate identically.
   * Summary counts mirror researchSummary() over exportGraph() output:
   * clusterCount is the cluster-map size, NOT the distinct node.cluster
   * count summarizePersistenceView() reports — the persistence layer
   * compares this summary against its captured export to decide delta
   * eligibility, so the two must count the same way.
   */
  capturePersistenceChangesSnapshot() {
    return this.withPersistenceBarrier(() => {
      const changes = {
        nodes: Array.from(this.dirtyNodeIds)
          .map((nodeId) => {
            const node = this.nodes.get(nodeId);
            return node ? clonePersistenceValue(projectExportedNodeRecord(node)) : null;
          })
          .filter(Boolean),
        edges: Array.from(this.dirtyEdgeKeys)
          .map((edgeKey) => {
            const edge = this.edges.get(edgeKey);
            return edge ? clonePersistenceValue(projectExportedEdgeRecord(edgeKey, edge)) : null;
          })
          .filter(Boolean),
        removedNodeIds: Array.from(this.deletedNodeIds),
        removedEdgeKeys: Array.from(this.deletedEdgeKeys),
        revision: this.persistenceRevision,
      };
      return deepFreezePersistenceValue({
        generation: this.persistenceGeneration,
        changes,
        summary: {
          nodeCount: this.nodes.size,
          edgeCount: this.edges.size,
          clusterCount: this.clusters.size,
        },
      });
    });
  }

  markPersistenceCleanIfGeneration(expectedGeneration) {
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

Edit 1 of 2 — wire the gate into _saveStateUnlocked's persistResearchState call (~line 8617). Anchor is the call head + first two option lines (grep-unique — the lockRoot line alone appears twice, once here and once in maybeBackupBrain; no trailing whitespace). Absent config (`this.config?.memory?.deltaCompaction` undefined) the added options are inert and the legacy path is untouched. `this._memoryDeltaExpected` starts undefined on a fresh process — intentionally: the first armed save always rebases (no proven lineage), which also resets baseWrittenAt. No constructor init needed (matches the lazy `_knownGoodCache` pattern).

### Anchor
```
      const persistence = await persistResearchState(this.logsDir, state, {
        lockRoot: this.config?.memorySource?.lockRoot,
        logger: this.logger,
```

### Code
```js
      const persistence = await persistResearchState(this.logsDir, state, {
        lockRoot: this.config?.memorySource?.lockRoot,
        logger: this.logger,
        // Fix 3.4 (config-gated, default OFF): the live dirty tracking plus
        // the manifest identity committed by this process's previous save
        // let persistResearchState append changes-only deltas instead of
        // rewriting the full base sidecars every cycle. Absent config
        // leaves the legacy full-rewrite path untouched.
        liveMemory: this.memory,
        deltaCompaction: this.config?.memory?.deltaCompaction,
        deltaExpected: this._memoryDeltaExpected,
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js

Edit 2 of 2 — stash the committed lineage and ledger the compaction outcome, inserted right after the saveResult line (anchor grep-unique, no trailing whitespace). A degraded save yields persistence.deltaExpected undefined → lineage cleared → next armed save rebases (stale-manifest corruption impossible). eventLedger?.log matches the existing watchdog/cycle pattern: durable, fire-and-forget, never awaited (G3). totalNodes/totalEdges are in scope from the surrounding function.

### Anchor
```
      const saveResult = persistence.saveResult;
```

### Code
```js
      const saveResult = persistence.saveResult;

      // Fix 3.4: remember the manifest identity this save committed so the
      // next armed save can CAS-append onto it (a degraded save clears the
      // lineage — the next save rebases), and ledger the compaction outcome
      // durably. eventLedger.log is fire-and-forget — never awaited.
      this._memoryDeltaExpected = persistence.deltaExpected || null;
      if (persistence.compaction) {
        this.eventLedger?.log('memory_delta_compaction', {
          cycle: this.cycleCount,
          mode: persistence.compaction.mode,
          reason: persistence.compaction.reason || null,
          cleaned: persistence.compaction.cleaned,
          revision: persistence.revision,
          nodes: totalNodes,
          edges: totalEdges,
          ...(persistence.compaction.counts || {}),
        });
      }
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/brain-snapshot.js

Comment-only doc-truth fix: the countSidecarNodes docstring claims 'no delta files, so the base count is authoritative' — false once deltas ship. Anchor = the exact current 5-line comment (grep-unique, no trailing whitespace). No code change; the guard itself is already delta-safe (see apiNotes).

### Anchor
```
/**
 * Stream-count unique node ids in memory-nodes.jsonl.gz. cosmo23 rewrites
 * the base sidecar in full on every save (no delta files), so the base
 * count is authoritative.
 */
```

### Code
```js
/**
 * Stream-count unique node ids in memory-nodes.jsonl.gz. This tier only
 * matters for legacy-resident layouts: manifest-backed runs name their
 * bases memory-nodes.base-N.jsonl.gz (this path does not exist there), and
 * with delta compaction armed (Fix 3.4) a base-only count would undercount
 * anyway — the manifest tier ABOVE this one carries the authoritative
 * summary totals, refreshed by every delta append.
 */
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/package.json

Register the new suite in the scripts.test cjs chain, immediately after research-memory-manifest.test.cjs. Anchor = the space-separated adjacent pair (grep-unique; verified exactly once). WARNING: package.json carries FOREIGN UNCOMMITTED HUNKS from other sessions — stage this one-line change surgically (git add -p), never the whole file.

### Anchor
```
tests/cosmo23/research-memory-manifest.test.cjs tests/cosmo23/brain-snapshot-guard.test.cjs
```

### Code
```js
tests/cosmo23/research-memory-manifest.test.cjs tests/cosmo23/research-memory-delta-compaction.test.cjs tests/cosmo23/brain-snapshot-guard.test.cjs
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/package-test-registration.test.cjs

Add the new suite to the exactly-once registration list, directly after the research-memory-manifest entry (anchor line is grep-unique with its 4-space indent, no trailing whitespace). WARNING: this file also carries FOREIGN UNCOMMITTED HUNKS — stage surgically.

### Anchor
```
    'tests/cosmo23/research-memory-manifest.test.cjs',
```

### Code
```js
    'tests/cosmo23/research-memory-manifest.test.cjs',
    'tests/cosmo23/research-memory-delta-compaction.test.cjs',
```

## CHANGE: /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/CLAUDE.md

Doc truth: add the three new config knobs to the Key Config Fields table, after the backups.minFreeBytes row (anchor grep-unique, no trailing whitespace).

### Anchor
```
| `backups.minFreeBytes` | Free-disk floor below which backups are skipped, default 4294967296 (4GB) |
```

### Code
```js
| `backups.minFreeBytes` | Free-disk floor below which backups are skipped, default 4294967296 (4GB) |
| `memory.deltaCompaction.enabled` | Fix 3.4 gate, default false — armed saves append changes-only manifest deltas instead of rewriting the full base sidecars every cycle |
| `memory.deltaCompaction.minNodes` | Node floor below which saves stay full-rewrite even when enabled, default 10000 |
| `memory.deltaCompaction.fullRewriteIntervalMs` | Max base age before an armed save rebases with a full rewrite (folds the delta chain back in), default 21600000 (6h) |
```

## TEST FILE: /Users/jtr/_JTR23_/release/home23/tests/cosmo23/research-memory-delta-compaction.test.cjs

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const Module = require('node:module');

const gunzip = promisify(zlib.gunzip);

// NetworkMemory pulls heavyweight optional deps at require time; stub them
// exactly like tests/cosmo23/cluster-aware-memory-persistence.test.cjs does.
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'openai') return class OpenAI {};
  if (request === 'dotenv') return { config() {} };
  if (request === 'tiktoken') {
    return { encoding_for_model: () => ({ encode: () => [], free() {} }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { NetworkMemory } = require('../../cosmo23/engine/src/memory/network-memory.js');
const { Orchestrator } = require('../../cosmo23/engine/src/core/orchestrator.js');
Module._load = originalLoad;

const {
  persistResearchState,
  hydrateStateMemory,
} = require('../../cosmo23/lib/memory-sidecar');
const {
  resolveKnownGoodNodeCount,
  writeSnapshot,
} = require('../../cosmo23/engine/src/core/brain-snapshot');
const { readManifest } = require('../../shared/memory-source');

const toPlainJson = (value) => JSON.parse(JSON.stringify(value));

async function makeFixture(t) {
  const home23Root = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-delta-compaction-'));
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  await fs.mkdir(lockRoot, { recursive: true });
  const runDir = path.join(home23Root, 'brains', 'runs', 'delta-run');
  await fs.mkdir(runDir, { recursive: true });
  t.after(() => fs.rm(home23Root, { recursive: true, force: true }));
  return { home23Root, lockRoot, runDir };
}

function memoryConfig() {
  return {
    embedding: {},
    coordinator: {},
    spreading: {
      maxDepth: 2,
      activationThreshold: 0.01,
      decayFactor: 0.8,
      bridgeTraversalFactor: 0.2,
    },
    smallWorld: {
      bridgeProbability: 0,
      maxBridgesPerNode: 40,
      maxRewireEdgesPerRun: 100,
      rewireYieldEvery: 100,
    },
    hebbian: { enabled: false, reinforcementStrength: 0.1 },
    decay: { baseFactor: 0.95, minimumWeight: 0.01, decayInterval: 300, exemptTags: [] },
  };
}

function createLiveMemory() {
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const memory = new NetworkMemory(memoryConfig(), logger);
  memory.tokenizer = null;
  memory.embed = async () => { throw new Error('tests must pass explicit embeddings'); };
  return memory;
}

async function seedNodes(memory, count, label = 'seed') {
  const nodes = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index + 1) / (count + 1);
    const node = await memory.addNode(
      `durable ${label} semantic concept ${index + 1}`,
      'research',
      [Math.sin(angle), Math.cos(angle)],
    );
    assert.ok(node, `node ${index + 1} stored`);
    nodes.push(node);
  }
  return nodes;
}

function saveOptions(memory, lockRoot, extra = {}) {
  let savedState = null;
  const options = {
    lockRoot,
    liveMemory: memory,
    deltaCompaction: { enabled: true, minNodes: 1 },
    async saveState(captured) { savedState = captured; return { compressed: false, size: 0 }; },
    ...extra,
  };
  return { options, getSavedState: () => savedState };
}

async function persistOnce(runDir, memory, options, cycle) {
  const state = { cycleCount: cycle, journal: [], memory: memory.exportGraph() };
  return persistResearchState(runDir, state, options);
}

async function readDeltaRecords(runDir, manifest) {
  const text = await fs.readFile(path.join(runDir, manifest.activeDelta.file), 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function dirtSize(memory) {
  return memory.dirtyNodeIds.size + memory.dirtyEdgeKeys.size
    + memory.deletedNodeIds.size + memory.deletedEdgeKeys.size;
}

test('gate off: saves stay full-rewrite, result shape and dirty sets untouched', async (t) => {
  const { lockRoot, runDir } = await makeFixture(t);
  const memory = createLiveMemory();
  await seedNodes(memory, 4);

  // liveMemory present but NO deltaCompaction config — today's path exactly.
  const first = await persistOnce(runDir, memory, {
    lockRoot,
    liveMemory: memory,
    async saveState() {},
  }, 1);
  assert.equal(first.degraded, false);
  assert.equal('compaction' in first, false, 'gate off adds no compaction key');
  assert.equal('deltaExpected' in first, false, 'gate off adds no deltaExpected key');
  assert.ok(dirtSize(memory) > 0, 'gate off never consumes dirty tracking');
  const firstManifest = await readManifest(runDir);

  const second = await persistOnce(runDir, memory, {
    lockRoot,
    liveMemory: memory,
    async saveState() {},
  }, 2);
  assert.equal('compaction' in second, false);
  const secondManifest = await readManifest(runDir);
  assert.ok(secondManifest.baseRevision > firstManifest.baseRevision, 'second save rewrote the base');
  assert.notEqual(secondManifest.activeBase.nodes.file, firstManifest.activeBase.nodes.file);
  assert.equal(secondManifest.activeDelta.count, 0);

  // enabled but below minNodes threshold — still today's path, no receipt.
  const third = await persistOnce(runDir, memory, {
    lockRoot,
    liveMemory: memory,
    deltaCompaction: { enabled: true, minNodes: 10000 },
    async saveState() {},
  }, 3);
  assert.equal('compaction' in third, false, 'below minNodes stays on the legacy path');
  const thirdManifest = await readManifest(runDir);
  assert.ok(thirdManifest.baseRevision > secondManifest.baseRevision);
});

test('armed: first save rebases, delta save appends tombstoned changes and consumes dirty sets', async (t) => {
  const { lockRoot, runDir } = await makeFixture(t);
  const memory = createLiveMemory();
  const seeded = await seedNodes(memory, 5);

  const { options } = saveOptions(memory, lockRoot);
  const first = await persistOnce(runDir, memory, options, 1);
  assert.equal(first.degraded, false);
  assert.equal(first.compaction.mode, 'full');
  assert.equal(first.compaction.reason, 'no_expected_source');
  assert.equal(first.compaction.cleaned, true);
  assert.equal(dirtSize(memory), 0, 'full rewrite consumed the dirty sets');
  assert.equal(typeof first.deltaExpected.generation, 'string');
  assert.match(first.deltaExpected.digest, /^sha256:[a-f0-9]{64}$/);
  const baseManifest = await readManifest(runDir);
  assert.equal(baseManifest.currentRevision, first.revision);

  // Mutate through REAL NetworkMemory methods: add (with metadata that full
  // saves drop), touch, and remove-with-edge-cascade.
  const added = await memory.addNode('durable delta semantic concept', 'research', [0.6, 0.8], { origin: 'test' });
  memory.withPersistenceBarrier(() => {
    memory._upsertEdgeUnsafe(added.id, seeded[0].id, 0.7, 'associative', {});
  });
  memory.recordNodeAccess([seeded[1].id]);
  assert.equal(memory.removeNode(seeded[2].id), true);
  assert.ok(memory.deletedNodeIds.has(seeded[2].id));

  const { options: options2, getSavedState } = saveOptions(memory, lockRoot, {
    deltaExpected: first.deltaExpected,
  });
  const second = await persistOnce(runDir, memory, options2, 2);
  assert.equal(second.degraded, false);
  assert.equal(second.compaction.mode, 'delta');
  assert.equal(second.compaction.reason, undefined);
  assert.equal(second.compaction.cleaned, true);
  assert.equal(dirtSize(memory), 0, 'delta append consumed the dirty sets');
  assert.ok(second.compaction.counts.records > 0);
  assert.ok(second.compaction.counts.removedNodes >= 1);

  const manifest = await readManifest(runDir);
  assert.equal(manifest.generation, baseManifest.generation, 'no rebase: same manifest generation');
  assert.equal(manifest.activeBase.nodes.file, baseManifest.activeBase.nodes.file, 'base sidecars untouched');
  assert.equal(manifest.currentRevision, baseManifest.currentRevision + second.compaction.counts.records);
  assert.equal(manifest.activeDelta.count, second.compaction.counts.records);
  assert.equal(manifest.summary.nodeCount, memory.nodes.size);
  assert.equal(manifest.summary.edgeCount, memory.edges.size);

  const records = await readDeltaRecords(runDir, manifest);
  assert.equal(records.length, second.compaction.counts.records);
  for (const record of records) assert.equal(record.epoch, manifest.activeDeltaEpoch);
  const ops = records.map((record) => record.op);
  assert.ok(ops.includes('upsert_node'));
  assert.ok(ops.includes('remove_node'), 'deleted node produced a tombstone record');
  assert.ok(records.some((record) => record.op === 'remove_node' && record.id === seeded[2].id));

  // Projection parity: delta node records carry exactly the exportGraph
  // field set — nothing full saves would have dropped (metadata, summary).
  const addedRecord = records.find((record) => record.op === 'upsert_node' && record.record.id === added.id);
  assert.ok(addedRecord);
  const exported = toPlainJson(memory.exportGraph().nodes.find((node) => node.id === added.id));
  assert.deepEqual(
    Object.keys(addedRecord.record).sort(),
    Object.keys(exported).sort(),
    'delta record fields match the exportGraph projection',
  );
  assert.equal('metadata' in addedRecord.record, false);

  // The shell still carries authoritative counts + the new revision.
  const shell = getSavedState();
  assert.equal(shell.memorySource, 'manifest');
  assert.equal(shell.memorySourceRevision, manifest.currentRevision);
  assert.equal(shell.memory.nodeCount, memory.nodes.size);
  assert.deepEqual(shell.memory.nodes, []);

  // deltaExpected advanced to the appended revision.
  assert.equal(second.deltaExpected.generation, manifest.generation);
  assert.equal(second.deltaExpected.revision, manifest.currentRevision);
});

test('hydration replays the delta chain with no read-side change', async (t) => {
  const { lockRoot, runDir } = await makeFixture(t);
  const memory = createLiveMemory();
  const seeded = await seedNodes(memory, 4);

  const { options } = saveOptions(memory, lockRoot);
  const first = await persistOnce(runDir, memory, options, 1);

  const added = await memory.addNode('durable hydration semantic concept', 'research', [0.6, 0.8]);
  memory.withPersistenceBarrier(() => {
    memory._upsertEdgeUnsafe(added.id, seeded[0].id, 0.9, 'associative', {});
  });
  assert.equal(memory.removeNode(seeded[3].id), true);

  const { options: options2 } = saveOptions(memory, lockRoot, { deltaExpected: first.deltaExpected });
  const second = await persistOnce(runDir, memory, options2, 2);
  assert.equal(second.compaction.mode, 'delta');

  const hydration = await hydrateStateMemory(runDir, { memory: {} }, { logger: { warn() {} } });
  assert.equal(hydration.hydrated, true);
  assert.equal(hydration.source, 'manifest');

  const live = toPlainJson(memory.exportGraph());
  // The shared reader has always normalized node ids to strings on yield
  // (pre-existing manifest-v1 behavior, identical on the gate-off path);
  // per lib/CLAUDE.md doctrine comparisons use String(id).
  const normalizeId = (node) => ({ ...node, id: String(node.id) });
  const hydratedNodes = new Map(hydration.state.memory.nodes.map((node) => [String(node.id), normalizeId(node)]));
  assert.equal(hydratedNodes.size, live.nodes.length, 'hydrated node count matches live graph');
  for (const node of live.nodes) {
    assert.deepEqual(hydratedNodes.get(String(node.id)), normalizeId(node), `node ${node.id} round-tripped`);
  }
  assert.equal(hydratedNodes.has(String(seeded[3].id)), false, 'removed node stays removed after replay');
  const edgeKey = (edge) => [String(edge.source), String(edge.target)].sort().join('->');
  assert.deepEqual(
    hydration.state.memory.edges.map(edgeKey).sort(),
    live.edges.map(edgeKey).sort(),
    'hydrated edges match live graph',
  );
});

test('base older than fullRewriteIntervalMs rebases with a fresh base', async (t) => {
  const { lockRoot, runDir } = await makeFixture(t);
  const memory = createLiveMemory();
  await seedNodes(memory, 3);

  const armed = { enabled: true, minNodes: 1, fullRewriteIntervalMs: 1 };
  const { options } = saveOptions(memory, lockRoot, { deltaCompaction: armed });
  const first = await persistOnce(runDir, memory, options, 1);
  const firstManifest = await readManifest(runDir);
  await new Promise((resolve) => setTimeout(resolve, 10));

  await memory.addNode('durable rebase semantic concept', 'research', [0.6, 0.8]);
  const { options: options2 } = saveOptions(memory, lockRoot, {
    deltaCompaction: armed,
    deltaExpected: first.deltaExpected,
  });
  const second = await persistOnce(runDir, memory, options2, 2);
  assert.equal(second.compaction.mode, 'full');
  assert.equal(second.compaction.reason, 'base_overdue');
  assert.equal(second.compaction.cleaned, true);
  assert.equal(dirtSize(memory), 0);

  const manifest = await readManifest(runDir);
  assert.notEqual(manifest.generation, firstManifest.generation, 'rebase minted a new generation');
  assert.notEqual(manifest.activeBase.nodes.file, firstManifest.activeBase.nodes.file);
  assert.equal(manifest.activeDelta.count, 0, 'fresh empty delta chain after rebase');
  assert.equal(manifest.summary.nodeCount, memory.nodes.size);
  const baseWrittenAtMs = Date.parse(manifest.baseWrittenAt);
  assert.ok(Number.isFinite(baseWrittenAtMs), 'rebase stamped baseWrittenAt');
});

test('stale expected lineage forces a full rewrite instead of appending', async (t) => {
  const { lockRoot, runDir } = await makeFixture(t);
  const memory = createLiveMemory();
  await seedNodes(memory, 3);

  const { options } = saveOptions(memory, lockRoot);
  const first = await persistOnce(runDir, memory, options, 1);

  await memory.addNode('durable stale-lineage semantic concept', 'research', [0.6, 0.8]);
  const forged = { ...first.deltaExpected, revision: first.deltaExpected.revision + 1 };
  const { options: options2 } = saveOptions(memory, lockRoot, { deltaExpected: forged });
  const second = await persistOnce(runDir, memory, options2, 2);
  assert.equal(second.compaction.mode, 'full');
  assert.equal(second.compaction.reason, 'expected_source_changed');

  const manifest = await readManifest(runDir);
  assert.equal(manifest.activeDelta.count, 0, 'nothing was appended onto the unproven lineage');
  assert.equal(manifest.summary.nodeCount, memory.nodes.size, 'full rewrite persisted the whole graph');
});

test('clean cycle with no changes reuses the committed manifest untouched', async (t) => {
  const { lockRoot, runDir } = await makeFixture(t);
  const memory = createLiveMemory();
  await seedNodes(memory, 3);

  const { options } = saveOptions(memory, lockRoot);
  const first = await persistOnce(runDir, memory, options, 1);
  const before = await readManifest(runDir);

  const { options: options2, getSavedState } = saveOptions(memory, lockRoot, {
    deltaExpected: first.deltaExpected,
  });
  const second = await persistOnce(runDir, memory, options2, 2);
  assert.equal(second.compaction.mode, 'reused');
  assert.equal(second.revision, first.revision);
  const after = await readManifest(runDir);
  assert.deepEqual(after, before, 'manifest bytes semantically untouched by a no-change save');
  assert.equal(getSavedState().memorySourceRevision, first.revision, 'shell still written');
  assert.deepEqual(second.deltaExpected, first.deltaExpected);
});

test('save guard baseline stays authoritative with deltas on', async (t) => {
  const { lockRoot, runDir } = await makeFixture(t);
  const memory = createLiveMemory();
  await seedNodes(memory, 4);

  const { options } = saveOptions(memory, lockRoot);
  const first = await persistOnce(runDir, memory, options, 1);
  await memory.addNode('durable guard semantic concept', 'research', [0.6, 0.8]);
  const { options: options2 } = saveOptions(memory, lockRoot, { deltaExpected: first.deltaExpected });
  const second = await persistOnce(runDir, memory, options2, 2);
  assert.equal(second.compaction.mode, 'delta');

  // No brain-snapshot.json here → the manifest tier resolves, and its
  // summary includes the delta-appended node (never a base-only count).
  const statePath = path.join(runDir, 'state.json');
  const resolved = await resolveKnownGoodNodeCount(runDir, statePath);
  assert.equal(resolved.source, 'memory-manifest');
  assert.equal(resolved.count, memory.nodes.size);

  // The snapshot tier still outranks the manifest when present.
  assert.equal(writeSnapshot(runDir, { nodes: 2, edges: 1, savedAt: new Date().toISOString() }), true);
  const snapshotResolved = await resolveKnownGoodNodeCount(runDir, statePath);
  assert.equal(snapshotResolved.source, 'snapshot');
  assert.equal(snapshotResolved.count, 2);
});

test('orchestrator saveState wires the gate end-to-end and ledgers compaction events', async (t) => {
  const { lockRoot, runDir } = await makeFixture(t);
  const memory = createLiveMemory();
  await seedNodes(memory, 4);
  const events = [];
  const logs = [];
  const noopLogger = {
    info(message, fields) { logs.push({ level: 'info', message, fields }); },
    warn(message, fields) { logs.push({ level: 'warn', message, fields }); },
    error(message, fields) { logs.push({ level: 'error', message, fields }); },
  };
  const fake = {
    evaluation: null,
    cycleCount: 1,
    journal: [],
    memory,
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
    logger: noopLogger,
    eventLedger: { log(name, fields) { events.push({ name, fields }); } },
    config: {
      memorySource: { lockRoot },
      memory: { deltaCompaction: { enabled: true, minNodes: 1 } },
    },
    generateSessionSummary: () => ({ cycleCount: 1 }),
    getProgressMarkers: () => [],
    writeProgressFile: async () => {},
  };
  Object.setPrototypeOf(fake, Orchestrator.prototype);

  const firstResult = await Orchestrator.prototype.saveState.call(fake);
  assert.equal(firstResult.saved, true, JSON.stringify(logs.filter((l) => l.level === 'error')));
  assert.ok(fake._memoryDeltaExpected, 'manifest lineage stashed for the next save');
  const firstEvent = events.find((event) => event.name === 'memory_delta_compaction');
  assert.ok(firstEvent, 'compaction outcome ledgered');
  assert.equal(firstEvent.fields.mode, 'full');
  assert.equal(firstEvent.fields.reason, 'no_expected_source');

  await memory.addNode('durable orchestrator semantic concept', 'research', [0.6, 0.8]);
  fake.cycleCount = 2;
  events.length = 0;
  const secondResult = await Orchestrator.prototype.saveState.call(fake);
  assert.equal(secondResult.saved, true);
  const secondEvent = events.find((event) => event.name === 'memory_delta_compaction');
  assert.equal(secondEvent.fields.mode, 'delta');
  assert.equal(secondEvent.fields.reason, null);
  assert.ok(secondEvent.fields.records > 0);
  const manifest = await readManifest(runDir);
  assert.equal(fake._memoryDeltaExpected.revision, manifest.currentRevision);
  assert.equal(manifest.summary.nodeCount, memory.nodes.size);
  await fake._backupPromise;
});

```

## API NOTES

VALIDATION RECEIPT + REVERT: I validated by applying every code hunk to the live tree and running: new suite 8/8 PASS; regression research-memory-manifest + state-hydration + brain-snapshot-guard + merge-engine-state-io 34/34 PASS; cluster-aware-memory-persistence + network-memory-embedding-batch + crash-recovery-scalar-checkpoints + graceful-shutdown-honesty 76/76 PASS (node --test, root harness). All edits were then reverted byte-exact — verified `git diff --quiet` clean on cosmo23/lib/memory-sidecar.js, cosmo23/engine/src/memory/network-memory.js, cosmo23/engine/src/core/orchestrator.js, cosmo23/engine/src/core/brain-snapshot.js, and the test file deleted. package.json / package-test-registration / CLAUDE.md were never touched during validation (I ran the test file directly). CONCURRENCY WARNING: another session was actively applying/reverting its own Fix-3.x validation edits in memory-sidecar.js AND orchestrator.js while I worked (its restore clobbered my in-flight hunks twice); implementer should re-verify each anchor with grep immediately before editing — all 11 anchors were grep-unique with zero trailing whitespace at hand-off time. The sibling's likely landing change (per-record capture rework of normalizeResearchGraph/captureResearchState in memory-sidecar.js) does NOT overlap any of my anchors; my hunks applied cleanly on both file variants. GUARD COMPOSITION (asked explicitly): brain-snapshot resolveKnownGoodNodeCount stays correct with deltas ON — tier order is snapshot → memory-manifest → sidecar-count → legacy state; every delta append refreshes manifest.summary via options.summary (writer.cjs validateScalarSummaryOnly + appendMemoryRevision `summary: capturedSummary || manifest.summary`), so the manifest tier carries CURRENT totals including delta effects (pinned by test 'save guard baseline stays authoritative'); the undercounting sidecar-count tier is unreachable for manifest-backed runs (bases are memory-nodes.base-N.jsonl.gz; nodesPath() = legacy memory-nodes.jsonl.gz doesn't exist) and only its stale comment needed fixing. hydrateStateMemory's snapshot guard (expectedNodes>=100 && loaded 0) also stays correct because the reader replays deltas before counting. DONOR MISMATCHES FOUND (G6, verify-not-assume): (1) Home23's capturePersistenceChangesSnapshot uses serializeNodePersistenceRecord full clones + assertUniqueLogicalNodeIds + distinct-node.cluster clusterCount; cosmo23's port deliberately diverges — exportGraph-projected records (cosmo23 full saves persist a PROJECTION dropping summary/keyPhrase/metadata/type; raw clones would make node shape depend on save path) and clusters.size (must match researchSummary over exportGraph, else eligibility would spuriously fail). (2) Home23's persistMemoryRevision appends onto whatever manifest exists; cosmo23's port is STRICTER — it requires the CAS lineage from this process's previous save (writer's expectedGeneration/Revision/Digest contract), because cosmo23's degraded-inline fallback can leave a STALE manifest on disk that Home23's flow never produces; cost is one full rewrite per process boot (= today's behavior anyway). KNOWN EXPOSURE (documented, accepted): in-place field mutations that bypass dirty marking are count-invisible (loadState's embedding backfill; any external module poking node fields) — bounded by the 6h rebase exactly as in the Home23 donor; count-visible barrier bypasses (loadState skipping corrupted edges, stale manifests) ARE caught by deltaDriftExplained/CAS and force a full rewrite. PRE-EXISTING QUIRK (not introduced by this change, verified on the gate-off path): the shared reader normalizes node ids to strings on hydration (numeric id 1 → '1') while edge source/target keep their type; cosmo23 doctrine already mandates String(id) comparisons and nextNodeId survives via the shell scalars, but this deserves its own look someday — flag it, don't fix it here. CONFIG PLUMBING: `memory:` is a new top-level engine-config block (this.config.memory was unused; conventions match backups/watchdog/memorySource); absent config = gate off = bit-identical, so no launcher/config-generator change is needed for Phase 3 (operators hand-edit run config.yaml to arm). API SHAPE: persistResearchState options gain liveMemory / deltaCompaction {enabled,minNodes,fullRewriteIntervalMs} / deltaExpected {generation,revision,digest}; non-degraded result gains compaction {mode:'full'|'delta'|'reused', reason?, cleaned, counts?} and deltaExpected ONLY when armed. Ledger event 'memory_delta_compaction' (orchestrator, fire-and-forget) carries cycle/mode/reason/cleaned/revision/nodes/edges + append counts (G1 logging). merge-engine/brain-backups/persistResearchMemoryRevision callers pass none of the new options → unchanged; brain-backups contends on the same withMemorySourceLock as appendMemoryRevision so backups stay coherent (G3). Registration: package.json scripts.test chain AND tests/cosmo23/package-test-registration.test.cjs list, exactly once each — both files carry foreign uncommitted hunks, stage surgically with git add -p.
