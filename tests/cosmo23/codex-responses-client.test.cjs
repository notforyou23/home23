'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CodexResponsesClient } = require('../../cosmo23/lib/codex-responses-client');
const { requireCompleteProviderResult } = require('../../cosmo23/lib/provider-completion');

function streamFrom(text, { fail = null } = {}) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      if (bytes.length) controller.enqueue(bytes);
      if (fail) controller.error(fail);
      else controller.close();
    },
  });
}

function makeClient({ body, signal, status = 200, counters = {}, credentialsProvider, fetchImpl }) {
  return new CodexResponsesClient({
    credentialsProvider: credentialsProvider || (async (options) => {
      counters.credentialCalls = (counters.credentialCalls || 0) + 1;
      assert.equal(options.signal, signal);
      return { accessToken: 'test-token', accountId: 'test-account' };
    }),
    fetchImpl: fetchImpl || (async (_url, init) => {
      counters.fetchCalls = (counters.fetchCalls || 0) + 1;
      assert.equal(init.signal, signal);
      return new Response(body, {
        status,
        headers: { 'content-type': 'text/event-stream' },
      });
    }),
  });
}

async function generate(client, signal, overrides = {}) {
  return client.generate({
    provider: 'openai-codex',
    model: 'gpt-5.6-terra',
    input: [{ type: 'message', role: 'user', content: 'question' }],
    maxOutputTokens: 256,
    signal,
    ...overrides,
  });
}

test('Codex flushes an unterminated terminal frame and reports exact identity', async () => {
  const controller = new AbortController();
  const activity = [];
  const body = streamFrom(
    'data: {"type":"response.output_text.delta","delta":"answer"}\n\n'
      + 'data: {"type":"response.completed","response":{"id":"codex-1"}}',
  );
  const result = await generate(makeClient({ body, signal: controller.signal }), controller.signal, {
    onProviderActivity: (event) => activity.push(event.type),
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.terminalReceived, true);
  assert.equal(result.content, 'answer');
  assert.equal(result.provider, 'openai-codex');
  assert.equal(result.model, 'gpt-5.6-terra');
  assert.equal(requireCompleteProviderResult(result).content, 'answer');
  assert.deepEqual(activity, ['response.output_text.delta', 'response.completed']);
});

test('Codex distinguishes incomplete, EOF, malformed EOF, and empty completion', async () => {
  const rows = [
    {
      name: 'incomplete',
      body: 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
        + 'data: {"type":"response.incomplete"}\n\n',
      status: 'partial', terminalReceived: true, code: 'provider_incomplete',
    },
    {
      name: 'eof',
      body: 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      status: 'partial', terminalReceived: false, code: 'provider_incomplete',
    },
    {
      name: 'malformed',
      body: 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
        + 'data: {bad-json',
      status: 'partial', terminalReceived: false, code: 'provider_failed',
    },
    {
      name: 'empty completed',
      body: 'data: {"type":"response.completed","response":{"id":"empty"}}\n\n',
      status: 'failed', terminalReceived: true, code: 'provider_incomplete',
    },
  ];
  for (const row of rows) {
    const controller = new AbortController();
    const result = await generate(makeClient({
      body: streamFrom(row.body), signal: controller.signal,
    }), controller.signal);
    assert.equal(result.status, row.status, row.name);
    assert.equal(result.terminalReceived, row.terminalReceived, row.name);
    assert.equal(result.error?.code, row.code, row.name);
  }
});

test('Codex validates capability, provider, model, and pre-abort before credentials', async () => {
  for (const overrides of [
    { maxOutputTokens: undefined },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 1.5 },
    { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 },
    { provider: 'openai' },
    { model: ' ' },
  ]) {
    const counters = {};
    const controller = new AbortController();
    const client = makeClient({ body: streamFrom(''), signal: controller.signal, counters });
    await assert.rejects(generate(client, controller.signal, overrides), (error) =>
      ['model_capability_invalid', 'provider_model_mismatch', 'model_not_found'].includes(error.code));
    assert.equal(counters.credentialCalls || 0, 0);
    assert.equal(counters.fetchCalls || 0, 0);
  }

  const reason = Object.assign(new Error('operator cancelled'), { code: 'cancelled' });
  const counters = {};
  const controller = new AbortController();
  controller.abort(reason);
  const client = makeClient({ body: streamFrom(''), signal: controller.signal, counters });
  await assert.rejects(generate(client, controller.signal), (error) => error === reason);
  assert.equal(counters.credentialCalls || 0, 0);
  assert.equal(counters.fetchCalls || 0, 0);
});

test('Codex preserves exact cancellation when abort races credentials, fetch, body, or reader', async () => {
  function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  for (const boundary of ['credentials', 'fetch', 'error-body', 'reader']) {
    const controller = new AbortController();
    const reason = Object.assign(new Error(`cancel ${boundary}`), { code: 'cancelled' });
    const gate = deferred();
    const started = deferred();
    const credentialsProvider = async ({ signal }) => {
      assert.equal(signal, controller.signal);
      if (boundary === 'credentials') {
        started.resolve();
        return gate.promise;
      }
      return { accessToken: 'test', accountId: 'acct' };
    };
    const fetchImpl = async (_url, init) => {
      assert.equal(init.signal, controller.signal);
      if (boundary === 'fetch') {
        started.resolve();
        return gate.promise;
      }
      if (boundary === 'error-body') {
        return {
          ok: false,
          status: 503,
          text() { started.resolve(); return gate.promise; },
        };
      }
      return {
        ok: true,
        body: {
          getReader() {
            return {
              read() { started.resolve(); return gate.promise; },
              releaseLock() {},
            };
          },
        },
      };
    };
    const client = new CodexResponsesClient({ credentialsProvider, fetchImpl });
    const pending = generate(client, controller.signal);
    await started.promise;
    controller.abort(reason);
    gate.reject(new Error(`ordinary ${boundary} failure`));
    await assert.rejects(pending, (error) => error === reason, boundary);
  }
});
