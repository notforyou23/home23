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

  it('defers then commits consolidation markers through one exact-identity patchNodes call', async () => {
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
    expect(memoryNetwork.patchNodes.called).to.equal(false);
    const candidate = results[0];
    const timestampDescriptor = Object.getOwnPropertyDescriptor(candidate, 'consolidationTimestamp');
    expect(timestampDescriptor).to.include({
      configurable: false,
      enumerable: false,
      writable: false,
    });
    expect(candidate.consolidationTimestamp).to.be.a('string');
    expect(Number.isFinite(Date.parse(candidate.consolidationTimestamp))).to.equal(true);

    const sourceCommit = summarizer.commitConsolidationSources(memoryNetwork, candidate);
    expect(sourceCommit.committed).to.equal(true);
    expect(sourceCommit.consolidatedAt).to.equal(candidate.consolidationTimestamp);
    expect(memoryNetwork.patchNodes.calledOnce).to.equal(true);
    const entries = memoryNetwork.patchNodes.firstCall.args[0];
    expect(entries).to.have.length(3);
    for (let index = 0; index < entries.length; index += 1) {
      expect(entries[index].nodeId).to.equal(cluster[index].id);
      expect(entries[index].expectedNode).to.equal(cluster[index]);
      expect(entries[index].patch.consolidatedAt).to.equal(candidate.consolidationTimestamp);
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

  it('blocks every marker when a source identity changes after candidate creation', async () => {
    const summarizer = new MemorySummarizer({}, logger(), {});
    const nodes = Array.from({ length: 10 }, (_, index) => node(`node-${index}`));
    const memoryNetwork = {
      nodes: new Map(nodes.map((entry) => [entry.id, entry])),
      patchNodes: sinon.stub(),
    };
    const cluster = nodes.slice(0, 3);
    sinon.stub(summarizer, 'clusterSimilarMemories').resolves([cluster]);
    sinon.stub(summarizer, 'createConsolidatedMemoryGPT5').resolves({
      content: 'candidate whose source will be replaced',
      reasoning: null,
      model: 'controlled-model',
    });
    const [candidate] = await summarizer.consolidateMemories(memoryNetwork);
    const replacement = node(cluster[0].id, { concept: 'replacement source' });
    memoryNetwork.nodes.set(replacement.id, replacement);

    const committed = summarizer.commitConsolidationSources(memoryNetwork, candidate);

    expect(committed).to.include({
      committed: false,
      mode: 'partial',
      reason: 'source_identity_changed',
      updatedSourceNodes: 0,
      skippedSourceNodes: cluster.length,
    });
    expect(committed.identityChangedSourceNodes).to.deep.equal([replacement.id]);
    expect(memoryNetwork.patchNodes.called).to.equal(false);
    expect(replacement.consolidatedAt).to.equal(undefined);
    expect(cluster.slice(1).every((entry) => entry.consolidatedAt === undefined)).to.equal(true);
  });

  it('reports an incomplete marker commit without claiming success', () => {
    const summarizer = new MemorySummarizer({}, logger(), {});
    const sources = [node('source-a'), node('source-b'), node('source-c')];
    const memoryNetwork = {
      nodes: new Map(sources.map((entry) => [entry.id, entry])),
      patchNodes: sinon.stub().returns({ updated: 2, nodes: sources.slice(0, 2) }),
    };
    const candidate = {
      sourceNodes: sources.map((entry) => entry.id),
    };
    Object.defineProperty(candidate, 'sourceIdentityTokens', {
      value: new Map(sources.map((entry) => [entry.id, entry])),
    });
    Object.defineProperty(candidate, 'consolidationTimestamp', {
      value: '2026-07-11T12:00:00.000Z',
    });

    const committed = summarizer.commitConsolidationSources(memoryNetwork, candidate);

    expect(committed).to.include({
      committed: false,
      mode: 'partial',
      reason: 'source_marker_commit_incomplete',
      updatedSourceNodes: 2,
      skippedSourceNodes: 1,
    });
    expect(memoryNetwork.patchNodes.firstCall.args[0][0].patch.consolidatedAt)
      .to.equal(candidate.consolidationTimestamp);
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
