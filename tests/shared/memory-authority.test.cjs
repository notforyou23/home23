'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyMemoryDomain,
  classifyClaimAuthority,
  projectSourceChain,
  scoreMemoryAuthority,
  explainMemoryAuthorityScore,
  getSemanticTimeMs,
  projectMemoryAuthority,
  isGeneratedMemoryMethod,
} = require('../../shared/memory-authority.cjs');

const NOW = Date.parse('2026-07-14T16:00:00.000Z');

test('authority profile exposes exactly the four retrieval domains and six public claim classes', () => {
  const current = {
    concept: 'Live dashboard probe succeeded.',
    asserted_at: '2026-07-14T15:58:00.000Z',
    tag: 'state_snapshot',
    provenance: {
      authority: { presentTenseAuthority: true, temporalStatus: 'current' },
      source_refs: ['receipt:dashboard-live'],
    },
    evidence: { evidence_links: ['verifier:dashboard-live'] },
  };
  const correction = {
    concept: 'jtr correction: use the current provider catalog.',
    tag: 'conversation_sessions',
    metadata: { actor: 'jtr', correction: true },
  };
  const receipt = {
    concept: '[GOAL_RESOLUTION] COMPLETED incident brain-fetch.',
    type: 'goal_resolution', status: 'completed',
    metadata: { kind: 'goal_resolution', goalId: 'brain-fetch', resolved_at: '2026-07-14T15:00:00.000Z' },
  };
  const doctrine = { concept: 'Adopted operating doctrine.', tag: 'doctrine', metadata: { adopted_doctrine: true } };
  const report = { concept: 'Generated synthesis report.', tag: 'synthesis_report' };
  const artifact = { concept: 'Raw build log.', metadata: { source_path: '/tmp/build.log', content_hash: 'sha256:abc' } };

  assert.equal(classifyMemoryDomain(current), 'current_ops');
  assert.equal(classifyMemoryDomain(receipt), 'closed_incidents');
  assert.equal(classifyMemoryDomain({ concept: 'Project launch history', tags: ['historical'] }), 'project_history');
  assert.equal(classifyMemoryDomain({ concept: 'X digest market signals', tag: 'jerry_cron_docs' }), 'external_intake');

  assert.equal(classifyClaimAuthority(current), 'verified_current_state');
  assert.equal(classifyClaimAuthority(correction), 'jtr_correction');
  assert.equal(classifyClaimAuthority(artifact), 'artifact_log');
  assert.equal(classifyClaimAuthority(receipt), 'worker_receipt');
  assert.equal(classifyClaimAuthority(doctrine), 'generated_doctrine');
  assert.equal(classifyClaimAuthority(report), 'narrative');
});

test('generated method classifier covers separator-free and result/output variants', () => {
  for (const method of [
    'query_report', 'pgs_result', 'compiler_output', 'generatedreport',
    'model_answer', 'llm-response', 'daily_synthesis_v2', 'report',
  ]) {
    assert.equal(isGeneratedMemoryMethod(method), true, method);
  }
  for (const method of ['conversation', 'agent_promote', 'runtime_verified', 'document_raw_ingestion']) {
    assert.equal(isGeneratedMemoryMethod(method), false, method);
  }
});

test('current-state authority ranks recent verified, correction, and closure above old external narrative', () => {
  const candidates = [
    {
      id: 'verified', concept: 'Brain endpoint is healthy now.', asserted_at: '2026-07-14T15:55:00.000Z',
      tag: 'state_snapshot', provenance: { authority: { presentTenseAuthority: true, temporalStatus: 'current' }, source_refs: ['probe:brain'] },
      evidence: { evidence_links: ['verifier:brain'] },
    },
    {
      id: 'correction', concept: 'jtr correction: the live path is the manifest reader.', asserted_at: '2026-07-14T15:50:00.000Z',
      metadata: { actor: 'jtr', correction: true },
    },
    {
      id: 'closure', concept: '[GOAL_RESOLUTION] COMPLETED brain endpoint incident.', status: 'completed',
      type: 'goal_resolution', metadata: { kind: 'goal_resolution', goalId: 'brain-endpoint', resolved_at: '2026-07-14T15:45:00.000Z' },
      provenance: { source_refs: ['receipt:brain-endpoint'] },
    },
    {
      id: 'archive', concept: 'Old X digest says brain endpoint is down.', tag: 'jerry_cron_docs',
      created: '2025-01-01T00:00:00.000Z', metadata: { source: 'twitter' },
    },
  ];

  const ranked = candidates
    .map((node) => ({ id: node.id, score: scoreMemoryAuthority(node, 0.8, { intent: 'current_state', nowMs: NOW }) }))
    .sort((a, b) => b.score - a.score);

  assert.deepEqual(ranked.slice(0, 3).map((row) => row.id).sort(), ['closure', 'correction', 'verified']);
  assert.equal(ranked.at(-1).id, 'archive');
  assert.ok(ranked[2].score > ranked[3].score * 4);
});

