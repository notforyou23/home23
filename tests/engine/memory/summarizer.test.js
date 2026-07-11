import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MemorySummarizer } = require('../../../engine/src/memory/summarizer.js');

function makeLogger() {
  const entries = [];
  const logger = {
    entries,
    info(message, data) {
      entries.push({ level: 'info', message, data });
    },
    warn(message, data) {
      entries.push({ level: 'warn', message, data });
    },
    error(message, data) {
      entries.push({ level: 'error', message, data });
    },
    debug(message, data) {
      entries.push({ level: 'debug', message, data });
    },
  };
  return logger;
}

function attachMutationApi(memoryNetwork) {
  memoryNetwork.mutationCalls = { patchNodes: 0, patchNode: 0, removeNodes: 0 };
  memoryNetwork.patchNodes = (entries) => {
    memoryNetwork.mutationCalls.patchNodes += 1;
    const nodes = [];
    for (const entry of entries) {
      const stored = memoryNetwork.nodes.get(entry.nodeId);
      if (!stored || (entry.expectedNode && stored !== entry.expectedNode)) continue;
      Object.assign(stored, entry.patch);
      nodes.push(stored);
    }
    return { updated: nodes.length, nodes };
  };
  memoryNetwork.patchNode = (nodeId, patch, options = {}) => {
    memoryNetwork.mutationCalls.patchNode += 1;
    const stored = memoryNetwork.nodes.get(nodeId);
    if (!stored || (options.expectedNode && stored !== options.expectedNode)) return null;
    Object.assign(stored, patch);
    return stored;
  };
  memoryNetwork.removeNodes = (nodeIds) => {
    memoryNetwork.mutationCalls.removeNodes += 1;
    let removedNodes = 0;
    for (const nodeId of nodeIds) {
      if (memoryNetwork.nodes.delete(nodeId)) removedNodes += 1;
    }
    return { removedNodes, removedEdges: 0 };
  };
  return memoryNetwork;
}

test('createConsolidatedMemoryGPT5 caps large clusters before sending model prompt', async () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
  const logger = makeLogger();
  const summarizer = new MemorySummarizer({}, logger, {});
  const sent = [];

  summarizer.gpt5 = {
    async generate(request) {
      sent.push(request);
      return { content: 'consolidated insight', reasoning: 'reasoned', model: 'test-model' };
    },
  };

  const cluster = Array.from({ length: 4688 }, (_, index) => ({
    id: `node-${index}`,
    concept: `memory concept ${index} ${'x'.repeat(500)}`,
    weight: index === 4687 ? 99999 : index,
  }));

  const result = await summarizer.createConsolidatedMemoryGPT5(cluster);

  assert.equal(result.content, 'consolidated insight');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].messages[0].content.length < 60000);
  assert.ok(sent[0].messages[0].content.includes('memory concept 4687'));
  assert.ok(sent[0].messages[0].content.includes('omitted'));
  assert.ok(
    logger.entries.some((entry) =>
      entry.message === 'Large memory cluster compacted before consolidation' &&
      entry.data.clusterSize === 4688 &&
      entry.data.selected < 4688
    )
  );
});

