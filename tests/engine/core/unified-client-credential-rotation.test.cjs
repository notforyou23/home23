'use strict';

/**
 * UnifiedClient (the cognitive loop's model client) must resolve provider
 * credentials at use — secrets.yaml first, env floor second — rebuild its
 * Anthropic SDK client when the file rotates, and spend exactly one
 * force-fresh retry on an auth failure.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshUnifiedClient() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/engine/src/core/unified-client.js')
      || key.includes('/engine/src/core/gpt5-client.js')
      || key.includes('/engine/src/core/openai-client.js')
      || key.includes('/engine/src/services/openai-codex-oauth-engine.js')
      || key.includes('/engine/src/core/provider-credentials.js')) {
      delete require.cache[key];
    }
  }
  return require('../../../engine/src/core/unified-client');
}

function credentialsModule() {
  return require('../../../engine/src/core/provider-credentials');
}

function writeSecrets(filePath, anthropicKey) {
  fs.writeFileSync(filePath, `providers:\n  anthropic:\n    apiKey: "${anthropicKey}"\n`);
}

function fakeSdk(credential, plan) {
  return {
    _credential: credential,
    messages: {
      async create(payload) {
        const behavior = plan[credential];
        if (!behavior) throw new Error(`no plan for credential ${credential}`);
        if (behavior.throwAlways) throw behavior.throwAlways;
        behavior.calls = (behavior.calls || 0) + 1;
        behavior.lastPayload = payload;
        return {
          id: 'msg_test',
          model: payload.model,
          content: [{ type: 'text', text: behavior.text || 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  };
}

async function withHarness(fn) {
  const saved = {};
  for (const key of ['HOME23_SECRETS_PATH', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-unified-'));
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

const ANTHROPIC_CONFIG = {
  providers: { anthropic: { enabled: true } },
  modelAssignments: { 'test.think': { provider: 'anthropic', model: 'claude-test' } },
};

test('the constructor resolves the anthropic credential from secrets.yaml with no env at all', async () => {
  await withHarness(async ({ secretsPath }) => {
    writeSecrets(secretsPath, 'sk-ant-oat01-file-only');
    const { UnifiedClient } = freshUnifiedClient();
    const client = new UnifiedClient(ANTHROPIC_CONFIG, null);

    assert.ok(client.anthropic, 'anthropic client should initialize from the file without env vars');
    assert.equal(client._anthropicCredential, 'sk-ant-oat01-file-only');
  });
});

test('generateAnthropic rebuilds the SDK client when the file credential rotates', async () => {
  await withHarness(async ({ secretsPath }) => {
    writeSecrets(secretsPath, 'sk-ant-oat01-old');
    const { UnifiedClient } = freshUnifiedClient();
    const client = new UnifiedClient(ANTHROPIC_CONFIG, null);

    const plan = {
      'sk-ant-oat01-old': { text: 'from old' },
      'sk-ant-oat01-new': { text: 'from new' },
    };
    client._createAnthropicSDK = (credential) => fakeSdk(credential, plan);
    // Put the fake in play for the already-built generation too.
    client.anthropic = fakeSdk('sk-ant-oat01-old', plan);

    const first = await client.generate({
      component: 'test', purpose: 'think', input: 'hello',
    });
    assert.equal(first.content, 'from old');

    writeSecrets(secretsPath, 'sk-ant-oat01-new');
    credentialsModule()._resetCredentialCache(); // stand-in for the 15s window elapsing

    const second = await client.generate({
      component: 'test', purpose: 'think', input: 'hello again',
    });
    assert.equal(second.content, 'from new');
    assert.equal(client._anthropicCredential, 'sk-ant-oat01-new');
  });
});

test('an auth failure spends exactly one force-fresh retry with the reread credential', async () => {
  await withHarness(async ({ secretsPath }) => {
    writeSecrets(secretsPath, 'sk-ant-oat01-revoked');
    const { UnifiedClient } = freshUnifiedClient();
    const client = new UnifiedClient(ANTHROPIC_CONFIG, null);

    const authError = new Error('401 authentication_error: OAuth access token is invalid');
    authError.status = 401;
    const plan = {
      'sk-ant-oat01-revoked': { throwAlways: authError },
      'sk-ant-oat01-rotated': { text: 'recovered' },
    };
    client._createAnthropicSDK = (credential) => fakeSdk(credential, plan);
    client.anthropic = fakeSdk('sk-ant-oat01-revoked', plan);

    // Rotation lands in the file after boot; the resolver cache is inside its
    // check window, so only the auth failure's forced reread can see it.
    writeSecrets(secretsPath, 'sk-ant-oat01-rotated');

    const result = await client.generateAnthropic(
      { provider: 'anthropic', model: 'claude-test' },
      { input: 'hello' }
    );
    assert.equal(result.content, 'recovered');
    assert.equal(client._anthropicCredential, 'sk-ant-oat01-rotated');
  });
});

test('a non-auth failure propagates without touching credentials', async () => {
  await withHarness(async ({ secretsPath }) => {
    writeSecrets(secretsPath, 'sk-ant-oat01-healthy');
    const { UnifiedClient } = freshUnifiedClient();
    const client = new UnifiedClient(ANTHROPIC_CONFIG, null);

    let rebuilds = 0;
    const overloaded = new Error('overloaded_error: try later');
    const plan = { 'sk-ant-oat01-healthy': { throwAlways: overloaded } };
    client._createAnthropicSDK = (credential) => { rebuilds++; return fakeSdk(credential, plan); };
    client.anthropic = fakeSdk('sk-ant-oat01-healthy', plan);

    await assert.rejects(
      () => client.generateAnthropic({ provider: 'anthropic', model: 'claude-test' }, { input: 'hi' }),
      /overloaded_error/
    );
    assert.equal(rebuilds, 0);
  });
});
