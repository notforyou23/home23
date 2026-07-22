'use strict';

// Fix 3.2 — decay retuned to research timescales + MemoryGovernor enforcement.
//
// Pins, in order:
//  1. gc-policy criteria resolution: memory.gc gate OFF returns the legacy
//     ultra-conservative criteria (weight < 0.01 AND untouched 730+ days)
//     bit-for-bit; ON returns research-lifetime criteria (weight <
//     decay.minimumWeight, untouched > memory.gc.maxAgeDays default 14).
//  2. Governor enforcement gate: memory.governor.applyPruning default FALSE;
//     the legacy memoryGovernance.applyPruning knob does NOT arm live-graph
//     enforcement; batch bound clamped.
//  3. selectGcCandidates hits exactly the intended set on a mixed fixture —
//     protected tags (execution_result / execution_failure et al.),
//     consolidated, merged/inherited, domain-stamped and decay.exemptTags
//     nodes are immune; malformed weight/accessed fail closed.
//  4. The REAL removal path: summarizer.garbageCollect with research criteria
//     removes exactly the intended nodes through NetworkMemory.removeNodes —
//     edges cleaned up, delta tombstones (deletedNodeIds/deletedEdgeKeys)
//     recorded, numeric return preserved.
//  5. applyPruning=false bit-identical pin: advisory evaluate() and unarmed
//     enforce() leave exportGraph() byte-equal.
//  6. Armed enforce(): bounded batches per eval, protected survivors, result
//     payload carries the ledger-event fields, synchronous by contract.
//  7. save-in-flight stand-down: armed enforce() with saveInFlight refuses to
//     mutate.
//  8. Legacy default pin: garbageCollect with no explicit criteria still
//     enforces 0.01 / 730d.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GC_PROTECTED_TAGS,
  LEGACY_GC_CRITERIA,
  resolveResearchGcCriteria,
  resolveGcCriteria,
  resolveGovernorEnforcement,
  isGcProtectedNode,
  selectGcCandidates,
} = require('../../cosmo23/engine/src/memory/gc-policy');
const { NetworkMemory } = require('../../cosmo23/engine/src/memory/network-memory');
const { MemorySummarizer } = require('../../cosmo23/engine/src/memory/summarizer');
const { MemoryGovernor } = require('../../cosmo23/engine/src/system/memory-governor');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const quietLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function makeNode(id, overrides = {}) {
  const ageDays = overrides.ageDays ?? 30;
  const accessed = overrides.accessed ?? new Date(NOW - ageDays * DAY_MS);
  const node = {
    id,
    concept: `concept ${id}`,
    tag: 'thought',
    embedding: null,
    weight: 0.05,
    activation: 0.1,
    cluster: 1,
    created: accessed,
    accessed,
    accessCount: 0,
    ...overrides,
  };
  delete node.ageDays;
  return node;
}

// Real-behavior fixture: NetworkMemory.prototype methods over hand-built
// graph state, so removeNodes / withPersistenceBarrier / exportGraph are the
// production implementations, not stubs.
function buildMemoryFixture(nodes, edges = []) {
  const memory = Object.create(NetworkMemory.prototype);
  memory.config = { decay: { minimumWeight: 0.1 } };
  memory.logger = null;
  memory.events = { emitEvent() {}, emit() {} };
  memory.nodes = new Map();
  memory.edges = new Map();
  memory.clusters = new Map();
  memory.activations = new Map();
  memory.nextNodeId = 1;
  memory.nextClusterId = 2;
  memory.nodeIdFormat = 'numeric';
  memory.nodeIdPrefix = null;
  memory.persistenceRevision = 0;
  memory.persistenceGeneration = 0;
  memory.persistenceBarrierActive = false;
  memory.dirtyNodeIds = new Set();
  memory.dirtyEdgeKeys = new Set();
  memory.deletedNodeIds = new Set();
  memory.deletedEdgeKeys = new Set();

  const clusterMembers = new Set();
  for (const node of nodes) {
    memory.nodes.set(node.id, node);
    clusterMembers.add(node.id);
  }
  memory.clusters.set(1, clusterMembers);

  for (const [a, b] of edges) {
    const pair = [a, b].sort((x, y) => String(x).localeCompare(String(y)));
    const key = pair.join('->');
    memory.edges.set(key, {
      source: pair[0],
      target: pair[1],
      weight: 0.3,
      type: 'associative',
      created: new Date(NOW - 30 * DAY_MS),
      accessed: new Date(NOW - 30 * DAY_MS),
    });
  }
  return memory;
}

