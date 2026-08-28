const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const { allowed, coordinationOrigin, createConnectedAgentsProxy } = require('../../../engine/src/dashboard/connected-agents-proxy.js');

async function serverFor(fetchImpl) {
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use('/home23/api/product', createConnectedAgentsProxy({ fetchImpl, timeoutMs: 100 }));
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('product proxy allowlist contains product nouns and exact methods only', () => {
  assert.equal(allowed('GET', '/inbox'), true);
  assert.equal(allowed('POST', '/bots/bot_123/restart'), true);
  assert.equal(allowed('POST', '/bots/bot_123/archive'), true);
  assert.equal(allowed('POST', '/bots/bot_123/restore'), true);
  assert.equal(allowed('GET', '/communications/events'), true);
  assert.equal(allowed('GET', '/work/wrk_123'), true);
  assert.equal(allowed('POST', '/work/wrk_123/cancel'), true);
  assert.equal(allowed('POST', '/work/wrk_123/retry'), true);
  assert.equal(allowed('DELETE', '/work/wrk_123'), false);
  assert.equal(allowed('GET', '/rounds'), false);
  assert.equal(allowed('GET', '/workers'), false);
  assert.equal(allowed('DELETE', '/bots/bot_123'), false);
  assert.throws(() => coordinationOrigin('http://0.0.0.0:7346'), /origin_invalid/);
  assert.throws(() => coordinationOrigin('https://127.0.0.1:7346'), /origin_invalid/);
});

test('proxy forwards auth, idempotency, query, and JSON only to canonical v1 path', async (t) => {
  let observed;
  const fixture = await serverFor(async (url, init) => {
    observed = { url, init };
    return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'content-type':'application/json', 'x-request-id':'req_fixture' } });
  });
  t.after(() => fixture.server.close());
  const response = await fetch(`${fixture.origin}/home23/api/product/channels/chn_1/messages?limit=2`, { method:'POST', headers:{ authorization:'Bearer token', 'idempotency-key':'fixture-key-00001', 'content-type':'application/json' }, body:JSON.stringify({ text:'hello' }) });
  assert.equal(response.status, 202);
  assert.equal(observed.url, 'http://127.0.0.1:7346/api/v1/channels/chn_1/messages?limit=2');
  assert.equal(observed.init.headers.authorization, 'Bearer token');
  assert.equal(observed.init.headers['idempotency-key'], 'fixture-key-00001');
  assert.deepEqual(JSON.parse(observed.init.body), { text:'hello' });
});

test('proxy fails closed before upstream on missing auth and unlisted paths', async (t) => {
  let calls = 0;
  const fixture = await serverFor(async () => { calls++; return new Response('{}'); });
  t.after(() => fixture.server.close());
  assert.equal((await fetch(`${fixture.origin}/home23/api/product/inbox`)).status, 401);
  assert.equal((await fetch(`${fixture.origin}/home23/api/product/leases`, { headers:{authorization:'Bearer token'} })).status, 404);
  assert.equal(calls, 0);
});

test('proxy reports upstream failure without simulating success', async (t) => {
  const fixture = await serverFor(async () => { throw new Error('offline'); });
  t.after(() => fixture.server.close());
  const response = await fetch(`${fixture.origin}/home23/api/product/inbox`, { headers:{authorization:'Bearer token'} });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'coordination_unavailable');
});

test('proxy preserves the communication cursor query and fails visibly at its byte boundary', async (t) => {
  let observed;
  const fixture = await serverFor(async (url) => {
    observed = url;
    return new Response(JSON.stringify({ events: [{ payload: 'x'.repeat(300) }] }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  t.after(() => fixture.server.close());
  // This fixture uses the normal limit first to prove canonical routing.
  const response = await fetch(
    `${fixture.origin}/home23/api/product/communications/events?after=7&limit=25&conversationId=cnv_1`,
    { headers: { authorization: 'Bearer token' } },
  );
  assert.equal(response.status, 200);
  assert.equal(observed, 'http://127.0.0.1:7346/api/v1/communications/events?after=7&limit=25&conversationId=cnv_1');

  const small = express();
  small.use(express.json({ limit: '32kb' }));
  small.use('/home23/api/product', createConnectedAgentsProxy({
    maxResponseBytes: 64,
    fetchImpl: async () => new Response(JSON.stringify({ exact: 'x'.repeat(100) }), {
      headers: { 'content-type': 'application/json' },
    }),
  }));
  const server = http.createServer(small).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const rejected = await fetch(
    `http://127.0.0.1:${server.address().port}/home23/api/product/communications/events?after=0&limit=1`,
    { headers: { authorization: 'Bearer token' } },
  );
  assert.equal(rejected.status, 503);
  const body = await rejected.json();
  assert.equal(body.error.code, 'coordination_response_too_large');
  assert.equal(body.error.retryable, false);
});