test('consolidateMemories limits cluster work per run and records deferral', async () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
  const logger = makeLogger();
  const summarizer = new MemorySummarizer({}, logger, {
    memory: {
      consolidation: {
        maxClustersPerRun: 2,
      },
    },
  });

  const clusters = Array.from({ length: 5 }, (_, clusterIndex) =>
    Array.from({ length: 3 }, (_, nodeIndex) => ({
      id: `cluster-${clusterIndex}-node-${nodeIndex}`,
      concept: `cluster ${clusterIndex} memory ${nodeIndex}`,
      weight: nodeIndex,
    }))
  );
  const nodes = clusters.flat();
  const memoryNetwork = attachMutationApi({ nodes: new Map(nodes.map((node) => [node.id, node])) });
  const attempted = [];

  summarizer.clusterSimilarMemories = async () => clusters;
  summarizer.createConsolidatedMemoryGPT5 = async (cluster) => {
    attempted.push(cluster[0].id);
    return { content: `summary ${cluster[0].id}`, reasoning: null, model: 'test-model' };
  };

  const result = await summarizer.consolidateMemories(memoryNetwork);

  for (const candidate of result) {
    assert.equal(summarizer.commitConsolidationSources(memoryNetwork, candidate).committed, true);
  }

  assert.equal(result.length, 2);
  assert.deepEqual(attempted, ['cluster-0-node-0', 'cluster-1-node-0']);
  assert.ok(nodes.slice(0, 6).every((node) => node.consolidatedAt));
  assert.ok(nodes.slice(6).every((node) => !node.consolidatedAt));
  assert.equal(memoryNetwork.mutationCalls.patchNodes, 2);
  assert.equal(summarizer.consolidationHistory.at(-1).eligibleClusters, 5);
  assert.equal(summarizer.consolidationHistory.at(-1).attemptedClusters, 2);
  assert.equal(summarizer.consolidationHistory.at(-1).deferredClusters, 3);
  assert.ok(
    logger.entries.some((entry) =>
      entry.message === 'Consolidation run deferred remaining clusters' &&
      entry.data.deferredClusters === 3
    )
  );
});

test('consolidateMemories dry-runs source compost without deleting sources', async () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
  const logger = makeLogger();
  const summarizer = new MemorySummarizer({}, logger, {});
  const clusters = [
    Array.from({ length: 5 }, (_, nodeIndex) => ({
      id: `source-a-${nodeIndex}`,
      concept: `alpha source ${nodeIndex}`,
      weight: nodeIndex,
    })),
    Array.from({ length: 5 }, (_, nodeIndex) => ({
      id: `source-b-${nodeIndex}`,
      concept: `beta source ${nodeIndex}`,
      weight: nodeIndex,
    })),
  ];
  const nodes = clusters.flat();
  const memoryNetwork = attachMutationApi({ nodes: new Map(nodes.map((node) => [node.id, node])) });

  summarizer.clusterSimilarMemories = async () => clusters;
  summarizer.createConsolidatedMemoryGPT5 = async (cluster) => ({
    content: `summary for ${cluster[0].id}`,
    reasoning: null,
    model: 'test-model',
  });

  const result = await summarizer.consolidateMemories(memoryNetwork, 0.75, {
    compostSources: 'dry-run',
  });

  for (const candidate of result) {
    assert.equal(summarizer.commitConsolidationSources(memoryNetwork, candidate).committed, true);
  }

  assert.equal(result.length, 2);
  assert.equal(result[0].compost.mode, 'dry-run');
  assert.equal(result[0].compost.wouldRemoveSourceNodes, 5);
  assert.equal(result[1].compost.wouldRemoveSourceNodes, 5);
  assert.equal(memoryNetwork.nodes.size, 10);
  assert.equal(memoryNetwork.mutationCalls.patchNodes, 2);
  assert.equal(memoryNetwork.mutationCalls.removeNodes, 0);
  assert.equal(summarizer.consolidationHistory.at(-1).compostDryRun.wouldRemoveSourceNodes, 10);
  assert.equal(summarizer.consolidationHistory.at(-1).compostDryRun.clusters, 2);
});

test('finalizeConsolidationCompost applies removal only after summary provenance is recorded', async () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
  const logger = makeLogger();
  const summarizer = new MemorySummarizer({}, logger, {});
  const removed = [];
  const sourceNodes = ['source-1', 'source-2', 'source-3'];
  const summaryNode = { id: 'summary-1', concept: '[CONSOLIDATED] source summary', tag: 'consolidated', metadata: {} };
  const memoryNetwork = attachMutationApi({
    nodes: new Map([
      ...sourceNodes.map((id) => [id, { id, concept: id, tag: 'reasoning' }]),
      [summaryNode.id, summaryNode],
    ]),
  });
  const originalRemoveNodes = memoryNetwork.removeNodes;
  memoryNetwork.removeNodes = (nodeIds) => {
    removed.push(...nodeIds);
    return originalRemoveNodes(nodeIds);
  };
  const consolidation = {
    sourceNodes,
    compost: { mode: 'ready', sourceNodes },
  };

  const result = summarizer.finalizeConsolidationCompost(memoryNetwork, consolidation, {
    mode: 'apply',
    summaryNodeId: summaryNode.id,
    confirmedDryRunAt: '2026-05-30T00:00:00.000Z',
  });

  assert.equal(result.removedSourceNodes, 3);
  assert.deepEqual(removed, sourceNodes);
  assert.equal(memoryNetwork.nodes.has('source-1'), false);
  assert.equal(memoryNetwork.nodes.has(summaryNode.id), true);
  assert.deepEqual(summaryNode.metadata.consolidationProvenance.sourceNodes, sourceNodes);
  assert.equal(summaryNode.metadata.consolidationProvenance.compostedSourceCount, 3);
  assert.equal(summaryNode.metadata.consolidationProvenance.model, null);
  assert.equal(memoryNetwork.mutationCalls.patchNode, 2);
  assert.equal(memoryNetwork.mutationCalls.removeNodes, 1);
  assert.equal(summaryNode.metadata.consolidationProvenance.compostStatus, 'complete');
});

