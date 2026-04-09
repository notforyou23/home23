/**
 * Regression: Cluster-aware wrapper vs baseline NetworkMemory
 *
 * Ensures the proxy introduces no behavioural changes when clustering is off.
 */

const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');

const { ClusterAwareMemory } = require('../../src/cluster/cluster-aware-memory');
const { NetworkMemory } = require('../../src/memory/network-memory');

const loadConfig = () => {
  const configPath = path.join(__dirname, '../../src/config.yaml');
  return yaml.load(fs.readFileSync(configPath, 'utf8'));
};

const createLogger = () => ({
  info() {},
  warn() {},
  error() {},
  debug() {}
});

const createBaseMemory = (config, logger) => {
  const memory = new NetworkMemory(config.architecture.memory, logger);
  const embedding = Array(8).fill(0.15);
  memory.embed = async () => embedding.slice();
  memory.embedBatch = async (texts) => texts.map(() => embedding.slice());
  memory.formInitialConnections = async () => {};
  return memory;
};

const runScenario = async (memory) => {
  const n1 = await memory.addNode('Alpha hypothesis about clusters', 'research');
  const n2 = await memory.addNode('Beta insight on coordination', 'analysis');
  const n3 = await memory.addNode('Gamma idea for synthesis', 'synthesis');

  memory.addEdge(n1.id, n2.id, 0.42);
  memory.addEdge(n2.id, n3.id, 0.33);
  memory.reinforceCooccurrence([n1.id, n3.id]);

  const n1Record = memory.nodes.get(n1.id);
  n1Record.activation = 0.27;
  n1Record.weight = 0.81;

  memory.assignToCluster(n1.id);
  memory.assignToCluster(n2.id);
  memory.assignToCluster(n3.id);

  memory.removeEdge(n2.id, n3.id);
  return { n1, n2, n3 };
};

const sanitizeGraph = (graph) => ({
  nodes: graph.nodes
    .map((node) => ({
      id: node.id,
      concept: node.concept,
      tag: node.tag,
      cluster: node.cluster,
      weight: Number(node.weight?.toFixed(6)),
      activation: Number(node.activation?.toFixed(6) || 0),
      accessCount: node.accessCount,
      summary: node.summary || null,
      keyPhrase: node.keyPhrase || null,
      embeddingLength: Array.isArray(node.embedding) ? node.embedding.length : 0
    }))
    .sort((a, b) => a.id - b.id),
  edges: graph.edges
    .map((edge) => ({
      source: edge.source,
      target: edge.target,
      weight: Number(edge.weight?.toFixed(6)),
      type: edge.type
    }))
    .sort((a, b) => (a.source === b.source ? a.target - b.target : a.source - b.source)),
  clusters: graph.clusters
    .map((cluster) => ({
      id: cluster.id,
      nodes: Array.from(cluster.nodes || []).sort((a, b) => a - b)
    }))
    .sort((a, b) => a.id - b.id)
});

describe('Single-Instance Regression: ClusterAwareMemory parity', () => {
  it('produces identical memory graphs to baseline NetworkMemory in solo mode', async () => {
    const config = loadConfig();
    const logger = createLogger();

    const baselineMemory = createBaseMemory(config, logger);
    const wrappedBaseMemory = createBaseMemory(config, logger);
    const clusterWrapper = new ClusterAwareMemory(wrappedBaseMemory, {
      config,
      logger,
      instanceId: 'regression',
      clusterEnabled: false
    });
    const clusterMemory = clusterWrapper.getInterface();

    await runScenario(baselineMemory);
    await runScenario(clusterMemory);

    const baselineGraph = sanitizeGraph(baselineMemory.exportGraph());
    const clusterGraph = sanitizeGraph(clusterMemory.exportGraph());

    expect(clusterGraph).to.deep.equal(baselineGraph);
  });
});
