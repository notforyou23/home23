const test = require('node:test');
const assert = require('node:assert/strict');

const CosmoAnthropicClient = require('../../cosmo23/lib/anthropic-client');
const CosmoEngineAnthropicClient = require('../../cosmo23/engine/src/core/anthropic-client');

const clients = [
  ['cosmo23/lib', CosmoAnthropicClient],
  ['cosmo23/engine/src/core', CosmoEngineAnthropicClient]
];

function makeLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}

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

async function captureGenerateParams(Client, options) {
  let captured = null;
  const client = new Client({ useExtendedThinking: true }, makeLogger());
  client.isOAuth = false;
  client._initClient = async () => {};
  if (typeof client._resolveWireModel === 'function') {
    client._resolveWireModel = async model => model;
  }
  client._streamResponse = async () => ({ content: 'ok', hadError: false });
  client.anthropic = {
    messages: {
      stream: async params => {
        captured = params;
        return {};
      }
    }
  };

  await client.generate({
    instructions: 'system',
    input: 'hello',
    maxOutputTokens: 256,
    ...options
  });

  return captured;
}

async function captureWebSearchParams(Client, options) {
  let captured = null;
  const client = new Client({ useExtendedThinking: true }, makeLogger());
  client.isOAuth = false;
  client._initClient = async () => {};
  if (typeof client._resolveWireModel === 'function') {
    client._resolveWireModel = async model => model;
  }
  client._streamResponseWithWebSearch = async () => ({ content: 'ok', hadError: false });
  client.anthropic = {
    messages: {
      stream: async params => {
        captured = params;
        return {};
      }
    }
  };

  await client.generateWithWebSearch({
    instructions: 'system',
    input: 'hello',
    maxOutputTokens: 256,
    ...options
  });

  return captured;
}

for (const [name, Client] of clients) {
  test(`${name} omits deprecated sampling params for Claude Opus 4.8`, async () => {
    const params = await captureGenerateParams(Client, {
      model: 'claude-opus-4-8',
      reasoningEffort: 'high'
    });

    assert.equal(params.model, 'claude-opus-4-8');
    assert.equal(Object.hasOwn(params, 'temperature'), false);
    assert.deepEqual(params.thinking, {
      type: 'adaptive',
      display: 'summarized'
    });
    assert.deepEqual(params.output_config, {
      effort: 'high'
    });
  });

  test(`${name} omits deprecated sampling params for Claude Sonnet 4.7`, async () => {
    const params = await captureGenerateParams(Client, {
      model: 'claude-sonnet-4-7',
      reasoningEffort: 'high'
    });

    assert.equal(params.model, 'claude-sonnet-4-7');
    assert.equal(Object.hasOwn(params, 'temperature'), false);
    assert.deepEqual(params.thinking, {
      type: 'adaptive',
      display: 'summarized'
    });
  });

  test(`${name} omits deprecated sampling params for the Sonnet 5 wire model`, async () => {
    const params = await captureGenerateParams(Client, {
      model: 'claude-sonnet-5'
    });

    assert.equal(params.model, 'claude-sonnet-5');
    assert.equal(Object.hasOwn(params, 'temperature'), false);
  });

  test(`${name} keeps temperature for models that still accept sampling params`, async () => {
    const params = await captureGenerateParams(Client, {
      model: 'claude-haiku-4-5'
    });

    assert.equal(params.model, 'claude-haiku-4-5');
    assert.equal(params.temperature, 0.1);
    assert.equal(Object.hasOwn(params, 'thinking'), false);
  });

  test(`${name} omits deprecated sampling params during native web search`, async () => {
    const params = await captureWebSearchParams(Client, {
      model: 'claude-opus-4-8',
      query: 'station newsletter pipeline'
    });

    assert.equal(params.model, 'claude-opus-4-8');
    assert.equal(Object.hasOwn(params, 'temperature'), false);
    assert.equal(params.tools?.[0]?.type, 'web_search_20250305');
  });
}

test('cosmo23 engine Anthropic client falls back to an available Sonnet wire model', async () => {
  let captured = null;
  const client = new CosmoEngineAnthropicClient({ useExtendedThinking: true }, makeLogger());
  client.isOAuth = false;
  client._initClient = async () => {};
  client._streamResponse = async () => ({ content: 'ok', hadError: false });
  client.anthropic = {
    models: {
      list: async () => ({
        data: [
          { id: 'claude-sonnet-4-5' },
          { id: 'claude-haiku-4-5' }
        ]
      })
    },
    messages: {
      stream: async params => {
        captured = params;
        return {};
      }
    }
  };

  await client.generate({
    instructions: 'system',
    input: 'hello',
    maxOutputTokens: 256,
    model: 'claude-sonnet-4-7'
  });

  assert.equal(captured.model, 'claude-sonnet-4-5');
  assert.equal(captured.temperature, 0.1);
});

