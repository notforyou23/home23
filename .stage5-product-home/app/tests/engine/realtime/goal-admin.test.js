import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { RealtimeServer } = require('../../../engine/src/realtime/websocket-server.js');

function makeRequest({ url, body = {} }) {
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
  req.method = 'POST';
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

test('goal admin archives a live active goal and saves state', async () => {
  const server = new RealtimeServer(0, { info: () => {}, warn: () => {}, error: () => {} });
  let archived = null;
  let saved = false;
  server.setOrchestrator({
    goals: {
      getGoal(id) {
        return id === 'goal_1' ? { id, status: 'active', description: 'stale force-output digest' } : null;
      },
      archiveGoal(id, reason) {
        archived = { id, reason };
        return true;
      },
    },
    async saveState() {
      saved = true;
    },
  });

  const res = makeResponse();
  await server._handleGoalAdmin(makeRequest({
    url: '/admin/goals/goal_1/archive',
    body: { reason: 'operator reviewed stale back-pressure' },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  assert.deepEqual(archived, { id: 'goal_1', reason: 'operator reviewed stale back-pressure' });
  assert.equal(saved, true);
});

test('goal admin refuses to archive missing or inactive goals', async () => {
  const server = new RealtimeServer(0, { info: () => {}, warn: () => {}, error: () => {} });
  server.setOrchestrator({
    goals: {
      getGoal() {
        return { id: 'goal_done', status: 'completed', description: 'done' };
      },
      archiveGoal() {
        throw new Error('should not archive');
      },
    },
  });

  const res = makeResponse();
  await server._handleGoalAdmin(makeRequest({
    url: '/admin/goals/goal_done/archive',
    body: {},
  }), res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.json().ok, false);
});

test('live-problems admin immediately processes all problems', async () => {
  const server = new RealtimeServer(0, { info: () => {}, warn: () => {}, error: () => {} });
  let called = false;
  let processArgs = null;
  server.setOrchestrator({
    liveProblems: {
      async processAllNow(args) {
        called = true;
        processArgs = args;
        return {
          processed: 2,
          changed: [{ id: 'health_log_fresh', state: 'resolved' }],
          snapshot: { counts: { open: 0, chronic: 0, resolved: 1, unverifiable: 0 } },
        };
      },
    },
  });

  const res = makeResponse();
  await server._handleLiveProblemsAdmin(makeRequest({
    url: '/admin/live-problems/tick',
    body: {},
  }), res);

  const payload = res.json();
  assert.equal(res.statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, 'immediate');
  assert.equal(payload.processed, 2);
  assert.deepEqual(payload.changed, [{ id: 'health_log_fresh', state: 'resolved' }]);
  assert.equal(called, true);
  assert.deepEqual(processArgs, { force: true });
});

test('live-problems admin processes one problem by id', async () => {
  const server = new RealtimeServer(0, { info: () => {}, warn: () => {}, error: () => {} });
  server.setOrchestrator({
    liveProblems: {
      async processNow(id) {
        return id === 'p1' ? { id, state: 'resolved', lastCheckedAt: '2026-05-09T18:40:00.000Z' } : null;
      },
      briefSnapshot() {
        return { counts: { open: 0, chronic: 0, resolved: 1, unverifiable: 0 } };
      },
    },
  });

  const res = makeResponse();
  await server._handleLiveProblemsAdmin(makeRequest({
    url: '/admin/live-problems/p1/process',
    body: {},
  }), res);

  const payload = res.json();
  assert.equal(res.statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.problem.id, 'p1');
  assert.deepEqual(payload.snapshot, { counts: { open: 0, chronic: 0, resolved: 1, unverifiable: 0 } });
});

test('memory cleanup compost-backlog apply removes exact sources with delta backup and save', async () => {
  const server = new RealtimeServer(0, { info: () => {}, warn: () => {}, error: () => {} });
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-compost-apply-'));
  for (const name of ['memory-nodes.jsonl.gz', 'memory-edges.jsonl.gz', 'brain-snapshot.json', 'state.json.gz', 'memory-delta.jsonl']) {
    fs.writeFileSync(path.join(brainDir, name), `${name}\n`);
  }

  const nodes = new Map([
    ['s1', { id: 's1', tag: 'consolidated', consolidatedAt: 't1' }],
    ['a', { id: 'a', tag: 'workspace', consolidatedAt: 't1' }],
    ['b', { id: 'b', tag: 'reasoning', consolidatedAt: 't1' }],
    ['m1', { id: 'm1', tag: 'consolidated', consolidatedAt: 't2' }],
    ['m2', { id: 'm2', tag: 'consolidated', consolidatedAt: 't2' }],
    ['c', { id: 'c', tag: 'workspace', consolidatedAt: 't2' }],
  ]);
  let saved = false;
  server.setOrchestrator({
    logsDir: brainDir,
    memory: {
      nodes,
      removeNode(id) {
        return nodes.delete(String(id));
      },
    },
    async saveState() {
      saved = true;
    },
  });

  const res = makeResponse();
  await server._handleMemoryCleanupAdmin(makeRequest({
    url: '/admin/memory/cleanup/compost-backlog',
    body: { mode: 'apply', expectedRemovableSourceNodes: 2 },
  }), res);

  const payload = res.json();
  assert.equal(res.statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.removed, 2);
  assert.deepEqual(payload.removedIds, ['a', 'b']);
  assert.equal(nodes.has('s1'), true);
  assert.equal(nodes.has('c'), true);
  assert.equal(saved, true);
  assert.equal(payload.backup.ok, true);
  assert.equal(payload.backup.files.includes('memory-delta.jsonl'), true);
});
