import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DiscoveryEngine } = require('../../../engine/src/cognition/discovery-engine.js');
const {
  attestMemoryAuthority,
} = require('../../../shared/memory-authority-attestation.cjs');

const AUTHORITY_KEY = '6'.repeat(64);
const priorAuthorityKey = process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = AUTHORITY_KEY;
test.after(() => {
  if (priorAuthorityKey === undefined) delete process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
  else process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = priorAuthorityKey;
});

function node(id, fields = {}) {
  return { id, concept: id, created: new Date().toISOString(), accessed: new Date().toISOString(), ...fields };
}

function authoritativeNode(id, fields) {
  return attestMemoryAuthority(node(id, fields), AUTHORITY_KEY);
}

function verified(ref) {
  return {
    schema: 'home23.node-provenance.v1', authorityClass: 'verified_current_state',
    operationalAuthority: true, evidenceRefs: [`verifier:${ref}`], sourceRefs: [`probe:${ref}`],
  };
}

function correctionProfile(ref) {
  return {
    schema: 'home23.node-provenance.v1', authorityClass: 'jtr_correction',
    sourceRefs: [ref], evidenceRefs: [ref],
  };
}

test('discovery novelty applies the same authority policy as retrieval', () => {
  const current = authoritativeNode('current', {
    tag: 'state_snapshot', asserted_at: new Date().toISOString(),
    provenance: verified('current'),
    evidence: { evidence_links: ['verifier:current'] },
  });
  const report = node('report', { tag: 'synthesis_report', activation: 100, accessCount: 100 });
  const memory = { nodes: new Map([[current.id, current], [report.id, report]]), edges: new Map(), clusters: new Map() };
  const discovery = new DiscoveryEngine({ memory, logger: { info() {}, warn() {} } });

  const candidates = discovery._probeNovelty().sort((a, b) => b.score - a.score);

  assert.equal(candidates[0].nodeIds[0], 'current');
  assert.equal(candidates.some((row) => row.nodeIds[0] === 'report'), false);
});

test('discovery orphan age cannot promote a narrative into present-tense authority', () => {
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  const report = node('report', { tag: 'synthesis_report', created: old, accessed: old });
  const evidence = authoritativeNode('evidence', {
    tag: 'state_snapshot', created: old, accessed: old,
    provenance: verified('evidence'),
    evidence: { evidence_links: ['verifier:evidence'] },
  });
  const edges = new Map();
  for (let i = 0; i < 6; i += 1) {
    edges.set(`report->r${i}`, { source: 'report', target: `r${i}` });
    edges.set(`evidence->e${i}`, { source: 'evidence', target: `e${i}` });
  }
  const memory = { nodes: new Map([[report.id, report], [evidence.id, evidence]]), edges, clusters: new Map() };
  const discovery = new DiscoveryEngine({ memory, logger: { info() {}, warn() {} } });

  const candidates = discovery._probeOrphan().sort((a, b) => b.score - a.score);

  assert.equal(candidates[0].nodeIds[0], 'evidence');
  assert.equal(candidates.some((row) => row.nodeIds[0] === 'report'), false);
});

test('discovery anomaly sizes use only live authority-eligible current nodes', () => {
  const currentA = authoritativeNode('current-a', {
    cluster: 1, tag: 'state_snapshot',
    provenance: verified('a'),
    evidence: { evidence_links: ['verifier:a'] },
  });
  const currentB = authoritativeNode('current-b', {
    cluster: 2, tag: 'state_snapshot',
    provenance: verified('b'),
    evidence: { evidence_links: ['verifier:b'] },
  });
  const nodes = new Map([[currentA.id, currentA], [currentB.id, currentB]]);
  const clusterOne = new Set([currentA.id]);
  for (let i = 0; i < 20; i += 1) {
    const report = node(`report-${i}`, { cluster: 1, tag: 'synthesis_report' });
    nodes.set(report.id, report);
    clusterOne.add(report.id);
  }
  const memory = {
    nodes,
    edges: new Map(),
    clusters: new Map([[1, clusterOne], [2, new Set([currentB.id])]]),
  };
  const discovery = new DiscoveryEngine({ memory, logger: { info() {}, warn() {} } });

  assert.deepEqual(discovery._probeAnomaly(), []);
});

test('discovery authority eligibility excludes a claim superseded by a jtr correction', () => {
  const stale = node('stale', {
    asserted_at: '2026-07-13T12:00:00.000Z',
    metadata: { source_path: '/tmp/old-receipt.json' },
  });
  const correction = authoritativeNode('correction', {
    asserted_at: '2026-07-14T15:00:00.000Z',
    metadata: { actor: 'jtr', correction: true, supersedes: ['stale'] },
    actor: 'jtr',
    provenance: correctionProfile('turn:correction:user'),
  });
  const memory = {
    nodes: new Map([[stale.id, stale], [correction.id, correction]]),
    edges: new Map(), clusters: new Map(),
  };
  const discovery = new DiscoveryEngine({ memory, logger: { info() {}, warn() {} } });

  assert.deepEqual(discovery._authorityEligibleIds(new Set(['stale', 'correction'])), ['correction']);
});

test('stagnation and salience probes emit only current authority-eligible node IDs', () => {
  const now = new Date().toISOString();
  const current = authoritativeNode('current', {
    cluster: 1, tag: 'state_snapshot', asserted_at: now,
    provenance: verified('current'),
    evidence: { evidence_links: ['verifier:current'] },
  });
  const report = node('report', { cluster: 1, tag: 'synthesis_report' });
  const memory = {
    nodes: new Map([[current.id, current], [report.id, report]]),
    edges: new Map(),
    clusters: new Map([[1, new Set([current.id, report.id])]]),
  };
  const thoughts = Array.from({ length: 5 }, (_, index) => ({
    clusterId: 1, timestamp: new Date(Date.now() - (5 - index) * 1000).toISOString(),
  }));
  const discovery = new DiscoveryEngine({
    memory,
    logger: { info() {}, warn() {} },
    getThoughtsHistory: () => thoughts,
    getConversationSalience: () => ({
      topSalientClusters: () => [{ clusterId: 1, score: 1, nodeIds: ['report', 'current'] }],
    }),
  });

  assert.deepEqual(discovery._probeStagnation()[0].nodeIds, ['current']);
  assert.deepEqual(discovery._probeSalience()[0].nodeIds, ['current']);
});
