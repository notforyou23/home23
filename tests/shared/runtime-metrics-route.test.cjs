'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  createRuntimeMetricsHandler,
  registerRuntimeMetricsRoute,
} = require('../../shared/runtime-metrics-route.cjs');

function response() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('loopback runtime metric distinguishes request samples from process RSS high-water evidence', () => {
  const handler = createRuntimeMetricsHandler({
    role: 'dashboard',
    pid: () => 4242,
    memoryUsage: () => ({ heapUsed: 123_456_789, rss: 234_567_890 }),
    resourceUsage: () => ({ maxRSS: 345_679 }),
    now: () => Date.parse('2026-07-11T12:00:00.000Z'),
  });
  const res = response();
  handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.body, {
    schemaVersion: 2,
    role: 'dashboard',
    pid: 4242,
    v8HeapUsedBytes: 123_456_789,
    rssBytes: 234_567_890,
    processMaxRssBytes: 345_679 * 1024,
    semantics: {
      v8HeapUsedBytes: 'request-time-sample',
      rssBytes: 'request-time-sample',
      processMaxRssBytes: 'process-lifetime-high-water',
    },
    sampledAt: '2026-07-11T12:00:00.000Z',
  });
});

test('runtime metric fails closed when RSS high-water evidence is inconsistent', () => {
  const handler = createRuntimeMetricsHandler({
    role: 'dashboard',
    pid: () => 4242,
    memoryUsage: () => ({ heapUsed: 10, rss: 10 * 1024 * 1024 }),
    resourceUsage: () => ({ maxRSS: 1 }),
  });
  const res = response();
  handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error.code, 'runtime_metrics_unavailable');
});

test('runtime metric route rejects non-loopback and non-GET requests', () => {
  const handler = createRuntimeMetricsHandler({ role: 'cosmo' });
  const remote = response();
  handler({ method: 'GET', socket: { remoteAddress: '10.0.0.9' } }, remote);
  assert.equal(remote.statusCode, 403);
  assert.equal(remote.body.error.code, 'access_denied');
  const post = response();
  handler({ method: 'POST', socket: { remoteAddress: '127.0.0.1' } }, post);
  assert.equal(post.statusCode, 405);
  assert.equal(post.body.error.code, 'method_not_allowed');
});

test('runtime metric registration binds exactly one explicit internal route', () => {
  const registrations = [];
  const handler = registerRuntimeMetricsRoute({
    get(route, callback) { registrations.push({ route, callback }); },
  }, {
    route: '/api/internal/runtime-metrics',
    role: 'cosmo',
  });
  assert.equal(typeof handler, 'function');
  assert.deepEqual(registrations, [{
    route: '/api/internal/runtime-metrics',
    callback: handler,
  }]);
});

test('executing dashboard and COSMO servers register their distinct loopback metric routes', () => {
  const root = path.resolve(__dirname, '..', '..');
  const dashboard = readFileSync(path.join(root, 'engine/src/dashboard/server.js'), 'utf8');
  const cosmo = readFileSync(path.join(root, 'cosmo23/server/index.js'), 'utf8');
  assert.match(dashboard, /registerRuntimeMetricsRoute\(this\.app, \{\s*route: '\/home23\/api\/internal\/runtime-metrics',\s*role: 'dashboard',\s*\}\);/);
  assert.match(cosmo, /registerRuntimeMetricsRoute\(app, \{\s*route: '\/api\/internal\/runtime-metrics',\s*role: 'cosmo',\s*\}\);/);
});