function runGarbageCollect(memory, ...criteriaArgs) {
  return MemorySummarizer.prototype.garbageCollect.call(
    { logger: quietLogger },
    memory,
    ...criteriaArgs,
  );
}

test('resolveGcCriteria: gate off returns the legacy ultra-conservative criteria bit-for-bit', () => {
  for (const config of [
    undefined,
    {},
    { memory: {} },
    { memory: { gc: {} } },
    { memory: { gc: { enabled: false, maxAgeDays: 3 } } },
    { memory: { gc: { enabled: 'true' } } }, // strings never arm the gate
  ]) {
    const criteria = resolveGcCriteria(config);
    assert.deepEqual(
      { enabled: criteria.enabled, minWeight: criteria.minWeight, maxAgeDays: criteria.maxAgeDays },
      { enabled: false, minWeight: 0.01, maxAgeDays: 730 },
    );
  }
  assert.equal(LEGACY_GC_CRITERIA.minWeight, 0.01);
  assert.equal(LEGACY_GC_CRITERIA.maxAgeDays, 730);
});

test('resolveGcCriteria: gate on resolves research-lifetime criteria with decay.minimumWeight fallback', () => {
  const enabled = resolveGcCriteria({
    memory: { gc: { enabled: true } },
    architecture: { memory: { decay: { minimumWeight: 0.1 } } },
  });
  assert.deepEqual(
    { enabled: enabled.enabled, minWeight: enabled.minWeight, maxAgeDays: enabled.maxAgeDays },
    { enabled: true, minWeight: 0.1, maxAgeDays: 14 },
  );

  const overridden = resolveGcCriteria({
    memory: { gc: { enabled: true, minWeight: 0.25, maxAgeDays: 3 } },
  });
  assert.equal(overridden.minWeight, 0.25);
  assert.equal(overridden.maxAgeDays, 3);

  // Garbage values fall back instead of arming nonsense criteria.
  const garbage = resolveResearchGcCriteria({
    memory: { gc: { enabled: true, minWeight: 'lots', maxAgeDays: -5 } },
    architecture: { memory: { decay: { minimumWeight: 'also garbage' } } },
  });
  assert.equal(garbage.minWeight, 0.1);
  assert.equal(garbage.maxAgeDays, 14);
});

test('resolveGovernorEnforcement: default OFF, legacy memoryGovernance knob does not arm it, batch bound clamped', () => {
  assert.equal(resolveGovernorEnforcement().applyPruning, false);
  assert.equal(resolveGovernorEnforcement({}).applyPruning, false);
  // The legacy advisory knob must NOT arm live-graph enforcement.
  assert.equal(
    resolveGovernorEnforcement({ memoryGovernance: { enabled: true, applyPruning: true } }).applyPruning,
    false,
  );
  assert.equal(
    resolveGovernorEnforcement({ memory: { governor: { applyPruning: true } } }).applyPruning,
    true,
  );
  assert.equal(resolveGovernorEnforcement({}).maxPrunesPerEval, 50);
  assert.equal(
    resolveGovernorEnforcement({ memory: { governor: { maxPrunesPerEval: 7 } } }).maxPrunesPerEval,
    7,
  );
  assert.equal(
    resolveGovernorEnforcement({ memory: { governor: { maxPrunesPerEval: 999999 } } }).maxPrunesPerEval,
    1000,
  );
  assert.equal(
    resolveGovernorEnforcement({ memory: { governor: { maxPrunesPerEval: -3 } } }).maxPrunesPerEval,
    50,
  );
});

