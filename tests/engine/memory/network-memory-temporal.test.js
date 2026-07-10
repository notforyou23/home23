import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NetworkMemory } = require('../../../engine/src/memory/network-memory.js');

function makeMemory() {
  const memory = new NetworkMemory({
    embedding: { model: 'test', dimensions: 2 },
    decay: { minimumWeight: 0.1 },
    hebbian: { reinforcementStrength: 0.1 },
    spreading: { bridgeTraversalFactor: 0.2 },
    retrieval: { temporalHalfLifeDays: 14 },
    coordinator: {},
  }, {
    info() {},
    warn() {},
    debug() {},
    error() {},
  });
  memory.embed = async () => [1, 0];
  return memory;
}

function makeMemoryLite() {
  const memory = makeMemory();
  memory.embed = async () => null;
  return memory;
}

function makeRewireMemory() {
  const memory = makeMemory();
  memory.config.smallWorld = {
    ...(memory.config.smallWorld || {}),
    maxRewireEdgesPerRun: 3,
    rewireYieldEvery: 1,
    maxBridgesPerNode: 40,
  };
  for (let id = 1; id <= 30; id++) {
    const cluster = id <= 15 ? 1 : 2;
    memory.nodes.set(id, {
      id,
      concept: `node ${id}`,
      cluster,
      activation: 0,
      created: new Date(),
      accessed: new Date(),
    });
    const set = memory.clusters.get(cluster) || new Set();
    set.add(id);
    memory.clusters.set(cluster, set);
  }
  for (let id = 1; id <= 12; id++) {
    memory.addEdge(id, id + 1, 0.25, 'semantic');
  }
  return memory;
}

