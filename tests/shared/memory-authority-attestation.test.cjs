'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  attestMemoryAuthority,
  attestMemoryAuthorityIfAvailable,
  deriveMemoryAuthorityAttestationKey,
  verifyMemoryAuthorityAttestation,
} = require('../../shared/memory-authority-attestation.cjs');
const {
  classifyClaimAuthority,
  isVerifiedMemoryClosure,
  projectMemoryRelations,
} = require('../../shared/memory-authority.cjs');

const CAPABILITY_KEY = 'a'.repeat(64);
const AUTHORITY_KEY = deriveMemoryAuthorityAttestationKey(CAPABILITY_KEY);

function correctionNode() {
  return {
    id: 'correction-1',
    concept: 'jtr correction: manifest-v1 is authoritative.',
    actor: 'jtr',
    source_time: '2026-07-14T12:00:00.000Z',
    metadata: {
      supersedes: ['legacy-claim'],
      source_path: '/private/authority/receipt.json',
    },
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'jtr_correction',
      retrievalDomain: 'current_ops',
      sourceRefs: ['chat:turn-1'],
      evidenceRefs: ['chat:turn-1'],
    },
  };
}

test('memory authority attestation uses a domain-separated derived key', () => {
  assert.match(AUTHORITY_KEY, /^[a-f0-9]{64}$/);
  assert.notEqual(AUTHORITY_KEY, CAPABILITY_KEY);
  assert.notEqual(
    deriveMemoryAuthorityAttestationKey('b'.repeat(64)),
    AUTHORITY_KEY,
  );
});

test('attestation binds authority profile, content, evidence, and relation targets', () => {
  const node = attestMemoryAuthority(correctionNode(), AUTHORITY_KEY);
  assert.equal(verifyMemoryAuthorityAttestation(node, AUTHORITY_KEY), true);

  for (const mutate of [
    value => { value.concept = 'different claim'; },
    value => { value.id = 'copied-correction'; },
    value => { value.actor = 'agent'; },
    value => { value.source_time = '2026-07-15T12:00:00.000Z'; },
    value => { value.metadata.source_path = '/private/authority/other.json'; },
    value => { value.provenance.authorityClass = 'verified_current_state'; },
    value => { value.provenance.evidenceRefs = ['chat:forged']; },
    value => { value.metadata.supersedes = ['different-claim']; },
  ]) {
    const tampered = structuredClone(node);
    mutate(tampered);
    assert.equal(verifyMemoryAuthorityAttestation(tampered, AUTHORITY_KEY), false);
  }
});

test('attestation rejects an incident target copied onto a valid signed receipt', () => {
  const node = attestMemoryAuthority({
    id: 'goal-receipt-1',
    concept: 'Goal completed.',
    status: 'completed',
    metadata: {
      goalId: 'goal-1',
      closure_proof_refs: ['worker-receipt:goal-curator:goal-1'],
    },
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'worker_receipt',
      sourceRefs: ['goal:goal-1'],
      evidenceRefs: ['worker-receipt:goal-curator:goal-1'],
    },
  }, AUTHORITY_KEY);

  node.incidentId = 'arbitrary-incident';
  assert.equal(verifyMemoryAuthorityAttestation(node, AUTHORITY_KEY), false);
  assert.equal(isVerifiedMemoryClosure(node, { authorityKey: AUTHORITY_KEY }), false);
  assert.equal(
    projectMemoryRelations(node, { authorityKey: AUTHORITY_KEY }).refs.includes('incident:arbitrary-incident'),
    true,
  );
});

test('attestation rejects a supersession target copied onto a valid correction', () => {
  const node = attestMemoryAuthority(correctionNode(), AUTHORITY_KEY);
  node.provenance.supersedes = ['arbitrary-claim'];
  assert.equal(verifyMemoryAuthorityAttestation(node, AUTHORITY_KEY), false);
  assert.notEqual(classifyClaimAuthority(node, { authorityKey: AUTHORITY_KEY }), 'jtr_correction');
  assert.deepEqual(projectMemoryRelations(node, { authorityKey: AUTHORITY_KEY }).supersedes, []);
});

test('attestation rejects a source closure target added after signing', () => {
  const node = attestMemoryAuthority({
    id: 'source-receipt-1',
    concept: 'Source repaired.',
    status: 'completed',
    metadata: {
      closure_proof_refs: ['worker-receipt:repair:source-1'],
    },
    provenance: {
      schema: 'home23.node-provenance.v1',
      authorityClass: 'worker_receipt',
      sourceRefs: ['source:source-1'],
      evidenceRefs: ['worker-receipt:repair:source-1'],
    },
  }, AUTHORITY_KEY);

  node.metadata.source_refs = ['source:arbitrary-source'];
  assert.equal(verifyMemoryAuthorityAttestation(node, AUTHORITY_KEY), false);
});

test('attestation rejects semantic-time reordering after signing', () => {
  const node = attestMemoryAuthority(correctionNode(), AUTHORITY_KEY);
  node.resolved_at = '2099-01-01T00:00:00.000Z';
  assert.equal(verifyMemoryAuthorityAttestation(node, AUTHORITY_KEY), false);
});

