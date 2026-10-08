import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { DiscoveryEngine } = require('../../../engine/src/cognition/discovery-engine.js');
const { ClusterAwareMemory } = require('../../../engine/src/cluster/cluster-aware-memory.js');
const logger = { info() {}, warn() {} };

function graphFixture() {
  const visited = new Set();
  const nodes = new Map();
  for (let i = 0; i < 80; i++) {
    const id = `log-${i}`;
    const source = {
      id, tag: 'raw_log', metadata: { source_path: `/logs/${id}.jsonl` },
      created: new Date().toISOString(), accessed: new Date().toISOString(),
    };
    Object.defineProperty(source, 'concept', {
      enumerable: true,
      get() {
        visited.add(id);
        const end = performance.now() + 0.05;
        while (performance.now() < end) { /* emulate substantial classification input */ }
        return `Raw event ${id}`;
      },
    });
    nodes.set(id, source);
  }
  const local = { nodes, edges: new Map(), clusters: new Map(), persistenceGeneration: 0 };
  const cluster = new ClusterAwareMemory(local, { logger });
  const memory = cluster.getInterface();
  return { visited, cluster, memory, discovery: new DiscoveryEngine({ memory, logger }) };
}

test('discovery serves another event-loop turn before finishing a substantial authority scan', async () => {
  const { visited, memory, discovery } = graphFixture();
  const duringScan = new Promise(resolve => setImmediate(() => resolve(visited.size)));
  const probe = discovery._runProbe();
  assert.ok(await duringScan < memory.nodes.size, 'the entire authority scan blocked the event loop');
  await probe;
  assert.equal(discovery.stats.probeCount, 1);
  assert.equal(discovery.stats.errors, 0);
  assert.ok(discovery.peek().length > 0);
});

test('an in-place tracked mutation discards the old scan and the next scan uses the new authority', async () => {
  const { memory, cluster, discovery } = graphFixture();
  const mutation = new Promise(resolve => setImmediate(() => {
    memory.nodes.get('log-0').tag = 'synthesis_report';
    memory.nodes.get('log-0').metadata = {};
    resolve();
  }));
  const probe = discovery._runProbe();
  await mutation;
  await probe;
  assert.ok(cluster.versionClock > 0);
  assert.equal(memory.persistenceGeneration, 0, 'cluster writes require their own revision guard');
  assert.equal(discovery.queue.size, 0, 'discarded scan enqueued stale authority');
  assert.equal(discovery.stats.probeCount, 0);
  assert.equal(discovery.stats.supersededProbes, 1);
  await discovery._runProbe();
  assert.equal(discovery.stats.probeCount, 1);
  assert.equal(discovery.peek().some(c => c.signal === 'novelty' && c.nodeIds.includes('log-0')), false);
});

test('stopping discovery during a yielded scan prevents post-stop queue writes', async () => {
  const { discovery } = graphFixture();
  const stopped = new Promise(resolve => setImmediate(() => { discovery.stop(); resolve(); }));
  const probe = discovery._runProbe();
  await stopped;
  await probe;
  assert.equal(discovery.queue.size, 0);
  assert.equal(discovery.stats.probeCount, 0);
  assert.equal(discovery.stats.errors, 0);
});

test('overlapping discovery ticks share no partially built authority context', async () => {
  const { discovery } = graphFixture();
  await Promise.all([discovery._runProbe(), discovery._runProbe()]);
  assert.equal(discovery.stats.probeCount, 1);
  assert.equal(discovery.stats.errors, 0);
  assert.equal(discovery._probeAuthorityContext, null);
});
