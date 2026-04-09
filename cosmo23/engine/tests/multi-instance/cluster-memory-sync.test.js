const { expect } = require('chai');

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { ClusterAwareMemory } = require('../../src/cluster/cluster-aware-memory');
const { NetworkMemory } = require('../../src/memory/network-memory');
const { MemoryDiffMerger } = require('../../src/cluster/memory-merger');

const createLogger = () => ({
  info() {},
  warn() {},
  error() {},
  debug() {}
});

class InMemoryStateStore {
  constructor() {
    this.diffs = [];
    this.mergedState = null;
  }

  async submitDiff(cycle, instanceId, diff) {
    this.diffs.push({ cycle, instanceId, diff });
    return true;
  }

  takeDiffs() {
    const copies = [...this.diffs];
    this.diffs = [];
    return copies;
  }

  async getMergedState() {
    return this.mergedState;
  }

  setMergedState(state) {
    this.mergedState = state;
  }
}

const createClusterMemory = (instanceId, config, logger) => {
  const baseMemory = new NetworkMemory(config.architecture.memory, logger);
  baseMemory.embed = async () => Array(8).fill(0.05);
  baseMemory.embedBatch = async (texts) => texts.map(() => Array(8).fill(0.05));
  baseMemory.formInitialConnections = async () => {};

  const clusterMemory = new ClusterAwareMemory(baseMemory, {
    config,
    logger,
    instanceId,
    clusterEnabled: true
  });

  return {
    memory: clusterMemory.getInterface(),
    cluster: clusterMemory
  };
};

describe('Multi-Instance Memory Sync', () => {
  it('propagates node writes between instances via merged state', async () => {
    const configPath = path.join(__dirname, '../../src/config.yaml');
    const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
    const logger = createLogger();
    const stateStore = new InMemoryStateStore();

    const instanceA = createClusterMemory('instA', config, logger);
    const instanceB = createClusterMemory('instB', config, logger);

    instanceA.cluster.attachStateStore(stateStore);
    instanceB.cluster.attachStateStore(stateStore);
    instanceA.cluster.setClusterEnabled(true);
    instanceB.cluster.setClusterEnabled(true);

    instanceA.cluster.startCycleTracking();
    instanceB.cluster.startCycleTracking();
    const created = await instanceA.memory.addNode('Shared insight', 'research');
    const diff = await instanceA.cluster.getCycleDiff(1);
    await instanceA.cluster.submitCycleDiff(1, diff);

    const merger = new MemoryDiffMerger(logger);
    const pendingDiffs = stateStore.takeDiffs();
    pendingDiffs.forEach(entry => merger.applyDiff(entry.diff, entry.instanceId));
    const mergedState = merger.build(1);
    stateStore.setMergedState(mergedState);

    await instanceB.cluster.fetchMergedState(1);

    expect(instanceB.memory.nodes.size).to.equal(1);
    const receivedNode = Array.from(instanceB.memory.nodes.values())[0];
    expect(receivedNode.concept).to.equal('Shared insight');
    expect(receivedNode.tag).to.equal('research');
  });
});
