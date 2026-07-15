import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NetworkMemory } = require('../../../engine/src/memory/network-memory.js');
const {
  scoreMemorySalience,
  scoreMemoryAuthority,
} = require('../../../engine/src/memory/provenance-salience.js');
const {
  classifyClaimAuthority,
  isVerifiedMemoryClosure,
  projectMemoryRelations,
} = require('../../../shared/memory-authority.cjs');
const {
  attestMemoryAuthority,
  verifyMemoryAuthorityAttestation,
} = require('../../../shared/memory-authority-attestation.cjs');

const AUTHORITY_KEY = '5'.repeat(64);
const priorAuthorityKey = process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = AUTHORITY_KEY;
test.after(() => {
  if (priorAuthorityKey === undefined) delete process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
  else process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = priorAuthorityKey;
});

function attestedNode(id, node) {
  const copy = structuredClone(node);
  return attestMemoryAuthority({
    id,
    created: copy.created || copy.asserted_at || '2026-07-14T15:00:00.000Z',
    ...copy,
  }, AUTHORITY_KEY);
}

function makeMemory() {
  const memory = new NetworkMemory({
    embedding: { model: 'test', dimensions: 2 },
    decay: { minimumWeight: 0.1 },
    hebbian: { reinforcementStrength: 0.1 },
    spreading: { bridgeTraversalFactor: 0.2 },
    retrieval: { temporalHalfLifeDays: 14 },
    coordinator: {},
  }, {
    info() {},
    warn() {},
    debug() {},
    error() {},
  });
  memory.embed = async () => [1, 0];
  return memory;
}

function makeMemoryLite() {
  const memory = makeMemory();
  memory.embed = async () => null;
  return memory;
}

function verifiedProvenance(ref) {
  return {
    schema: 'home23.node-provenance.v1', authorityClass: 'verified_current_state',
    operationalAuthority: true, sourceRefs: [`probe:${ref}`], evidenceRefs: [`verifier:${ref}`],
  };
}

function closureProvenance(ref) {
  return {
    schema: 'home23.node-provenance.v1', authorityClass: 'worker_receipt',
    sourceRefs: [`incident:${ref}`], evidenceRefs: [`verifier:${ref}-live`],
  };
}

function correctionProvenance(ref) {
  return {
    schema: 'home23.node-provenance.v1', authorityClass: 'jtr_correction',
    sourceRefs: [ref], evidenceRefs: [ref],
  };
}

function makeRewireMemory() {
  const memory = makeMemory();
  memory.config.smallWorld = {
    ...(memory.config.smallWorld || {}),
    maxRewireEdgesPerRun: 3,
    rewireYieldEvery: 1,
    maxBridgesPerNode: 40,
  };
  for (let id = 1; id <= 30; id++) {
    const cluster = id <= 15 ? 1 : 2;
    memory.nodes.set(id, {
      id,
      concept: `node ${id}`,
      cluster,
      activation: 0,
      created: new Date(),
      accessed: new Date(),
    });
    const set = memory.clusters.get(cluster) || new Set();
    set.add(id);
    memory.clusters.set(cluster, set);
  }
  for (let id = 1; id <= 12; id++) {
    memory.addEdge(id, id + 1, 0.25, 'semantic');
  }
  return memory;
}

