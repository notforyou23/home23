import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const express = require('express');
const http = require('node:http');
const { createMcpProxyRouter } = require('../../../engine/src/dashboard/mcp-proxy-router.js');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
}

async function proxyFor(upstream, options = {}) {
  const app = express();
  app.use(createMcpProxyRouter({
    port: upstream.address().port,
    isEnabled: () => true,
    probeAvailability: async () => ({ available: true }),
    buildUnavailableEnvelope: () => ({ ok: false }),
    logger: { error() {} },
    ...options,
  }));
  return listen(http.createServer(app));
}

test('MCP proxy connects over IPv4 and streams SSE without whole-response buffering', async (t) => {
  let upstreamBody = '';
  const upstream = await listen(http.createServer((req, res) => {
    assert.equal(req.socket.localAddress, '127.0.0.1');
    req.on('data', (chunk) => { upstreamBody += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      setImmediate(() => res.end('data: second\n\n'));
    });
  }));
  const proxy = await proxyFor(upstream);
  t.after(async () => { await close(proxy); await close(upstream); });
  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'data: first\n\ndata: second\n\n');
  assert.match(upstreamBody, /tools\/list/);
});

test('MCP proxy bounds request and upstream response bytes', async (t) => {
  const upstream = await listen(http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ value: 'x'.repeat(4096) }));
  }));
  const proxy = await proxyFor(upstream, {
    requestBodyLimit: '1kb',
    maxResponseBytes: 512,
  });
  t.after(async () => { await close(proxy); await close(upstream); });

  const tooLarge = await fetch(`http://127.0.0.1:${proxy.address().port}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'x'.repeat(2048) }),
  });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error.code, 'request_too_large');

  const boundedResponse = await fetch(`http://127.0.0.1:${proxy.address().port}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(boundedResponse.status, 502);
  assert.equal((await boundedResponse.json()).error.code, 'mcp_response_too_large');
});

test('MCP proxy destroys the upstream request when its client disconnects', async (t) => {
  let upstreamStarted;
  let upstreamClosed;
  const started = new Promise((resolve) => { upstreamStarted = resolve; });
  const closed = new Promise((resolve) => { upstreamClosed = resolve; });
  const upstream = await listen(http.createServer((req, res) => {
    req.resume();
    req.on('end', () => upstreamStarted());
    res.on('close', () => upstreamClosed());
  }));
  const proxy = await proxyFor(upstream);
  t.after(async () => { await close(proxy); await close(upstream); });

  const client = http.request({
    hostname: '127.0.0.1',
    port: proxy.address().port,
    path: '/api/mcp',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  client.on('error', () => {});
  client.end('{}');
  await started;
  client.destroy();
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('upstream not cancelled')), 1000)),
  ]);
});