test('protected-tag set: execution_result / execution_failure and the full summarizer list stay exempt', () => {
  for (const tag of [
    'agent_insight', 'agent_finding', 'mission_plan', 'cross_agent_pattern',
    'consolidated', 'breakthrough', 'synthesis', 'goal', 'milestone',
    'research', 'analysis', 'important', 'core', 'foundation',
    'execution_result', 'execution_failure', 'capability_gap', 'disconfirmation',
  ]) {
    assert.equal(GC_PROTECTED_TAGS.has(tag), true, `expected protected tag: ${tag}`);
    assert.equal(isGcProtectedNode(makeNode(1, { tag, weight: 0, ageDays: 5000 })), true);
  }
  assert.equal(GC_PROTECTED_TAGS.size, 18);
  assert.equal(isGcProtectedNode(makeNode(2, { consolidatedAt: new Date() })), true);
  assert.equal(isGcProtectedNode(makeNode(3, { sourceRuns: ['run-a'] })), true);
  assert.equal(isGcProtectedNode(makeNode(4, { mergedAt: new Date() })), true);
  assert.equal(isGcProtectedNode(makeNode(5, { inheritedArtifact: true })), true);
  assert.equal(isGcProtectedNode(makeNode(6, { domain: 'physics' })), true);
  assert.equal(isGcProtectedNode(makeNode(7, { domain: 'unknown' })), false);
  assert.equal(isGcProtectedNode(makeNode(8, { tag: 'custom_keep' }), ['custom_keep']), true);
  assert.equal(isGcProtectedNode(makeNode(9, { tag: 'custom_keep' }), new Set(['custom_keep'])), true);
  assert.equal(isGcProtectedNode(null), true); // fail-closed
});

test('selectGcCandidates: mixed fixture hits exactly the intended set, fail-closed on malformed fields', () => {
  const criteria = { enabled: true, minWeight: 0.1, maxAgeDays: 14 };
  const memory = buildMemoryFixture([
    makeNode(1, { weight: 0.05, ageDays: 20 }),                       // eligible
    makeNode(2, { weight: 0.09, ageDays: 15 }),                       // eligible
    makeNode(3, { weight: 0.05, ageDays: 2 }),                        // too fresh
    makeNode(4, { weight: 0.5, ageDays: 200 }),                       // weight too high
    makeNode(5, { weight: 0.0, ageDays: 400, tag: 'execution_result' }),   // protected
    makeNode(6, { weight: 0.0, ageDays: 400, tag: 'execution_failure' }),  // protected
    makeNode(7, { weight: 0.0, ageDays: 400, consolidatedAt: new Date() }),// protected
    makeNode(8, { weight: 0.0, ageDays: 400, sourceRuns: ['r'] }),    // protected (merged)
    makeNode(9, { weight: 0.0, ageDays: 400, tag: 'custom_keep' }),   // decay.exemptTags
    makeNode(10, { weight: NaN, ageDays: 400 }),                      // fail-closed
    makeNode(11, { weight: 0.05, accessed: 'not-a-date', ageDays: 0 }), // fail-closed
    makeNode(12, { weight: 0.05, ageDays: 20 }),                      // eligible
  ]);

  const candidates = selectGcCandidates(memory, criteria, {
    now: NOW,
    extraExemptTags: ['custom_keep'],
  });
  assert.deepEqual(candidates.sort((a, b) => a - b), [1, 2, 12]);

  const bounded = selectGcCandidates(memory, criteria, {
    now: NOW,
    extraExemptTags: ['custom_keep'],
    limit: 2,
  });
  assert.equal(bounded.length, 2);

  assert.deepEqual(selectGcCandidates({}, criteria), []);
  assert.deepEqual(selectGcCandidates(null, criteria), []);
});

