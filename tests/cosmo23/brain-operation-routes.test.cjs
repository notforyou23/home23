'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { createBrainOperationRoutes } = require(
  '../../cosmo23/server/lib/brain-operation-routes'
);

const OPERATION_ID = `brop_${'a'.repeat(32)}`;

async function withServer(callback, options = {}) {
  const calls = [];
  const worker = {
    async readVerifiedFollowUpSupport(body, capability) {
      if (options.supportError) throw Object.assign(new Error(options.supportError), {
        code: options.supportError,
      });
      calls.push(['support', body, capability]);
      return { ok: true };
    },
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

function postSupport(baseUrl, body, authorization = 'Bearer vfh1.test-signature') {
  return fetch(`${baseUrl}/api/internal/brain-operations/support`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body,
  });
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

test('protected support handshake is loopback-only, bearer-authenticated, and narrowly bounded', async () => {
  await withServer(async ({ baseUrl, calls, broadCalls }) => {
    const body = JSON.stringify({ version: 1, issuedAt: Date.now(), nonce: `vfhs_${'a'.repeat(32)}` });
    const accepted = await postSupport(baseUrl, body);
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { ok: true });
    assert.equal(calls[0][0], 'support');
    assert.equal(calls[0][2], 'vfh1.test-signature');

    const missing = await postSupport(baseUrl, body, '');
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error.code, 'capability_invalid');

    const oversized = await postSupport(baseUrl, JSON.stringify({
      value: 'x'.repeat(4 * 1024 + 1),
    }));
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, 'request_too_large');
    assert.equal(calls.filter(([kind]) => kind === 'support').length, 1);
    assert.equal(broadCalls(), 0);
  });
});

test('support handshake reports absent auth authority or runtime support as unavailable', async () => {
  const body = JSON.stringify({ version: 1, issuedAt: Date.now(), nonce: `vfhs_${'a'.repeat(32)}` });
  for (const code of ['capability_unavailable', 'verified_follow_up_support_unavailable']) {
    await withServer(async ({ baseUrl }) => {
      const response = await postSupport(baseUrl, body);
      assert.equal(response.status, 503, code);
      assert.equal((await response.json()).error.code, code);
    }, { supportError: code });
  }
});
