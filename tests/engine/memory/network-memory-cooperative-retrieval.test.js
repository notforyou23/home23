import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NetworkMemory } = require('../../../engine/src/memory/network-memory.js');
const { ClusterAwareMemory } = require('../../../engine/src/cluster/cluster-aware-memory.js');

function corpus(t, wrapped = false) {
  const local = new NetworkMemory({
    embedding: { model: 'test', dimensions: 2 },
    spreading: { maxDepth: 2, activationThreshold: 0.1, decayFactor: 0.5 },
    smallWorld: {},
    retrieval: { keywordIndex: { smallGraphBootstrap: 0 } },
  }, { info() {}, warn() {}, debug() {}, error() {} });
  t.after(() => local.tokenizer?.free?.());
  const memory = wrapped ? new ClusterAwareMemory(local).getInterface() : local;
  for (let id = 0; id < 4096; id += 1) {
    memory.nodes.set(id, {
      id, concept: `archive group${Math.floor(id / 256)}`, embedding: [0, 1],
      weight: 0.2, activation: 0, accessCount: 0,
      created: '2025-01-01T00:00:00.000Z', accessed: '2025-01-01T00:00:00.000Z',
    });
  }
  memory.nodes.set('seed', {
    id: 'seed', concept: 'unique semantic canary', embedding: [1, 0],
    weight: 0.2, activation: 0, accessCount: 0,
    created: '2025-01-01T00:00:00.000Z', accessed: '2025-01-01T00:00:00.000Z',
  });
  const index = local._createKeywordIndexState();
  for (const node of local.nodes.values()) local._indexKeywordNode(node, index);
  local.keywordIndexState = index;
  local.embed = async () => [1, 0];
  return { memory, local };
}

for (const mode of ['semantic', 'keyword', 'peripheral']) {
  test(`${mode} retrieval serves pending work before finishing its scan`, async t => {
    const { memory, local } = corpus(t);
    let healthRan = false;
    let health;
    local.embed = async () => {
      health = new Promise(resolve => setImmediate(() => { healthRan = true; resolve(); }));
      return mode === 'keyword' ? null : [1, 0];
    };
    const query = mode === 'keyword' ? Array.from({ length: 16 }, (_, id) => `group${id}`).join(' ') : 'unique semantic canary';
    const expected = mode === 'keyword' ? memory.queryByKeyword(query, 6, { markAccess: false }) : null;
    const rows = mode === 'peripheral'
      ? await memory.queryPeripheral(query, 3)
      : await memory.query(query, 6, { markAccess: false });
    const ranDuringRetrieval = healthRan;
    await health;
    assert.equal(ranDuringRetrieval, true);
    if (expected) assert.deepEqual(rows, expected);
    else assert.equal(rows[0].id, 'seed');
    assert.equal(local.nodes.get('seed').accessCount, 0);
    assert.equal(local.nodes.get('seed').activation, 0);
  });
}

