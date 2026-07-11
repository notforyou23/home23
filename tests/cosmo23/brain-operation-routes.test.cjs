'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { createBrainOperationRoutes } = require(
  '../../cosmo23/server/lib/brain-operation-routes'
);

const OPERATION_ID = `brop_${'a'.repeat(32)}`;

async function withServer(callback) {
  const calls = [];
  const worker = {
    async start(_id, _capability, body) { calls.push(['start', body]); return { ok: true }; },
    async status() { return { ok: true }; },
    async *events() {},
    async result() { return { ok: true }; },
    async cancel(_id, _capability) { calls.push(['cancel']); return { ok: true }; },
  };
  const app = express();
  app.set('trust proxy', false);
  app.use(createBrainOperationRoutes({ worker }));
  let broadCalls = 0;
  app.use((_req, _res, next) => { broadCalls += 1; next(new Error('broad parser reached')); });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await callback({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      calls,
      broadCalls: () => broadCalls,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(baseUrl, action, body) {
  return fetch(`${baseUrl}/api/internal/brain-operations/${OPERATION_ID}/${action}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer header.payload.signature',
      'content-type': 'application/json',
    },
    body,
  });
}

test('protected start and cancel bodies are bounded before any broad parser', async () => {
  await withServer(async ({ baseUrl, calls, broadCalls }) => {
    const start = await post(baseUrl, 'start', JSON.stringify({ value: 'x'.repeat(1024) }));
    assert.equal(start.status, 200);
    assert.equal(calls.length, 1);

    const startOver = await post(baseUrl, 'start', JSON.stringify({
      value: 'x'.repeat((2 * 1024 * 1024) + 1),
    }));
    assert.equal(startOver.status, 413);
    assert.equal((await startOver.json()).error.code, 'request_too_large');
    assert.equal(calls.length, 1);

    const cancel = await post(baseUrl, 'cancel', '{}');
    assert.equal(cancel.status, 200);
    const cancelOver = await post(baseUrl, 'cancel', JSON.stringify({
      value: 'x'.repeat((256 * 1024) + 1),
    }));
    assert.equal(cancelOver.status, 413);
    assert.equal(calls.filter(([kind]) => kind === 'cancel').length, 1);
    assert.equal(broadCalls(), 0);
  });
});
