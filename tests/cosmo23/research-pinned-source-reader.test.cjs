'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readPinnedIntelligence,
} = require('../../cosmo23/server/lib/research-pinned-source-reader');

function hasCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

function makePin({ nodes = [], edges = [], evidence = {}, onNode } = {}) {
  const declared = {
    async summarize() {
      return { nodes: nodes.length, edges: edges.length, clusters: 2 };
    },
    async searchKeyword() {
      return { results: [] };
    },
    async *iterateNodes({ signal } = {}) {
      for (let index = 0; index < nodes.length; index += 1) {
        signal?.throwIfAborted?.();
        await onNode?.(index, signal);
        yield nodes[index];
      }
    },
    async *iterateEdges({ signal } = {}) {
      for (const edge of edges) {
        signal?.throwIfAborted?.();
        yield edge;
      }
    },
    getEvidence(extra = {}) {
      return {
        implementation: 'manifest-v1',
        sourceHealth: 'healthy',
        ...evidence,
        ...extra,
      };
    },
  };
  return new Proxy(declared, {
    get(target, property, receiver) {
      if (!Reflect.has(target, property)) {
        throw new Error(`undeclared PinnedMemorySource access: ${String(property)}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

const intelligenceNodes = [
  {
    id: 'goal-node',
    concept: 'The exact goal evidence.',
    tag: 'goal',
    metadata: { kind: 'intelligence', section: 'goal', sectionId: 'goal-7' },
    embedding: [1, 2, 3],
    privatePath: '/must/not/cross',
  },
  {
    id: 'goal-lookalike',
    content: 'This belongs to a different goal.',
    metadata: { kind: 'intelligence', section: 'goal', sectionId: 'goal-70' },
  },
  {
    id: 'insight-node',
    text: 'A bounded insight.',
    tag: 'agent_insight',
    metadata: { kind: 'intelligence', section: 'insight', sectionId: 'insight-1' },
  },
  {
    id: 'thought-node',
    concept: 'A bounded thought.',
    metadata: { section: 'thought', sectionId: 'thought-1' },
  },
];

const intelligenceEdges = [
  { source: 'goal-node', target: 'goal-lookalike', type: 'related', weight: 0.8, embedding: [4] },
  { source: 'goal-node', target: 'insight-node', type: 'supports', weight: 0.9 },
  { source: 'insight-node', target: 'thought-node', type: 'derived', weight: 0.5 },
];

test('resident, legacy, and completed-research pins cross the same canonical bounded surface', async () => {
  for (const implementation of [
    'manifest-v1',
    'legacy-resident-sidecar-projection',
    'legacy-research-snapshot-projection',
  ]) {
    const sourcePin = makePin({
      nodes: intelligenceNodes,
      edges: intelligenceEdges,
      evidence: { implementation },
    });
    const result = await readPinnedIntelligence(sourcePin, { kind: 'brain' }, {
      signal: new AbortController().signal,
      maxNodes: 20,
      maxEdges: 20,
      maxBytes: 64 * 1024,
    });

    assert.equal(result.content.nodes.length, intelligenceNodes.length);
    assert.equal(result.content.edges.length, intelligenceEdges.length);
    assert.deepEqual(Object.keys(result.content.nodes[0]).sort(), ['content', 'id', 'metadata']);
    assert.deepEqual(Object.keys(result.content.edges[0]).sort(), ['source', 'target', 'type', 'weight']);
    assert.equal(Object.hasOwn(result.content.nodes[0], 'embedding'), false);
    assert.equal(Object.hasOwn(result.content.nodes[0], 'privatePath'), false);
    assert.equal(result.summary.nodes, intelligenceNodes.length);
    assert.equal(result.summary.returnedNodes, intelligenceNodes.length);
    assert.equal(result.evidence.implementation, implementation);
    assert.deepEqual(result.selection, { kind: 'brain' });
  }
});

test('intelligence include selection is exact and returns only connected selected edges', async () => {
  const sourcePin = makePin({ nodes: intelligenceNodes, edges: intelligenceEdges });
  const result = await readPinnedIntelligence(sourcePin, {
    kind: 'intelligence',
    include: ['goals', 'insights'],
  }, {
    signal: new AbortController().signal,
    maxNodes: 20,
    maxEdges: 20,
    maxBytes: 64 * 1024,
  });

  assert.deepEqual(result.content.nodes.map((node) => node.id), [
    'goal-node', 'goal-lookalike', 'insight-node',
  ]);
  assert.deepEqual(result.content.edges.map((edge) => `${edge.source}->${edge.target}`), [
    'goal-node->goal-lookalike', 'goal-node->insight-node',
  ]);
  assert.deepEqual(result.evidence.filters, {
    kind: 'intelligence',
    include: ['goals', 'insights'],
  });
});

test('section selection matches the exact section and sectionId', async () => {
  const sourcePin = makePin({ nodes: intelligenceNodes, edges: intelligenceEdges });
  const result = await readPinnedIntelligence(sourcePin, {
    kind: 'section', section: 'goal', sectionId: 'goal-7',
  }, {
    signal: new AbortController().signal,
    maxNodes: 20,
    maxEdges: 20,
    maxBytes: 64 * 1024,
  });

  assert.deepEqual(result.content.nodes.map((node) => node.id), ['goal-node']);
  assert.deepEqual(result.content.edges, []);
  assert.equal(result.content.nodes[0].metadata.sectionId, 'goal-7');
  assert.deepEqual(result.selection, {
    kind: 'section', section: 'goal', sectionId: 'goal-7',
  });
});

test('a missing exact section returns null rather than substituting a fuzzy match', async () => {
  const sourcePin = makePin({ nodes: intelligenceNodes, edges: intelligenceEdges });
  const result = await readPinnedIntelligence(sourcePin, {
    kind: 'section', section: 'goal', sectionId: 'goal-8',
  }, {
    signal: new AbortController().signal,
    maxNodes: 20,
    maxEdges: 20,
    maxBytes: 64 * 1024,
  });
  assert.equal(result, null);
});

test('cancellation during a pinned iterator rejects with the exact abort reason', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel pinned intelligence'), { code: 'cancelled' });
  const sourcePin = makePin({
    nodes: intelligenceNodes,
    onNode(index) {
      if (index === 1) controller.abort(reason);
    },
  });

  await assert.rejects(readPinnedIntelligence(sourcePin, { kind: 'brain' }, {
    signal: controller.signal,
    maxNodes: 20,
    maxEdges: 20,
    maxBytes: 64 * 1024,
  }), (error) => error === reason);
});

test('node, edge, and canonical content byte ceilings fail closed', async () => {
  await assert.rejects(readPinnedIntelligence(
    makePin({ nodes: intelligenceNodes }),
    { kind: 'brain' },
    { signal: new AbortController().signal, maxNodes: 2, maxEdges: 20, maxBytes: 64 * 1024 },
  ), hasCode('result_too_large'));

  await assert.rejects(readPinnedIntelligence(
    makePin({ nodes: intelligenceNodes, edges: intelligenceEdges }),
    { kind: 'brain' },
    { signal: new AbortController().signal, maxNodes: 20, maxEdges: 1, maxBytes: 64 * 1024 },
  ), hasCode('result_too_large'));

  await assert.rejects(readPinnedIntelligence(
    makePin({ nodes: [{ id: 'huge', content: 'x'.repeat(4096) }] }),
    { kind: 'brain' },
    { signal: new AbortController().signal, maxNodes: 20, maxEdges: 20, maxBytes: 1024 },
  ), hasCode('result_too_large'));
});

test('invalid or ambiguous selectors are rejected before the source is read', async () => {
  const sourcePin = makePin({ nodes: intelligenceNodes });
  await assert.rejects(
    readPinnedIntelligence(sourcePin, { kind: 'section', section: 'goal' }, {}),
    hasCode('invalid_request'),
  );
  await assert.rejects(
    readPinnedIntelligence(sourcePin, { kind: 'brain', section: 'goal', sectionId: 'goal-7' }, {}),
    hasCode('invalid_request'),
  );
  await assert.rejects(
    readPinnedIntelligence(sourcePin, { kind: 'intelligence', include: ['goals', 'goals'] }, {}),
    hasCode('invalid_request'),
  );
});
