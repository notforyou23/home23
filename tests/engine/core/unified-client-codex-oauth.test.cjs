const assert = require('assert');
const test = require('node:test');

function futureJwt() {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: 'acct-test' })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function clearClientModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/engine/src/core/unified-client.js')
      || key.includes('/engine/src/core/gpt5-client.js')
      || key.includes('/engine/src/core/openai-client.js')
      || key.includes('/engine/src/services/openai-codex-oauth-engine.js')) {
      delete require.cache[key];
    }
  }
}

test('UnifiedClient routes openai-codex assignments through OAuth, not OPENAI_API_KEY', async () => {
  const oldEnv = { ...process.env };
  const oldFetch = global.fetch;
  let captured = null;

  try {
    const token = futureJwt();
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_CODEX_AUTH_TOKEN = token;
    global.fetch = async (url, options = {}) => {
      captured = {
        url,
        headers: options.headers,
        body: JSON.parse(options.body)
      };
      return {
        ok: true,
        body: {
          getReader() {
            const chunks = [
              Buffer.from('data: {"type":"response.output_text.delta","delta":"codex ok"}\n\n'),
              Buffer.from('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2}}}\n\n')
            ];
            let index = 0;
            return {
              async read() {
                if (index >= chunks.length) return { done: true };
                return { done: false, value: chunks[index++] };
              }
            };
          }
        }
      };
    };
    clearClientModules();

    const { UnifiedClient } = require('../../../engine/src/core/unified-client');
    const client = new UnifiedClient({
      modelAssignments: {
        'agents.research': { provider: 'openai-codex', model: 'gpt-5.4' }
      }
    }, console);

    const result = await client.generate({
      component: 'agents',
      purpose: 'research',
      messages: [{ role: 'user', content: 'hello' }]
    });

    assert.equal(result.content, 'codex ok');
    assert.equal(captured.url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(captured.headers.Authorization, `Bearer ${token}`);
    assert.ok(captured.headers['chatgpt-account-id']);
    assert.equal(captured.body.model, 'gpt-5.4');
    assert.equal(typeof captured.body.instructions, 'string');
    assert.ok(captured.body.instructions.length > 0);
    assert.equal(Object.hasOwn(captured.body, 'max_output_tokens'), false);
  } finally {
    process.env = oldEnv;
    global.fetch = oldFetch;
    clearClientModules();
  }
});
