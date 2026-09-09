import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NetworkMemory } = require('../../../engine/src/memory/network-memory.js');

function makeMemory() {
  const memory = new NetworkMemory({
    embedding: { model: 'test', dimensions: 2 },
    smallWorld: {},
    spreading: {},
    retrieval: {
      temporalHalfLifeDays: 14,
      keywordIndex: {
        maxTerms: 2000,
        maxEntries: 20000,
        maxPostingsPerTerm: 32,
        maxTokensPerNode: 24,
      },
    },
  }, {
    info() {}, warn() {}, debug() {}, error() {},
  });
  memory.tokenizer = null;
  memory.embed = async () => null;
  return memory;
}

test('loaded keyword retrieval scores a bounded candidate set and preserves ranking fields', async (t) => {
  const memory = makeMemory();
  const corpusSize = 20000;
  const nodes = [];
  for (let id = 1; id <= corpusSize; id += 1) {
    nodes.push([id, {
      id,
      concept: `bulk archive filler record item-${id}`,
      tag: 'archive',
      created: '2025-01-01T00:00:00.000Z',
      accessed: '2025-01-01T00:00:00.000Z',
    }]);
  }
  nodes.push(['old-match', {
    id: 'old-match',
    concept: 'memory runaway canary is recorded',
    tag: 'incident',
    asserted_at: '2025-01-01T00:00:00.000Z',
    created: '2025-01-01T00:00:00.000Z',
    metadata: { incidentId: 'memory-runaway', source: 'profiler' },
  }]);
  nodes.push(['new-match', {
    id: 'new-match',
    concept: 'memory runaway canary is healthy',
    tag: 'state_snapshot',
    type: 'state_snapshot',
    asserted_at: '2026-09-09T12:00:00.000Z',
    asserted_cycle: 7312,
    created: '2026-09-09T12:00:00.000Z',
    metadata: { kind: 'state_snapshot', incidentId: 'memory-runaway', source: 'live-probe' },
  }]);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-keyword-index-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filepath = path.join(directory, 'network.json');
  await fs.writeFile(filepath, JSON.stringify({
    nodes,
    edges: [],
    clusters: [],
    nextNodeId: corpusSize + 1,
    nextClusterId: 1,
    nodeIdFormat: 'numeric',
    nodeIdPrefix: null,
  }));
  await memory.load(filepath);

  let scoreCalls = 0;
  const originalScore = memory.keywordScoreNode.bind(memory);
  memory.keywordScoreNode = (...args) => {
    scoreCalls += 1;
    return originalScore(...args);
  };
  // A loaded large graph has a ready index. Keyword retrieval must not fall
  // back to enumerating every node for scoring or authority resolution.
  memory.nodes.values = () => { throw new Error('unexpected full node scan'); };

  const results = memory.queryByKeyword('memory runaway canary', 2, {
    intent: 'current_state',
    nowMs: Date.parse('2026-09-09T13:00:00.000Z'),
    markAccess: false,
  });

  assert.deepEqual(results.map((node) => node.id), ['new-match', 'old-match']);
  assert.ok(scoreCalls <= 32 * 3, `expected bounded scoring, got ${scoreCalls}`);
  assert.equal(results[0].asserted_cycle, 7312);
  assert.equal(results[0].retrievalAuthority.semanticTime, '2026-09-09T12:00:00.000Z');
  assert.equal(typeof results[0].retrievalScore, 'number');
});

test('keyword index follows add, patch, generic dirty, and remove mutations', async () => {
  const memory = makeMemory();
  const node = await memory.addNode('mutable alpha beacon', 'state_snapshot');
  assert.equal(memory.queryByKeyword('alpha', 1, { markAccess: false })[0]?.id, node.id);

  memory.patchNode(node.id, { concept: 'mutable omega beacon' });
  assert.equal(memory.queryByKeyword('alpha', 1, { markAccess: false }).length, 0);
  assert.equal(memory.queryByKeyword('omega', 1, { markAccess: false })[0]?.id, node.id);

  node.concept = 'mutable sigma beacon';
  memory.markNodeDirty(node.id);
  assert.equal(memory.queryByKeyword('omega', 1, { markAccess: false }).length, 0);
  assert.equal(memory.queryByKeyword('sigma', 1, { markAccess: false })[0]?.id, node.id);

  assert.equal(memory.removeNode(node.id), true);
  assert.equal(memory.queryByKeyword('sigma', 1, { markAccess: false }).length, 0);
});
