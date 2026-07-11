const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ChatCompletionsClient,
} = require('../../cosmo23/engine/src/core/chat-completions-client');

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

const chatCases = [
  { name: 'normal completion', chunks: [
    { id: 'c1', model: 'local', choices: [{ delta: { content: 'answer' }, finish_reason: null }] },
    { id: 'c1', model: 'local', choices: [{ delta: {}, finish_reason: 'stop' }] },
  ], expected: { status: 'complete', terminalReceived: true } },
  { name: 'terminal token limit', chunks: [
    { choices: [{ delta: { content: 'partial' }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
  ], expected: { status: 'partial', terminalReceived: true, code: 'provider_incomplete' } },
  { name: 'premature EOF', chunks: [
    { choices: [{ delta: { content: 'partial' }, finish_reason: null }] },
  ], expected: { status: 'partial', terminalReceived: false, code: 'provider_incomplete' } },
  { name: 'partial text then stream error', chunks: [
    { choices: [{ delta: { content: 'partial' }, finish_reason: null }] },
  ], terminalError: new Error('socket reset'),
  expected: { status: 'partial', terminalReceived: false, code: 'provider_failed' } },
];

for (const row of chatCases) {
  test(`Chat Completions: ${row.name}`, async () => {
    const controller = new AbortController();
    const activity = [];
    let requestPayload = null;
    const client = new ChatCompletionsClient({
      providerId: 'test-openai-compatible', supportsStreaming: true,
    });
    client.client = { chat: { completions: { create: async (payload, requestOptions) => {
      requestPayload = payload;
      assert.equal(requestOptions.signal, controller.signal);
      return controlledEvents(row.chunks, row.terminalError);
    } } } };

    const result = await client.generate({
      input: 'question', maxOutputTokens: 256, signal: controller.signal,
      onProviderActivity: event => activity.push(event.type),
    });

    assert.equal(requestPayload.max_tokens, 256);
    assert.equal(result.provider, 'test-openai-compatible');
    assert.equal(result.status, row.expected.status);
    assert.equal(result.terminalReceived, row.expected.terminalReceived);
    if (row.expected.code) assert.equal(result.error.code, row.expected.code);
    assert.deepEqual(activity, row.chunks.map(() => 'chat.completion.chunk'));
  });
}

test('Chat Completions requires fixed provider identity at construction', () => {
  for (const providerId of [undefined, '', ' ', 'bad/provider']) {
    assert.throws(
      () => new ChatCompletionsClient({ providerId }),
      error => error.code === 'provider_model_mismatch',
    );
  }
});

test('Chat Completions validates token capability before provider work', async () => {
  for (const maxOutputTokens of [undefined, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    let providerCalls = 0;
    const client = new ChatCompletionsClient({
      providerId: 'local',
      client: { chat: { completions: { create: async () => {
        providerCalls += 1;
        return controlledEvents([]);
      } } } },
    });
    await assert.rejects(
      () => client.generate({ input: 'question', maxOutputTokens }),
      error => error.code === 'model_capability_invalid',
    );
    assert.equal(providerCalls, 0);
  }

  let clientAccesses = 0;
  const client = new ChatCompletionsClient({ providerId: 'local' }, { error() {} });
  client.getClient = () => {
    clientAccesses += 1;
    throw new Error('client must not be initialized');
  };
  await assert.rejects(
    () => client.generate({ input: 'question', maxOutputTokens: 0 }),
    error => error.code === 'model_capability_invalid',
  );
  assert.equal(clientAccesses, 0);
});

test('Chat Completions non-streaming uses exact signal, tokens, and terminal envelope', async () => {
  const controller = new AbortController();
  let payload = null;
  const client = new ChatCompletionsClient({
    providerId: 'ollama-cloud',
    supportsStreaming: false,
    client: { chat: { completions: { create: async (request, requestOptions) => {
      payload = request;
      assert.equal(requestOptions.signal, controller.signal);
      return {
        id: 'response-1', model: 'nemotron',
        choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      };
    } } } },
  });

  const result = await client.generate({
    model: 'nemotron', input: 'question', maxOutputTokens: 333,
    signal: controller.signal,
  });
  assert.equal(payload.max_tokens, 333);
  assert.equal(payload.stream, false);
  assert.equal(result.status, 'complete');
  assert.equal(result.provider, 'ollama-cloud');
});

test('Chat Completions rethrows exact cancellation during stream creation and iteration', async () => {
  for (const boundary of ['creation', 'iterator']) {
    const controller = new AbortController();
    const reason = Object.assign(new Error('operator cancelled'), { code: 'cancelled' });
    const started = deferred();
    const gate = deferred();
    const iterator = {
      [Symbol.asyncIterator]() { return this; },
      next() { started.resolve(); return gate.promise; },
      return() { return Promise.resolve({ done: true }); },
    };
    const client = new ChatCompletionsClient({
      providerId: 'local',
      client: { chat: { completions: { create: async (_payload, requestOptions) => {
        assert.equal(requestOptions.signal, controller.signal);
        if (boundary === 'creation') {
          started.resolve();
          return gate.promise;
        }
        return iterator;
      } } } },
    });
    const pending = client.generate({
      input: 'question', maxOutputTokens: 256, signal: controller.signal,
    });
    await started.promise;
    controller.abort(reason);
    gate.reject(new Error(`ordinary ${boundary} failure after abort`));
    await assert.rejects(pending, error => error === reason);
  }
});

test('Chat Completions retry delay is abortable and partial is never success', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('operator cancelled'), { code: 'cancelled' });
  const enteredBackoff = deferred();
  let calls = 0;
  const client = new ChatCompletionsClient({ providerId: 'local' }, {
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