function restoreEmbeddingEnv(previous) {
  const entries = {
    EMBEDDING_PROVIDER: previous.provider,
    EMBEDDING_BASE_URL: previous.baseUrl,
    EMBEDDING_MODEL: previous.model,
    EMBEDDING_DIMENSIONS: previous.dimensions,
  };
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('query boosts current state_snapshot above older cue-matched nodes', async () => {
  const memory = makeMemory();

  const old = await memory.addNode('Health shortcut is dark and the bridge is broken.', 'deep_thought', [1, 0]);
  old.created = new Date(Date.now() - 30 * 86400000);
  old.asserted_at = new Date(Date.now() - 30 * 86400000).toISOString();

  const snapshot = await memory.addNode({
    concept: '[STATE_SNAPSHOT] RECENT.md: health bridge is stale at the Pi/HealthKit source; dashboard is live.',
    tag: 'state_snapshot',
    type: 'state_snapshot',
    tags: ['state_snapshot', 'current_state'],
    asserted_at: new Date().toISOString(),
    asserted_cycle: 6299,
    metadata: { kind: 'state_snapshot', source: 'RECENT.md' },
  }, 'state_snapshot', [1, 0]);

  const results = await memory.query('health bridge dashboard', 2);

  assert.equal(results[0].id, snapshot.id);
  assert.ok(results[0].retrievalScore > results[1].retrievalScore);
  assert.equal(results[0].asserted_cycle, 6299);
});

test('retrieval salience demotes cron conversation logs below direct user conversation', async () => {
  const memory = makeMemory();
  const now = Date.parse('2026-05-30T12:00:00.000Z');

  const direct = await memory.addNode({
    concept: 'Channel: dashboard-jerry\n**User:** Fix the brain cleanup scope.',
    tag: 'conversation_sessions',
    created: '2026-05-20T00:00:00.000Z',
  }, 'conversation_sessions', [1, 0]);

  const cron = await memory.addNode({
    concept: 'Channel: cron-agent-1775704909558\n**User:** Run the EVENING-RESEARCH session for Ticker Home23.',
    tag: 'conversation_sessions',
    created: '2026-05-30T00:00:00.000Z',
  }, 'conversation_sessions', [1, 0]);

  const directScore = memory.scoreTemporalRetrieval(direct, 0.5, { nowMs: now });
  const cronScore = memory.scoreTemporalRetrieval(cron, 0.5, { nowMs: now });

  assert.equal(direct.source_class, 'conversation');
  assert.equal(cron.source_class, 'telemetry');
  assert.ok(directScore > cronScore);
});

test('NetworkMemory semantic and keyword routes use the shared authority scorer exactly once', async () => {
  const memory = makeMemoryLite();
  const nowMs = Date.parse('2026-07-14T16:00:00.000Z');
  const node = await memory.addNode({
    concept: 'Current shared scorer canary is healthy.', tag: 'state_snapshot',
    asserted_at: '2026-07-14T15:59:00.000Z',
    provenance: { authority: { presentTenseAuthority: true }, source_refs: ['probe:canary'] },
    evidence: { evidence_links: ['verifier:canary'] },
  }, 'state_snapshot', null);
  const options = { intent: 'current_state', query: 'current shared scorer canary', nowMs };
  assert.equal(
    memory.scoreTemporalRetrieval(node, 0.8, options),
    scoreMemoryAuthority(node, 0.8, options),
  );

  const [keyword] = memory.queryByKeyword('current shared scorer canary', 1, {
    intent: 'current_state', nowMs, markAccess: false,
  });
  assert.equal(
    keyword.retrievalScore,
    scoreMemoryAuthority(keyword, keyword.similarity, options),
  );
});

test('current-state retrieval suppresses an older open alarm when a newer verified closure exists', async () => {
  const memory = makeMemory();
  const alarm = await memory.addNode({
    concept: 'Brain endpoint incident is open and retrieval is down.',
    tag: 'incident', status: 'open', asserted_at: '2026-07-13T12:00:00.000Z',
    metadata: { incidentId: 'brain-fetch' },
  }, 'incident', [1, 0]);
  const closure = await memory.addNode(attestedNode('closure-brain-fetch-current', {
    concept: '[GOAL_RESOLUTION] COMPLETED brain endpoint incident after live probe.',
    tag: 'goal_resolution', type: 'goal_resolution', status: 'completed',
    asserted_at: '2026-07-14T15:00:00.000Z',
    metadata: {
      kind: 'goal_resolution', incidentId: 'brain-fetch',
      resolved_at: '2026-07-14T15:00:00.000Z',
      closure_proof_refs: ['verifier:brain-fetch-live'],
    },
    provenance: closureProvenance('brain-fetch'),
  }), 'goal_resolution', [1, 0]);

  const results = await memory.query('current brain endpoint incident status', 5, {
    intent: 'current_state', markAccess: false, nowMs: Date.parse('2026-07-14T16:00:00.000Z'),
  });

  assert.equal(results[0].id, closure.id);
  assert.equal(results.some((node) => node.id === alarm.id), false);
  assert.equal(results[0].resolutionEvidence.resolves[0], 'incident:brain-fetch');
});

test('recurrence retrieval keeps incident history but ranks the closure before the old alarm', async () => {
  const memory = makeMemory();
  const alarm = await memory.addNode({
    concept: 'Brain endpoint incident is open and retrieval is down.', tag: 'incident', status: 'open',
    asserted_at: '2026-07-13T12:00:00.000Z', metadata: { incidentId: 'brain-fetch' },
  }, 'incident', [1, 0]);
  const closure = await memory.addNode(attestedNode('closure-brain-fetch-history', {
    concept: '[GOAL_RESOLUTION] COMPLETED brain endpoint incident.', tag: 'goal_resolution',
    type: 'goal_resolution', status: 'completed', asserted_at: '2026-07-14T15:00:00.000Z',
    metadata: {
      kind: 'goal_resolution', incidentId: 'brain-fetch',
      resolved_at: '2026-07-14T15:00:00.000Z',
      closure_proof_refs: ['verifier:brain-fetch-live'],
    },
    provenance: closureProvenance('brain-fetch'),
  }), 'goal_resolution', [1, 0]);

  const results = await memory.query('brain endpoint incident recurrence history', 5, {
    intent: 'history', markAccess: false, nowMs: Date.parse('2026-07-14T16:00:00.000Z'),
  });

  assert.equal(results[0].id, closure.id);
  assert.equal(results.some((node) => node.id === alarm.id), true);
});

test('jtr correction suppresses its explicitly superseded claim for current-state retrieval', async () => {
  const memory = makeMemory();
  const stale = await memory.addNode({
    id: 'stale-claim', concept: 'Current brain path uses legacy sidecars.',
    asserted_at: '2026-07-13T12:00:00.000Z',
  }, 'conversation_sessions', [1, 0]);
  const correction = await memory.addNode(attestedNode('correction-manifest-v1', {
    concept: 'Current brain path uses manifest-v1.',
    tag: 'conversation_sessions',
    asserted_at: '2026-07-14T15:00:00.000Z',
    metadata: { actor: 'jtr', correction: true, supersedes: [stale.id] },
    actor: 'jtr',
    provenance: correctionProvenance('turn:correction:user'),
  }), 'conversation_sessions', [1, 0]);

  const results = await memory.query('current brain path', 5, {
    intent: 'current_state', markAccess: false,
    nowMs: Date.parse('2026-07-14T16:00:00.000Z'),
  });
  assert.equal(results[0].id, correction.id);
  assert.equal(results.some((node) => node.id === stale.id), false);
  assert.deepEqual(results[0].correctionEvidence.supersedes, [`node:${stale.id}`]);
});

test('a progress receipt cannot suppress an open incident as if it were closure proof', async () => {
  const memory = makeMemory();
  const alarm = await memory.addNode({
    concept: 'Brain endpoint incident remains open.', tag: 'incident', status: 'open',
    asserted_at: '2026-07-13T12:00:00.000Z', metadata: { incidentId: 'brain-fetch' },
  }, 'incident', [1, 0]);
  await memory.addNode({
    concept: 'Worker progress receipt: investigation started.', tag: 'worker_receipt', status: 'running',
    asserted_at: '2026-07-14T15:00:00.000Z',
    metadata: { incidentId: 'brain-fetch', receipt_id: 'progress-1' },
  }, 'worker_receipt', [1, 0]);

  const results = await memory.query('current brain endpoint incident status', 5, {
    intent: 'current_state', markAccess: false, nowMs: Date.parse('2026-07-14T16:00:00.000Z'),
  });

  assert.equal(results.some((node) => node.id === alarm.id), true);
  const progress = results.find((node) => node.metadata?.receipt_id === 'progress-1');
  assert.ok(progress);
  assert.equal(progress?.resolutionEvidence, undefined);
});

test('verified live telemetry is not penalized below equivalent verified state evidence', async () => {
  const memory = makeMemory();
  const evidence = {
    asserted_at: '2026-07-14T15:59:00.000Z',
    provenance: verifiedProvenance('live'),
    evidence: { evidence_links: ['verifier:live'] },
  };
  const telemetry = attestedNode('verified-telemetry', {
    ...evidence, concept: 'Live metric is healthy.', tag: 'telemetry',
  });
  const snapshot = attestedNode('verified-snapshot', {
    ...evidence, concept: 'Live state is healthy.', tag: 'state_snapshot',
  });
  const options = { intent: 'current_state', nowMs: Date.parse('2026-07-14T16:00:00.000Z') };

  const telemetryScore = scoreMemorySalience(telemetry, 1, options);
  const snapshotScore = scoreMemorySalience(snapshot, 1, options);

  assert.ok(telemetryScore >= snapshotScore * 0.95);
});

test('closure index cache survives access-only mutations but invalidates for structural node changes', async () => {
  const memory = makeMemory();
  const closure = await memory.addNode({
    concept: '[GOAL_RESOLUTION] COMPLETED incident.', tag: 'goal_resolution', type: 'goal_resolution',
    status: 'completed', metadata: { incidentId: 'brain-fetch', resolved_at: '2026-07-14T15:00:00.000Z' },
  }, 'goal_resolution', [1, 0]);
  const first = memory.buildClosureIndex();

  memory.recordNodeAccess([closure.id]);
  assert.equal(memory.buildClosureIndex(), first);

  await memory.addNode({
    concept: '[GOAL_RESOLUTION] COMPLETED second incident.', tag: 'goal_resolution', type: 'goal_resolution',
    status: 'completed', metadata: { incidentId: 'second', resolved_at: '2026-07-14T15:30:00.000Z' },
  }, 'goal_resolution', [1, 0]);
  assert.notEqual(memory.buildClosureIndex(), first);
});

test('peripheral semantic retrieval applies authority ranking instead of returning narrative by activation alone', async () => {
  const memory = makeMemory();
  const narrative = await memory.addNode({
    concept: 'Brain endpoint status report.', tag: 'synthesis_report', activation: 0.01,
  }, 'synthesis_report', [1, 0]);
  const verified = await memory.addNode(attestedNode('verified-brain-probe', {
    concept: 'Brain endpoint live probe succeeded.', tag: 'state_snapshot', activation: 0.2,
    asserted_at: new Date().toISOString(),
    provenance: verifiedProvenance('brain'),
    evidence: { evidence_links: ['verifier:brain'] },
  }), 'state_snapshot', [1, 0]);

  const results = await memory.queryPeripheral('brain endpoint status', 2);

  assert.equal(results[0].id, verified.id);
  assert.ok(results[0].retrievalScore > results.find((node) => node.id === narrative.id).retrievalScore);
});

test('addNode preserves temporal metadata through exportGraph', async () => {
  const memory = makeMemory();
  await memory.addNode({
    concept: 'Goal resolved with visible output.',
    tag: 'goal_resolution',
    type: 'goal_resolution',
    tags: ['goal_resolution', 'completed'],
    asserted_at: '2026-05-01T19:00:00.000Z',
    asserted_cycle: 6300,
    superseded_by: 'node-newer',
    confidence_decay: 0.8,
    status: 'completed',
    evidence: { evidence_links: ['verifier:goal-closure'] },
    metadata: { kind: 'goal_resolution', goalId: 'g1' },
  }, 'goal_resolution', [1, 0]);

  const [node] = memory.exportGraph().nodes;
  assert.equal(node.type, 'goal_resolution');
  assert.deepEqual(node.tags, ['goal_resolution', 'completed']);
  assert.equal(node.asserted_at, '2026-05-01T19:00:00.000Z');
  assert.equal(node.asserted_cycle, 6300);
  assert.equal(node.superseded_by, 'node-newer');
  assert.equal(node.confidence_decay, 0.8);
  assert.equal(node.status, 'completed');
  assert.deepEqual(node.evidence.evidence_links, ['verifier:goal-closure']);
  assert.equal(node.metadata.goalId, 'g1');
  assert.equal(node.source_class, 'durable');
  assert.equal(node.salienceWeight, 1);
  assert.equal(node.provenance.sourceClass, 'durable');
});

test('ordinary NetworkMemory callers cannot auto-sign raw authority profiles', async () => {
  const memory = makeMemory();
  const raw = await memory.addNode({
    id: 'raw-self-promoted',
    concept: 'Raw caller claims to be verified.',
    provenance: verifiedProvenance('raw-self'),
    evidence: { evidence_links: ['verifier:raw-self'] },
  }, 'state_snapshot', [1, 0]);

  assert.equal(verifyMemoryAuthorityAttestation(raw, AUTHORITY_KEY), false);
  assert.notEqual(classifyClaimAuthority(raw, { authorityKey: AUTHORITY_KEY }), 'verified_current_state');
});

test('addNode re-attests only a valid incoming receipt after final normalization', async () => {
  const memory = makeMemory();
  memory.config.coordinator = {
    useMemorySummaries: true,
    extractiveSummarization: true,
  };
  memory.extractiveSummarizer.summarize = () => ({
    quality: 1,
    summary: 'Normalized signed summary.',
    keyPhrase: 'normalized-receipt',
  });
  const receipt = attestedNode('normalized-goal-receipt', {
    concept: 'Goal completed after a live verification and produced a durable resolution receipt.',
    tag: 'goal_resolution',
    type: 'goal_resolution',
    status: 'completed',
    metadata: {
      kind: 'goal_resolution',
      goalId: 'goal-1',
      resolved_at: '2026-07-14T15:00:00.000Z',
      closure_proof_refs: ['worker-receipt:goal-curator:goal-1'],
    },
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'worker_receipt',
      sourceRefs: ['goal:goal-1'],
      evidenceRefs: ['worker-receipt:goal-curator:goal-1'],
    },
  });

  const stored = await memory.addNode(receipt, 'goal_resolution', [1, 0]);
  assert.equal(stored.summary, 'Normalized signed summary.');
  assert.equal(stored.keyPhrase, 'normalized-receipt');
  assert.equal(verifyMemoryAuthorityAttestation(stored, AUTHORITY_KEY), true);
  assert.equal(classifyClaimAuthority(stored, { authorityKey: AUTHORITY_KEY }), 'worker_receipt');

  const raw = await memory.addNode({
    id: 'normalized-raw-claim',
    concept: 'Unsigned caller claims verified state.',
    provenance: verifiedProvenance('normalized-raw'),
    evidence: { evidence_links: ['verifier:normalized-raw'] },
  }, 'state_snapshot', [1, 0]);
  assert.equal(verifyMemoryAuthorityAttestation(raw, AUTHORITY_KEY), false);
  assert.notEqual(classifyClaimAuthority(raw, { authorityKey: AUTHORITY_KEY }), 'verified_current_state');
});

