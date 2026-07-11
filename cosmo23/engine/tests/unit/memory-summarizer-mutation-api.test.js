'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const { MemorySummarizer } = require('../../src/memory/summarizer');

function logger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function node(id, overrides = {}) {
  return {
    id,
    concept: `durable memory ${id}`,
    tag: 'note',
    weight: 1,
    accessed: new Date(),
    ...overrides,
  };
}

describe('MemorySummarizer mutation API boundary', () => {
  afterEach(() => sinon.restore());

  it('commits consolidation markers through one exact-identity patchNodes call', async () => {
    const summarizer = new MemorySummarizer({}, logger(), {});
    const nodes = Array.from({ length: 10 }, (_, index) => node(`node-${index}`));
    const memoryNetwork = {
      nodes: new Map(nodes.map((entry) => [entry.id, entry])),
      patchNodes: sinon.stub().callsFake((entries) => ({
        updated: entries.length,
        nodes: entries.map((entry) => entry.expectedNode),
      })),
    };
    const cluster = nodes.slice(0, 3);
    sinon.stub(summarizer, 'clusterSimilarMemories').resolves([cluster]);
    sinon.stub(summarizer, 'createConsolidatedMemoryGPT5').resolves({
      content: 'one durable consolidation',
      reasoning: null,
      model: 'controlled-model',
    });

    const results = await summarizer.consolidateMemories(memoryNetwork);

    expect(results).to.have.length(1);
    expect(memoryNetwork.patchNodes.calledOnce).to.equal(true);
    const entries = memoryNetwork.patchNodes.firstCall.args[0];
    expect(entries).to.have.length(3);
    for (let index = 0; index < entries.length; index += 1) {
      expect(entries[index].nodeId).to.equal(cluster[index].id);
      expect(entries[index].expectedNode).to.equal(cluster[index]);
      expect(entries[index].patch.consolidatedAt).to.be.a('string');
    }
  });

  it('discards provider output when a source identity changes before commit', async () => {
    const summarizer = new MemorySummarizer({}, logger(), {});
    const nodes = Array.from({ length: 10 }, (_, index) => node(`node-${index}`));
    const memoryNetwork = {
      nodes: new Map(nodes.map((entry) => [entry.id, entry])),
      patchNodes: sinon.stub(),
    };
    const cluster = nodes.slice(0, 3);
    sinon.stub(summarizer, 'clusterSimilarMemories').resolves([cluster]);
    sinon.stub(summarizer, 'createConsolidatedMemoryGPT5').callsFake(async () => {
      memoryNetwork.nodes.set(cluster[0].id, node(cluster[0].id));
      return { content: 'stale result', reasoning: null, model: 'controlled-model' };
    });

    const results = await summarizer.consolidateMemories(memoryNetwork);

    expect(results).to.deep.equal([]);
    expect(memoryNetwork.patchNodes.called).to.equal(false);
  });

  it('removes garbage through removeNodes without direct map deletion', () => {
    const summarizer = new MemorySummarizer({}, logger(), {});
    const expired = node('expired', {
      weight: 0.001,
      accessed: new Date('2020-01-01T00:00:00.000Z'),
    });
    const protectedNode = node('protected', {
      tag: 'research',
      weight: 0.001,
      accessed: new Date('2020-01-01T00:00:00.000Z'),
    });
    const memoryNetwork = {
      nodes: new Map([[expired.id, expired], [protectedNode.id, protectedNode]]),
      removeNodes: sinon.stub().callsFake((ids) => {
        for (const id of ids) memoryNetwork.nodes.delete(id);
        return { removedNodes: ids.length, removedEdges: 0 };
      }),
    };

    const removed = summarizer.garbageCollect(memoryNetwork, 0.01, 1);

    expect(removed).to.equal(1);
    expect(memoryNetwork.removeNodes.calledOnceWithExactly(['expired'])).to.equal(true);
    expect(memoryNetwork.nodes.has('protected')).to.equal(true);
  });
});
