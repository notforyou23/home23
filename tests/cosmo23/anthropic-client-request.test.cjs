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

  test(`${name} keeps temperature for non-Opus 4.8 models`, async () => {
    const params = await captureGenerateParams(Client, {
      model: 'claude-sonnet-4-7'
    });

    assert.equal(params.model, 'claude-sonnet-4-7');
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
