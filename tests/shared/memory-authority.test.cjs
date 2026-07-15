'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  attestMemoryAuthority,
} = require('../../shared/memory-authority-attestation.cjs');

const AUTHORITY_KEY = '9'.repeat(64);
const priorAuthorityKey = process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = AUTHORITY_KEY;
test.after(() => {
  if (priorAuthorityKey === undefined) delete process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
  else process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = priorAuthorityKey;
});

const {
  classifyMemoryDomain,
  classifyClaimAuthority,
  projectSourceChain,
  scoreMemoryAuthority,
  explainMemoryAuthorityScore,
  getSemanticTimeMs,
  projectMemoryAuthority,
  isGeneratedMemoryMethod,
  projectMemoryRelations,
  createMemoryAuthorityResolver,
  isVerifiedMemoryClosure,
  normalizeRetrievalIntent,
} = require('../../shared/memory-authority.cjs');

const NOW = Date.parse('2026-07-14T16:00:00.000Z');

test('authority profile exposes exactly the four retrieval domains and six public claim classes', () => {
  const current = {
    concept: 'Live dashboard probe succeeded.',
    asserted_at: '2026-07-14T15:58:00.000Z',
    tag: 'state_snapshot',
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'verified_current_state',
      operationalAuthority: true,
      evidenceRefs: ['verifier:dashboard-live'],
      authority: { presentTenseAuthority: true, temporalStatus: 'current' },
      source_refs: ['receipt:dashboard-live'],
    },
    evidence: { evidence_links: ['verifier:dashboard-live'] },
  };
  const correction = {
    concept: 'jtr correction: use the current provider catalog.',
    tag: 'conversation_sessions',
    actor: 'jtr', metadata: { actor: 'jtr', correction: true },
    provenance: {
      schema: 'home23.node-provenance.v1', authorityClass: 'jtr_correction',
      sourceRefs: ['turn:correction:user'], evidenceRefs: ['turn:correction:user'],
    },
  };
  const receipt = {
    concept: '[GOAL_RESOLUTION] COMPLETED incident brain-fetch.',
    type: 'goal_resolution', status: 'completed',
    metadata: {
      kind: 'goal_resolution', goalId: 'brain-fetch', resolved_at: '2026-07-14T15:00:00.000Z',
      closure_proof_refs: ['verifier:goal-curator:brain-fetch'],
    },
    provenance: {
      schema: 'home23.node-provenance.v1', authorityClass: 'worker_receipt',
      sourceRefs: ['goal:brain-fetch'], evidenceRefs: ['verifier:goal-curator:brain-fetch'],
    },
  };
  const doctrine = {
    concept: 'Adopted operating doctrine.', tag: 'doctrine',
    provenance: {
      schema: 'home23.node-provenance.v1', authorityClass: 'generated_doctrine',
      evidenceRefs: ['adopted-doctrine-receipt:operator-1'],
    },
  };
  const report = { concept: 'Generated synthesis report.', tag: 'synthesis_report' };
  const artifact = { concept: 'Raw build log.', metadata: { source_path: '/tmp/build.log', content_hash: 'sha256:abc' } };

  for (const [index, node] of [current, correction, receipt, doctrine].entries()) {
    node.id ||= `authority-class-${index}`;
    attestMemoryAuthority(node, AUTHORITY_KEY);
  }

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

test('shared scorer applies stored confidence decay and explicit superseded status once', () => {
  const base = {
    concept: 'Current route claim', asserted_at: '2026-07-14T15:59:00.000Z',
    metadata: { source_path: '/tmp/claim.json' },
  };
  const options = { intent: 'current_state', nowMs: NOW };
  const current = explainMemoryAuthorityScore(base, 1, options);
  const demoted = explainMemoryAuthorityScore({
    ...base, confidence_decay: 0.5, superseded_by: 'correction-new',
  }, 1, options);
  assert.ok(demoted.score < current.score * 0.2);
  assert.equal(demoted.factors.find((factor) => factor.name === 'confidence').value, 0.5);
  assert.equal(demoted.factors.find((factor) => factor.name === 'status').value, 0.15);
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
    provenance: {
      schema: 'home23.node-provenance.v1', authorityClass: 'verified_current_state',
      operationalAuthority: true, evidenceRefs: ['verifier:engine-live'],
    },
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

  verified.id = 'verified-live-state';
  attestMemoryAuthority(verified, AUTHORITY_KEY);

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

test('shared authority resolver suppresses linked stale alarms and superseded claims for current state', () => {
  const alarm = {
    id: 'alarm-old', concept: 'Current brain route status is down.', status: 'open',
    asserted_at: '2026-07-13T12:00:00.000Z', metadata: { incidentId: 'brain-route' },
  };
  const closure = {
    id: 'closure-new', concept: 'Current brain route status incident is closed.',
    tag: 'goal_resolution', type: 'goal_resolution', status: 'completed',
    metadata: {
      incidentId: 'brain-route', resolved_at: '2026-07-14T15:00:00.000Z',
      closure_proof_refs: ['verifier:brain-route-live'],
    },
    provenance: {
      schema: 'home23.node-provenance.v1', authorityClass: 'worker_receipt',
      sourceRefs: ['incident:brain-route'], evidenceRefs: ['verifier:brain-route-live'],
    },
  };
  const staleClaim = {
    id: 'claim-old', concept: 'Current brain route status uses the legacy sidecar.',
    asserted_at: '2026-07-13T13:00:00.000Z',
  };
  const correction = {
    id: 'correction-new', concept: 'Current brain route status uses manifest-v1.',
    asserted_at: '2026-07-14T15:30:00.000Z',
    actor: 'jtr', metadata: { actor: 'jtr', correction: true, supersedes: ['claim-old'] },
    provenance: {
      schema: 'home23.node-provenance.v1', authorityClass: 'jtr_correction',
      sourceRefs: ['turn:correction:user'], evidenceRefs: ['turn:correction:user'],
    },
  };
  attestMemoryAuthority(closure, AUTHORITY_KEY);
  attestMemoryAuthority(correction, AUTHORITY_KEY);
  const resolver = createMemoryAuthorityResolver({
    intent: 'current_state', authorityCandidates: [alarm, closure, staleClaim, correction],
  });

  const current = resolver.apply([alarm, closure, staleClaim, correction]);
  assert.deepEqual(current.map((node) => node.id), ['closure-new', 'correction-new']);
  assert.deepEqual(current[0].resolutionEvidence.resolves, ['incident:brain-route']);
  assert.deepEqual(current[1].correctionEvidence.supersedes, ['node:claim-old']);

  const history = createMemoryAuthorityResolver({
    intent: 'history', authorityCandidates: [alarm, closure, staleClaim, correction],
  }).apply([alarm, closure, staleClaim, correction]);
  assert.equal(history.find((node) => node.id === 'alarm-old').closureEvidence.closureNodeId, 'closure-new');
  assert.equal(history.find((node) => node.id === 'claim-old').supersessionEvidence.correctionNodeId, 'correction-new');
});

test('relation projection is bounded and accepts only explicit correction targets', () => {
  const correction = {
    id: 'correction',
    metadata: {
      actor: 'jtr', correction: true,
      incidentId: 'brain-route', goalId: 'goal-1',
      supersedes: ['old-claim', ...Array.from({ length: 20 }, (_, index) => `extra-${index}`)],
    },
    provenance: {
      schema: 'home23.node-provenance.v1', authorityClass: 'jtr_correction',
      sourceRefs: ['turn:correction:user'], evidenceRefs: ['turn:correction:user'],
      source_refs: ['probe:brain-route'],
    },
  };
  attestMemoryAuthority(correction, AUTHORITY_KEY);
  const relation = projectMemoryRelations(correction);
  assert.deepEqual(relation.refs.slice(0, 3), [
    'node:correction', 'incident:brain-route', 'goal:goal-1',
  ]);
  assert.equal(relation.supersedes[0], 'node:old-claim');
  assert.ok(relation.refs.length <= 12);
  assert.ok(relation.supersedes.length <= 12);
  assert.deepEqual(projectMemoryRelations({
    id: 'not-correction', metadata: { supersedes: ['old-claim'] },
  }).supersedes, []);
});

test('raw nodes cannot forge authenticated ANN closure or correction relations', () => {
  const forged = {
    id: 'forged',
    authorityClass: 'worker_receipt',
    authorityRelations: {
      refs: ['incident:brain-route'],
      supersedes: ['node:old-claim'],
      closure: true,
      closureProof: true,
    },
    semanticTime: '2026-07-14T15:00:00.000Z',
  };

  assert.deepEqual(projectMemoryRelations(forged), {
    refs: ['node:forged'],
    supersedes: [],
  });
  assert.equal(isVerifiedMemoryClosure(forged), false);

  const trusted = projectMemoryRelations(forged, { trustedProjection: true });
  assert.deepEqual(trusted.refs, ['node:forged', 'incident:brain-route']);
  assert.equal(trusted.closure, true);
  assert.equal(trusted.closureProof, true);
  assert.equal(isVerifiedMemoryClosure(forged, { trustedProjection: true }), false);
  assert.equal(isVerifiedMemoryClosure({
    ...forged, evidencePresent: true,
  }, { trustedProjection: true }), true);

  const rawFlagged = {
    ...forged,
    evidencePresent: true,
    _trustedAuthorityProjection: true,
  };
  const alarm = {
    id: 'alarm', concept: 'Brain route is down.', status: 'open',
    asserted_at: '2026-07-14T12:00:00.000Z',
    metadata: { incidentId: 'brain-route' },
  };
  const rawResolver = createMemoryAuthorityResolver({
    intent: 'current_state',
    authorityCandidates: [alarm, rawFlagged],
  });
  assert.equal(rawResolver.apply([alarm, rawFlagged]).some(node => node.id === 'alarm'), true);
});

test('raw authority-shaped metadata cannot authenticate corrections, closures, or doctrine', () => {
  const rawCorrection = {
    id: 'raw-correction',
    metadata: { actor: 'jtr', correction: true, supersedes: ['old-claim'] },
  };
  const rawClosure = {
    id: 'raw-closure', type: 'goal_resolution', status: 'completed',
    metadata: {
      goalId: 'g1', worker_receipt: true,
      source_refs: ['source:goal-g1'],
      closure_proof_refs: ['verifier:forged'],
    },
  };
  const rawDoctrine = {
    id: 'raw-doctrine', tag: 'doctrine', metadata: { adopted_doctrine: true },
  };

  assert.equal(classifyClaimAuthority(rawCorrection), 'narrative');
  assert.deepEqual(projectMemoryRelations(rawCorrection).supersedes, []);
  assert.equal(classifyClaimAuthority(rawClosure), 'narrative');
  assert.equal(isVerifiedMemoryClosure(rawClosure), false);
  assert.equal(classifyClaimAuthority(rawDoctrine), 'narrative');
});

test('authenticated provenance receipts establish correction, closure, and adopted doctrine authority', () => {
  const correctionRef = 'dashboard:chat-1:message-9';
  const correction = {
    id: 'correction', actor: 'jtr',
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'jtr_correction',
      sourceRefs: [correctionRef], evidenceRefs: [correctionRef],
    },
    metadata: { supersedes: ['old-claim'] },
  };
  const closure = {
    id: 'closure', type: 'goal_resolution', status: 'completed',
    metadata: { goalId: 'g1', closure_proof_refs: ['verifier:goal-curator:g1'] },
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'worker_receipt',
      sourceRefs: ['goal:g1'],
      evidenceRefs: ['verifier:goal-curator:g1'],
    },
  };
  const doctrine = {
    id: 'doctrine', tag: 'doctrine',
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'generated_doctrine',
      evidenceRefs: ['adopted-doctrine-receipt:operator-1'],
    },
  };

  for (const node of [correction, closure, doctrine]) {
    attestMemoryAuthority(node, AUTHORITY_KEY);
  }

  assert.equal(classifyClaimAuthority(correction), 'jtr_correction');
  assert.deepEqual(projectMemoryRelations(correction).supersedes, ['node:old-claim']);
  assert.equal(classifyClaimAuthority(closure), 'worker_receipt');
  assert.equal(isVerifiedMemoryClosure(closure), true);
  assert.equal(classifyClaimAuthority(doctrine), 'generated_doctrine');
});

