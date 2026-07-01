const test = require('node:test');
const assert = require('node:assert/strict');

const { QueryEngine } = require('./query-engine');
const { QueryEngine: DashboardQueryEngine } = require('../engine/src/dashboard/query-engine');

test('QueryEngine cache key includes artifact fingerprint and prior context', () => {
  const base = {
    stateHash: 'solo:12:34',
    query: 'Do we have fan anecdotes?',
    model: 'gpt-5.4',
    mode: 'normal',
    artifactContext: '# Artifact Inventory\nAnswer substrate: records_present'
  };

  const first = QueryEngine.buildQueryCacheKey({
    ...base,
    artifactFingerprint: 'fingerprint-a',
    priorContext: { query: 'old question', answer: 'old answer' }
  });
  const same = QueryEngine.buildQueryCacheKey({
    ...base,
    artifactFingerprint: 'fingerprint-a',
    priorContext: { query: 'old question', answer: 'old answer' }
  });
  const changedArtifact = QueryEngine.buildQueryCacheKey({
    ...base,
    artifactFingerprint: 'fingerprint-b',
    priorContext: { query: 'old question', answer: 'old answer' }
  });
  const changedPrior = QueryEngine.buildQueryCacheKey({
    ...base,
    artifactFingerprint: 'fingerprint-a',
    priorContext: { query: 'old question', answer: 'stale answer changed' }
  });

  assert.equal(first, same);
  assert.notEqual(first, changedArtifact);
  assert.notEqual(first, changedPrior);
});

test('Dashboard QueryEngine cache key includes artifact fingerprint and prior context', () => {
  const base = {
    stateHash: 'solo:12:34',
    query: 'Do we have fan anecdotes?',
    model: 'gpt-5.5',
    mode: 'normal',
    artifactContext: '# Artifact Inventory\nAnswer substrate: records_present'
  };

  const first = DashboardQueryEngine.buildQueryCacheKey({
    ...base,
    artifactFingerprint: 'fingerprint-a',
    priorContext: { query: 'old question', answer: 'old answer' }
  });
  const changedArtifact = DashboardQueryEngine.buildQueryCacheKey({
    ...base,
    artifactFingerprint: 'fingerprint-b',
    priorContext: { query: 'old question', answer: 'old answer' }
  });
  const changedPrior = DashboardQueryEngine.buildQueryCacheKey({
    ...base,
    artifactFingerprint: 'fingerprint-a',
    priorContext: { query: 'old question', answer: 'stale answer changed' }
  });

  assert.notEqual(first, changedArtifact);
  assert.notEqual(first, changedPrior);
});
