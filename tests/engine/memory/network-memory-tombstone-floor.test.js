import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'openai') return class OpenAI {};
  if (request === 'dotenv') return { config() {} };
  if (request === 'tiktoken') {
    return { encoding_for_model: () => ({ encode: () => [], free() {} }) };
  }
  if (request.endsWith('/core/openai-client') || request === '../core/openai-client') {
    return { getOpenAIClient: () => null, getEmbeddingClient: () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { NetworkMemory: RootNetworkMemory } = require('../../../engine/src/memory/network-memory.js');
const { NetworkMemory: CosmoNetworkMemory } = require('../../../cosmo23/engine/src/memory/network-memory.js');
Module._load = originalLoad;

function config() {
  return {
    embedding: {},
    coordinator: {},
    smallWorld: { maxBridgesPerNode: 40 },
    spreading: { maxDepth: 2, activationThreshold: 0.01, decayFactor: 0.8 },
    hebbian: { enabled: false, reinforcementStrength: 0.1 },
    decay: { baseFactor: 0.95, minimumWeight: 0.01, decayInterval: 300, exemptTags: [] },
  };
}

for (const [name, NetworkMemory] of [
  ['root', RootNetworkMemory],
  ['COSMO', CosmoNetworkMemory],
]) {
  test(`${name} tombstone-only imports persist node identity without inventing cluster state`, async () => {
    const memory = new NetworkMemory(config(), {
      info() {}, warn() {}, error() {}, debug() {},
    });
    memory.embed = async () => [0.1, 0.2, 0.3];
    memory.markPersistenceCleanIfGeneration(memory.persistenceGeneration);
    const generation = memory.persistenceGeneration;

    assert.deepEqual(memory.importGraphChanges({
      nodeDeletes: [500],
      clusterDeletes: [700],
    }), {
      importedNodes: 0,
      importedEdges: 0,
      importedClusters: 0,
      removedNodes: 0,
      removedEdges: 0,
      removedClusters: 0,
    });
    assert.equal(memory.nextNodeId, 501);
    assert.equal(memory.nextClusterId, 1);
    assert.equal(memory.persistenceGeneration, generation + 1);
    assert.deepEqual(memory.capturePersistenceSnapshot().changes.removedNodeIds, [500]);
    assert.equal(memory.markPersistenceCleanIfGeneration(generation), false);

    const created = await memory.addNode(
      'new identity after tombstone-only import',
      'research',
      [0.1, 0.2, 0.3],
    );
    assert.equal(created.id, 501);
    assert.equal(created.cluster, 1);
  });
}
