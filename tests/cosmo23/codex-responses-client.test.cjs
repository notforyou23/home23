'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CodexResponsesClient,
  MAX_CODEX_INPUT_BYTES,
} = require('../../cosmo23/lib/codex-responses-client');
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

function streamFromChunks(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
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

test('Codex normalizes bounded string input into the exact backend item list', async () => {
  const controller = new AbortController();
  let wireBody = null;
  const body = streamFrom(
    'data: {"type":"response.output_text.delta","delta":"OK"}\n\n'
      + 'data: {"type":"response.completed","response":{"id":"codex-input"}}\n\n',
  );
  const client = makeClient({
    body,
    signal: controller.signal,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(init.signal, controller.signal);
      wireBody = JSON.parse(init.body);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  const result = await generate(client, controller.signal, {
    instructions: 'Return a normal terminal response containing OK.',
    input: 'Reply with OK.',
  });

  assert.equal(result.status, 'complete');
  assert.deepEqual(wireBody, {
    model: 'gpt-5.6-terra',
    store: false,
    stream: true,
    instructions: 'Return a normal terminal response containing OK.',
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Reply with OK.' }],
    }],
  });
  assert.equal(Object.hasOwn(wireBody, 'max_output_tokens'), false);
});

test('Codex forwards its long-lived dispatcher so transport defaults cannot end a durable call', async () => {
  const controller = new AbortController();
  const dispatcher = { dispatch() {} };
  let observedDispatcher = null;
  const body = streamFrom(
    'data: {"type":"response.output_text.delta","delta":"OK"}\n\n'
      + 'data: {"type":"response.completed"}\n\n',
  );
  const client = new CodexResponsesClient({
    dispatcher,
    credentialsProvider: async () => ({ accessToken: 'test-token', accountId: 'test-account' }),
    fetchImpl: async (_url, init) => {
      observedDispatcher = init.dispatcher;
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  const result = await generate(client, controller.signal);
  assert.equal(result.status, 'complete');
  assert.equal(observedDispatcher, dispatcher);
});

test('Codex turns an opaque fetch failure into a typed retryable transport error', async () => {
  const controller = new AbortController();
  const client = new CodexResponsesClient({
    credentialsProvider: async () => ({ accessToken: 'test-token', accountId: 'test-account' }),
    fetchImpl: async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
      });
    },
  });

  await assert.rejects(
    generate(client, controller.signal),
    (error) => error.code === 'provider_unavailable'
      && error.retryable === true
      && /UND_ERR_HEADERS_TIMEOUT/.test(error.message),
  );
});

test('Codex preserves valid structured input items on the wire', async () => {
  const controller = new AbortController();
  let wireInput = null;
  const input = [{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'question' }],
  }, {
    type: 'function_call_output',
    call_id: 'call-1',
    output: 'tool result',
  }];
  const body = streamFrom(
    'data: {"type":"response.output_text.delta","delta":"answer"}\n\n'
      + 'data: {"type":"response.completed"}\n\n',
  );
  const client = makeClient({
    body,
    signal: controller.signal,
    fetchImpl: async (_url, init) => {
      wireInput = JSON.parse(init.body).input;
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  const result = await generate(client, controller.signal, { input });

  assert.equal(result.status, 'complete');
  assert.deepEqual(wireInput, input);
});

test('Codex rejects invalid input structure before credentials or fetch', async () => {
  const invalidInputs = [
    undefined,
    null,
    '',
    '   ',
    {},
    [],
    [null],
    ['question'],
    [{}],
    [{ type: '' }],
    [{ type: 'message', content: 1n }],
  ];
  const circular = { type: 'message' };
  circular.self = circular;
  invalidInputs.push([circular]);

  for (const input of invalidInputs) {
    const counters = {};
    const controller = new AbortController();
    const client = makeClient({
      body: streamFrom(''), signal: controller.signal, counters,
    });
    await assert.rejects(
      generate(client, controller.signal, { input }),
      error => error.code === 'provider_execution_invalid' && error.retryable === false,
    );
    assert.equal(counters.credentialCalls || 0, 0);
    assert.equal(counters.fetchCalls || 0, 0);
  }
});

test('Codex rejects string and structured input beyond its hard transport ceiling', async () => {
  assert.equal(MAX_CODEX_INPUT_BYTES, 64 * 1024 * 1024);
  const inputs = [
    '\0'.repeat(Math.ceil(MAX_CODEX_INPUT_BYTES / 6)),
    [{
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: '\0'.repeat(Math.ceil(MAX_CODEX_INPUT_BYTES / 6)),
      }],
    }],
  ];

  for (const input of inputs) {
    const counters = {};
    const controller = new AbortController();
    const client = makeClient({
      body: streamFrom(''), signal: controller.signal, counters,
    });
    await assert.rejects(
      generate(client, controller.signal, { input }),
      error => error.code === 'result_too_large' && error.retryable === false,
    );
    assert.equal(counters.credentialCalls || 0, 0);
    assert.equal(counters.fetchCalls || 0, 0);
  }
});

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
    { maxOutputBytes: 0 },
    { maxOutputBytes: 1.5 },
    { maxOutputBytes: 64 * 1024 * 1024 + 1 },
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

