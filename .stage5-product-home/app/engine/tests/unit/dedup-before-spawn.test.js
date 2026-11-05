const { expect } = require('chai');
const { checkDedup, buildQueryText } = require('../../src/agents/dedup-before-spawn');

function fakeMemory(results) {
  return {
    async query() { return results; }
  };
}

describe('dedup-before-spawn', () => {
  const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  it('returns duplicate=true when an answer-tagged node scores above threshold', async () => {
    const memory = fakeMemory([
      { id: 42, similarity: 0.91, tag: 'resolved:dashboard-pipeline', concept: 'Health pipeline resolved; re-trigger shortcut on phone.' },
      { id: 43, similarity: 0.6, tag: 'curiosity', concept: 'unrelated' }
    ]);
    const r = await checkDedup({ description: 'investigate the health pipeline' }, memory, { logger });
    expect(r.duplicate).to.equal(true);
    expect(r.match.id).to.equal(42);
    expect(r.match.similarity).to.be.greaterThan(0.85);
  });

  it('returns duplicate=false when no answer-tagged node matches', async () => {
    const memory = fakeMemory([
      { id: 42, similarity: 0.91, tag: 'curiosity', concept: 'high score but not an answer tag' }
    ]);
    const r = await checkDedup({ description: 'investigate the health pipeline' }, memory, { logger });
    expect(r.duplicate).to.equal(false);
    expect(r.reason).to.match(/no answer-tagged/i);
  });

  it('returns duplicate=false when similarity is below threshold', async () => {
    const memory = fakeMemory([
      { id: 42, similarity: 0.5, tag: 'resolved:x', concept: 'low similarity' }
    ]);
    const r = await checkDedup({ description: 'investigate anything at all' }, memory, { logger });
    expect(r.duplicate).to.equal(false);
  });

  it('honors custom threshold', async () => {
    const memory = fakeMemory([
      { id: 42, similarity: 0.7, tag: 'finding:x', concept: 'borderline' }
    ]);
    const r = await checkDedup({ description: 'some mission goal' }, memory, { threshold: 0.65, logger });
    expect(r.duplicate).to.equal(true);
  });

  it('returns duplicate=false when query text is too short', async () => {
    const memory = fakeMemory([
      { id: 42, similarity: 0.99, tag: 'resolved:x' }
    ]);
    const r = await checkDedup({ description: 'x' }, memory, { logger });
    expect(r.duplicate).to.equal(false);
    expect(r.reason).to.match(/too short/i);
  });

  it('handles memory with no query method gracefully', async () => {
    const r = await checkDedup({ description: 'any mission description' }, {}, { logger });
    expect(r.duplicate).to.equal(false);
    expect(r.reason).to.match(/no query/i);
  });

  it('handles memory.query throwing', async () => {
    const memory = { async query() { throw new Error('boom'); } };
    const r = await checkDedup({ description: 'any mission description' }, memory, { logger });
    expect(r.duplicate).to.equal(false);
    expect(r.reason).to.match(/query error/i);
  });

  it('accepts activation score when similarity is undefined', async () => {
    const memory = fakeMemory([
      { id: 42, activation: 0.92, tag: 'resolved:x', concept: 'spread-activation match' }
    ]);
    const r = await checkDedup({ description: 'some long enough mission description' }, memory, { logger });
    expect(r.duplicate).to.equal(true);
    expect(r.match.id).to.equal(42);
  });

  it('buildQueryText combines description + goal.description + prompt', () => {
    const t = buildQueryText({
      description: 'desc',
      goal: { description: 'g' },
      prompt: 'p'
    });
    expect(t).to.contain('desc');
    expect(t).to.contain('g');
    expect(t).to.contain('p');
  });
});