for (const mode of ['semantic', 'peripheral']) {
for (const mutation of ['node replacement', 'edge replacement', 'instrumented edit', 'append']) {
  if (mode === 'peripheral' && mutation === 'edge replacement') continue;
  test(`${mode} retrieval recovers one ${mutation} without another embedding call`, async t => {
    const { memory, local } = corpus(t, mutation === 'instrumented edit');
    memory.addEdge('seed', 0, 0.8);
    memory.markPersistenceClean();
    let change;
    let embeddings = 0;
    let writesAtChange;
    local.embed = async () => {
      embeddings += 1;
      change = new Promise(resolve => setImmediate(() => {
        if (mutation === 'node replacement') memory.nodes.set(4095, { ...memory.nodes.get(4095), concept: 'replacement' });
        else if (mutation === 'edge replacement') {
          const key = memory.edges.keys().next().value;
          memory.edges.set(key, { ...memory.edges.get(key), weight: 0.9 });
        } else if (mutation === 'instrumented edit') memory.nodes.get('seed').concept = 'a concurrent correction';
        else memory.importGraphChanges({ nodes: [{
          id: 'fresh', concept: 'unique semantic canary fresh state', embedding: [1, 0],
          tag: 'state_snapshot', created: '2026-01-01T00:00:00.000Z',
        }] });
        writesAtChange = [local.nodes.get('seed').accessCount, local.nodes.get('seed').activation];
        resolve();
      }));
      return [1, 0];
    };
    const rows = mode === 'semantic'
      ? await memory.query('unique semantic canary', 2)
      : await memory.queryPeripheral('unique semantic canary', 2);
    await change;
    assert.equal(embeddings, 1);
    assert.deepEqual(writesAtChange, [0, 0], 'the rejected attempt must not write access/activation');
    if (mutation === 'instrumented edit') assert.equal(rows.find(row => row.id === 'seed').concept, 'a concurrent correction');
    if (mutation === 'append') assert.ok(rows.some(row => row.id === 'fresh'));
    if (mode === 'semantic') {
      assert.equal(local.nodes.get('seed').accessCount, 1);
      assert.equal(local.nodes.get('seed').activation, 1);
    } else assert.deepEqual([local.nodes.get('seed').accessCount, local.nodes.get('seed').activation], [0, 0]);
  });
}
}

for (const mode of ['semantic', 'peripheral']) {
  test(`${mode} retrieval stops after its fresh-generation retry under persistent churn`, async t => {
    const { memory, local } = corpus(t, true);
    let embeddings = 0;
    local.embed = async () => { embeddings += 1; return [1, 0]; };
    const method = mode === 'semantic' ? '_queryWithEmbedding' : '_queryPeripheralWithEmbedding';
    const attempt = local[method].bind(local);
    let attempts = 0;
    const changes = [];
    local[method] = (...args) => {
      attempts += 1;
      changes.push(new Promise(resolve => setImmediate(() => {
        memory.patchNode('seed', { concept: `concurrent edit ${attempts}` });
        resolve();
      })));
      return attempt(...args);
    };
    const result = mode === 'semantic' ? memory.query('unique semantic canary', 2) : memory.queryPeripheral('unique semantic canary', 2);
    await assert.rejects(result, { code: 'source_changed', retryable: true });
    await Promise.all(changes);
    assert.equal(attempts, 2);
    assert.equal(embeddings, 1);
    assert.deepEqual([local.nodes.get('seed').accessCount, local.nodes.get('seed').activation], [0, 0]);
  });
}

test('successful semantic retrieval preserves owned access and spreading mutations', async t => {
  const { memory, local } = corpus(t, true);
  memory.addEdge('seed', 0, 0.8);
  memory.markPersistenceClean();
  const rows = await memory.query('unique semantic canary', 2);
  assert.equal(rows[0].id, 'seed');
  assert.equal(local.nodes.get('seed').activation, 1);
  assert.equal(local.nodes.get(0).activation, 0.4);
  for (const row of rows) {
    assert.equal(local.nodes.get(row.id).accessCount, 1);
    assert.ok(local.dirtyNodeIds.has(row.id));
  }
});

test('keyword retrieval fences a replaced candidate/authority index', async t => {
  const { memory, local } = corpus(t);
  let change;
  local.embed = async () => {
    change = new Promise(resolve => setImmediate(() => {
      local.keywordIndexState = local._createKeywordIndexState();
      resolve();
    }));
    return null;
  };
  const query = Array.from({ length: 16 }, (_, id) => `group${id}`).join(' ');
  assert.deepEqual(await memory.query(query, 4), []);
  await change;
  assert.equal(local.dirtyNodeIds.size, 0);
});

function connectedCorpus(t) {
  const fixture = corpus(t, true);
  for (let id = 0; id < 64; id += 1) {
    fixture.memory.addEdge('seed', id, 0.8);
    for (let neighbor = 64; neighbor < 72; neighbor += 1) fixture.memory.addEdge(id, neighbor, 0.8);
  }
  fixture.memory.markPersistenceClean();
  return fixture;
}