test('consolidateMemories discards provider output when a source identity changes', async () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
  const logger = makeLogger();
  const summarizer = new MemorySummarizer({}, logger, {});
  const nodes = Array.from({ length: 10 }, (_, index) => ({
    id: `source-${index}`,
    concept: `source memory ${index}`,
    weight: index,
  }));
  const cluster = nodes.slice(0, 3);
  const memoryNetwork = attachMutationApi({ nodes: new Map(nodes.map((node) => [node.id, node])) });
  summarizer.clusterSimilarMemories = async () => [cluster];
  summarizer.createConsolidatedMemoryGPT5 = async () => {
    memoryNetwork.nodes.set(cluster[0].id, { ...cluster[0], concept: 'replacement identity' });
    return { content: 'stale summary', reasoning: null, model: 'test-model' };
  };

  const result = await summarizer.consolidateMemories(memoryNetwork);

  assert.deepEqual(result, []);
  assert.equal(memoryNetwork.mutationCalls.patchNodes, 0);
  assert.ok(cluster.every((node) => !node.consolidatedAt));
  assert.equal(summarizer.consolidationHistory.at(-1).consolidations, 0);
  assert.ok(logger.entries.some((entry) => entry.message === 'Memory consolidation discarded after source changed'));
});

test('consolidation source markers are deferred until a stored summary is ready', async () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
  const logger = makeLogger();
  const summarizer = new MemorySummarizer({}, logger, {});
  const nodes = Array.from({ length: 10 }, (_, index) => ({
    id: `deferred-source-${index}`,
    concept: `deferred durable source ${index}`,
    weight: index,
  }));
  const cluster = nodes.slice(0, 3);
  const memoryNetwork = attachMutationApi({ nodes: new Map(nodes.map((node) => [node.id, node])) });
  summarizer.clusterSimilarMemories = async () => [cluster];
  summarizer.createConsolidatedMemoryGPT5 = async () => ({
    content: 'deferred durable consolidation',
    reasoning: null,
    model: 'test-model',
  });

  const [candidate] = await summarizer.consolidateMemories(memoryNetwork);

  assert.ok(candidate);
  assert.equal(memoryNetwork.mutationCalls.patchNodes, 0);
  assert.ok(cluster.every((node) => !node.consolidatedAt));

  const committed = summarizer.commitConsolidationSources(memoryNetwork, candidate);

  assert.equal(committed.committed, true);
  assert.equal(memoryNetwork.mutationCalls.patchNodes, 1);
  assert.ok(cluster.every((node) => typeof node.consolidatedAt === 'string'));
});