for (const [name, Client] of clients) {
  test(`${name} resolves available models from SDK beta.models when models is absent`, async () => {
    let captured = null;
    const client = new Client({ useExtendedThinking: true }, makeLogger());
    client.isOAuth = false;
    client._initClient = async () => {};
    client._streamResponse = async () => ({ content: 'ok', hadError: false });
    client.anthropic = {
      beta: {
        models: {
          list: async () => ({
            data: [
              { id: 'claude-sonnet-4-6' },
              { id: 'claude-sonnet-4-5-20250929' }
            ]
          })
        }
      },
      messages: {
        stream: async params => {
          captured = params;
          return {};
        }
      }
    };

    await client.generate({
      instructions: 'system',
      input: 'hello',
      maxOutputTokens: 256,
      model: 'claude-sonnet-4-7'
    });

    assert.equal(captured.model, 'claude-sonnet-4-6');
    assert.equal(captured.temperature, 0.1);
  });
}

for (const [name, Client] of clients) {
  test(`${name} resolves available models with direct HTTP when SDK has no models resource`, async () => {
    let captured = null;
    let fetchUrl = null;
    let fetchHeaders = null;
    const previousFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      fetchUrl = String(url);
      fetchHeaders = options.headers || {};
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'claude-sonnet-4-6' },
            { id: 'claude-haiku-4-5-20251001' }
          ]
        })
      };
    };

    const client = new Client({ useExtendedThinking: true }, makeLogger());
    client.isOAuth = false;
    client._initClient = async () => {};
    client._modelListHeaders = { authorization: 'Bearer sk-ant-oauth-test' };
    client._streamResponse = async () => ({ content: 'ok', hadError: false });
    client.anthropic = {
      messages: {
        stream: async params => {
          captured = params;
          return {};
        }
      }
    };

    try {
    await client.generate({
      instructions: 'system',
      input: 'hello',
      maxOutputTokens: 256,
      model: 'claude-sonnet-4-7'
    });
    } finally {
      global.fetch = previousFetch;
    }

    assert.equal(captured.model, 'claude-sonnet-4-6');
    assert.equal(captured.temperature, 0.1);
    assert.match(fetchUrl, /\/v1\/models\?limit=100$/);
    assert.equal(fetchHeaders.authorization, 'Bearer sk-ant-oauth-test');
  });
}

test('cosmo23/lib Anthropic stream does not call finalMessage after message_stop', async () => {
  const warnings = [];
  let finalMessageCalled = false;
  const client = new CosmoAnthropicClient({ useExtendedThinking: true }, {
    debug() {},
    info() {},
    warn(...args) { warnings.push(args.join(' ')); },
    error() {}
  });

  async function* streamEvents() {
    yield {
      type: 'message_start',
      message: {
        id: 'msg_stream',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 12 }
      }
    };
    yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'planner ok' } };
    yield { type: 'message_delta', usage: { output_tokens: 3 } };
    yield { type: 'message_stop' };
  }

  const stream = streamEvents();
  stream.finalMessage = async () => {
    finalMessageCalled = true;
    throw new Error('Request was aborted.');
  };

  const response = await client._streamResponseWithWebSearch(stream, {});

  assert.equal(response.content, 'planner ok');
  assert.equal(response.hadError, false);
  assert.equal(response.usage.input_tokens, 12);
  assert.equal(response.usage.output_tokens, 3);
  assert.equal(finalMessageCalled, false);
  assert.deepEqual(warnings, []);
});

const anthropicCases = [
  { name: 'normal completion', events: [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ], expected: { status: 'complete', terminalReceived: true } },
  { name: 'terminal token limit', events: [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ], expected: { status: 'partial', terminalReceived: true, code: 'provider_incomplete' } },
  { name: 'premature EOF', events: [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
  ], expected: { status: 'partial', terminalReceived: false, code: 'provider_incomplete' } },
  { name: 'partial text then stream error', events: [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
  ], terminalError: new Error('socket reset'),
  expected: { status: 'partial', terminalReceived: false, code: 'provider_failed' } },
];

for (const row of anthropicCases) {
  test(`Anthropic: ${row.name}`, async () => {
    const activity = [];
    const client = Object.create(CosmoAnthropicClient.prototype);
    client.logger = makeLogger();
    client.providerId = 'minimax';
    client._getModelFromOptions = () => 'MiniMax-M3';
    const result = await client._streamResponseWithWebSearch(
      controlledEvents(row.events, row.terminalError),
      { model: 'MiniMax-M3', onProviderActivity: event => activity.push(event.type) },
    );
    assert.equal(result.provider, 'minimax');
    assert.equal(result.status, row.expected.status);
    assert.equal(result.terminalReceived, row.expected.terminalReceived);
    if (row.expected.code) assert.equal(result.error.code, row.expected.code);
    assert.deepEqual(activity, row.events.map(event => event.type));
  });
}

