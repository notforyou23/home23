import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { NetworkMemory } = require('../../../engine/src/memory/network-memory.js');
const { ClusterAwareMemory } = require('../../../engine/src/cluster/cluster-aware-memory.js');
const { Orchestrator } = require('../../../engine/src/core/orchestrator.js');

function corpus(t, wrapped = false) {
  const local = new NetworkMemory({ embedding: { model: 'test', dimensions: 128 }, smallWorld: {} },
    { info() {}, warn() {}, debug() {}, error() {} });
  t.after(() => local.tokenizer?.free?.());
  for (let id = 0; id < 4096; id++) local.nodes.set(id, {
    id, concept: `node ${id}`, embedding: new Float32Array(128).fill(id / 4096),
    activation: 0.2, weight: 0.4, accessCount: 2, metadata: { nested: [id] },
    asserted_at: '2026-10-08T00:00:00Z', source_class: 'fixture', tags: ['test'],
  });
  local.nodes.set('seed', { id: 'seed', concept: 'string identity', embedding: [1, 0], evidence: { source: 'fixture' } });
  local.edges.set('0->1', { weight: 0.3, type: 'legacy' });
  local.edges.set('1->seed', { source: 1, target: 'seed', weight: 0.6, type: 'explicit' });
  local.clusters.set('cluster', new Set([1, 'seed']));
  return { local, memory: wrapped ? new ClusterAwareMemory(local).getInterface() : local };
}

for (const wrapped of [false, true]) test(`complete graph export yields without changing records or access (${wrapped ? 'instrumented' : 'local'})`, async t => {
  const { memory } = corpus(t, wrapped), expected = memory.exportGraph();
  let pendingRan = false; setImmediate(() => { pendingRan = true; });
  const actual = await memory.exportGraphAsync();
  assert.equal(pendingRan, true, 'A full review snapshot must serve pending work');
  assert.deepEqual(actual, expected);
  assert.deepEqual(memory.exportGraph(), expected, 'Export must not change access, activation, or graph state');
});

for (const mutation of ['replacement', 'cluster order', 'next identity']) test(`one ${mutation} during export retries a complete current snapshot`, async t => {
  const { local } = corpus(t); let once = false, retries = 0;
  const original = local._yieldRetrieval;
  local._yieldRetrieval = async function(fence) {
    if (!once) {
      once = true; retries++;
      if (mutation === 'replacement') local.nodes.set(3000, { ...local.nodes.get(3000), concept: 'updated node' });
      else if (mutation === 'cluster order') { const members = local.clusters.get('cluster'); members.delete(1); members.add(1); }
      else local.nextNodeId++;
    }
    return original.call(this, fence);
  };
  assert.deepEqual(await local.exportGraphAsync(), local.exportGraph());
  assert.equal(retries, 1);
});

test('persistent instrumented edits reject instead of returning a partial graph', async t => {
  const { local, memory } = corpus(t, true); let yields = 0;
  const original = local._yieldRetrieval;
  local._yieldRetrieval = async function(fence) {
    yields++; memory.nodes.get(3000).weight += 0.01;
    return original.call(this, fence);
  };
  await assert.rejects(memory.exportGraphAsync(), { code: 'source_changed', retryable: true });
  assert.equal(yields, 2, 'Only one fresh snapshot retry is allowed');
});

test('coordinator review awaits the complete cooperative memory snapshot', async () => {
  const subject = Object.create(Orchestrator.prototype), order = [], graph = { nodes: [{ id: 'kept' }], edges: [], clusters: [] };
  subject.memory = {
    exportGraph() { throw new Error('synchronous export blocks health'); },
    async exportGraphAsync() { order.push('snapshot'); await new Promise(r => setImmediate(r)); order.push('complete'); return graph; },
  };
  subject.goals = { export: () => ({ active: [] }) }; subject.roles = { getRoles: () => [] };
  subject.reflection = { export: () => ({}) }; subject.oscillator = { getStats: () => ({}) };
  subject.stateModulator = { getState: () => ({}) };
  subject.coordinator = { conductReview: async snapshot => { order.push('review'); assert.equal(snapshot.memory, graph); return null; } };
  subject.handleReviewPipeline = async role => { assert.equal(role, 'solo'); order.push('pipeline'); };
  await subject.runMetaCoordinatorReview();
  assert.deepEqual(order, ['snapshot', 'complete', 'review', 'pipeline']);
});

test('an unstable snapshot defers the coordinator before review state or goals change', async () => {
  const subject = Object.create(Orchestrator.prototype), messages = [];
  subject.memory = { exportGraphAsync: async () => { throw Object.assign(new Error('changed'), { code: 'source_changed' }); } };
  subject.goals = { export() { throw new Error('must not capture or advance goals'); } };
  subject.coordinator = { lastReviewCycle: 123, conductReview() { throw new Error('must not review a partial snapshot'); } };
  subject.logger = { info: message => messages.push(message) };
  await subject.runMetaCoordinatorReview();
  assert.equal(subject.coordinator.lastReviewCycle, 123); assert.equal(messages.length, 1);
  subject.memory.exportGraphAsync = async () => { throw new Error('unexpected failure'); };
  await assert.rejects(subject.runMetaCoordinatorReview(), /unexpected failure/);
});
