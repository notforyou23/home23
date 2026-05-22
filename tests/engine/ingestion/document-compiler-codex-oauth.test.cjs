const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

function futureJwt() {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: 'acct-test' })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function clearCompilerModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/engine/src/ingestion/document-compiler.js')
      || key.includes('/engine/src/services/openai-codex-oauth-engine.js')) {
      delete require.cache[key];
    }
  }
}

test('DocumentCompiler maps openai-codex models to OAuth token, not OPENAI_API_KEY', async () => {
  const oldEnv = { ...process.env };
  const oldFetch = global.fetch;
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-codex-compiler-'));
  let captured = null;

  try {
    const token = futureJwt();
    process.env.OPENAI_API_KEY = 'sk-plain-openai-key';
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
              Buffer.from('data: {"type":"response.output_text.delta","delta":"No new entries."}\n\n'),
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
    clearCompilerModules();

    const { DocumentCompiler } = require('../../../engine/src/ingestion/document-compiler');
    const compiler = new DocumentCompiler({
      workspacePath,
      config: { model: 'gpt-5.3-codex' },
      logger: console
    });

    assert.equal(compiler.clientType, 'codex');
    await compiler.compile('hello', { filePath: 'note.txt', format: 'text' });
    assert.equal(captured.url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(captured.headers.Authorization, `Bearer ${token}`);
    assert.ok(captured.headers['chatgpt-account-id']);
    assert.equal(captured.body.model, 'gpt-5.3-codex');
  } finally {
    process.env = oldEnv;
    global.fetch = oldFetch;
    clearCompilerModules();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});
