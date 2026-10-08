import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getActiveClusterSummary } = require('../../../engine/src/memory/active-clusters.js');
const { attestMemoryAuthority } = require('../../../shared/memory-authority-attestation.cjs');

const AUTHORITY_KEY = '7'.repeat(64);
const priorAuthorityKey = process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = AUTHORITY_KEY;
test.after(() => {
  if (priorAuthorityKey === undefined) delete process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
  else process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = priorAuthorityKey;
});

test('active clusters do not let recent access make an external archive dominate current-state context', async () => {
  const now = Date.now();
  const memory = { nodes: new Map([
    ['archive', {
      id: 'archive', cluster: 1, tag: 'jerry_cron_docs',
      concept: 'Old X digest market signal archive', created: '2025-01-01T00:00:00.000Z',
      accessed: new Date(now).toISOString(), activation: 10, weight: 10,
    }],
    ['live', attestMemoryAuthority({
      id: 'live', cluster: 1, tag: 'state_snapshot', concept: 'Current brain probe is healthy',
      created: new Date(now - 1000).toISOString(),
      asserted_at: new Date(now - 1000).toISOString(), accessed: new Date(now - 60_000).toISOString(),
      provenance: {
        schema: 'home23.node-provenance.v1', authorityClass: 'verified_current_state',
        operationalAuthority: true, sourceRefs: ['probe:brain'], evidenceRefs: ['verifier:brain'],
      },
      evidence: { evidence_links: ['verifier:brain'] }, weight: 1,
    }, AUTHORITY_KEY)],
  ]) };

  const summary = await getActiveClusterSummary(memory, 1, 3, { intent: 'current_state', nowMs: now });

  assert.match(summary, /Current brain probe is healthy/);
  assert.doesNotMatch(summary, /X digest/);
});

test('active clusters omit a claim explicitly superseded by a newer jtr correction', async () => {
  const now = Date.parse('2026-07-14T16:00:00.000Z');
  const memory = { nodes: new Map([
    ['stale', {
      id: 'stale', cluster: 1, concept: 'Brain path uses legacy sidecars.',
      asserted_at: '2026-07-13T12:00:00.000Z', accessed: new Date(now).toISOString(),
      metadata: { source_path: '/tmp/old-receipt.json' },
    }],
    ['correction', attestMemoryAuthority({
      id: 'correction', cluster: 1, concept: 'Brain path uses manifest-v1.',
      created: '2026-07-14T15:00:00.000Z',
      asserted_at: '2026-07-14T15:00:00.000Z', accessed: new Date(now - 1000).toISOString(),
      metadata: { actor: 'jtr', correction: true, supersedes: ['stale'] },
      actor: 'jtr',
      provenance: {
        schema: 'home23.node-provenance.v1', authorityClass: 'jtr_correction',
        sourceRefs: ['turn:correction:user'], evidenceRefs: ['turn:correction:user'],
      },
    }, AUTHORITY_KEY)],
  ]) };

  const summary = await getActiveClusterSummary(memory, 1, 3, {
    intent: 'current_state', nowMs: now,
  });
  assert.match(summary, /manifest-v1/);
  assert.doesNotMatch(summary, /legacy sidecars/);
});

test('active cluster summaries let pending health work run during a large authority scan', async () => {
  const nodes = new Map();
  for (let id = 0; id < 4000; id += 1) {
    nodes.set(id, {
      id, cluster: 1, tag: 'archive', concept: `Historical document ${id}`,
      created: '2025-01-01T00:00:00.000Z',
    });
  }
  let healthRan = false;
  const health = new Promise(resolve => setImmediate(() => {
    healthRan = true;
    resolve();
  }));
  await getActiveClusterSummary({ nodes });
  const ranDuringScan = healthRan;
  await health;
  assert.equal(ranDuringScan, true, 'authority scans must return control before completing the full graph');
});