test('compost provenance records only source nodes actually removed and preserves numeric IDs', () => {
  const logger = makeLogger();
  const summarizer = new MemorySummarizer({}, logger, {});
  const summaryNode = { id: 99, concept: 'numeric summary', metadata: {} };
  const memoryNetwork = attachMutationApi({
    nodes: new Map([
      [1, { id: 1, concept: 'one' }],
      [2, { id: 2, concept: 'two' }],
      [3, { id: 3, concept: 'three' }],
      [99, summaryNode],
    ]),
  });
  memoryNetwork.removeNodes = (nodeIds) => {
    memoryNetwork.mutationCalls.removeNodes += 1;
    assert.deepEqual(nodeIds, [1, 2, 3]);
    memoryNetwork.nodes.delete(1);
    return { removedNodes: 1, removedEdges: 0 };
  };

  const result = summarizer.finalizeConsolidationCompost(memoryNetwork, {
    sourceNodes: [1, 2, 3],
    model: 'test-model',
    compost: { mode: 'ready', sourceNodes: [1, 2, 3] },
  }, {
    mode: 'apply',
    summaryNodeId: 99,
    confirmedDryRunAt: '2026-07-11T00:00:00.000Z',
  });

  assert.equal(result.removedSourceNodes, 1);
  assert.equal(result.skippedSourceNodes, 2);
  assert.equal(memoryNetwork.mutationCalls.patchNode, 2);
  assert.equal(memoryNetwork.mutationCalls.removeNodes, 1);
  assert.deepEqual(summaryNode.metadata.consolidationProvenance.sourceNodes, [1, 2, 3]);
  assert.deepEqual(summaryNode.metadata.consolidationProvenance.compostedSourceNodes, [1]);
  assert.equal(summaryNode.metadata.consolidationProvenance.compostedSourceCount, 1);
  assert.equal(summaryNode.metadata.consolidationProvenance.skippedSourceCount, 2);
  assert.equal(summaryNode.metadata.consolidationProvenance.compostStatus, 'complete_with_skips');
});

test('compost never deletes a source identity replaced while the summary node is being created', async () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
  const logger = makeLogger();
  const summarizer = new MemorySummarizer({}, logger, {});
  const nodes = Array.from({ length: 10 }, (_, index) => ({
    id: `source-${index}`,
    concept: `durable source memory ${index}`,
    weight: index,
  }));
  const sourceCluster = nodes.slice(0, 3);
  const memoryNetwork = attachMutationApi({ nodes: new Map(nodes.map((node) => [node.id, node])) });
  summarizer.clusterSimilarMemories = async () => [sourceCluster];
  summarizer.createConsolidatedMemoryGPT5 = async () => ({
    content: 'durable consolidated insight',
    reasoning: null,
    model: 'test-model',
  });

  const [consolidation] = await summarizer.consolidateMemories(memoryNetwork, 0.75, {
    compostSources: 'apply',
  });
  const replacedSourceId = sourceCluster[0].id;
  const replacement = {
    ...sourceCluster[0],
    concept: 'replacement accepted while summary embedding was pending',
  };
  memoryNetwork.nodes.set(replacedSourceId, replacement);
  const summaryNode = {
    id: 'summary-identity-race',
    concept: '[CONSOLIDATED] durable consolidated insight',
    tag: 'consolidated',
    metadata: {},
  };
  memoryNetwork.nodes.set(summaryNode.id, summaryNode);

  const result = summarizer.finalizeConsolidationCompost(memoryNetwork, consolidation, {
    mode: 'apply',
    summaryNodeId: summaryNode.id,
    confirmedDryRunAt: '2026-07-11T00:00:00.000Z',
  });

  assert.equal(result.mode, 'partial');
  assert.equal(result.reason, 'source_identity_changed');
  assert.equal(result.removedSourceNodes, 2);
  assert.equal(result.skippedSourceNodes, 1);
  assert.deepEqual(result.identityChangedSourceNodes, [replacedSourceId]);
  assert.equal(memoryNetwork.nodes.get(replacedSourceId), replacement);
  assert.equal(memoryNetwork.nodes.has(sourceCluster[1].id), false);
  assert.equal(memoryNetwork.nodes.has(sourceCluster[2].id), false);
  assert.deepEqual(
    summaryNode.metadata.consolidationProvenance.compostedSourceNodes.sort(),
    [sourceCluster[1].id, sourceCluster[2].id].sort(),
  );
  assert.deepEqual(
    summaryNode.metadata.consolidationProvenance.identityChangedSourceNodes,
    [replacedSourceId],
  );
  assert.equal(summaryNode.metadata.consolidationProvenance.compostStatus, 'complete_with_skips');
});
