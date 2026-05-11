'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeCompletedTopicRefs,
  normalizeState,
  slugifyTopic,
  validateState,
} = require('../../scripts/from-the-inside-state.cjs');

test('slugifyTopic matches the Field Report artifact slug convention', () => {
  assert.equal(
    slugifyTopic('Indexing Failure Modes: When Systems "Have Data" but Return Zero'),
    'indexing-failure-modes-when-systems-have-data-but-return-zero',
  );
  assert.equal(slugifyTopic('  CRDTs for Narrative + State Coherence  '), 'crdts-for-narrative-state-coherence');
});

test('normalizeCompletedTopicRefs gives completed topics canonical slug identity', () => {
  const refs = normalizeCompletedTopicRefs([
    'The Ghosts Were Never Missing',
    'The Case of the Missing Dissertations: How Slug Fractions Hid Operational Reality',
  ], [
    {
      topic: 'The Ghosts Were Never Missing',
      slug: 'the-ghosts-were-never-missing',
      issue: 53,
      completed_at: '2026-05-04T10:00:00.000Z',
    },
  ]);

  assert.deepEqual(refs[0], {
    topic: 'The Ghosts Were Never Missing',
    slug: 'the-ghosts-were-never-missing',
    issue: 53,
    completed_at: '2026-05-04T10:00:00.000Z',
  });
  assert.equal(
    refs[1].slug,
    'the-case-of-the-missing-dissertations-how-slug-fractions-hid-operational-reality',
  );
});

test('normalizeState preserves string compatibility while adding completed topic refs', () => {
  const normalized = normalizeState({
    active_topic: { topic: 'Memory Pipeline Forensics', status: 'queued' },
    completed_topics: ['Event Sourcing for a Living Knowledge Graph'],
    progress: { units_completed: 0 },
  });

  assert.equal(normalized.active_topic.slug, 'memory-pipeline-forensics');
  assert.deepEqual(normalized.completed_topics, ['Event Sourcing for a Living Knowledge Graph']);
  assert.deepEqual(normalized.completed_topic_refs, [
    {
      topic: 'Event Sourcing for a Living Knowledge Graph',
      slug: 'event-sourcing-for-a-living-knowledge-graph',
    },
  ]);
});

test('validateState catches active topics that are already completed by slug', () => {
  const result = validateState({
    active_topic: {
      topic: 'CRDTs for Narrative + State Coherence',
      slug: 'crdts-for-narrative-state-coherence',
    },
    completed_topics: ['CRDTs for Narrative + State Coherence'],
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /active topic already appears/.test(error)));
});
