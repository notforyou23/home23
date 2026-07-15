import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DiscoveryEngine } = require('../../../engine/src/cognition/discovery-engine.js');

function node(id, fields = {}) {
  return { id, concept: id, created: new Date().toISOString(), accessed: new Date().toISOString(), ...fields };
}

test('discovery novelty applies the same authority policy as retrieval', () => {
  const current = node('current', {
    tag: 'state_snapshot', asserted_at: new Date().toISOString(),
    provenance: { authority: { presentTenseAuthority: true, temporalStatus: 'current' }, source_refs: ['probe:current'] },
    evidence: { evidence_links: ['verifier:current'] },
  });
  const report = node('report', { tag: 'synthesis_report', activation: 100, accessCount: 100 });
  const memory = { nodes: new Map([[current.id, current], [report.id, report]]), edges: new Map(), clusters: new Map() };
  const discovery = new DiscoveryEngine({ memory, logger: { info() {}, warn() {} } });

  const candidates = discovery._probeNovelty().sort((a, b) => b.score - a.score);

  assert.equal(candidates[0].nodeIds[0], 'current');
  assert.ok(candidates[0].score > candidates.find((row) => row.nodeIds[0] === 'report').score);
});

test('discovery orphan age cannot promote a narrative into present-tense authority', () => {
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  const report = node('report', { tag: 'synthesis_report', created: old, accessed: old });
  const evidence = node('evidence', {
    tag: 'state_snapshot', created: old, accessed: old,
    provenance: { authority: { presentTenseAuthority: true, temporalStatus: 'current' }, source_refs: ['probe:evidence'] },
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
  assert.ok(candidates[0].score > candidates.find((row) => row.nodeIds[0] === 'report').score);
});

test('discovery anomaly sizes use only live authority-eligible current nodes', () => {
  const currentA = node('current-a', {
    cluster: 1, tag: 'state_snapshot',
    provenance: { authority: { presentTenseAuthority: true }, source_refs: ['probe:a'] },
    evidence: { evidence_links: ['verifier:a'] },
  });
  const currentB = node('current-b', {
    cluster: 2, tag: 'state_snapshot',
    provenance: { authority: { presentTenseAuthority: true }, source_refs: ['probe:b'] },
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
