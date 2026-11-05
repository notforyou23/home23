import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { RealtimeServer } = require('../../../engine/src/realtime/websocket-server.js');
const { NetworkMemory } = require('../../../engine/src/memory/network-memory.js');

// The /admin/memory/cleanup/communities endpoint shipped as dead code once:
// the knownRoutes allowlist gate 404'd every request and no test noticed.
// This file exists so that can never happen again.

function makeRequest({ url, method = 'POST', body = {} }) {
  const req = method === 'GET'
    ? Readable.from([])
    : Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
  req.method = method;
  req.url = url;
  return req;
}

function makeResponse() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(payload) {
      this.body = payload || '';
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

function memoryConfig() {
  return {
    embedding: {},
    coordinator: {},
    smallWorld: { maxBridgesPerNode: 40 },
    spreading: { maxDepth: 2, activationThreshold: 0.01, decayFactor: 0.8, bridgeTraversalFactor: 0.2 },
    hebbian: { enabled: false, reinforcementStrength: 0.1 },
    decay: { baseFactor: 0.95, minimumWeight: 0.01, decayInterval: 300, exemptTags: [] },
  };
}

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

// Two 5-cliques joined by one bridge, all in cluster 1 — the real starting
// state in miniature. Community detection must split them.
async function seededMemory() {
  const memory = new NetworkMemory(memoryConfig(), silentLogger);
  memory.embed = async () => null;
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const node = await memory.addNode(`endpoint test node ${i}`, 'general');
    ids.push(node.id);
  }
  memory.withPersistenceBarrier(() => {
    for (let a = 0; a < 5; a++) {
      for (let b = a + 1; b < 5; b++) {
        memory._upsertEdgeUnsafe(ids[a], ids[b], 1, 'associative', { enforceBridgeCap: false });
        memory._upsertEdgeUnsafe(ids[5 + a], ids[5 + b], 1, 'associative', { enforceBridgeCap: false });
      }
    }
    memory._upsertEdgeUnsafe(ids[0], ids[5], 1, 'bridge', { enforceBridgeCap: false });
    for (const id of ids) memory._moveNodeToClusterUnsafe(id, 1);
  });
  return memory;
}

function makeServer(memory, { onSave } = {}) {
  const server = new RealtimeServer(0, silentLogger);
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'communities-admin-test-'));
  server.setOrchestrator({
    memory,
    logsDir,
    async saveState() {
      if (onSave) onSave();
    },
  });
  return { server, logsDir };
}

test('the communities route is reachable (allowlist regression pin) and dry-run never mutates', async () => {
  const memory = await seededMemory();
  let saved = 0;
  const { server } = makeServer(memory, { onSave: () => { saved += 1; } });

  const res = makeResponse();
  await server._handleMemoryCleanupAdmin(
    makeRequest({ url: '/admin/memory/cleanup/communities?minCommunitySize=2', method: 'GET' }),
    res,
  );
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, 'dry-run');
  assert.equal(payload.communityCount, 2);
  assert.ok(payload.movedNodes > 0);
  assert.ok(Array.isArray(payload.sizes) && Array.isArray(payload.sample));
  // dry-run mutated nothing and saved nothing
  const clusters = new Set(Array.from(memory.nodes.values()).map((n) => String(n.cluster)));
  assert.deepEqual([...clusters], ['1'], 'dry-run must not move nodes');
  assert.equal(saved, 0, 'dry-run must not save');

  // unknown routes still 404 (the gate itself keeps working)
  const bogus = makeResponse();
  await server._handleMemoryCleanupAdmin(
    makeRequest({ url: '/admin/memory/cleanup/nonsense', method: 'GET' }),
    bogus,
  );
  assert.equal(bogus.statusCode, 404);
});

test('apply moves nodes, takes a backup, saves state; re-apply short-circuits unchanged', async () => {
  const memory = await seededMemory();
  let saved = 0;
  const { server, logsDir } = makeServer(memory, { onSave: () => { saved += 1; } });

  const applyRes = makeResponse();
  await server._handleMemoryCleanupAdmin(
    makeRequest({
      url: '/admin/memory/cleanup/communities?minCommunitySize=2',
      method: 'POST',
      body: { mode: 'apply' },
    }),
    applyRes,
  );
  assert.equal(applyRes.statusCode, 200, applyRes.body);
  const applied = applyRes.json();
  assert.equal(applied.ok, true);
  assert.equal(applied.mode, 'apply');
  assert.ok(applied.movedNodes > 0);
  assert.equal(applied.communityCount, 2);
  assert.ok(applied.backup && applied.backup.ok, 'apply must take a sidecar backup');
  assert.ok(String(applied.backup.path).startsWith(logsDir), 'backup lands under the brain dir');
  assert.equal(saved, 1, 'apply must save state');
  const clusters = new Set(Array.from(memory.nodes.values()).map((n) => String(n.cluster)));
  assert.equal(clusters.size, 2, 'the graph is actually repartitioned');

  // Event rule at the endpoint: nothing to move — no backup, no save.
  const again = makeResponse();
  await server._handleMemoryCleanupAdmin(
    makeRequest({
      url: '/admin/memory/cleanup/communities?minCommunitySize=2',
      method: 'POST',
      body: { mode: 'apply' },
    }),
    again,
  );
  assert.equal(again.statusCode, 200, again.body);
  const second = again.json();
  assert.equal(second.unchanged, true);
  assert.equal(second.movedNodes, 0);
  assert.equal(second.backup, undefined, 'unchanged apply must not take a backup');
  assert.equal(saved, 1, 'unchanged apply must not save again');
});

test('POST without a valid mode is rejected; wrong methods are rejected', async () => {
  const memory = await seededMemory();
  const { server } = makeServer(memory);

  const badMode = makeResponse();
  await server._handleMemoryCleanupAdmin(
    makeRequest({ url: '/admin/memory/cleanup/communities', method: 'POST', body: { mode: 'yolo' } }),
    badMode,
  );
  assert.equal(badMode.statusCode, 400);
  assert.match(badMode.json().error, /mode must be dry-run or apply/);
});