test('summarizer.garbageCollect with research criteria removes exactly the intended set through the real removal path', () => {
  const memory = buildMemoryFixture(
    [
      makeNode(1, { weight: 0.05, ageDays: 20 }),                        // removed
      makeNode(2, { weight: 0.01, ageDays: 60 }),                        // removed
      makeNode(3, { weight: 0.05, ageDays: 2 }),                         // survives: fresh
      makeNode(4, { weight: 0.5, ageDays: 200 }),                        // survives: weight
      makeNode(5, { weight: 0.0, ageDays: 400, tag: 'execution_result' }),  // survives: protected
      makeNode(6, { weight: 0.0, ageDays: 400, tag: 'execution_failure' }), // survives: protected
      makeNode(7, { weight: 0.0, ageDays: 400, consolidatedAt: new Date() }),
      makeNode(8, { weight: 0.0, ageDays: 400, mergedAt: new Date() }),
    ],
    [[1, 4], [2, 5], [4, 5], [3, 6]],
  );

  const removed = runGarbageCollect(memory, 0.1, 14);

  assert.equal(typeof removed, 'number'); // numeric return contract preserved
  assert.equal(removed, 2);
  assert.deepEqual(Array.from(memory.nodes.keys()).sort((a, b) => a - b), [3, 4, 5, 6, 7, 8]);
  // Edges touching removed nodes are gone; the rest survive.
  assert.equal(memory.edges.has('1->4'), false);
  assert.equal(memory.edges.has('2->5'), false);
  assert.equal(memory.edges.has('4->5'), true);
  assert.equal(memory.edges.has('3->6'), true);
  // Removal is tombstoned for the delta/manifest protocol.
  assert.deepEqual(Array.from(memory.deletedNodeIds).sort((a, b) => a - b), [1, 2]);
  assert.equal(memory.deletedEdgeKeys.has('1->4'), true);
  assert.equal(memory.deletedEdgeKeys.has('2->5'), true);
  // Cluster membership pruned with the nodes.
  assert.equal(memory.clusters.get(1).has(1), false);
  assert.equal(memory.clusters.get(1).has(4), true);
});

test('summarizer.garbageCollect default criteria still enforce 0.01 / 730d (legacy pin)', () => {
  const memory = buildMemoryFixture([
    makeNode(1, { weight: 0.005, ageDays: 400 }), // old + tiny, but < 730d → survives defaults
    makeNode(2, { weight: 0.005, ageDays: 800 }), // beyond 730d → removed by defaults
    makeNode(3, { weight: 0.05, ageDays: 800 }),  // weight >= 0.01 → survives defaults
  ]);
  const removed = runGarbageCollect(memory);
  assert.equal(removed, 1);
  assert.deepEqual(Array.from(memory.nodes.keys()).sort((a, b) => a - b), [1, 3]);
});

test('applyPruning=false pin: advisory evaluate() and unarmed enforce() leave the graph bit-identical', () => {
  const memory = buildMemoryFixture(
    [
      makeNode(1, { weight: 0.05, ageDays: 20 }),
      makeNode(2, { weight: 0.0, ageDays: 400, tag: 'execution_result' }),
      makeNode(3, { weight: 0.5, ageDays: 2 }),
    ],
    [[1, 3]],
  );
  const config = {
    memoryGovernance: { enabled: true, applyPruning: false },
    architecture: { memory: { decay: { minimumWeight: 0.1, exemptTags: [] } } },
    // no memory.governor block → enforcement stays OFF by default
  };
  const governor = new MemoryGovernor(config, quietLogger, memory);

  // Populate the legacy registry so the advisory path actually produces
  // candidates (in production nothing calls registerNode — the registry is
  // empty and evaluate() is inert; this exercises the worst case).
  governor.registerNode(1, { activation: 1.0, cycle: 0 });
  governor.registerNode(3, { activation: 1.0, cycle: 0 });

  const before = JSON.stringify(memory.exportGraph());
  const evaluation = governor.evaluate(10000);
  assert.ok(Array.isArray(evaluation.pruneCandidates));
  assert.ok(evaluation.pruneCandidates.length > 0, 'advisory path should identify candidates');
  assert.equal(JSON.stringify(memory.exportGraph()), before, 'advisory evaluate() must not mutate the graph');

  const enforcement = governor.enforce(10000, {});
  assert.equal(enforcement.applied, false);
  assert.equal(enforcement.skipped, 'not_armed');
  assert.equal(enforcement.removedNodes, 0);
  assert.equal(JSON.stringify(memory.exportGraph()), before, 'unarmed enforce() must not mutate the graph');

  // Legacy knob alone must not arm enforcement either.
  const legacyArmed = new MemoryGovernor(
    { memoryGovernance: { enabled: true, applyPruning: true } },
    quietLogger,
    memory,
  );
  const legacyResult = legacyArmed.enforce(10000, {});
  assert.equal(legacyResult.skipped, 'not_armed');
  assert.equal(JSON.stringify(memory.exportGraph()), before);
});

