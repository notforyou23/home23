const { expect } = require('chai');
const { computeRoleDedupPrefix } = require('../../src/cognition/role-dedup-prefix');

function fakeMemory(results) {
  return { async query() { return results; } };
}

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('role-dedup-prefix.computeRoleDedupPrefix', () => {
  it('returns prefix when an answer-tagged node matches above threshold', async () => {
    const memory = fakeMemory([
      { id: 60441, similarity: 0.91, tag: 'resolved:dashboard-pipeline',
        concept: 'Dashboard health shortcut stopped on 2026-04-13. Phone-side.' }
    ]);
    const r = await computeRoleDedupPrefix({
      goal: { description: 'Investigate why the iOS Health Shortcut stopped delivering data' },
      memory, logger
    });
    expect(r.prefix).to.be.a('string');
    expect(r.prefix).to.include('ALREADY IN MEMORY');
    expect(r.prefix).to.include('resolved:dashboard-pipeline');
    expect(r.match.id).to.equal(60441);
  });

  it('returns null when no answer-tagged node matches', async () => {
    const memory = fakeMemory([
      { id: 1, similarity: 0.95, tag: 'curiosity', concept: 'unrelated curiosity' }
    ]);
    const r = await computeRoleDedupPrefix({
      goal: { description: 'investigate the thing' }, memory, logger
    });
    expect(r.prefix).to.equal(null);
  });

  it('returns null when similarity below threshold', async () => {
    const memory = fakeMemory([
      { id: 1, similarity: 0.5, tag: 'resolved:x', concept: 'low sim' }
    ]);
    const r = await computeRoleDedupPrefix({
      goal: { description: 'some goal description long enough' }, memory, logger
    });
    expect(r.prefix).to.equal(null);
  });

  it('returns null when goal is null', async () => {
    const memory = fakeMemory([
      { id: 1, similarity: 0.99, tag: 'resolved:x', concept: 'x' }
    ]);
    const r = await computeRoleDedupPrefix({ goal: null, memory, logger });
    expect(r.prefix).to.equal(null);
  });

  it('handles memory query errors gracefully', async () => {
    const memory = { async query() { throw new Error('boom'); } };
    const r = await computeRoleDedupPrefix({
      goal: { description: 'long enough mission description' }, memory, logger
    });
    expect(r.prefix).to.equal(null);
  });
});
