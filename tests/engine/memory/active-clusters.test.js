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
