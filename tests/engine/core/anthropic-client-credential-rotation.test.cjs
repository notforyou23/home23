'use strict';

/**
 * AnthropicClient must resolve its credential at use: rebuild the SDK client
 * when secrets.yaml rotates, and spend exactly one force-fresh retry on an
 * auth failure. No restart lists, no frozen env.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshAnthropicClient() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/engine/src/core/anthropic-client.js')
      || key.includes('/engine/src/services/anthropic-oauth-engine.js')
      || key.includes('/engine/src/core/provider-credentials.js')) {
      delete require.cache[key];
    }
  }
  return require('../../../engine/src/core/anthropic-client');
}

function credentialsModule() {
  return require('../../../engine/src/core/provider-credentials');
}

function writeSecrets(filePath, anthropicKey) {
  fs.writeFileSync(filePath, `providers:\n  anthropic:\n    apiKey: "${anthropicKey}"\n`);
}

/** A minimal message stream the client's stream reader accepts. */
function fakeStream(text) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_start', message: { id: 'msg_test', model: 'claude-test', usage: { input_tokens: 1 } } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
      yield { type: 'message_stop' };
    },
  };
}

async function withHarness(fn) {
  const saved = {
    HOME23_SECRETS_PATH: process.env.HOME23_SECRETS_PATH,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-anthropic-'));
  const secretsPath = path.join(dir, 'secrets.yaml');
  process.env.HOME23_SECRETS_PATH = secretsPath;
  try {
    return await fn({ secretsPath });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Install a recording SDK factory on the client. Each built SDK remembers
 * the credential it was built with; behavior comes from `plan[credential]`. */
function stubSdkFactory(client, plan) {
  const built = [];
  client._createSdkClient = (credentials) => {
    const credential = credentials.authToken || credentials.apiKey;
    built.push(credential);
    return {
      _credential: credential,
      messages: {
        stream(params) {
          const behavior = plan[credential];
          if (!behavior) throw new Error(`no plan for credential ${credential}`);
          if (behavior.throwAlways) throw behavior.throwAlways;
          if (behavior.thenThrow && behavior.calls >= 1) throw behavior.thenThrow;
          behavior.calls = (behavior.calls || 0) + 1;
          behavior.lastParams = params;
          return fakeStream(behavior.text || 'ok');
        },
      },
    };
  };
  return built;
}

test('the SDK client is rebuilt when the file credential rotates', async () => {
  await withHarness(async ({ secretsPath }) => {
    writeSecrets(secretsPath, 'sk-ant-oat01-generation-one');
    const AnthropicClient = freshAnthropicClient();
    const client = new AnthropicClient({}, null);
    const built = stubSdkFactory(client, {
      'sk-ant-oat01-generation-one': { text: 'from one' },
      'sk-ant-oat01-generation-two': { text: 'from two' },
    });

    const first = await client.generate({ input: 'hello', model: 'claude-test' });
    assert.equal(first.content, 'from one');

    writeSecrets(secretsPath, 'sk-ant-oat01-generation-two');
    credentialsModule()._resetCredentialCache(); // stand-in for the 15s window elapsing

    const second = await client.generate({ input: 'hello again', model: 'claude-test' });
    assert.equal(second.content, 'from two');
    assert.deepEqual(built, ['sk-ant-oat01-generation-one', 'sk-ant-oat01-generation-two']);
  });
});

test('an auth failure spends exactly one force-fresh retry with the reread credential', async () => {
  await withHarness(async ({ secretsPath }) => {
    writeSecrets(secretsPath, 'sk-ant-oat01-revoked');
    const AnthropicClient = freshAnthropicClient();
    const client = new AnthropicClient({}, null);

    const authError = new Error('authentication_error: token has been revoked');
    authError.status = 401;
    const built = stubSdkFactory(client, {
      'sk-ant-oat01-revoked': { text: 'pre-rotation ok', thenThrow: authError },
      'sk-ant-oat01-rotated': { text: 'recovered' },
    });

    // Build the client while the old token is still valid...
    const before = await client.generate({ input: 'hello', model: 'claude-test' });
    assert.equal(before.content, 'pre-rotation ok');

    // ...then the rotation lands in the file. The resolver cache is inside
    // its check window, so the cheap pre-call check still sees the old
    // token: only the auth failure's forced reread can find the new one.
    writeSecrets(secretsPath, 'sk-ant-oat01-rotated');

    const result = await client.generate({ input: 'hello again', model: 'claude-test' });
    assert.equal(result.content, 'recovered');
    assert.equal(result.hadError, false);
    assert.deepEqual(built, ['sk-ant-oat01-revoked', 'sk-ant-oat01-rotated']);
  });
});

test('a second auth failure surfaces the error response instead of looping', async () => {
  await withHarness(async ({ secretsPath }) => {
    writeSecrets(secretsPath, 'sk-ant-oat01-dead');
    const AnthropicClient = freshAnthropicClient();
    const client = new AnthropicClient({}, null);

    const authError = new Error('authentication_error: token has been revoked');
    authError.status = 401;
    const built = stubSdkFactory(client, {
      'sk-ant-oat01-dead': { throwAlways: authError },
    });

    const result = await client.generate({ input: 'hello', model: 'claude-test' });
    assert.equal(result.hadError, true);
    assert.match(result.content, /token has been revoked/);
    // One initial build + one forced rebuild — never a third.
    assert.deepEqual(built, ['sk-ant-oat01-dead', 'sk-ant-oat01-dead']);
  });
});

test('a non-auth failure does not trigger the credential retry', async () => {
  await withHarness(async ({ secretsPath }) => {
    writeSecrets(secretsPath, 'sk-ant-oat01-healthy');
    const AnthropicClient = freshAnthropicClient();
    const client = new AnthropicClient({}, null);

    const built = stubSdkFactory(client, {
      'sk-ant-oat01-healthy': { throwAlways: new Error('overloaded_error: try later') },
    });

    const result = await client.generate({ input: 'hello', model: 'claude-test' });
    assert.equal(result.hadError, true);
    assert.deepEqual(built, ['sk-ant-oat01-healthy']);
  });
});