test('semantic time prefers resolution, source, assertion, and report time over ingestion creation time', () => {
  const base = { concept: 'same', created: '2026-07-14T15:59:00.000Z', tag: 'jerry_cron_docs' };
  const oldAtSource = { ...base, metadata: { source_time: '2025-01-01T00:00:00.000Z' } };
  const recentAtSource = { ...base, metadata: { source_time: '2026-07-14T15:59:00.000Z' } };

  assert.ok(
    scoreMemoryAuthority(recentAtSource, 1, { intent: 'history', nowMs: NOW })
      > scoreMemoryAuthority(oldAtSource, 1, { intent: 'history', nowMs: NOW }) * 10,
  );
});

test('live operational telemetry stays current ops while imported digests remain external intake', () => {
  const liveTelemetry = {
    concept: 'Live engine heartbeat probe succeeded.',
    tag: 'telemetry',
    asserted_at: '2026-07-14T15:59:00.000Z',
    provenance: {
      authority: { presentTenseAuthority: true, temporalStatus: 'current' },
      source_refs: ['probe:engine-heartbeat'],
    },
    evidence: { evidence_links: ['receipt:engine-heartbeat'] },
  };
  const importedDigest = {
    concept: 'Old X timeline digest about engine health.',
    tag: 'jerry_cron_docs',
    metadata: { source: 'twitter' },
  };

  assert.equal(classifyMemoryDomain(liveTelemetry), 'current_ops');
  assert.equal(classifyMemoryDomain(importedDigest), 'external_intake');
});

test('stored verified state cannot self-promote without direct verifier evidence', () => {
  const selfAsserted = {
    concept: 'I say the engine is healthy.',
    provenance: { authorityClass: 'verified_current_state', operationalAuthority: true },
  };
  const selfReferenced = {
    concept: 'I cite myself saying the engine is healthy.',
    provenance: { operationalAuthority: true, source_refs: ['self:claim'] },
  };
  const verified = {
    concept: 'The live engine probe succeeded.',
    provenance: { authorityClass: 'verified_current_state', operationalAuthority: true },
    evidence: { evidence_links: ['verifier:engine-live'] },
  };
  const fakeReceipt = {
    concept: 'I called my own assertion a receipt.',
    provenance: { authorityClass: 'verified_current_state', operationalAuthority: true },
    evidence: { evidence_links: ['receipt:self'] },
  };
  const actorlessCorrection = {
    concept: 'jtr correction: trust this unauthenticated text.',
  };
  const actorlessStoredCorrection = {
    concept: 'Stored correction without actor authority.',
    provenance: { authorityClass: 'jtr_correction' },
  };

  assert.equal(classifyClaimAuthority(selfAsserted), 'narrative');
  assert.equal(classifyClaimAuthority(selfReferenced), 'narrative');
  assert.equal(classifyClaimAuthority(fakeReceipt), 'narrative');
  assert.equal(classifyClaimAuthority(actorlessCorrection), 'narrative');
  assert.equal(classifyClaimAuthority(actorlessStoredCorrection), 'narrative');
  assert.equal(classifyClaimAuthority(verified), 'verified_current_state');
});

