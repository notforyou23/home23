const assert = require('assert');
const test = require('node:test');

function futureJwt() {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: 'acct-test' })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function loadFresh() {
  const modulePath = require.resolve('../../../engine/src/services/openai-codex-oauth-engine');
  delete require.cache[modulePath];
  return require(modulePath);
}

test('openai-codex credentials use OAuth token and ignore OPENAI_API_KEY', () => {
  const oldEnv = { ...process.env };
  try {
    const token = futureJwt();
    process.env.OPENAI_CODEX_AUTH_TOKEN = token;
    process.env.OPENAI_API_KEY = 'sk-should-not-be-used';

    const { getOpenAICodexCredentials } = loadFresh();
    const credentials = getOpenAICodexCredentials();

    assert.equal(credentials.apiKey, token);
    assert.equal(credentials.authMode, 'oauth');
    assert.equal(credentials.isOAuth, true);
  } finally {
    process.env = oldEnv;
  }
});

test('openai-codex fails closed instead of falling back to OPENAI_API_KEY', () => {
  const oldEnv = { ...process.env };
  try {
    delete process.env.OPENAI_CODEX_AUTH_TOKEN;
    process.env.OPENAI_API_KEY = 'sk-should-not-be-used';

    const { getOpenAICodexCredentials } = loadFresh();

    assert.throws(
      () => getOpenAICodexCredentials(),
      /Refusing to use OPENAI_API_KEY for openai-codex/
    );
  } finally {
    process.env = oldEnv;
  }
});

test('openai-codex rejects API-key shaped values in the OAuth slot', () => {
  const oldEnv = { ...process.env };
  try {
    process.env.OPENAI_CODEX_AUTH_TOKEN = 'sk-not-oauth';

    const { getOpenAICodexCredentials } = loadFresh();

    assert.throws(
      () => getOpenAICodexCredentials(),
      /not an OpenAI OAuth JWT/
    );
  } finally {
    process.env = oldEnv;
  }
});

test('openai-codex moves system and developer messages into instructions', async () => {
  const oldEnv = { ...process.env };
  const oldFetch = global.fetch;
  let captured = null;

  try {
    process.env.OPENAI_CODEX_AUTH_TOKEN = futureJwt();
    global.fetch = async (url, options = {}) => {
      captured = {
        url,
        body: JSON.parse(options.body),
      };
      return {
        ok: true,
        body: {
          getReader() {
            const chunks = [
              Buffer.from('data: {"type":"response.output_text.delta","delta":"ok"}\n\n'),
              Buffer.from('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'),
            ];
            let index = 0;
            return {
              async read() {
                if (index >= chunks.length) return { done: true };
                return { done: false, value: chunks[index++] };
              },
            };
          },
        },
      };
    };

    const { OpenAICodexClient } = loadFresh();
    const client = new OpenAICodexClient({}, { info() {} });

    await client.generate({
      model: 'gpt-5.5',
      instructions: 'Base instruction.',
      messages: [
        { role: 'system', content: 'System instruction.' },
        { role: 'developer', content: 'Developer instruction.' },
        { role: 'user', content: 'Hello.' },
      ],
    });

    assert.equal(captured.url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.match(captured.body.instructions, /Base instruction/);
    assert.match(captured.body.instructions, /System instruction/);
    assert.match(captured.body.instructions, /Developer instruction/);
    assert.deepEqual(captured.body.input.map(item => item.role), ['user']);
  } finally {
    process.env = oldEnv;
    global.fetch = oldFetch;
  }
});
