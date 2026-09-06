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
    // Task 3 lock wrapper: saveState() delegates to _saveStateUnlocked(), so the
    // fake carries the real unlocked body and an idle lock slot.
    _saveStatePromise: null,
    _saveStateUnlocked: Orchestrator.prototype._saveStateUnlocked,
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

async function saveStateAndSettleBackup(fake) {
  const result = await Orchestrator.prototype.saveState.call(fake);
  // saveState deliberately leaves the interval-gated brain backup running in
  // the background on the cycle path. Real-save tests own temporary run dirs,
  // so settle that explicit lifecycle promise before their teardown removes
  // the directory. Otherwise the copy can race rmSync and intermittently
  // recreate an entry beneath it (ENOTEMPTY).
  if (fake._backupPromise && typeof fake._backupPromise.then === 'function') {
    await fake._backupPromise;
  }
  return result;
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

test('snapshotNodeCount clamps corrupt counts to safe non-negative integers', () => {
  assert.equal(snapshotNodeCount({ nodes: -5 }), null, 'negative counts are corrupt, not a baseline');
  assert.equal(snapshotNodeCount({ nodeCount: 3.7 }), null, 'non-integer counts are corrupt, not a baseline');
  assert.equal(snapshotNodeCount({ nodes: 0 }), 0, 'zero is a valid count');
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

test('resolveKnownGoodNodeCount fails closed when a state file exists but cannot be loaded', async (t) => {
  const dir = makeBrainDir(t, 'unreadable');
  // A state file EXISTS, so this is NOT a fresh run — an unreadable existing
  // brain must throw (the orchestrator turns that into persistence_guard_failed)
  // rather than resolve to a zero baseline that would bless an overwrite.
  writeCompressedState(dir, { memory: { nodes: [], edges: [] } });
  await assert.rejects(
    resolveKnownGoodNodeCount(dir, path.join(dir, 'state.json'), {
      loadCompressed: async () => { throw new Error('EIO: i/o error, read'); },
    }),
    /EIO/,
  );
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
  const first = await saveStateAndSettleBackup(
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
  const refused = await saveStateAndSettleBackup(
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
  const second = await saveStateAndSettleBackup(
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

test('real saveState refuses with persistence_guard_failed when the existing state is unreadable', async (t) => {
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-guard-unreadable-'));
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  const runDir = path.join(home23Root, 'brains', 'runs', 'guard-run');
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(lockRoot, { recursive: true });
  // Corrupt .gz (salvage-proof) AND corrupt uncompressed fallback: Task 1's
  // loadCompressed throws for this pair instead of returning an empty state.
  // No snapshot/manifest/sidecars, so resolution reaches the state tier.
  fs.writeFileSync(path.join(runDir, 'state.json.gz'), Buffer.from('not gzip at all'));
  fs.writeFileSync(path.join(runDir, 'state.json'), '{not json');
  const logs = [];
  const stateBefore = fs.readFileSync(path.join(runDir, 'state.json.gz'));

  const refused = await saveStateAndSettleBackup(
    makeOrchestratorFake(runDir, lockRoot, memoryGraph('unreadable', 20), 5, logs),
  );
  assert.equal(refused.saved, false);
  assert.equal(refused.reason, 'persistence_guard_failed');
  assert.equal(refused.existingNodes, null);
  assert.equal(refused.currentNodes, 20);
  assert.ok(
    logs.some((entry) => entry.level === 'error' && /REFUSING STATE SAVE/.test(entry.message)),
    'baseline failure must be logged loudly',
  );
  assert.deepEqual(
    fs.readFileSync(path.join(runDir, 'state.json.gz')),
    stateBefore,
    'refused save must not rewrite the unreadable state file',
  );
  assert.equal(fs.existsSync(path.join(runDir, 'memory-manifest.json')), false,
    'refused save must not create sidecar artifacts');
  assert.equal(readSnapshot(runDir), null, 'refused save must not stamp a snapshot');
});

// --- Phase-1 polish (c): save-guard cold-path memoization -------------------
// A legacy run with no brain-snapshot.json resolves its baseline by streaming
// memory-nodes.jsonl.gz. Without the memo, EVERY refused save re-streams the
// sidecar every cycle. The memo caches the cold-path resolution on the
// orchestrator; refused saves reuse it, and only a successful save refreshes
// it. brain-snapshot.json itself stays un-memoized — it is the operator
// escape hatch and must be re-read every save.

test('refused saves reuse the memoized cold-path baseline instead of re-resolving sidecars', async (t) => {
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-guard-memo-'));
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  const runDir = path.join(home23Root, 'brains', 'runs', 'memo-run');
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(lockRoot, { recursive: true });
  const logs = [];

  // Legacy shape: sidecars only — NO snapshot, NO manifest, NO state file.
  writeJsonlGz(
    path.join(runDir, 'memory-nodes.jsonl.gz'),
    Array.from({ length: 200 }, (_, i) => ({ id: `n${i + 1}`, concept: `c${i + 1}` })),
  );
  writeJsonlGz(path.join(runDir, 'memory-edges.jsonl.gz'), []);

  // ONE orchestrator instance across both saves — the memo lives on `this`.
  const fake = makeOrchestratorFake(runDir, lockRoot, memoryGraph('shrunk', 20), 50, logs);

  const first = await saveStateAndSettleBackup(fake);
  assert.equal(first.saved, false);
  assert.equal(first.reason, 'catastrophic_node_drop');
  assert.equal(first.existingNodes, 200);
  assert.equal(first.safeguardSource, 'memory-sidecar', 'cold path streamed the sidecar once');
  assert.deepEqual(fake._knownGoodCache, { count: 200, source: 'memory-sidecar' },
    'cold-path resolution must be memoized on the orchestrator');

  // Remove the sidecars. If the second refused save re-resolved from disk it
  // would now see a fresh dir (count 0, guard passes) and bless the shrunken
  // overwrite — so a still-refused second save proves the memo was used.
  fs.rmSync(path.join(runDir, 'memory-nodes.jsonl.gz'));
  fs.rmSync(path.join(runDir, 'memory-edges.jsonl.gz'));

  const second = await saveStateAndSettleBackup(fake);
  assert.equal(second.saved, false, 'refused save must reuse the memoized baseline, not re-stream');
  assert.equal(second.reason, 'catastrophic_node_drop');
  assert.equal(second.existingNodes, 200);
});

test('a successful save refreshes the memoized baseline to the just-saved counts', async (t) => {
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-guard-memo-refresh-'));
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  const runDir = path.join(home23Root, 'brains', 'runs', 'memo-run');
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(lockRoot, { recursive: true });
  const logs = [];

  const fake = makeOrchestratorFake(runDir, lockRoot, memoryGraph('grow', 200), 2, logs);
  const result = await saveStateAndSettleBackup(fake);

  assert.equal(result.saved, true);
  assert.deepEqual(fake._knownGoodCache, { count: 200, source: 'snapshot' },
    'successful save must set the cache to the new truth (mirrors the snapshot stamp)');
});

test('cache provenance is honest when the snapshot stamp fails: last-save, not snapshot', async (t) => {
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-guard-provenance-'));
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  const runDir = path.join(home23Root, 'brains', 'runs', 'provenance-run');
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(lockRoot, { recursive: true });
  const logs = [];

  // Force the post-save snapshot stamp to fail: brain-snapshot.json is a
  // DIRECTORY, so writeSnapshot's tmp→target rename throws and it returns
  // false. readSnapshot on the directory returns null, so the guard's tier-1
  // read stays a clean miss too.
  fs.mkdirSync(path.join(runDir, 'brain-snapshot.json'));

  const fake = makeOrchestratorFake(runDir, lockRoot, memoryGraph('grow', 200), 2, logs);
  const result = await saveStateAndSettleBackup(fake);

  assert.equal(result.saved, true);
  assert.deepEqual(fake._knownGoodCache, { count: 200, source: 'last-save' },
    'no snapshot landed on disk — the cache must not claim snapshot provenance');
});

test('operator escape hatch survives memoization: editing brain-snapshot.json down is honored without a restart', async (t) => {
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-guard-hatch-'));
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  const runDir = path.join(home23Root, 'brains', 'runs', 'hatch-run');
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(lockRoot, { recursive: true });
  const logs = [];

  // ONE long-lived orchestrator instance: warm cache, then a legitimate prune.
  const fake = makeOrchestratorFake(runDir, lockRoot, memoryGraph('big', 200), 2, logs);
  const grow = await saveStateAndSettleBackup(fake);
  assert.equal(grow.saved, true);

  // Legitimate prune to 60 nodes: refused every cycle (60 < 50% of 200).
  fake.cycleCount = 50;
  fake.memory = { exportGraph: () => memoryGraph('pruned', 60) };
  const refused = await saveStateAndSettleBackup(fake);
  assert.equal(refused.saved, false);
  assert.equal(refused.reason, 'catastrophic_node_drop');
  assert.equal(refused.existingNodes, 200);

  // Documented intervention: the operator edits the snapshot counts down.
  // The snapshot tier must be re-read every save — a memo that hides it
  // would dead-end the escape hatch until a process restart.
  writeSnapshot(runDir, {
    nodes: 60, edges: 59, savedAt: new Date().toISOString(), generation: null,
    nodeCount: 60, edgeCount: 59,
  });

  fake.cycleCount = 51;
  const approved = await saveStateAndSettleBackup(fake);
  assert.equal(approved.saved, true,
    'edited snapshot must take effect on the very next save, no restart');
  assert.equal(approved.existingNodes, 60, 'baseline comes from the operator-edited snapshot');
});