test('addNode snapshots a signed receipt before asynchronous embedding', async () => {
  const memory = makeMemory();
  let releaseEmbedding;
  let markEmbeddingStarted;
  const embeddingStarted = new Promise((resolve) => { markEmbeddingStarted = resolve; });
  const embeddingGate = new Promise((resolve) => { releaseEmbedding = resolve; });
  memory.embed = async () => {
    markEmbeddingStarted();
    await embeddingGate;
    return [1, 0];
  };
  const receipt = attestedNode('goal-receipt-toctou', {
    concept: 'Original goal completed.',
    tag: 'goal_resolution',
    type: 'goal_resolution',
    status: 'completed',
    metadata: {
      kind: 'goal_resolution',
      goalId: 'original-goal',
      resolved_at: '2026-07-14T15:00:00.000Z',
      closure_proof_refs: ['worker-receipt:goal-curator:original-goal'],
    },
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'worker_receipt',
      sourceRefs: ['goal:original-goal'],
      evidenceRefs: ['worker-receipt:goal-curator:original-goal'],
    },
  });

  const pending = memory.addNode(receipt);
  await embeddingStarted;
  receipt.metadata.goalId = 'victim-goal';
  receipt.provenance.sourceRefs = ['goal:victim-goal'];
  releaseEmbedding();
  const stored = await pending;

  assert.equal(stored.metadata.goalId, 'original-goal');
  assert.deepEqual(stored.provenance.sourceRefs, ['goal:original-goal']);
  assert.equal(verifyMemoryAuthorityAttestation(stored, AUTHORITY_KEY), true);
  const relations = projectMemoryRelations(stored, { authorityKey: AUTHORITY_KEY });
  assert.equal(relations.refs.includes('goal:original-goal'), true);
  assert.equal(relations.refs.includes('goal:victim-goal'), false);
});