test('Codex decodes split UTF-8 bytes and keeps wire aliases as bounded metadata', async () => {
  const controller = new AbortController();
  const encoded = new TextEncoder().encode(
    'data: {"type":"response.output_text.delta","delta":"😀"}\n\n'
      + 'data: {"type":"response.completed","response":{"id":"alias","model":"gpt-5.6-terra-20260701"}}\n\n',
  );
  const emojiStart = encoded.findIndex((value, index) =>
    value === 0xF0 && encoded[index + 1] === 0x9F);
  const body = streamFromChunks([
    encoded.subarray(0, emojiStart + 2),
    encoded.subarray(emojiStart + 2, emojiStart + 3),
    encoded.subarray(emojiStart + 3),
  ]);

  const result = await generate(
    makeClient({ body, signal: controller.signal }), controller.signal,
    { maxOutputBytes: 4 },
  );

  assert.equal(result.status, 'complete');
  assert.equal(result.content, '😀');
  assert.equal(result.model, 'gpt-5.6-terra');
  assert.equal(result.observedModel, 'gpt-5.6-terra-20260701');
});

test('Codex tool-call overflow cancels and releases its reader', async () => {
  const controller = new AbortController();
  const counters = { cancel: 0, release: 0, reads: 0 };
  const bytes = new TextEncoder().encode(
    'data: {"type":"response.function_call_arguments.delta","item_id":"i","call_id":"c","name":"f","delta":"{"}\n\n',
  );
  const reader = {
    async read() {
      counters.reads += 1;
      return counters.reads === 1
        ? { done: false, value: bytes }
        : { done: true };
    },
    cancel() { counters.cancel += 1; return Promise.resolve(); },
    releaseLock() { counters.release += 1; },
  };
  const client = new CodexResponsesClient({
    credentialsProvider: async () => ({ accessToken: 'test', accountId: 'acct' }),
    fetchImpl: async () => ({
      ok: true,
      body: { getReader: () => reader },
    }),
  });

  await assert.rejects(
    () => generate(client, controller.signal, { maxOutputBytes: 66 }),
    error => error.code === 'result_too_large' && error.retryable === false,
  );
  assert.equal(counters.cancel, 1);
  assert.equal(counters.release, 1);
});

test('Codex rejects an oversized unterminated SSE frame without concatenating forever', async () => {
  const controller = new AbortController();
  const counters = { cancel: 0, release: 0, reads: 0 };
  const chunk = new TextEncoder().encode('x'.repeat(1024 * 1024));
  const reader = {
    async read() {
      counters.reads += 1;
      return counters.reads <= 3
        ? { done: false, value: chunk }
        : { done: true };
    },
    cancel() { counters.cancel += 1; return Promise.resolve(); },
    releaseLock() { counters.release += 1; },
  };
  const client = new CodexResponsesClient({
    credentialsProvider: async () => ({ accessToken: 'test', accountId: 'acct' }),
    fetchImpl: async () => ({
      ok: true,
      body: { getReader: () => reader },
    }),
  });

  await assert.rejects(
    () => generate(client, controller.signal),
    error => error.code === 'result_too_large' && error.retryable === false,
  );
  assert.equal(counters.reads, 3);
  assert.equal(counters.cancel, 1);
  assert.equal(counters.release, 1);
});