test('armed enforce(): bounded batches, protected survivors, ledger-ready payload, synchronous', () => {
  const nodes = [];
  for (let i = 1; i <= 12; i++) {
    nodes.push(makeNode(i, { weight: 0.05, ageDays: 30 })); // eligible garbage
  }
  nodes.push(makeNode(100, { weight: 0.0, ageDays: 400, tag: 'execution_result' }));
  nodes.push(makeNode(101, { weight: 0.0, ageDays: 400, tag: 'custom_keep' }));
  nodes.push(makeNode(102, { weight: 0.05, ageDays: 1 })); // fresh
  const memory = buildMemoryFixture(nodes, [[1, 100], [2, 3]]);

  const config = {
    memory: { governor: { applyPruning: true, maxPrunesPerEval: 5 } },
    architecture: { memory: { decay: { minimumWeight: 0.1, exemptTags: ['custom_keep'] } } },
  };
  const governor = new MemoryGovernor(config, quietLogger, memory);

  const first = governor.enforce(20, { now: NOW });
  assert.equal(typeof first.then, 'undefined', 'enforce() must be synchronous');
  assert.equal(first.applied, true);
  assert.equal(first.removedNodes, 5, 'bounded batch respected');
  assert.equal(first.batchLimit, 5);
  assert.equal(first.candidateCount, 5);
  assert.equal(first.criteria.minWeight, 0.1);
  assert.equal(first.criteria.maxAgeDays, 14);
  assert.ok(Array.isArray(first.nodeIds) && first.nodeIds.length === 5);
  assert.equal(memory.nodes.size, 15 - 5);

  const second = governor.enforce(40, { now: NOW });
  assert.equal(second.removedNodes, 5);
  const third = governor.enforce(60, { now: NOW });
  assert.equal(third.removedNodes, 2, 'only the remaining eligible nodes are pruned');
  const fourth = governor.enforce(80, { now: NOW });
  assert.equal(fourth.applied, true);
  assert.equal(fourth.removedNodes, 0, 'steady state: nothing eligible left');

  // Survivors: protected tag, decay-exempt custom tag, fresh node.
  assert.deepEqual(Array.from(memory.nodes.keys()).sort((a, b) => a - b), [100, 101, 102]);
  // Edges referencing pruned nodes were cleaned through the real removal path.
  assert.equal(memory.edges.has('2->3'), false);
  assert.equal(memory.edges.size, 0);
  assert.equal(memory.deletedNodeIds.size, 12);
});

test('armed enforce() stands down while a save is in flight', () => {
  const memory = buildMemoryFixture([
    makeNode(1, { weight: 0.05, ageDays: 30 }),
    makeNode(2, { weight: 0.05, ageDays: 30 }),
  ]);
  const config = {
    memory: { governor: { applyPruning: true, maxPrunesPerEval: 5 } },
    architecture: { memory: { decay: { minimumWeight: 0.1, exemptTags: [] } } },
  };
  const governor = new MemoryGovernor(config, quietLogger, memory);
  const before = JSON.stringify(memory.exportGraph());

  const result = governor.enforce(20, { saveInFlight: true, now: NOW });
  assert.equal(result.applied, false);
  assert.equal(result.skipped, 'save_in_flight');
  assert.equal(result.removedNodes, 0);
  assert.equal(JSON.stringify(memory.exportGraph()), before, 'no mutation while a save is in flight');

  const after = governor.enforce(20, { saveInFlight: false, now: NOW });
  assert.equal(after.removedNodes, 2, 'same evaluation succeeds once the save window closes');
});
