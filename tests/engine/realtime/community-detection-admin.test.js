import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

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
  const home23Root = fs.mkdtempSync(path.join(os.tmpdir(), 'communities-admin-test-'));
  const logsDir = path.join(home23Root, 'brain');
  fs.mkdirSync(logsDir);
  fs.writeFileSync(path.join(logsDir, 'brain-snapshot.json'), JSON.stringify({ fixture: true }));
  fs.writeFileSync(path.join(logsDir, 'state.json.gz'), gzipSync(JSON.stringify({ fixture: true })));
  fs.writeFileSync(path.join(logsDir, 'memory-nodes.jsonl.gz'), gzipSync(''));
  fs.writeFileSync(path.join(logsDir, 'memory-edges.jsonl.gz'), gzipSync(''));
  server.setOrchestrator({
    memory,
    logsDir,
    home23Root,
    async saveState() {
      if (onSave) return onSave() ?? { saved: true };
      return { saved: true };
    },
  });
  return { server, logsDir };
}

test('the communities route is reachable (allowlist regression pin) and dry-run never mutates', async (t) => {
  const memory = await seededMemory();
  let saved = 0;
  const { server, logsDir } = makeServer(memory, { onSave: () => { saved += 1; } });
  t.after(() => fs.rmSync(path.dirname(logsDir), { recursive: true, force: true }));

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

test('apply moves nodes, takes a backup, saves state; re-apply short-circuits unchanged', async (t) => {
  const memory = await seededMemory();
  let saved = 0;
  const { server, logsDir } = makeServer(memory, { onSave: () => { saved += 1; } });
  t.after(() => fs.rmSync(path.dirname(logsDir), { recursive: true, force: true }));

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
  assert.ok(String(applied.backup.path).startsWith(fs.realpathSync(logsDir)), 'backup lands under the resolved brain dir');
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

test('POST without a valid mode is rejected; wrong methods are rejected', async (t) => {
  const memory = await seededMemory();
  const { server, logsDir } = makeServer(memory);
  t.after(() => fs.rmSync(path.dirname(logsDir), { recursive: true, force: true }));

  const badMode = makeResponse();
  await server._handleMemoryCleanupAdmin(
    makeRequest({ url: '/admin/memory/cleanup/communities', method: 'POST', body: { mode: 'yolo' } }),
    badMode,
  );
  assert.equal(badMode.statusCode, 400);
  assert.match(badMode.json().error, /mode must be dry-run or apply/);
});

const applyRequest = () => makeRequest({
  url: '/admin/memory/cleanup/communities?minCommunitySize=2', body: { mode: 'apply' },
});

test('an unconfirmed or failed state save preserves a failed recovery snapshot', async (t) => {
  for (const failure of ['unconfirmed', 'thrown']) {
    const memory = await seededMemory();
    const { server, logsDir } = makeServer(memory, { onSave: () => {
      if (failure === 'thrown') throw new Error('fixture save exception');
      return { saved: false, reason: 'fixture refused' };
    } });
    t.after(() => fs.rmSync(path.dirname(logsDir), { recursive: true, force: true }));
    await assert.rejects(server._handleMemoryCleanupAdmin(applyRequest(), makeResponse()), /fixture/);
    const backups = path.join(logsDir, 'backups');
    const names = fs.readdirSync(backups).filter((name) => name.endsWith('-brain-communities'));
    assert.equal(names.length, 1);
    const receipt = JSON.parse(fs.readFileSync(path.join(backups, names[0], 'community-backup-manifest.json'), 'utf8'));
    assert.equal(receipt.status, 'complete');
    assert.equal(receipt.operation.status, 'failed');
    assert.equal(fs.existsSync(path.join(backups, '.community-retention-receipts')), false);
  }
});

test('apply waits for a prior save to clear before starting its fresh save', async (t) => {
  const memory = await seededMemory();
  let freshSaves = 0;
  const { server, logsDir } = makeServer(memory, { onSave: () => {
    assert.equal(server.orchestrator._saveStatePromise, null);
    freshSaves += 1;
  } });
  t.after(() => fs.rmSync(path.dirname(logsDir), { recursive: true, force: true }));
  server.orchestrator._saveStatePromise = Promise.resolve({ saved: true });
  setImmediate(() => { server.orchestrator._saveStatePromise = null; });
  const response = makeResponse();
  await server._handleMemoryCleanupAdmin(applyRequest(), response);
  assert.equal(response.statusCode, 200);
  assert.equal(freshSaves, 1);
});

test('a changed memory revision aborts a stale plan before community mutation', async (t) => {
  const memory = await seededMemory();
  let freshSaves = 0, releasePrior, entered;
  const reachedPrior = new Promise((resolve) => { entered = resolve; });
  let prior = new Promise((resolve) => { releasePrior = resolve; });
  const { server, logsDir } = makeServer(memory, { onSave: () => { freshSaves += 1; } });
  t.after(() => fs.rmSync(path.dirname(logsDir), { recursive: true, force: true }));
  Object.defineProperty(server.orchestrator, '_saveStatePromise', { get() { entered(); return prior; } });
  const applying = server._handleMemoryCleanupAdmin(applyRequest(), makeResponse());
  await reachedPrior;
  memory.recordNodeAccess([memory.nodes.keys().next().value]);
  prior = null;
  releasePrior({ saved: true });
  await assert.rejects(applying, /community_plan_changed_during_backup/);
  assert.equal(freshSaves, 0);
  assert.deepEqual([...new Set([...memory.nodes.values()].map((n) => String(n.cluster)))], ['1']);
});

test('configured resident retention can preserve all recovery snapshots', async (t) => {
  const memory = await seededMemory();
  const { server, logsDir } = makeServer(memory);
  t.after(() => fs.rmSync(path.dirname(logsDir), { recursive: true, force: true }));
  server.orchestrator.config = { persistence: { communityBackupRetention: { retainAll: true } } };
  const response = makeResponse();
  await server._handleMemoryCleanupAdmin(applyRequest(), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().backup.retention.retained[0].reason, 'retain-all policy');
});
