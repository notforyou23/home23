const assert = require('node:assert/strict');
const test = require('node:test');

const { UnifiedClient } = require('../../engine/src/core/unified-client.js');

function encodeSegment(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function makeJwt(payload) {
  return [
    encodeSegment({ alg: 'RS256', typ: 'JWT' }),
    encodeSegment(payload),
    'signature'
  ].join('.');
}

function makeClient() {
  return new UnifiedClient({
    providers: {
      'openai-codex': {
        enabled: true,
        baseURL: 'https://chatgpt.com/backend-api'
      }
    }
  }, {
    debug() {},
    info() {},
    warn() {},
    error() {}
  });
}

function fakeCodexStream() {
  const chunks = [
    Buffer.from('data: {"type":"response.output_text.delta","delta":"OK"}\n\n'),
    Buffer.from('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n')
  ];
  let index = 0;
  return {
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) return { done: true };
          return { done: false, value: chunks[index++] };
        }
      };
    }
  };
}

test('cosmo23 UnifiedClient sends Codex query input as response input items', async () => {
  const previousEnv = {
    OPENAI_CODEX_AUTH_TOKEN: process.env.OPENAI_CODEX_AUTH_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  const previousFetch = global.fetch;
  const token = makeJwt({
    exp: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct_unified_test'
    }
  });
  let capturedBody = null;

  process.env.OPENAI_CODEX_AUTH_TOKEN = token;
  process.env.OPENAI_API_KEY = 'sk-test-openai-required-by-parent-client';
  global.fetch = async (_url, options = {}) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      body: fakeCodexStream()
    };
  };

  try {
    const client = makeClient();
    const response = await client.generateCodex(
      { provider: 'openai-codex', model: 'gpt-5.5' },
      {
        instructions: 'Reply briefly.',
        query: 'Credential smoke test.',
        tools: [{ type: 'web_search' }]
      }
    );

    assert.equal(response.content, 'OK');
    assert.equal(capturedBody.model, 'gpt-5.5');
    assert.equal(Array.isArray(capturedBody.input), true);
    assert.deepEqual(capturedBody.input, [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Credential smoke test.' }]
    }]);
    assert.equal(capturedBody.tools[0].type, 'web_search');
    assert.equal(capturedBody.tool_choice, 'auto');
    assert.equal(Object.hasOwn(capturedBody, 'max_output_tokens'), false);
    assert.equal(Object.hasOwn(capturedBody, 'include'), false);
    assert.equal(Object.hasOwn(capturedBody, 'reasoning'), false);
  } finally {
    global.fetch = previousFetch;
    if (previousEnv.OPENAI_CODEX_AUTH_TOKEN === undefined) delete process.env.OPENAI_CODEX_AUTH_TOKEN;
    else process.env.OPENAI_CODEX_AUTH_TOKEN = previousEnv.OPENAI_CODEX_AUTH_TOKEN;
    if (previousEnv.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousEnv.OPENAI_API_KEY;
  }
});
