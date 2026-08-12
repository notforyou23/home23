'use strict';

/**
 * The codex OAuth engine must resolve its token at use from secrets.yaml
 * (the mirror target), with the boot env as the floor, and spend exactly one
 * force-fresh retry on an auth failure. This is the credential class that
 * killed the fleet on Aug 8–9: the token rotated but every consumer held the
 * frozen boot copy.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function futureJwt(marker) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: marker,
  })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function freshModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/engine/src/services/openai-codex-oauth-engine.js')
      || key.includes('/engine/src/core/provider-credentials.js')) {
      delete require.cache[key];
    }
  }
  return require('../../../engine/src/services/openai-codex-oauth-engine');
}

function writeSecrets(filePath, codexToken) {
  fs.writeFileSync(filePath, `providers:\n  openai-codex:\n    apiKey: "${codexToken}"\n`);
}

async function withHarness(fn) {
  const saved = {};
  for (const key of ['HOME23_SECRETS_PATH', 'OPENAI_CODEX_AUTH_TOKEN', 'OPENAI_OAUTH_TOKEN', 'OPENAI_API_KEY']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-codex-'));
  const secretsPath = path.join(dir, 'secrets.yaml');
  process.env.HOME23_SECRETS_PATH = secretsPath;
  const oldFetch = global.fetch;
  try {
    return await fn({ secretsPath });
  } finally {
    global.fetch = oldFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function okStreamResponse(text) {
  return {
    ok: true,
    body: {
      getReader() {
        const chunks = [
          Buffer.from(`data: {"type":"response.output_text.delta","delta":"${text}"}\n\n`),
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
}

test('the fresh file token wins over the env frozen at boot', async () => {
  await withHarness(async ({ secretsPath }) => {
    process.env.OPENAI_CODEX_AUTH_TOKEN = futureJwt('frozen-env');
    const fileToken = futureJwt('live-file');
    writeSecrets(secretsPath, fileToken);

    const { getOpenAICodexCredentials } = freshModules();
    const credentials = getOpenAICodexCredentials();

    assert.equal(credentials.accessToken, fileToken);
    assert.equal(credentials.isOAuth, true);
  });
});

test('a 401 spends exactly one force-fresh retry with the reread token', async () => {
  await withHarness(async ({ secretsPath }) => {
    const revoked = futureJwt('revoked');
    const rotated = futureJwt('rotated');
    writeSecrets(secretsPath, revoked);

    const { OpenAICodexClient } = freshModules();
    const authorizations = [];
    global.fetch = async (url, options = {}) => {
      authorizations.push(options.headers.Authorization);
      if (authorizations.length === 1) {
        // The mirror lands the rotation while this request is failing —
        // inside the resolver's check window, so only force can see it.
        writeSecrets(secretsPath, rotated);
        return { ok: false, status: 401, text: async () => 'unauthorized' };
      }
      return okStreamResponse('recovered');
    };

    const client = new OpenAICodexClient({}, null);
    const result = await client.generate({ model: 'gpt-5.5', input: 'hello' });

    assert.equal(result.content, 'recovered');
    assert.deepEqual(authorizations, [`Bearer ${revoked}`, `Bearer ${rotated}`]);
  });
});

test('a second 401 propagates instead of looping', async () => {
  await withHarness(async ({ secretsPath }) => {
    writeSecrets(secretsPath, futureJwt('dead'));

    const { OpenAICodexClient } = freshModules();
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return { ok: false, status: 401, text: async () => 'still unauthorized' };
    };

    const client = new OpenAICodexClient({}, null);
    await assert.rejects(
      () => client.generate({ model: 'gpt-5.5', input: 'hello' }),
      /OpenAI Codex 401/
    );
    assert.equal(calls, 2);
  });
});

test('a non-auth failure does not trigger the credential retry', async () => {
  await withHarness(async ({ secretsPath }) => {
    writeSecrets(secretsPath, futureJwt('healthy'));

    const { OpenAICodexClient } = freshModules();
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return { ok: false, status: 500, text: async () => 'server exploded' };
    };

    const client = new OpenAICodexClient({}, null);
    await assert.rejects(
      () => client.generate({ model: 'gpt-5.5', input: 'hello' }),
      /OpenAI Codex 500/
    );
    assert.equal(calls, 1);
  });
});
