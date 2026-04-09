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

const createMemoryWrapper = () => {
  const config = loadConfig();
  const logger = createLogger();

  const baseMemory = new NetworkMemory(config.architecture.memory, logger);

  // Deterministic embeddings for tests (no network calls)
  baseMemory.embed = async () => Array(8).fill(0.1);
  baseMemory.embedBatch = async (texts) => texts.map(() => Array(8).fill(0.1));
  baseMemory.formInitialConnections = async () => {};

  const clusterMemory = new ClusterAwareMemory(baseMemory, {
    config,
    logger,
    instanceId: 'test-instance',
    clusterEnabled: false
  });

  return { memory: clusterMemory.getInterface(), cluster: clusterMemory, config, logger };
};

describe('ClusterAwareMemory', () => {
  it('delegates operations to the underlying NetworkMemory when clustering is disabled', async () => {
    const { memory, cluster } = createMemoryWrapper();

    const node = await memory.addNode('Test concept for cluster-aware wrapper', 'test');

    expect(node).to.exist;
    expect(memory.nodes.size).to.equal(1);
    expect(memory.__cluster).to.equal(cluster);
    expect(cluster.isClusterEnabled()).to.equal(false);
  });

  it('tracks node, edge, and cluster mutations through instrumentation', async () => {
    const { memory, cluster } = createMemoryWrapper();
    cluster.startCycleTracking();

    const alpha = await memory.addNode('Alpha concept', 'test');
    const beta = await memory.addNode('Beta concept', 'test');

    const alphaRecord = memory.nodes.get(alpha.id);
    alphaRecord.weight = 0.75; // Proxy should record mutation

    memory.addEdge(alpha.id, beta.id, 0.3);
    const edgeKey = [alpha.id, beta.id].sort((a, b) => a - b).join('->');
    const edgeRecord = memory.edges.get(edgeKey);
    edgeRecord.weight = 0.9;

    memory.assignToCluster(alpha.id);
    memory.assignToCluster(beta.id);

    memory.removeEdge(alpha.id, beta.id);
    memory.nodes.delete(beta.id);

    expect(cluster.trackedNodes.has(alpha.id)).to.be.true;
    expect(cluster.deletedNodes.has(beta.id)).to.be.true;
    expect(cluster.trackedEdges.has(edgeKey)).to.be.false;
    expect(cluster.deletedEdges.has(edgeKey)).to.be.true;

    const clusterId = memory.nodes.get(alpha.id).cluster;
    expect(clusterId).to.be.a('number');
    expect(cluster.trackedClusters.has(clusterId)).to.be.true;
  });

  it('emits diff payload reflecting node, edge, and cluster mutations when cluster mode enabled', async () => {
    const { memory, cluster } = createMemoryWrapper();
    const submittedDiffs = [];
    const fakeStore = {
      submitDiff: async (cycle, instanceId, diff) => submittedDiffs.push({ cycle, instanceId, diff }),
      getMergedState: async () => null
    };

    cluster.attachStateStore(fakeStore);
    cluster.setClusterEnabled(true);

    cluster.startCycleTracking();
    const nodeA = await memory.addNode('A', 'test');
    const nodeB = await memory.addNode('B', 'test');
    memory.addEdge(nodeA.id, nodeB.id, 0.4);
    const edgeKey = [nodeA.id, nodeB.id].sort((a, b) => a - b).join('->');
    memory.assignToCluster(nodeA.id);
    memory.removeEdge(nodeA.id, nodeB.id);
    memory.nodes.delete(nodeB.id);

    const diff = await cluster.getCycleDiff(7);
    expect(diff).to.exist;
    expect(Object.keys(diff.fields)).to.not.be.empty;

    const nodeSetKey = `memory.node.${nodeA.id}`;
    const nodeDeleteKey = `memory.node.${nodeB.id}`;
    const edgeDeleteKey = `memory.edge.${edgeKey}`;
    const clusterKey = Object.keys(diff.fields).find((key) => key.startsWith('memory.cluster.'));

    expect(diff.fields[nodeSetKey]).to.deep.include({ op: 'set' });
    expect(diff.fields[nodeDeleteKey]).to.deep.include({ op: 'delete' });
    expect(diff.fields[edgeDeleteKey]).to.deep.include({ op: 'delete' });
    expect(clusterKey).to.exist;
    expect(diff.versionVector).to.have.property('test-instance');

    await cluster.submitCycleDiff(7, diff);
    expect(submittedDiffs).to.have.lengthOf(1);
    expect(submittedDiffs[0].diff).to.deep.equal(diff);
  });

  it('applies merged state snapshots without recording local mutations', async () => {
    const { memory, cluster } = createMemoryWrapper();
    const mergedPayload = {
      memory: {
        nodes: [
          {
            id: 9001,
            concept: 'Merged node',
            weight: 0.6,
            activation: 0.1,
            cluster: 42,
            accessCount: 3,
            created: new Date().toISOString(),
            accessed: new Date().toISOString()
          },
          {
            id: 9002,
            concept: 'Merged companion',
            weight: 0.5,
            activation: 0.05,
            cluster: 42,
            accessCount: 1,
            created: new Date().toISOString(),
            accessed: new Date().toISOString()
          }
        ],
        edges: [
          {
            id: '9001->9002',
            source: 9001,
            target: 9002,
            weight: 0.35,
            type: 'merged',
            created: new Date().toISOString(),
            accessed: new Date().toISOString()
          }
        ],
        clusters: [
          {
            id: 42,
            nodes: [9001, 9002]
          }
        ]
      }
    };

    const fakeStore = {
      submitDiff: async () => {},
      getMergedState: async () => mergedPayload
    };

    cluster.attachStateStore(fakeStore);
    cluster.setClusterEnabled(true);
    cluster.startCycleTracking();
    cluster.startCycleTracking(); // ensure clean slate

    await cluster.fetchMergedState(11);

    expect(memory.nodes.has(9001)).to.be.true;
    expect(memory.nodes.has(9002)).to.be.true;
    expect(memory.edges.has('9001->9002')).to.be.true;
    expect(memory.clusters.has(42)).to.be.true;
    expect(cluster.trackedNodes.size).to.equal(0);
    expect(cluster.trackedEdges.size).to.equal(0);
    expect(cluster.trackedClusters.size).to.equal(0);

    cluster.startCycleTracking();
    const mergedNode = memory.nodes.get(9001);
    mergedNode.weight = 0.9;
    expect(cluster.trackedNodes.has(9001)).to.be.true;
  });

  it('applies merged state sets and deletes correctly', async () => {
    const { memory, cluster } = createMemoryWrapper();

    cluster.attachStateStore({
      submitDiff: async () => {},
      getMergedState: async () => ({
        cycle: 1,
        memory: {
          sets: {
            nodes: [
              {
                id: 1,
                concept: 'Updated concept',
                tag: 'test',
                embedding: Array(8).fill(0.2),
                weight: 0.55,
                activation: 0.4,
                cluster: 5,
                accessCount: 2,
                created: new Date().toISOString(),
                accessed: new Date().toISOString()
              }
            ],
            edges: [],
            clusters: [
              {
                id: 5,
                nodes: [1]
              }
            ]
          },
          deletes: {
            nodeIds: [2],
            edgeKeys: ['1->2'],
            clusterIds: []
          }
        }
      })
    });

    cluster.setClusterEnabled(true);

    // Seed local memory with nodes/edges to validate deletion
    cluster.startCycleTracking();
    const nodeA = await memory.addNode('Original concept', 'test');
    const nodeB = await memory.addNode('Second concept', 'test');
    memory.addEdge(nodeA.id, nodeB.id, 0.4);
    const edgeKey = [nodeA.id, nodeB.id].sort((a, b) => a - b).join('->');
    memory.assignToCluster(nodeA.id);
    memory.assignToCluster(nodeB.id);

    await cluster.fetchMergedState(1);

    expect(memory.nodes.has(nodeA.id)).to.be.true;
    expect(memory.nodes.get(nodeA.id).concept).to.equal('Updated concept');
    expect(memory.nodes.has(nodeB.id)).to.be.false;
    expect(memory.edges.has(edgeKey)).to.be.false;
    expect(memory.clusters.has(5)).to.be.true;
  });
});