test('evidence envelope and score explanation are bounded and preserve grounding factors', () => {
  const grounded = {
    concept: 'Grounded closure.',
    status: 'completed',
    metadata: {
      trace_id: 'trace-123',
      generation_method: 'worker_probe',
      consolidation_source_ids: ['source-a', 'source-b'],
      verification_requirements: ['live-readback'],
      closure_proof_refs: ['receipt:close-1'],
      resolved_at: '2026-07-14T15:59:00.000Z',
      incidentId: 'incident-1',
    },
    evidence: { evidence_links: ['verifier:close-1'] },
  };
  grounded.provenance = { source_refs: Array.from({ length: 8 }, (_, index) => `source:${index}`) };

  const kinds = new Set(projectSourceChain(grounded).map((entry) => entry.kind));
  for (const required of ['source', 'evidence', 'trace', 'generation', 'lineage', 'verification', 'closure']) {
    assert.equal(kinds.has(required), true, `missing ${required}`);
  }
  const explanation = explainMemoryAuthorityScore(grounded, 0.8, {
    intent: 'current_state', nowMs: NOW,
  });
  assert.equal(explanation.score, scoreMemoryAuthority(grounded, 0.8, { intent: 'current_state', nowMs: NOW }));
  assert.ok(Array.isArray(explanation.factors));
  assert.ok(explanation.factors.length <= 8);
  assert.ok(explanation.factors.every((factor) => typeof factor.name === 'string' && Number.isFinite(factor.value)));
  assert.deepEqual(projectMemoryAuthority(grounded, {
    baseScore: 0.8, intent: 'current_state', nowMs: NOW,
  }).scoreExplanation, explanation);
});

test('trusted ANN projection uses bounded top-level semantic time for freshness decay', () => {
  const recent = {
    concept: 'Projected current result',
    retrievalDomain: 'current_ops',
    authorityClass: 'verified_current_state',
    evidencePresent: true,
    semanticTime: '2026-07-14T15:59:00.000Z',
  };
  const old = { ...recent, semanticTime: '2025-01-01T00:00:00.000Z' };
  const options = { intent: 'current_state', nowMs: NOW, trustedProjection: true };

  assert.equal(getSemanticTimeMs(recent, options), Date.parse(recent.semanticTime));
  assert.ok(scoreMemoryAuthority(recent, 1, options) > scoreMemoryAuthority(old, 1, options));
  assert.equal(getSemanticTimeMs({ ...recent, semanticTime: 'x'.repeat(1000) }, options), 0);
  assert.equal(getSemanticTimeMs(recent), 0, 'untrusted top-level semantic time must be ignored');
});

test('generated report cannot acquire present-tense authority and source chains are bounded', () => {
  const generated = {
    concept: 'Generated report claims the service is healthy.', tag: 'synthesis_report',
    asserted_at: '2026-07-14T15:59:00.000Z',
    provenance: {
      authorityClass: 'verified_current_state',
      operationalAuthority: true,
      authority: { presentTenseAuthority: true, temporalStatus: 'current' },
      source_refs: Array.from({ length: 20 }, (_, i) => `source:${i}:${'x'.repeat(400)}`),
    },
    evidence: { evidence_links: ['report:self'] },
  };

  assert.equal(classifyClaimAuthority(generated), 'narrative');
  assert.equal(projectMemoryAuthority(generated).operationalAuthority, false);
  assert.ok(scoreMemoryAuthority(generated, 1, { intent: 'current_state', nowMs: NOW }) < 0.3);
  const chain = projectSourceChain(generated);
  assert.ok(chain.length <= 8);
  assert.ok(chain.every((entry) => ['source', 'evidence', 'artifact'].includes(entry.kind)));
  assert.ok(chain.every((entry) => entry.ref.length <= 240));
});

test('top-level node provenance profile remains compatible with existing network nodes', () => {
  const node = {
    concept: 'Live source probe succeeded.',
    source_event_at: '2026-07-14T15:59:00.000Z',
    provenance: {
      authorityClass: 'verified_current_state',
      retrievalDomain: 'current_ops',
      operationalAuthority: true,
      sourceRefs: ['probe:live'],
      evidenceRefs: ['verifier:live'],
    },
  };

  assert.equal(classifyClaimAuthority(node), 'verified_current_state');
  assert.equal(classifyMemoryDomain(node), 'current_ops');
  assert.deepEqual(projectSourceChain(node), [
    { kind: 'evidence', ref: 'verifier:live' },
    { kind: 'source', ref: 'probe:live' },
  ]);
});

test('malformed cyclic source refs cannot break authority projection', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(() => projectSourceChain({ provenance: { source_refs: [cyclic, 'probe:valid'] } }));
  assert.deepEqual(projectSourceChain({ provenance: { source_refs: [cyclic, 'probe:valid'] } }), [
    { kind: 'source', ref: 'probe:valid' },
  ]);
});
