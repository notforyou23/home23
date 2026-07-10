import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const harnessUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'read-only-dashboard-qa-server.mjs'));
const dashboardRoot = path.join(repoRoot, 'engine', 'src', 'dashboard');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test('QA server forwards only GET and HEAD while rejecting every write method', async (t) => {
  const { createReadOnlyDashboardQaServer } = await import(harnessUrl.href);
  const upstreamMethods = [];
  const upstreamServer = http.createServer((req, res) => {
    upstreamMethods.push(req.method);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, method: req.method }));
  });
  const upstream = await listen(upstreamServer);
  t.after(() => close(upstreamServer));

  const qaServer = createReadOnlyDashboardQaServer({ dashboardRoot, upstream });
  const qa = await listen(qaServer);
  t.after(() => close(qaServer));

  const getResponse = await fetch(`${qa}/api/health`);
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.headers.get('x-qa-read-only'), 'true');
  assert.deepEqual(await getResponse.json(), { ok: true, method: 'GET' });

  const headResponse = await fetch(`${qa}/api/health`, { method: 'HEAD' });
  assert.equal(headResponse.status, 200);
  assert.equal(await headResponse.text(), '');

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await fetch(`${qa}/api/health`, { method });
    assert.equal(response.status, 405, `${method} must be rejected`);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assert.deepEqual(await response.json(), { ok: false, error: 'qa_server_is_read_only' });
  }

  assert.deepEqual(upstreamMethods, ['GET', 'HEAD']);
});

test('open-invariant fixture is synthetic, read-only, production-shaped, and provenance-labelled', async (t) => {
  const { createReadOnlyDashboardQaServer } = await import(harnessUrl.href);
  let upstreamCalls = 0;
  const upstreamServer = http.createServer((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(500);
    res.end();
  });
  const upstream = await listen(upstreamServer);
  t.after(() => close(upstreamServer));

  const qaServer = createReadOnlyDashboardQaServer({
    dashboardRoot,
    upstream,
    fixtureMode: 'open-invariant',
  });
  const qa = await listen(qaServer);
  t.after(() => close(qaServer));

  for (const route of ['/api/live-problems', '/home23/api/live-problems']) {
    const response = await fetch(`${qa}${route}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-qa-fixture'), 'synthetic-open-invariant');
    const payload = await response.json();
    assert.equal(payload.qaFixture.synthetic, true);
    assert.equal(payload.qaFixture.mode, 'open-invariant');
    assert.equal(payload.qaFixture.source, 'scripts/read-only-dashboard-qa-server.mjs');
    assert.equal(payload.qaFixture.writesAllowed, false);
    assert.equal(payload.problems.length, 1);
    assert.equal(payload.problems[0].state, 'open');
    assert.equal(payload.snapshot.counts.open, 1);
    assert.equal(payload.snapshot.counts.interventionRequired, 1);
  }

  const blockedWrite = await fetch(`${qa}/api/live-problems`, { method: 'POST' });
  assert.equal(blockedWrite.status, 405);
  assert.equal(upstreamCalls, 0);
});