test('addNode cannot promote a signed receipt through an external tag argument', async () => {
  const memory = makeMemory();
  const receipt = attestedNode('untagged-worker-receipt', {
    concept: 'Worker recorded progress but did not close the goal.',
    metadata: {
      goalId: 'goal-open',
      closure_proof_refs: ['worker-receipt:worker-1:goal-open'],
    },
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'worker_receipt',
      sourceRefs: ['goal:goal-open'],
      evidenceRefs: ['worker-receipt:worker-1:goal-open'],
    },
  });
  assert.equal(isVerifiedMemoryClosure(receipt, { authorityKey: AUTHORITY_KEY }), false);

  const stored = await memory.addNode(receipt, 'goal_resolution', [1, 0]);
  assert.notEqual(stored.tag, 'goal_resolution');
  assert.equal(verifyMemoryAuthorityAttestation(stored, AUTHORITY_KEY), true);
  assert.equal(isVerifiedMemoryClosure(stored, { authorityKey: AUTHORITY_KEY }), false);
});

test('addNode demotes signed receipts whose type or tags mutate after signing', async () => {
  for (const [field, value] of [
    ['type', 'goal_resolution'],
    ['tags', ['goal_resolution']],
  ]) {
    const memory = makeMemory();
    const receipt = attestedNode(`mutated-${field}-worker-receipt`, {
      concept: 'Worker recorded progress but did not close the goal.',
      metadata: {
        goalId: `goal-${field}`,
        closure_proof_refs: [`worker-receipt:worker-1:goal-${field}`],
      },
      provenance: {
        schema: 'home23.node-provenance.v1',
        authorityClass: 'worker_receipt',
        sourceRefs: [`goal:goal-${field}`],
        evidenceRefs: [`worker-receipt:worker-1:goal-${field}`],
      },
    });
    receipt[field] = value;

    assert.equal(verifyMemoryAuthorityAttestation(receipt, AUTHORITY_KEY), false, field);
    const stored = await memory.addNode(receipt, 'general', [1, 0]);
    assert.equal(verifyMemoryAuthorityAttestation(stored, AUTHORITY_KEY), false, field);
    assert.equal(isVerifiedMemoryClosure(stored, { authorityKey: AUTHORITY_KEY }), false, field);
  }
});