test('attestation cannot hide authority evidence beyond the signed array limit', () => {
  const node = correctionNode();
  node.provenance.evidenceRefs = Array.from({ length: 64 }, (_, index) => `source:${index}`);
  node.provenance.sourceRefs = [...node.provenance.evidenceRefs];
  attestMemoryAuthority(node, AUTHORITY_KEY);

  node.provenance.evidenceRefs.push('verifier:forged-at-index-65');
  assert.equal(verifyMemoryAuthorityAttestation(node, AUTHORITY_KEY), false);

  const oversized = correctionNode();
  oversized.provenance.evidenceRefs = Array.from({ length: 65 }, (_, index) => `source:${index}`);
  assert.throws(
    () => attestMemoryAuthority(oversized, AUTHORITY_KEY),
    /exceeds 64 items/,
  );
});

test('attestation cannot hide claim mutations after a signed text prefix', () => {
  const node = correctionNode();
  node.concept = 'a'.repeat(16 * 1024);
  attestMemoryAuthority(node, AUTHORITY_KEY);
  node.concept += 'forged suffix';
  assert.equal(verifyMemoryAuthorityAttestation(node, AUTHORITY_KEY), false);

  const oversized = correctionNode();
  oversized.concept = 'a'.repeat((16 * 1024) + 1);
  assert.throws(
    () => attestMemoryAuthority(oversized, AUTHORITY_KEY),
    /exceeds 16384 bytes/,
  );
});

test('attestation binds every addNode concept fallback alias before re-attestation', () => {
  for (const field of ['concept', 'content', 'summary', 'title']) {
    const node = correctionNode();
    delete node.concept;
    node[field] = `original ${field}`;
    attestMemoryAuthority(node, AUTHORITY_KEY);
    node[field] = `mutated ${field}`;
    assert.equal(verifyMemoryAuthorityAttestation(node, AUTHORITY_KEY), false, field);
  }
});

test('attestation rejects object-valued authority relation refs', () => {
  const node = correctionNode();
  node.metadata.supersedes = [{ claim: 'old-claim' }];
  assert.throws(
    () => attestMemoryAuthority(node, AUTHORITY_KEY),
    /must be a scalar/,
  );
});

test('attestation binds every scalar-or-array correction relation alias', () => {
  const aliases = [
    ['metadata', 'supersedes', ['old-claim'], ['victim']],
    ['metadata', 'supersedes_ids', ['old-claim'], ['victim']],
    ['metadata', 'supersedesIds', ['old-claim'], ['victim']],
    ['metadata', 'corrects', ['old-claim'], ['victim']],
    ['metadata', 'corrects_node_id', 'old-claim', 'victim'],
    ['metadata', 'correction_of', 'old-claim', 'victim'],
    ['provenance', 'supersedes', ['old-claim'], ['victim']],
  ];
  for (const [container, field, initial, changed] of aliases) {
    const node = correctionNode();
    delete node.metadata.supersedes;
    node[container][field] = initial;
    attestMemoryAuthority(node, AUTHORITY_KEY);
    node[container][field] = changed;
    assert.equal(verifyMemoryAuthorityAttestation(node, AUTHORITY_KEY), false, `${container}.${field}`);
    assert.deepEqual(
      projectMemoryRelations(node, { authorityKey: AUTHORITY_KEY }).supersedes,
      [],
      `${container}.${field} cannot suppress after mutation`,
    );
  }

  for (const [container, field] of [
    ['metadata', 'supersedes'],
    ['metadata', 'supersedes_ids'],
    ['metadata', 'supersedesIds'],
    ['metadata', 'corrects'],
    ['provenance', 'supersedes'],
  ]) {
    const node = correctionNode();
    delete node.metadata.supersedes;
    node[container][field] = 'old-claim';
    assert.throws(
      () => attestMemoryAuthority(node, AUTHORITY_KEY),
      /must be an array/,
      `${container}.${field}`,
    );
  }
});

test('optional signing fails closed without breaking an ordinary write', () => {
  const node = correctionNode();
  node.concept = 'a'.repeat((16 * 1024) + 1);
  assert.doesNotThrow(() => attestMemoryAuthorityIfAvailable(node, AUTHORITY_KEY));
  assert.equal(node.provenance.attestation, undefined);
  assert.notEqual(classifyClaimAuthority(node, { authorityKey: AUTHORITY_KEY }), 'jtr_correction');
});

test('raw schema and self-declared signature material do not attest authority', () => {
  const raw = correctionNode();
  raw.provenance.attestation = {
    schema: 'home23.memory-authority-attestation.v1',
    algorithm: 'hmac-sha256',
    keyId: 'forged',
    signature: Buffer.alloc(32).toString('base64url'),
  };
  assert.equal(verifyMemoryAuthorityAttestation(raw, AUTHORITY_KEY), false);
  assert.equal(verifyMemoryAuthorityAttestation(
    attestMemoryAuthority(correctionNode(), 'b'.repeat(64)),
    AUTHORITY_KEY,
  ), false);
});

test('authority attestation refuses a missing durable node or memory identity', () => {
  const node = correctionNode();
  delete node.id;
  assert.throws(
    () => attestMemoryAuthority(node, AUTHORITY_KEY),
    /durable identity is required/,
  );
  assert.equal(verifyMemoryAuthorityAttestation(node, AUTHORITY_KEY), false);
});

test('authority callers can inject the derived key without mutating process environment', () => {
  const node = attestMemoryAuthority(correctionNode(), AUTHORITY_KEY);
  assert.equal(classifyClaimAuthority(node, { authorityKey: AUTHORITY_KEY }), 'jtr_correction');
  assert.notEqual(classifyClaimAuthority(node, { authorityKey: 'c'.repeat(64) }), 'jtr_correction');
});
