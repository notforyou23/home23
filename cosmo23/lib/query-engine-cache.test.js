const test = require('node:test');
const assert = require('node:assert/strict');

const { QueryEngine } = require('./query-engine');
const { QueryEngine: DashboardQueryEngine } = require('../engine/src/dashboard/query-engine');
const {
  MAX_VERIFIED_CONTEXT_UTF16,
  vectors: verifiedContextVectors,
} = require('../../tests/helpers/query-verified-follow-up-context-vectors.cjs');
const {
  renderVerifiedConversation,
} = require('../../shared/query/verified-follow-up-context.cjs');

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

test('COSMO QueryEngine cache identity uses canonical verified conversation bytes', () => {
  const base = {
    stateHash: 'solo:12:34',
    query: 'What changed?',
    model: 'gpt-5.5',
    mode: 'dive',
  };
  const first = QueryEngine.buildQueryCacheKey({
    ...base,
    verifiedConversationContext: {
      version: 1,
      exchanges: verifiedContextVectors.simple.exchanges,
    },
  });
  const sameCanonicalChain = QueryEngine.buildQueryCacheKey({
    ...base,
    verifiedConversationContext: {
      exchanges: verifiedContextVectors.simple.exchanges.map(({ query, answer }) => ({ answer, query })),
      version: 1,
    },
  });
  const changedChain = QueryEngine.buildQueryCacheKey({
    ...base,
    verifiedConversationContext: {
      version: 1,
      exchanges: verifiedContextVectors.simple.exchanges.map((exchange, index) => (
        index === 1 ? { ...exchange, answer: `${exchange.answer}!` } : exchange
      )),
    },
  });

  assert.equal(first, sameCanonicalChain);
  assert.notEqual(first, changedChain);
  assert.equal(QueryEngine.verifiedFollowUpSupport.maxUtf16, MAX_VERIFIED_CONTEXT_UTF16);
});

test('COSMO QueryEngine cache identity separates distinct chains with the same rendered text', () => {
  const base = {
    stateHash: 'solo:12:34', query: 'What changed?', model: 'gpt-5.5', mode: 'dive',
  };
  const twoExchanges = [
    { query: 'First', answer: 'One' },
    { query: 'Second', answer: 'Two' },
  ];
  const oneExchange = [{
    query: 'First',
    answer: 'One\n\n---\n\nQuestion:\nSecond\n\nAnswer:\nTwo',
  }];
  assert.equal(
    renderVerifiedConversation(oneExchange),
    renderVerifiedConversation(twoExchanges),
    'the model-facing renderer is intentionally plain text, so cache identity needs structure',
  );
  assert.notEqual(
    QueryEngine.buildQueryCacheKey({
      ...base, verifiedConversationContext: { version: 1, exchanges: oneExchange },
    }),
    QueryEngine.buildQueryCacheKey({
      ...base, verifiedConversationContext: { version: 1, exchanges: twoExchanges },
    }),
  );
});

test('COSMO QueryEngine cache accepts the exact boundary and rejects one UTF-16 unit over it', () => {
  const base = {
    stateHash: 'solo:12:34', query: 'What changed?', model: 'gpt-5.5', mode: 'dive',
  };
  assert.doesNotThrow(() => QueryEngine.buildQueryCacheKey({
    ...base,
    verifiedConversationContext: {
      version: 1,
      exchanges: verifiedContextVectors.exactBoundary.exchanges,
    },
  }));
  assert.throws(() => QueryEngine.buildQueryCacheKey({
    ...base,
    verifiedConversationContext: {
      version: 1,
      exchanges: [{
        query: verifiedContextVectors.exactBoundary.exchanges[0].query,
        answer: `${verifiedContextVectors.exactBoundary.exchanges[0].answer}a`,
      }],
    },
  }), error => error?.code === 'verified_conversation_context_invalid');
});

test('COSMO QueryEngine leaves the legacy cache-key byte shape unchanged without verified context', () => {
  const base = {
    stateHash: 'solo:12:34',
    query: 'Do we have fan anecdotes?',
    model: 'gpt-5.4',
    mode: 'normal',
    artifactFingerprint: 'fingerprint-a',
    priorContext: { query: 'old question', answer: 'old answer' },
  };
  assert.equal(
    QueryEngine.buildQueryCacheKey(base),
    QueryEngine.buildQueryCacheKey({ ...base, verifiedConversationContext: null }),
  );
});