test('addNode never invents current authority time for an undated signed record', async () => {
  const memory = makeMemory();
  const undated = {
    id: 'undated-worker-receipt',
    concept: 'Undated worker receipt.',
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'worker_receipt',
      sourceRefs: ['goal:undated'],
      evidenceRefs: ['worker-receipt:worker-1:undated'],
    },
  };
  attestMemoryAuthority(undated, AUTHORITY_KEY);
  Object.assign(undated, {
    embedding: [0, 1],
    embedding_status: 'missing',
    activation: 0.99,
    weight: 999,
    accessed: '2099-01-01T00:00:00.000Z',
    accessCount: 999999,
    cluster: 'caller-controlled-cluster',
  });

  const stored = await memory.addNode(undated, 'general', [1, 0]);
  assert.equal(verifyMemoryAuthorityAttestation(stored, AUTHORITY_KEY), false);
  assert.notEqual(classifyClaimAuthority(stored, { authorityKey: AUTHORITY_KEY }), 'worker_receipt');
  assert.equal(stored.activation, 0);
  assert.deepEqual(Array.from(stored.embedding), [1, 0]);
  assert.equal(stored.embedding_status, 'embedded');
  assert.equal(stored.weight, 1);
  assert.equal(stored.accessCount, 0);
  assert.notEqual(stored.accessed.getUTCFullYear(), 2099);
  assert.notEqual(stored.cluster, 'caller-controlled-cluster');
});

