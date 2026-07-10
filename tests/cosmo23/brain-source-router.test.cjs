const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const { promises: fsp } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createBrainSourceRouter,
  rejectCallerIdentity
} = require('../../cosmo23/server/lib/brain-source-router');
const {
  rewriteMemoryBase
} = require('../../shared/memory-source');

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createManifestBrain() {
  const dir = await tempDir('home23-cosmo-brain-source-');
  await rewriteMemoryBase(dir, {
    nodes: [
      { id: 'n1', concept: 'one', weight: 1, activation: 1, cluster: 4 },
      { id: 'n2', concept: 'two', weight: 2, activation: 2, cluster: '4' },
      { id: 'n3', concept: 'three', weight: 3, activation: 3, embedding: new Array(768).fill(0.1) }
    ],
    edges: [
      { source: 'n1', target: 'n2', weight: 1, metadata: { discarded: true } },
      { source: 'n2', target: 'n3', weight: 2 }
    ],
    summary: { nodeCount: 3, edgeCount: 2, clusterCount: 2 }
  }, { lockRoot: await tempDir('home23-cosmo-brain-source-locks-') });
  return dir;
}

async function startApp(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test('COSMO graph route samples a memory source without queryEngine.loadBrainState', async () => {
  const brainDir = await createManifestBrain();
  let resolved = 0;
  let legacyRouteInvoked = false;
  const app = express();
  app.use(createBrainSourceRouter({
    home23Root: await tempDir('home23-cosmo-brain-source-home-'),
    requesterAgent: 'jerry',
    resolveBrainBySelector: async (selector) => {
      resolved += 1;
      assert.equal(selector, 'brain-jerry');
      return {
        id: 'brain-jerry',
        displayName: 'Jerry Brain',
        path: brainDir,
        sourceType: 'local',
        kind: 'run',
        catalogRevision: 'catalog-1'
      };
    }
  }));
  app.get('/api/brain/:name/graph', () => {
    legacyRouteInvoked = true;
    throw new Error('queryEngine.loadBrainState invoked');
  });
  const server = await startApp(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/brain/brain-jerry/graph?nodeLimit=2&edgeLimit=1`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.nodes.length <= 2, true);
    assert.equal(body.edges.length <= 1, true);
    assert.equal(body.meta.authoritativeNodeCount, 3);
    assert.equal(body.evidence.identity.requesterAgent, 'jerry');
    assert.equal(body.evidence.identity.brainId, 'brain-jerry');
    assert.match(body.evidence.identity.operationId, /^cosmo-source-/);
    assert.equal(legacyRouteInvoked, false);
    assert.equal(resolved, 1);
  } finally {
    await server.close();
  }
});

test('COSMO brain-source routes reject caller-supplied source identity', () => {
  for (const key of ['requesterAgent', 'canonicalRoot', 'operationId', 'scratchDir', 'operationRoot']) {
    assert.throws(
      () => rejectCallerIdentity({ [key]: 'forged' }),
      (error) => error.code === 'invalid_request' && error.status === 400 && error.field === key
    );
  }
});
