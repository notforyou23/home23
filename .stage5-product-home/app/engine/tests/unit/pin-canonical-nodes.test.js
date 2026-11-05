const { expect } = require('chai');
const { pinCanonicalNodes, PINS } = require('../../src/memory/pin-canonical-nodes');

function fakeMemory(existing = []) {
  const nodes = new Map(existing.map((n, i) => [i + 1, n]));
  const added = [];
  return {
    nodes,
    async addNode(concept, tag) {
      const id = nodes.size + 1 + added.length;
      const n = { id, concept, tag };
      added.push(n);
      nodes.set(id, n);
      return n;
    },
    _added: added,
  };
}

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('pin-canonical-nodes', () => {
  it('adds pinned nodes when not already present', async () => {
    const memory = fakeMemory([]);
    const r = await pinCanonicalNodes({ memory, logger });
    expect(r.pinned).to.equal(PINS.length);
    expect(r.skipped).to.equal(0);
    expect(memory._added).to.have.length(PINS.length);
  });

  it('skips pins that already exist (matched by tag, case-insensitive)', async () => {
    const memory = fakeMemory([
      { id: 99, concept: 'stale dashboard note', tag: 'Resolved:Dashboard-Pipeline' }
    ]);
    const r = await pinCanonicalNodes({ memory, logger });
    expect(r.skipped).to.equal(1);
    expect(r.pinned).to.equal(0);
  });

  it('returns 0/0 when memory has no addNode method', async () => {
    const r = await pinCanonicalNodes({ memory: { nodes: new Map() }, logger });
    expect(r.pinned).to.equal(0);
  });
});
