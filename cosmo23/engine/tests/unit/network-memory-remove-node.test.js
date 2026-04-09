const { expect } = require('chai');

describe('NetworkMemory.removeNode()', () => {
  let NetworkMemory, memory;

  before(() => {
    ({ NetworkMemory } = require('../../src/memory/network-memory'));
  });

  beforeEach(() => {
    const config = {
      embedding: { model: 'text-embedding-3-small', dimensions: 512 },
      coordinator: { useMemorySummaries: false, extractiveSummarization: false }
    };
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    memory = new NetworkMemory(config, logger);
  });

  it('should remove a node and its edges from the graph', () => {
    const fakeEmbed = new Array(512).fill(0.1);
    memory.nodes.set(1, { id: 1, concept: 'node1', embedding: fakeEmbed });
    memory.nodes.set(2, { id: 2, concept: 'node2', embedding: fakeEmbed });
    memory.nodes.set(3, { id: 3, concept: 'node3', embedding: fakeEmbed });
    memory.addEdge(1, 2, 0.5);
    memory.addEdge(1, 3, 0.3);
    memory.addEdge(2, 3, 0.4);

    expect(memory.nodes.size).to.equal(3);
    expect(memory.edges.size).to.equal(3);

    memory.removeNode(1);

    expect(memory.nodes.size).to.equal(2);
    expect(memory.nodes.has(1)).to.be.false;
    for (const [key] of memory.edges) {
      expect(key).to.not.include('1->');
      expect(key).to.not.include('->1');
    }
    expect(memory.edges.size).to.equal(1);
  });

  it('should remove the node from cluster membership', () => {
    const fakeEmbed = new Array(512).fill(0.1);
    memory.nodes.set(1, { id: 1, concept: 'node1', embedding: fakeEmbed });
    memory.nodes.set(2, { id: 2, concept: 'node2', embedding: fakeEmbed });

    // Manually add nodes to a cluster (clusters are Map<id, Set<nodeId>>)
    memory.clusters.set('c1', new Set([1, 2]));

    memory.removeNode(1);

    expect(memory.nodes.has(1)).to.be.false;
    expect(memory.clusters.get('c1').has(1)).to.be.false;
    expect(memory.clusters.get('c1').has(2)).to.be.true;
  });

  it('should be a no-op for non-existent node IDs', () => {
    memory.nodes.set(1, { id: 1, concept: 'node1', embedding: new Array(512).fill(0.1) });
    memory.removeNode(999);
    expect(memory.nodes.size).to.equal(1);
  });
});
