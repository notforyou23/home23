const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');

const {
  registerLegacyMemoryGraphRoute,
} = require('../../../engine/src/dashboard/brain-source-api.js');

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('legacy /api/memory is a bounded canonical-source projection', async () => {
  const calls = [];
  const app = express();
  registerLegacyMemoryGraphRoute(app, {
    async graph(options) {
      calls.push(options);
      return {
        success: true,
        nodes: [{ id: 'n1', concept: 'bounded' }],
        edges: [],
        clusters: { c1: 140086 },
        meta: {
          authoritativeNodeCount: 140086,
          authoritativeEdgeCount: 456709,
          returnedNodeCount: 1,
          returnedEdgeCount: 0,
          limited: true,
        },
        evidence: { sourceHealth: 'healthy', matchOutcome: 'matches' },
      };
    },
  });
  const server = await listen(app);
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/memory?nodeLimit=25&edgeLimit=50`,
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].nodeLimit, '25');
    assert.equal(calls[0].edgeLimit, '50');
    assert.ok(calls[0].signal instanceof AbortSignal);
    assert.equal(body.bounded, true);
    assert.equal(body.totalNodes, 140086);
    assert.equal(body.totalEdges, 456709);
    assert.deepEqual(body.nodes, [{ id: 'n1', concept: 'bounded' }]);
    assert.deepEqual(body.edges, []);
    assert.equal(body._liveJournalCount, 0);
    assert.equal(body.evidence.sourceHealth, 'healthy');
  } finally {
    await close(server);
  }
});

test('legacy /api/memory fails closed when canonical source is unavailable', async () => {
  const app = express();
  registerLegacyMemoryGraphRoute(app, {
    async graph() {
      throw Object.assign(new Error('source offline'), {
        code: 'source_unavailable',
        retryable: true,
      });
    },
  });
  const server = await listen(app);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/memory`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'source_unavailable');
    assert.equal(body.error.retryable, true);
    assert.equal(Object.hasOwn(body, 'nodes'), false);
  } finally {
    await close(server);
  }
});