test('Anthropic passes exact max tokens and shared signal to messages.stream', async () => {
  const controller = new AbortController();
  let capturedParams = null;
  let capturedOptions = null;
  const client = new CosmoAnthropicClient({
    providerId: 'anthropic', maxOutputTokens: 999,
  }, makeLogger());
  client.isOAuth = false;
  client._initClient = async () => {};
  client._resolveWireModel = async model => model;
  client._streamResponse = async () => ({
    status: 'complete', content: 'answer', terminalReceived: true,
    finishReason: 'end_turn', hadError: false,
  });
  client.anthropic = { messages: { stream: async (params, requestOptions) => {
    capturedParams = params;
    capturedOptions = requestOptions;
    return {};
  } } };

  await client.generate({
    model: 'claude-sonnet-4-6', input: 'hello', maxOutputTokens: 256,
    signal: controller.signal,
  });
  assert.equal(capturedParams.max_tokens, 256);
  assert.equal(capturedOptions.signal, controller.signal);
});

test('Anthropic validates max token capability before credentials or provider work', async () => {
  for (const maxOutputTokens of [undefined, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    let credentialCalls = 0;
    let providerCalls = 0;
    const client = new CosmoAnthropicClient({ providerId: 'anthropic' }, makeLogger());
    client._initClient = async () => { credentialCalls += 1; };
    client._resolveWireModel = async model => model;
    client.anthropic = { messages: { stream: async () => {
      providerCalls += 1;
      return controlledEvents([]);
    } } };
    await assert.rejects(
      () => client.generate({ input: 'hello', maxOutputTokens }),
      error => error.code === 'model_capability_invalid',
    );
    assert.equal(credentialCalls, 0);
    assert.equal(providerCalls, 0);
  }

  for (const maxOutputBytes of [0, 1.5, 64 * 1024 * 1024 + 1]) {
    let credentialCalls = 0;
    const client = new CosmoAnthropicClient({ providerId: 'anthropic' }, makeLogger());
    client._initClient = async () => { credentialCalls += 1; };
    await assert.rejects(
      () => client.generate({
        input: 'hello', maxOutputTokens: 16, maxOutputBytes,
      }),
      error => error.code === 'model_capability_invalid' && error.retryable === false,
    );
    assert.equal(credentialCalls, 0);
  }
});

test('Anthropic stream rethrows exact cancellation instead of building an error response', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('operator cancelled'), { code: 'cancelled' });
  const started = deferred();
  const gate = deferred();
  const stream = {
    [Symbol.asyncIterator]() { return this; },
    next() { started.resolve(); return gate.promise; },
    return() { return Promise.resolve({ done: true }); },
  };
  const client = Object.create(CosmoAnthropicClient.prototype);
  client.logger = makeLogger();
  client.providerId = 'anthropic';
  client._getModelFromOptions = () => 'claude-sonnet-4-6';
  const pending = client._streamResponseWithWebSearch(stream, {
    model: 'claude-sonnet-4-6', signal: controller.signal,
  });
  await started.promise;
  controller.abort(reason);
  gate.reject(new Error('ordinary reader failure after abort'));
  await assert.rejects(pending, error => error === reason);
});

test('Anthropic outer generate converts an init race to the exact cancellation reason', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('operator cancelled'), { code: 'cancelled' });
  const started = deferred();
  const gate = deferred();
  const client = new CosmoAnthropicClient({ providerId: 'anthropic' }, makeLogger());
  client._initClient = async () => { started.resolve(); return gate.promise; };
  const pending = client.generate({
    model: 'claude-sonnet-4-6', input: 'hello', maxOutputTokens: 256,
    signal: controller.signal,
  });
  await started.promise;
  controller.abort(reason);
  gate.reject(new Error('ordinary credential failure after abort'));
  await assert.rejects(pending, error => error === reason);
});

test('Anthropic web-search fallback never runs after exact cancellation', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('operator cancelled'), { code: 'cancelled' });
  let fallbackCalls = 0;
  const client = new CosmoAnthropicClient({ providerId: 'anthropic' }, makeLogger());
  client.isOAuth = false;
  client._initClient = async () => {};
  client._resolveWireModel = async model => model;
  client._performWebSearch = async () => { fallbackCalls += 1; return 'unexpected'; };
  client.generateWithRetry = async () => { fallbackCalls += 1; return {}; };
  client.anthropic = { messages: { stream: async () => {
    controller.abort(reason);
    throw new Error('ordinary provider failure after abort');
  } } };

  await assert.rejects(
    () => client.generateWithWebSearch({
      model: 'claude-sonnet-4-6', input: 'hello', maxOutputTokens: 256,
      signal: controller.signal,
    }),
    error => error === reason,
  );
  assert.equal(fallbackCalls, 0);
});

