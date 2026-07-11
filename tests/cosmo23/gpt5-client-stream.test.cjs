const test = require('node:test');
const assert = require('node:assert/strict');

const { GPT5Client } = require('../../cosmo23/lib/gpt5-client');

async function* controlledEvents(events, terminalError = null) {
  for (const event of events) yield event;
  if (terminalError) throw terminalError;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const terminalCases = [
  {
    name: 'normal completion',
    events: [
      { type: 'response.output_text.delta', delta: 'answer' },
      { type: 'response.completed', response: { id: 'r1', model: 'gpt-5.4-mini' } },
    ],
    expected: { status: 'complete', terminalReceived: true },
  },
  {
    name: 'terminal token limit',
    events: [
      { type: 'response.output_text.delta', delta: 'partial' },
      { type: 'response.incomplete', response: { id: 'r2', model: 'gpt-5.4-mini' } },
    ],
    expected: { status: 'partial', terminalReceived: true, code: 'provider_incomplete' },
  },
  {
    name: 'premature EOF',
    events: [{ type: 'response.output_text.delta', delta: 'partial' }],
    expected: { status: 'partial', terminalReceived: false, code: 'provider_incomplete' },
  },
  {
    name: 'partial text then stream error',
    events: [{ type: 'response.output_text.delta', delta: 'partial' }],
    terminalError: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    expected: { status: 'partial', terminalReceived: false, code: 'provider_failed' },
  },
];

for (const row of terminalCases) {
  test(`GPT Responses: ${row.name}`, async () => {
    const controller = new AbortController();
    const activity = [];
    let requestPayload = null;
    const client = new GPT5Client(null, { providerId: 'xai' });
    client.client = { responses: { stream: async (payload, requestOptions) => {
      requestPayload = payload;
      assert.equal(requestOptions.signal, controller.signal);
      return controlledEvents(row.events, row.terminalError);
    } } };

    const result = await client.generate({
      model: 'gpt-5.4-mini',
      input: 'question',
      maxOutputTokens: 256,
      signal: controller.signal,
      onProviderActivity: event => activity.push(event.type),
    });

    assert.equal(requestPayload.max_output_tokens, 256);
    assert.equal(result.provider, 'xai');
    assert.equal(result.status, row.expected.status);
    assert.equal(result.terminalReceived, row.expected.terminalReceived);
    if (row.expected.code) assert.equal(result.error.code, row.expected.code);
    assert.deepEqual(activity, row.events.map(event => event.type));
  });
}

test('GPT Responses validates fixed identity and token capability before provider work', async () => {
  for (const invalidProvider of ['', ' ', 'bad/provider']) {
    assert.throws(
      () => new GPT5Client(null, { providerId: invalidProvider }),
      error => error.code === 'provider_model_mismatch',
    );
  }

  for (const maxOutputTokens of [undefined, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    let providerCalls = 0;
    const client = new GPT5Client();
    client.client = { responses: { stream: async () => {
      providerCalls += 1;
      return controlledEvents([]);
    } } };
    await assert.rejects(
      () => client.generate({ input: 'question', maxOutputTokens }),
      error => error.code === 'model_capability_invalid',
    );
    assert.equal(providerCalls, 0);
  }
});

test('GPT Responses never promotes reasoning-only output to successful content', async () => {
  const client = new GPT5Client();
  client.client = { responses: { stream: async () => controlledEvents([
    {
      type: 'response.completed',
      response: {
        id: 'reasoning-only', model: 'gpt-5.4-mini',
        output: [{
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: 'private reasoning' }],
        }],
      },
    },
  ]) } };

  const result = await client.generate({
    input: 'question', maxOutputTokens: 256,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.content, '');
  assert.equal(result.error.code, 'provider_incomplete');
});

test('GPT Responses rethrows the exact cancellation reason during stream creation', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('operator cancelled'), { code: 'cancelled' });
  const started = deferred();
  const gate = deferred();
  const client = new GPT5Client();
  client.client = { responses: { stream: async (_payload, requestOptions) => {
    assert.equal(requestOptions.signal, controller.signal);
    started.resolve();
    return gate.promise;
  } } };

  const pending = client.generate({
    input: 'question', maxOutputTokens: 256, signal: controller.signal,
  });
  await started.promise;
  controller.abort(reason);
  gate.reject(new Error('ordinary setup failure after abort'));
  await assert.rejects(pending, error => error === reason);
});

test('GPT Responses rethrows the exact cancellation reason during iterator read', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('operator cancelled'), { code: 'cancelled' });
  const started = deferred();
  const gate = deferred();
  const iterator = {
    [Symbol.asyncIterator]() { return this; },
    next() { started.resolve(); return gate.promise; },
    return() { return Promise.resolve({ done: true }); },
  };
  const client = new GPT5Client();
  client.client = { responses: { stream: async () => iterator } };

  const pending = client.generate({
    input: 'question', maxOutputTokens: 256, signal: controller.signal,
  });
  await started.promise;
  controller.abort(reason);
  gate.reject(new Error('ordinary reader failure after abort'));
  await assert.rejects(pending, error => error === reason);
});

test('GPT Responses retry backoff is abortable and partial is never success', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('operator cancelled'), { code: 'cancelled' });
  const enteredBackoff = deferred();
  let calls = 0;
  const client = new GPT5Client({
    warn(message) {
      if (String(message).includes('retrying')) enteredBackoff.resolve();
    },
  });
  client.generate = async () => {
    calls += 1;
    return {
      status: 'partial', content: 'partial', terminalReceived: false,
      finishReason: null, hadError: false,
      error: { code: 'provider_incomplete', retryable: true },
    };
  };

  const pending = client.generateWithRetry({ signal: controller.signal }, 3);
  await enteredBackoff.promise;
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(calls, 1);
});

test('GPT code-interpreter helper preserves the canonical token capability field', async () => {
  const client = new GPT5Client();
  let forwarded = null;
  client.generateWithRetry = async options => {
    forwarded = options;
    return { output: null };
  };

  await client.executeInContainer({
    containerId: 'container-1', input: 'run this', maxOutputTokens: 411,
  });

  assert.equal(forwarded.maxOutputTokens, 411);
  assert.equal('max_output_tokens' in forwarded, false);
  assert.equal('maxTokens' in forwarded, false);
});