test('active cluster summaries do not read unused embedding payloads', async () => {
  const now = Date.parse('2026-07-14T16:00:00.000Z');
  const live = attestMemoryAuthority({
    id: 'live', cluster: 1, tag: 'state_snapshot', concept: 'Current brain probe is healthy',
    created: new Date(now - 1000).toISOString(), asserted_at: new Date(now - 1000).toISOString(),
    provenance: {
      schema: 'home23.node-provenance.v1', authorityClass: 'verified_current_state',
      operationalAuthority: true, sourceRefs: ['probe:brain'], evidenceRefs: ['verifier:brain'],
    },
  }, AUTHORITY_KEY);
  let embeddingReads = 0;
  Object.defineProperty(live, 'embedding', {
    enumerable: true,
    get() { embeddingReads += 1; throw new Error('summary must not hydrate embeddings'); },
  });
  const summary = await getActiveClusterSummary({ nodes: new Map([['live', live]]) }, 1, 3, { nowMs: now });
  assert.equal(embeddingReads, 0);
  assert.match(summary, /Current brain probe is healthy/);
});

for (const mutation of ['generation', 'same-size replacement', 'replacement ahead of the scan']) {
  test(`active cluster summaries discard a scan after ${mutation} changes`, async () => {
    const nodes = new Map();
    for (let id = 0; id < 4000; id += 1) {
      nodes.set(id, {
        id, cluster: 1, tag: 'archive', concept: `Historical document ${id}`,
        created: '2025-01-01T00:00:00.000Z',
      });
    }
    const memory = { nodes, persistenceGeneration: 1 };
    let changed = false;
    const change = new Promise(resolve => setImmediate(() => {
      if (mutation === 'generation') memory.persistenceGeneration += 1;
      else {
        const id = mutation === 'replacement ahead of the scan' ? 3999 : 0;
        nodes.set(id, { ...nodes.get(id), concept: 'Replacement document' });
      }
      changed = true;
      resolve();
    }));
    const summary = await getActiveClusterSummary(memory, 1, 1, { intent: 'general' });
    const changedDuringScan = changed;
    await change;
    assert.equal(changedDuringScan, true);
    assert.equal(summary, null, 'a summary must not combine different graph versions');
  });
}

test('active cluster summaries fence instrumented in-place node mutations', async () => {
  const { NetworkMemory } = require('../../../engine/src/memory/network-memory.js');
  const { ClusterAwareMemory } = require('../../../engine/src/cluster/cluster-aware-memory.js');
  const local = new NetworkMemory({}, { info() {}, debug() {}, warn() {} });
  try {
    const memory = new ClusterAwareMemory(local).getInterface();
    for (let id = 0; id < 4000; id += 1) {
      memory.nodes.set(id, { id, cluster: 1, concept: `Document ${id}`, created: '2025-01-01T00:00:00.000Z' });
    }
    const change = new Promise(resolve => setImmediate(() => {
      memory.nodes.get(0).concept = 'A concurrent edit';
      resolve();
    }));
    const summary = await getActiveClusterSummary(memory, 1, 1, { intent: 'general' });
    await change;
    assert.equal(summary, null);
  } finally {
    local.tokenizer?.free?.();
  }
});

test('active cluster summaries apply corrections beyond a cooperative scan slice', async () => {
  const now = Date.parse('2026-07-14T16:00:00.000Z');
  const stale = attestMemoryAuthority({
    id: 'stale', cluster: 1, tag: 'state_snapshot', concept: 'Current probe uses the old path.',
    created: '2026-07-13T12:00:00.000Z', asserted_at: '2026-07-13T12:00:00.000Z',
    provenance: {
      schema: 'home23.node-provenance.v1', authorityClass: 'verified_current_state',
      operationalAuthority: true, sourceRefs: ['probe:old-path'], evidenceRefs: ['verifier:old-path'],
    },
  }, AUTHORITY_KEY);
  const nodes = new Map([['stale', stale]]);
  for (let id = 0; id < 4000; id += 1) {
    nodes.set(id, { id, concept: 'Historical document', created: '2025-01-01T00:00:00.000Z' });
  }
  nodes.set('correction', attestMemoryAuthority({
    id: 'correction', cluster: 1, concept: 'Current probe uses the corrected path.',
    created: '2026-07-14T15:00:00.000Z', asserted_at: '2026-07-14T15:00:00.000Z', actor: 'jtr',
    metadata: { actor: 'jtr', correction: true, supersedes: ['stale'] },
    provenance: {
      schema: 'home23.node-provenance.v1', authorityClass: 'jtr_correction',
      sourceRefs: ['turn:correction:user'], evidenceRefs: ['turn:correction:user'],
    },
  }, AUTHORITY_KEY));
  const summary = await getActiveClusterSummary({ nodes }, 1, 3, { nowMs: now });
  assert.match(summary, /corrected path/);
  assert.doesNotMatch(summary, /old path/);
});