test('Anthropic retry honors pre-abort and aborts during backoff by exact identity', async () => {
  const preController = new AbortController();
  const preReason = Object.assign(new Error('pre-cancelled'), { code: 'cancelled' });
  preController.abort(preReason);
  let preCalls = 0;
  const preClient = Object.create(CosmoAnthropicClient.prototype);
  preClient.logger = makeLogger();
  preClient.generate = async () => { preCalls += 1; return {}; };
  await assert.rejects(
    () => preClient.generateWithRetry({ signal: preController.signal }),
    error => error === preReason,
  );
  assert.equal(preCalls, 0);

  const controller = new AbortController();
  const reason = Object.assign(new Error('operator cancelled'), { code: 'cancelled' });
  const enteredBackoff = deferred();
  let calls = 0;
  const client = Object.create(CosmoAnthropicClient.prototype);
  client.logger = {
    ...makeLogger(),
    warn(message) {
      if (String(message).includes('Retry')) enteredBackoff.resolve();
    },
  };
  client.generate = async () => {
    calls += 1;
    return {
      status: 'partial', content: 'partial', terminalReceived: false,
      hadError: true, error: { code: 'provider_incomplete', retryable: true },
    };
  };
  const pending = client.generateWithRetry({ signal: controller.signal }, 3);
  await enteredBackoff.promise;
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(calls, 1);
});

test('Anthropic bounds split multibyte output and keeps wire aliases as metadata', async () => {
  const client = Object.create(CosmoAnthropicClient.prototype);
  client.logger = makeLogger();
  client.providerId = 'anthropic';
  client._getModelFromOptions = options => options.model;

  const result = await client._streamResponseWithWebSearch(controlledEvents([
    {
      type: 'message_start',
      message: { id: 'm-alias', model: 'claude-sonnet-4-6-20260701' },
    },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '\uD83D' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '\uDE00' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]), {
    model: 'claude-sonnet-4-6', wireModel: 'claude-sonnet-4-6',
    maxOutputBytes: 4,
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.content, '😀');
  assert.equal(result.model, 'claude-sonnet-4-6');
  assert.equal(result.observedModel, 'claude-sonnet-4-6-20260701');
});

test('Anthropic tool JSON overflow cancels the stream and is nonretryable', async () => {
  let returnCalls = 0;
  let index = 0;
  const events = [
    {
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: 'i', name: 'f' },
    },
    {
      type: 'content_block_delta',
      delta: { type: 'input_json_delta', partial_json: '{"x":' },
    },
  ];
  const stream = {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      return index < events.length
        ? { done: false, value: events[index++] }
        : { done: true };
    },
    return() { returnCalls += 1; return Promise.resolve({ done: true }); },
  };
  const client = Object.create(CosmoAnthropicClient.prototype);
  client.logger = makeLogger();
  client.providerId = 'anthropic';
  client._getModelFromOptions = options => options.model;

  await assert.rejects(
    () => client._streamResponseWithWebSearch(stream, {
      model: 'claude-sonnet-4-6', maxOutputBytes: 70,
    }),
    error => error.code === 'result_too_large' && error.retryable === false,
  );
  assert.equal(returnCalls, 1);
});

test('Anthropic retries and web-search fallback never recover an overflow', async () => {
  let calls = 0;
  const retryClient = Object.create(CosmoAnthropicClient.prototype);
  retryClient.logger = makeLogger();
  retryClient.generate = async () => {
    calls += 1;
    throw Object.assign(new Error('too large'), {
      code: 'result_too_large', retryable: false,
    });
  };
  await assert.rejects(
    () => retryClient.generateWithRetry({}, 3),
    error => error.code === 'result_too_large',
  );
  assert.equal(calls, 1);

  let fallbackCalls = 0;
  const webClient = new CosmoAnthropicClient({ providerId: 'anthropic' }, makeLogger());
  webClient.isOAuth = false;
  webClient._initClient = async () => {};
  webClient._resolveWireModel = async model => model;
  webClient._performWebSearch = async () => { fallbackCalls += 1; return 'unexpected'; };
  webClient.generateWithRetry = async () => { fallbackCalls += 1; return {}; };
  webClient.anthropic = { messages: { stream: async () => controlledEvents([
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '😀x' } },
  ]) } };
  await assert.rejects(
    () => webClient.generateWithWebSearch({
      model: 'claude-sonnet-4-6', input: 'question', maxOutputTokens: 16,
      maxOutputBytes: 4,
    }),
    error => error.code === 'result_too_large',
  );
  assert.equal(fallbackCalls, 0);
});