test('addNode refuses to mint a new authority identity from a colliding signed ID', async () => {
  const memory = makeMemory();
  const receipt = attestedNode('unique-worker-receipt', {
    concept: 'Unique signed receipt.',
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'worker_receipt',
      sourceRefs: ['goal:unique'],
      evidenceRefs: ['worker-receipt:worker-1:unique'],
    },
  });
  const first = await memory.addNode(receipt, 'general', [1, 0]);
  await assert.rejects(
    memory.addNode(structuredClone(receipt), 'general', [1, 0]),
    error => error?.code === 'authority_node_id_collision',
  );
  assert.equal(memory.nodes.size, 1);
  assert.equal(memory.nodes.get(first.id), first);
});

test('addNode rejects numeric and string-equivalent authenticated ID collisions', async () => {
  for (const [residentId, incomingId] of [[7, '7'], ['8', 8]]) {
    const memory = makeMemory();
    const resident = attestedNode(residentId, {
      concept: 'Resident identity receipt.',
      provenance: {
        schema: 'home23.node-provenance.v1',
        authorityClass: 'worker_receipt',
        sourceRefs: [`goal:resident-${residentId}`],
        evidenceRefs: [`worker-receipt:worker-1:resident-${residentId}`],
      },
    });
    const incoming = attestedNode(incomingId, {
      concept: 'Equivalent incoming identity receipt.',
      provenance: {
        schema: 'home23.node-provenance.v1',
        authorityClass: 'worker_receipt',
        sourceRefs: [`goal:incoming-${incomingId}`],
        evidenceRefs: [`worker-receipt:worker-1:incoming-${incomingId}`],
      },
    });

    const stored = await memory.addNode(resident, 'general', [1, 0]);
    await assert.rejects(
      memory.addNode(incoming, 'general', [1, 0]),
      error => error?.code === 'authority_node_id_collision',
    );
    assert.equal(memory.nodes.size, 1);
    assert.equal(memory.nodes.get(stored.id), stored);
  }
});

test('addNode preserves and collision-checks a signed memory_id-only identity', async () => {
  const memory = makeMemory();
  const receipt = attestMemoryAuthority({
    memory_id: 'memory-id-only-worker-receipt',
    concept: 'Receipt uses the durable memory_id alias.',
    created: '2026-07-14T15:00:00.000Z',
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'worker_receipt',
      sourceRefs: ['goal:memory-id-only'],
      evidenceRefs: ['worker-receipt:worker-1:memory-id-only'],
    },
  }, AUTHORITY_KEY);

  assert.equal(verifyMemoryAuthorityAttestation(receipt, AUTHORITY_KEY), true);
  const stored = await memory.addNode(receipt, 'general', [1, 0]);
  assert.equal(stored.id, 'memory-id-only-worker-receipt');
  assert.equal(verifyMemoryAuthorityAttestation(stored, AUTHORITY_KEY), true);
  await assert.rejects(
    memory.addNode(structuredClone(receipt), 'general', [1, 0]),
    error => error?.code === 'authority_node_id_collision',
  );
  assert.equal(memory.nodes.size, 1);
});

test('addNode recomputes embeddings for authenticated input', async () => {
  const memory = makeMemory();
  let embedCalls = 0;
  memory.embed = async () => {
    embedCalls += 1;
    return [1, 0];
  };
  const receipt = attestedNode('signed-vector-receipt', {
    concept: 'Signed receipt with caller vector.',
    embedding: [0, 1],
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'worker_receipt',
      sourceRefs: ['goal:vector'],
      evidenceRefs: ['worker-receipt:worker-1:vector'],
    },
  });

  const stored = await memory.addNode(receipt, 'general', [0, 1]);
  assert.equal(embedCalls, 1);
  assert.deepEqual(Array.from(stored.embedding), [1, 0]);
  assert.equal(verifyMemoryAuthorityAttestation(stored, AUTHORITY_KEY), true);
});