test('standalone spreading recovers one edit without partial activation writes', async t => {
  const { memory, local } = connectedCorpus(t);
  let activationAtChange;
  const change = new Promise(resolve => setImmediate(() => {
    activationAtChange = local.nodes.get('seed').activation;
    memory.patchNode(71, { concept: 'one concurrent edit' });
    resolve();
  }));
  const result = await memory.spreadActivation('seed');
  await change;
  assert.equal(activationAtChange, 0);
  assert.equal(result.get('seed'), 1);
  assert.equal(local.nodes.get('seed').activation, 1);
  assert.equal(local.nodes.get('seed').accessCount, 0);
});

for (const standalone of [true, false]) {
  test(`${standalone ? 'standalone spreading' : 'query-owned spreading'} has one bounded retry under churn`, async t => {
    const { memory, local } = connectedCorpus(t);
    let embeddings = 0;
    local.embed = async () => { embeddings += 1; return [1, 0]; };
    let attempts = 0;
    const changes = [];
    const spread = local._spreadActivationWithFence.bind(local);
    local._spreadActivationWithFence = (...args) => {
      attempts += 1;
      changes.push(new Promise(resolve => setImmediate(() => {
        memory.patchNode(71, { concept: `concurrent edit ${attempts}` });
        resolve();
      })));
      return spread(...args);
    };
    await assert.rejects(standalone ? memory.spreadActivation('seed') : memory.query('unique semantic canary', 2), {
      code: 'source_changed', retryable: true,
    });
    await Promise.all(changes);
    assert.equal(attempts, 2, 'a query-owned fence must not add a nested spreading retry');
    assert.equal(embeddings, standalone ? 0 : 1);
    assert.deepEqual([local.nodes.get('seed').accessCount, local.nodes.get('seed').activation], [0, 0]);
  });
}

test('cooperative authority passes retain a late closure and synchronous keyword parity', async t => {
  const { attestMemoryAuthority } = require('../../../shared/memory-authority-attestation.cjs');
  const key = '8'.repeat(64);
  const prior = process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
  process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = key;
  t.after(() => {
    if (prior === undefined) delete process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
    else process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = prior;
  });
  const { memory, local } = corpus(t);
  const claim = attestMemoryAuthority({
    id: 'claim', concept: 'unique semantic canary is broken', embedding: [1, 0],
    created: '2025-01-01T00:00:00.000Z', metadata: { goalId: 'canary' },
    provenance: {
      schema: 'home23.node-provenance.v1', authorityClass: 'verified_current_state',
      operationalAuthority: true, sourceRefs: ['goal:canary'], evidenceRefs: ['verifier:claim'],
    },
  }, key);
  const closure = attestMemoryAuthority({
    id: 'closure', concept: 'unique semantic canary is resolved', embedding: [1, 0],
    created: '2026-01-01T00:00:00.000Z', type: 'goal_resolution', status: 'resolved',
    metadata: { goalId: 'canary', resolved_at: '2026-01-01T00:00:00.000Z', closure_proof_refs: ['verifier:closure'] },
    provenance: {
      schema: 'home23.node-provenance.v1', authorityClass: 'worker_receipt',
      sourceRefs: ['goal:canary'], evidenceRefs: ['verifier:closure'],
    },
  }, key);
  for (const node of [claim, closure]) {
    memory.nodes.set(node.id, node);
    local._indexKeywordNode(node);
  }
  const peripheral = await memory.queryPeripheral('current canary status', 5);
  assert.equal(peripheral.some(row => row.id === 'claim'), false);
  assert.ok(peripheral.some(row => row.id === 'closure'));
  local.embed = async () => null;
  const options = { markAccess: false, nowMs: Date.parse('2026-02-01T00:00:00.000Z') };
  const expected = memory.queryByKeyword('canary', 5, options);
  const rows = await memory.query('canary', 5, options);
  assert.deepEqual(rows, expected);
  assert.equal(rows.find(row => row.id === 'claim').closureEvidence.closureNodeId, 'closure');
});