function restoreEmbeddingEnv(previous) {
  const entries = {
    EMBEDDING_PROVIDER: previous.provider,
    EMBEDDING_BASE_URL: previous.baseUrl,
    EMBEDDING_MODEL: previous.model,
    EMBEDDING_DIMENSIONS: previous.dimensions,
  };
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('query boosts current state_snapshot above older cue-matched nodes', async () => {
  const memory = makeMemory();

  const old = await memory.addNode('Health shortcut is dark and the bridge is broken.', 'deep_thought', [1, 0]);
  old.created = new Date(Date.now() - 30 * 86400000);
  old.asserted_at = new Date(Date.now() - 30 * 86400000).toISOString();

  const snapshot = await memory.addNode({
    concept: '[STATE_SNAPSHOT] RECENT.md: health bridge is stale at the Pi/HealthKit source; dashboard is live.',
    tag: 'state_snapshot',
    type: 'state_snapshot',
    tags: ['state_snapshot', 'current_state'],
    asserted_at: new Date().toISOString(),
    asserted_cycle: 6299,
    metadata: { kind: 'state_snapshot', source: 'RECENT.md' },
  }, 'state_snapshot', [1, 0]);

  const results = await memory.query('health bridge dashboard', 2);

  assert.equal(results[0].id, snapshot.id);
  assert.ok(results[0].retrievalScore > results[1].retrievalScore);
  assert.equal(results[0].asserted_cycle, 6299);
});

test('retrieval salience demotes cron conversation logs below direct user conversation', async () => {
  const memory = makeMemory();
  const now = Date.parse('2026-05-30T12:00:00.000Z');

  const direct = await memory.addNode({
    concept: 'Channel: dashboard-jerry\n**User:** Fix the brain cleanup scope.',
    tag: 'conversation_sessions',
    created: '2026-05-20T00:00:00.000Z',
  }, 'conversation_sessions', [1, 0]);

  const cron = await memory.addNode({
    concept: 'Channel: cron-agent-1775704909558\n**User:** Run the EVENING-RESEARCH session for Ticker Home23.',
    tag: 'conversation_sessions',
    created: '2026-05-30T00:00:00.000Z',
  }, 'conversation_sessions', [1, 0]);

  const directScore = memory.scoreTemporalRetrieval(direct, 0.5, { nowMs: now });
  const cronScore = memory.scoreTemporalRetrieval(cron, 0.5, { nowMs: now });

  assert.equal(direct.source_class, 'conversation');
  assert.equal(cron.source_class, 'telemetry');
  assert.ok(directScore > cronScore);
});

test('addNode preserves temporal metadata through exportGraph', async () => {
  const memory = makeMemory();
  await memory.addNode({
    concept: 'Goal resolved with visible output.',
    tag: 'goal_resolution',
    type: 'goal_resolution',
    tags: ['goal_resolution', 'completed'],
    asserted_at: '2026-05-01T19:00:00.000Z',
    asserted_cycle: 6300,
    superseded_by: 'node-newer',
    confidence_decay: 0.8,
    status: 'completed',
    metadata: { kind: 'goal_resolution', goalId: 'g1' },
  }, 'goal_resolution', [1, 0]);

  const [node] = memory.exportGraph().nodes;
  assert.equal(node.type, 'goal_resolution');
  assert.deepEqual(node.tags, ['goal_resolution', 'completed']);
  assert.equal(node.asserted_at, '2026-05-01T19:00:00.000Z');
  assert.equal(node.asserted_cycle, 6300);
  assert.equal(node.superseded_by, 'node-newer');
  assert.equal(node.confidence_decay, 0.8);
  assert.equal(node.status, 'completed');
  assert.equal(node.metadata.goalId, 'g1');
  assert.equal(node.source_class, 'durable');
  assert.equal(node.salienceWeight, 1);
  assert.equal(node.provenance.sourceClass, 'durable');
});

test('runtime embeddings use typed arrays while exports stay JSON arrays', async () => {
  const memory = makeMemory();
  const node = await memory.addNode('typed embedding memory', 'test', [1, 0]);

  assert.equal(node.embedding instanceof Float32Array, true);
  assert.equal(memory.cosineSimilarity(node.embedding, Float32Array.from([1, 0])), 1);

  const exported = memory.exportGraph().nodes[0];
  assert.equal(Array.isArray(exported.embedding), true);
  assert.deepEqual(exported.embedding, [1, 0]);

  const changes = memory.consumePersistenceChanges();
  assert.equal(Array.isArray(changes.nodes[0].embedding), true);
  assert.deepEqual(changes.nodes[0].embedding, [1, 0]);
});

test('Memory Lite stores text nodes when embeddings are unavailable', async () => {
  const memory = makeMemoryLite();
  const node = await memory.addNode('Project Alpha should remember the launch checklist.', 'project_note');

  assert.ok(node);
  assert.equal(node.embedding, null);
  assert.equal(node.embedding_status, 'missing');
  assert.equal(memory.nodes.size, 1);

  const exported = memory.exportGraph().nodes[0];
  assert.equal(exported.embedding, null);
  assert.equal(exported.embedding_status, 'missing');
});

test('Memory Lite query falls back to keyword retrieval when query embedding fails', async () => {
  const memory = makeMemoryLite();
  await memory.addNode('Project Alpha should remember the launch checklist.', 'project_note');
  await memory.addNode('Garden notes about compost and watering.', 'personal_note');

  const results = await memory.query('alpha launch', 2);

  assert.equal(results.length, 1);
  assert.match(results[0].concept, /Project Alpha/);
  assert.equal(results[0].retrievalMode, 'keyword');
});

test('own-brain semantic query reinforces access metadata and persistence changes', async () => {
  const memory = makeMemory();
  const node = await memory.addNode('Semantic access canary for own brain.', 'project_note', [1, 0]);
  node.weight = 0.2;
  memory.consumePersistenceChanges();
  const beforeAccessed = node.accessed;
  const beforeWeight = node.weight;

  const results = await memory.query('semantic access canary', 1);

  assert.equal(results[0].id, node.id);
  assert.equal(node.accessCount, 1);
  assert.notEqual(node.accessed, beforeAccessed);
  assert.ok(node.weight > beforeWeight);
  assert.equal(memory.hasPersistenceChanges(), true);
  assert.deepEqual(memory.consumePersistenceChanges().nodes.map((row) => row.id), [node.id]);
});

test('read-only semantic and keyword queries do not mutate access metadata', async () => {
  const semantic = makeMemory();
  const semanticNode = await semantic.addNode('Cross-brain semantic canary.', 'project_note', [1, 0]);
  semantic.consumePersistenceChanges();
  const semanticAccessed = semanticNode.accessed;
  const semanticWeight = semanticNode.weight;

  const semanticResults = await semantic.query('cross brain semantic canary', 1, { accessMode: 'read-only' });

  assert.equal(semanticResults[0].id, semanticNode.id);
  assert.equal(semanticNode.accessCount, 0);
  assert.equal(semanticNode.accessed, semanticAccessed);
  assert.equal(semanticNode.weight, semanticWeight);
  assert.equal(semantic.hasPersistenceChanges(), false);

  const keyword = makeMemoryLite();
  const keywordNode = await keyword.addNode('Cross-brain keyword canary.', 'project_note');
  keyword.consumePersistenceChanges();
  const keywordAccessed = keywordNode.accessed;
  const keywordWeight = keywordNode.weight;

  const keywordResults = await keyword.query('cross brain keyword canary', 1, { markAccess: false });

  assert.equal(keywordResults[0].id, keywordNode.id);
  assert.equal(keywordNode.accessCount, 0);
  assert.equal(keywordNode.accessed, keywordAccessed);
  assert.equal(keywordNode.weight, keywordWeight);
  assert.equal(keyword.hasPersistenceChanges(), false);
});

test('persistence changes capture node, edge, and removal mutations', async () => {
  const memory = makeMemory();
  const first = await memory.addNode('first durable memory', 'test', [1, 0]);
  const second = await memory.addNode('second durable memory', 'test', [1, 0]);
  memory.addEdge(first.id, second.id, 0.25, 'manual');

  const initial = memory.consumePersistenceChanges();
  assert.ok(initial.nodes.some((node) => node.id === first.id));
  assert.ok(initial.nodes.some((node) => node.id === second.id));
  assert.ok(initial.edges.some((edge) => edge.source === first.id || edge.target === first.id));
  assert.equal(memory.hasPersistenceChanges(), false);

  memory.removeNode(first.id);
  const removed = memory.consumePersistenceChanges();
  assert.deepEqual(removed.removedNodeIds, [first.id]);
  assert.ok(removed.removedEdgeKeys.length >= 1);
  assert.equal(memory.hasPersistenceChanges(), false);
});

test('exportPersistenceShell omits full node and edge payloads but keeps graph metadata', async () => {
  const memory = makeMemory();
  const first = await memory.addNode('first durable memory', 'test', [1, 0]);
  const second = await memory.addNode('second durable memory', 'test', [1, 0]);
  memory.addEdge(first.id, second.id, 0.25, 'manual');

  const shell = memory.exportPersistenceShell();

  assert.deepEqual(shell.nodes, []);
  assert.deepEqual(shell.edges, []);
  assert.ok(Array.isArray(shell.clusters));
  assert.equal(shell.nextNodeId, memory.nextNodeId);
  assert.equal(shell.nextClusterId, memory.nextClusterId);
});

test('rewireSmallWorld caps large topology maintenance runs for engine responsiveness', async () => {
  const memory = makeRewireMemory();

  const rewired = await memory.rewireSmallWorld(1);

  assert.ok(rewired <= 3);
});

test('rewireSmallWorld does not scan all bridges for each dream bridge insertion', async () => {
  const memory = makeRewireMemory();
  const originalRandom = Math.random;
  Math.random = () => 0.75;
  memory.enforceBridgeCap = () => {
    throw new Error('rewireSmallWorld should use precomputed bridge counts');
  };

  try {
    const rewired = await memory.rewireSmallWorld(1);

    assert.ok(rewired > 0);
  } finally {
    Math.random = originalRandom;
  }
});

test('embedding request params honor environment-selected provider model and dimensions', () => {
  const previous = {
    provider: process.env.EMBEDDING_PROVIDER,
    baseUrl: process.env.EMBEDDING_BASE_URL,
    model: process.env.EMBEDDING_MODEL,
    dimensions: process.env.EMBEDDING_DIMENSIONS,
  };
  try {
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.EMBEDDING_BASE_URL = 'https://api.openai.com/v1';
    process.env.EMBEDDING_MODEL = 'text-embedding-3-small';
    process.env.EMBEDDING_DIMENSIONS = '1536';

    const memory = makeMemory();
    const params = memory.buildEmbeddingCreateParams('hello');

    assert.equal(params.model, 'text-embedding-3-small');
    assert.equal(params.input, 'hello');
    assert.equal(params.encoding_format, 'float');
    assert.equal(params.dimensions, 1536);
  } finally {
    restoreEmbeddingEnv(previous);
  }
});

test('embedding request params avoid OpenAI-only options for Ollama embeddings', () => {
  const previous = {
    provider: process.env.EMBEDDING_PROVIDER,
    baseUrl: process.env.EMBEDDING_BASE_URL,
    model: process.env.EMBEDDING_MODEL,
    dimensions: process.env.EMBEDDING_DIMENSIONS,
  };
  try {
    process.env.EMBEDDING_PROVIDER = 'ollama-local';
    process.env.EMBEDDING_BASE_URL = 'http://127.0.0.1:11434/v1';
    process.env.EMBEDDING_MODEL = 'nomic-embed-text';
    process.env.EMBEDDING_DIMENSIONS = '768';

    const memory = makeMemory();
    const params = memory.buildEmbeddingCreateParams(['hello']);

    assert.equal(params.model, 'nomic-embed-text');
    assert.deepEqual(params.input, ['hello']);
    assert.equal(params.encoding_format, undefined);
    assert.equal(params.dimensions, undefined);
  } finally {
    restoreEmbeddingEnv(previous);
  }
});