test('addNode resets mutable operational fields on authenticated input', async () => {
  const memory = makeMemory();
  let embedCalls = 0;
  memory.embed = async () => {
    embedCalls += 1;
    return [1, 0];
  };
  const receipt = attestedNode('signed-operational-state-receipt', {
    concept: 'Signed receipt with caller-controlled operational state.',
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'worker_receipt',
      sourceRefs: ['goal:operational-state'],
      evidenceRefs: ['worker-receipt:worker-1:operational-state'],
    },
  });
  Object.assign(receipt, {
    embedding: [0, 1],
    embedding_status: 'missing',
    activation: 0.99,
    weight: 999,
    accessed: '2099-01-01T00:00:00.000Z',
    accessCount: 999999,
    cluster: 'caller-controlled-cluster',
  });
  assert.equal(verifyMemoryAuthorityAttestation(receipt, AUTHORITY_KEY), true);

  const startedAt = Date.now();
  const stored = await memory.addNode(receipt, 'general', [0, 1]);
  const finishedAt = Date.now();

  assert.equal(embedCalls, 1);
  assert.deepEqual(Array.from(stored.embedding), [1, 0]);
  assert.equal(stored.embedding_status, 'embedded');
  assert.equal(stored.activation, 0);
  assert.equal(stored.weight, 1);
  assert.equal(stored.accessCount, 0);
  assert.equal(stored.accessed instanceof Date, true);
  assert.ok(stored.accessed.getTime() >= startedAt);
  assert.ok(stored.accessed.getTime() <= finishedAt);
  assert.notEqual(stored.cluster, 'caller-controlled-cluster');
  assert.equal(verifyMemoryAuthorityAttestation(stored, AUTHORITY_KEY), true);
});

test('runtime embeddings use typed arrays while exports stay JSON arrays', async () => {
  const memory = makeMemory();
  const node = await memory.addNode('typed embedding memory', 'test', [1, 0]);

  assert.equal(node.embedding instanceof Float32Array, true);
  assert.equal(memory.cosineSimilarity(node.embedding, Float32Array.from([1, 0])), 1);

  const exported = memory.exportGraph().nodes[0];
  assert.equal(Array.isArray(exported.embedding), true);
  assert.deepEqual(exported.embedding, [1, 0]);

  const changes = memory.consumePersistenceChanges();
  assert.equal(Array.isArray(changes.nodes[0].embedding), true);
  assert.deepEqual(changes.nodes[0].embedding, [1, 0]);
});

test('Memory Lite stores text nodes when embeddings are unavailable', async () => {
  const memory = makeMemoryLite();
  const node = await memory.addNode('Project Alpha should remember the launch checklist.', 'project_note');

  assert.ok(node);
  assert.equal(node.embedding, null);
  assert.equal(node.embedding_status, 'missing');
  assert.equal(memory.nodes.size, 1);

  const exported = memory.exportGraph().nodes[0];
  assert.equal(exported.embedding, null);
  assert.equal(exported.embedding_status, 'missing');
});

test('Memory Lite query falls back to keyword retrieval when query embedding fails', async () => {
  const memory = makeMemoryLite();
  await memory.addNode('Project Alpha should remember the launch checklist.', 'project_note');
  await memory.addNode('Garden notes about compost and watering.', 'personal_note');

  const results = await memory.query('alpha launch', 2);

  assert.equal(results.length, 1);
  assert.match(results[0].concept, /Project Alpha/);
  assert.equal(results[0].retrievalMode, 'logical-source-scan');
});

test('own-brain semantic query reinforces access metadata and persistence changes', async () => {
  const memory = makeMemory();
  const node = await memory.addNode('Semantic access canary for own brain.', 'project_note', [1, 0]);
  node.weight = 0.2;
  memory.consumePersistenceChanges();
  const beforeAccessed = node.accessed;
  const beforeWeight = node.weight;

  const results = await memory.query('semantic access canary', 1);

  assert.equal(results[0].id, node.id);
  assert.equal(node.accessCount, 1);
  assert.notEqual(node.accessed, beforeAccessed);
  assert.ok(node.weight > beforeWeight);
  assert.equal(memory.hasPersistenceChanges(), true);
  assert.deepEqual(memory.consumePersistenceChanges().nodes.map((row) => row.id), [node.id]);
});

test('read-only semantic and keyword queries do not mutate access metadata', async () => {
  const semantic = makeMemory();
  const semanticNode = await semantic.addNode('Cross-brain semantic canary.', 'project_note', [1, 0]);
  semantic.consumePersistenceChanges();
  const semanticAccessed = semanticNode.accessed;
  const semanticWeight = semanticNode.weight;

  const semanticResults = await semantic.query('cross brain semantic canary', 1, { accessMode: 'read-only' });

  assert.equal(semanticResults[0].id, semanticNode.id);
  assert.equal(semanticNode.accessCount, 0);
  assert.equal(semanticNode.accessed, semanticAccessed);
  assert.equal(semanticNode.weight, semanticWeight);
  assert.equal(semantic.hasPersistenceChanges(), false);

  const keyword = makeMemoryLite();
  const keywordNode = await keyword.addNode('Cross-brain keyword canary.', 'project_note');
  keyword.consumePersistenceChanges();
  const keywordAccessed = keywordNode.accessed;
  const keywordWeight = keywordNode.weight;

  const keywordResults = await keyword.query('cross brain keyword canary', 1, { markAccess: false });

  assert.equal(keywordResults[0].id, keywordNode.id);
  assert.equal(keywordNode.accessCount, 0);
  assert.equal(keywordNode.accessed, keywordAccessed);
  assert.equal(keywordNode.weight, keywordWeight);
  assert.equal(keyword.hasPersistenceChanges(), false);
});

