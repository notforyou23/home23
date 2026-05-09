import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';

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
  server.setOrchestrator({
    liveProblems: {
      async processAllNow() {
        called = true;
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