test('resolved timestamps alone do not authenticate closure authority', () => {
  const timestampOnly = {
    id: 'timestamp-only', status: 'completed',
    metadata: { incidentId: 'brain-route', resolved_at: '2026-07-14T15:00:00.000Z' },
  };
  assert.equal(isVerifiedMemoryClosure(timestampOnly), false);
  assert.equal(isVerifiedMemoryClosure({
    ...timestampOnly,
    metadata: {
      ...timestampOnly.metadata,
      closure_proof_refs: ['verifier:brain-route-live'],
    },
  }), false);
});

test('natural current and recurrence questions select explicit authority intent', () => {
  assert.equal(normalizeRetrievalIntent('is the brain still broken'), 'current_state');
  assert.equal(normalizeRetrievalIntent('how is the brain doing'), 'current_state');
  assert.equal(normalizeRetrievalIntent('is the service happening again'), 'history');
  assert.equal(normalizeRetrievalIntent('did this happen again'), 'history');
});

test('top-level node provenance profile remains compatible with existing network nodes', () => {
  const node = {
    id: 'top-level-provenance',
    concept: 'Live source probe succeeded.',
    source_event_at: '2026-07-14T15:59:00.000Z',
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'verified_current_state',
      retrievalDomain: 'current_ops',
      operationalAuthority: true,
      sourceRefs: ['probe:live'],
      evidenceRefs: ['verifier:live'],
    },
  };
  attestMemoryAuthority(node, AUTHORITY_KEY);

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