test('persistence changes capture node, edge, and removal mutations', async () => {
  const memory = makeMemory();
  const first = await memory.addNode('first durable memory', 'test', [1, 0]);
  const second = await memory.addNode('second durable memory', 'test', [1, 0]);
  memory.addEdge(first.id, second.id, 0.25, 'manual');

  const initial = memory.consumePersistenceChanges();
  assert.ok(initial.nodes.some((node) => node.id === first.id));
  assert.ok(initial.nodes.some((node) => node.id === second.id));
  assert.ok(initial.edges.some((edge) => edge.source === first.id || edge.target === first.id));
  assert.equal(memory.hasPersistenceChanges(), false);

  memory.removeNode(first.id);
  const removed = memory.consumePersistenceChanges();
  assert.deepEqual(removed.removedNodeIds, [first.id]);
  assert.ok(removed.removedEdgeKeys.length >= 1);
  assert.equal(memory.hasPersistenceChanges(), false);
});

test('exportPersistenceShell omits full node and edge payloads but keeps graph metadata', async () => {
  const memory = makeMemory();
  const first = await memory.addNode('first durable memory', 'test', [1, 0]);
  const second = await memory.addNode('second durable memory', 'test', [1, 0]);
  memory.addEdge(first.id, second.id, 0.25, 'manual');

  const shell = memory.exportPersistenceShell();

  assert.deepEqual(shell.nodes, []);
  assert.deepEqual(shell.edges, []);
  assert.ok(Array.isArray(shell.clusters));
  assert.equal(shell.nextNodeId, memory.nextNodeId);
  assert.equal(shell.nextClusterId, memory.nextClusterId);
});

test('rewireSmallWorld caps large topology maintenance runs for engine responsiveness', async () => {
  const memory = makeRewireMemory();

  const rewired = await memory.rewireSmallWorld(1);

  assert.ok(rewired <= 3);
});

test('rewireSmallWorld does not scan all bridges for each dream bridge insertion', async () => {
  const memory = makeRewireMemory();
  const originalRandom = Math.random;
  Math.random = () => 0.75;
  memory.enforceBridgeCap = () => {
    throw new Error('rewireSmallWorld should use precomputed bridge counts');
  };

  try {
    const rewired = await memory.rewireSmallWorld(1);

    assert.ok(rewired > 0);
  } finally {
    Math.random = originalRandom;
  }
});

test('embedding request params honor environment-selected provider model and dimensions', () => {
  const previous = {
    provider: process.env.EMBEDDING_PROVIDER,
    baseUrl: process.env.EMBEDDING_BASE_URL,
    model: process.env.EMBEDDING_MODEL,
    dimensions: process.env.EMBEDDING_DIMENSIONS,
  };
  try {
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.EMBEDDING_BASE_URL = 'https://api.openai.com/v1';
    process.env.EMBEDDING_MODEL = 'text-embedding-3-small';
    process.env.EMBEDDING_DIMENSIONS = '1536';

    const memory = makeMemory();
    const params = memory.buildEmbeddingCreateParams('hello');

    assert.equal(params.model, 'text-embedding-3-small');
    assert.equal(params.input, 'hello');
    assert.equal(params.encoding_format, 'float');
    assert.equal(params.dimensions, 1536);
  } finally {
    restoreEmbeddingEnv(previous);
  }
});

test('embedding request params avoid OpenAI-only options for Ollama embeddings', () => {
  const previous = {
    provider: process.env.EMBEDDING_PROVIDER,
    baseUrl: process.env.EMBEDDING_BASE_URL,
    model: process.env.EMBEDDING_MODEL,
    dimensions: process.env.EMBEDDING_DIMENSIONS,
  };
  try {
    process.env.EMBEDDING_PROVIDER = 'ollama-local';
    process.env.EMBEDDING_BASE_URL = 'http://127.0.0.1:11434/v1';
    process.env.EMBEDDING_MODEL = 'nomic-embed-text';
    process.env.EMBEDDING_DIMENSIONS = '768';

    const memory = makeMemory();
    const params = memory.buildEmbeddingCreateParams(['hello']);

    assert.equal(params.model, 'nomic-embed-text');
    assert.deepEqual(params.input, ['hello']);
    assert.equal(params.encoding_format, undefined);
    assert.equal(params.dimensions, undefined);
  } finally {
    restoreEmbeddingEnv(previous);
  }
});
