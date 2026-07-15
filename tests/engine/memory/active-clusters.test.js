import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getActiveClusterSummary } = require('../../../engine/src/memory/active-clusters.js');

test('active clusters do not let recent access make an external archive dominate current-state context', async () => {
  const now = Date.now();
  const memory = { nodes: new Map([
    ['archive', {
      id: 'archive', cluster: 1, tag: 'jerry_cron_docs',
      concept: 'Old X digest market signal archive', created: '2025-01-01T00:00:00.000Z',
      accessed: new Date(now).toISOString(), activation: 10, weight: 10,
    }],
    ['live', {
      id: 'live', cluster: 1, tag: 'state_snapshot', concept: 'Current brain probe is healthy',
      asserted_at: new Date(now - 1000).toISOString(), accessed: new Date(now - 60_000).toISOString(),
      provenance: { authority: { presentTenseAuthority: true, temporalStatus: 'current' }, source_refs: ['probe:brain'] },
      evidence: { evidence_links: ['verifier:brain'] }, weight: 1,
    }],
  ]) };

  const summary = await getActiveClusterSummary(memory, 1, 3, { intent: 'current_state', nowMs: now });

  assert.match(summary, /Current brain probe is healthy/);
  assert.doesNotMatch(summary, /X digest/);
});
