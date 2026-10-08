import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { ConversationSalience } = require('../../../engine/src/cognition/conversation-salience.js');
const { DiscoveryEngine } = require('../../../engine/src/cognition/discovery-engine.js');
const logger = { info() {}, warn() {} };

function fixture() {
  const memory = { nodes: new Map(), edges: new Map(), clusters: new Map(), persistenceGeneration: 0 };
  for (let i = 0; i < 160; i++) {
    const id = `node-${i}`;
    memory.nodes.set(id, { id, concept: `Garcia recognizable guitar phrasing memory ${i}`, cluster: i });
    memory.clusters.set(i, new Set([id]));
  }
  const salience = new ConversationSalience({ brainDir: '/unused-fixture', logger });
  salience.getRecentEntries = () => [{ ts: new Date().toISOString(), chatId: 'home',
    eventId: 'owner-contact', source: 'seed_contact', voice: 'jtr', summary: 'Garcia guitar phrasing' }];
  const tokenize = salience._tokenize.bind(salience);
  let visited = 0;
  salience._tokenize = text => {
    if (String(text).includes('memory')) {
      visited++;
      const end = performance.now() + 0.1;
      while (performance.now() < end) { /* substantial concept matching */ }
    }
    return tokenize(text);
  };
  const discovery = new DiscoveryEngine({ memory, logger, getConversationSalience: () => salience });
  discovery._buildAuthorityContextForProbe = async () => ({ eligibleIds: new Set(memory.nodes.keys()), resolver: {} });
  for (const name of ['_probeAnomaly', '_probeNovelty', '_probeOrphan', '_probeDrift', '_probeStagnation', '_probeExploration']) discovery[name] = () => [];
  return { memory, salience, discovery, visited: () => visited };
}

test('conversation matching yields while retaining synchronous ranking and cluster scores', async () => {
  const { memory, salience, visited } = fixture();
  const now = new Date('2026-10-08T08:00:00Z');
  salience.getRecentEntries = () => [{ ts: now.toISOString(), summary: 'Garcia guitar phrasing' }];
  const expectedIds = salience.relevantNodeIds(memory, 'guitar phrasing', 12);
  const expectedScores = salience.scoreClusters(memory, now);
  salience.nodeMatchCache.clear();
  const before = visited();
  const interrupted = new Promise(resolve => setImmediate(() => resolve(visited() - before)));
  const pending = salience.relevantNodeIdsAsync(memory, 'guitar phrasing', 12);
  assert.ok(await interrupted < memory.nodes.size, 'conversation matching blocked the whole graph scan');
  assert.deepEqual(await pending, expectedIds);
  assert.deepEqual(await salience.scoreClustersAsync(memory, now), expectedScores);
});

for (const stage of ['_probeSalienceAsync', '_probeConversationAsync']) {
  for (const action of ['stop', 'replace graph']) {
    test(`${action} during ${stage} prevents stale conversation candidates`, async () => {
      const { memory, discovery } = fixture();
      const syncStage = stage.replace('Async', '');
      for (const other of ['_probeSalience', '_probeConversation']) {
        if (other !== syncStage) { discovery[other] = () => []; discovery[other + 'Async'] = async () => []; }
      }
      let injected = false;
      const originalYield = discovery._yieldProbe.bind(discovery);
      const originalStage = discovery[stage]?.bind(discovery);
      if (originalStage) discovery[stage] = async revision => {
        discovery._yieldProbe = async token => {
          if (!injected) {
            injected = true;
            if (action === 'stop') discovery.stop();
            else { memory.nodes = new Map(); memory.clusters = new Map(); memory.persistenceGeneration++; }
          }
          return originalYield(token);
        };
        return originalStage(revision);
      };
      await discovery._runProbe();
      assert.equal(injected, true, 'the live probe did not use cooperative conversation matching');
      assert.equal(discovery.queue.size, 0);
      assert.equal(discovery.stats.probeCount, 0);
      assert.equal(discovery.stats.errors, 0);
      assert.equal(discovery.stats.supersededProbes, 1);
    });
  }
}
