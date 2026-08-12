'use strict';

/**
 * getAnthropicApiKey must resolve at use from secrets.yaml — not from the
 * process env frozen at boot. The env stays as the floor for credential-free
 * hosts. This is the engine-side kill of the token-rotation class.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/engine/src/services/anthropic-oauth-engine.js')
      || key.includes('/engine/src/core/provider-credentials.js')) {
      delete require.cache[key];
    }
  }
  return require('../../../engine/src/services/anthropic-oauth-engine');
}

function writeSecrets(filePath, providers) {
  const lines = ['providers:'];
  for (const [name, key] of Object.entries(providers)) {
    lines.push(`  ${name}:`);
    lines.push(`    apiKey: "${key}"`);
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

async function withHarness(fn) {
  const saved = {
    HOME23_SECRETS_PATH: process.env.HOME23_SECRETS_PATH,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-oauth-'));
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

test('the fresh file token wins over the env frozen at boot', async () => {
  await withHarness(async ({ secretsPath }) => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-oat01-frozen-at-boot';
    writeSecrets(secretsPath, { anthropic: 'sk-ant-oat01-live-rotation' });

    const { getAnthropicApiKey } = freshModules();
    const credentials = await getAnthropicApiKey();

    assert.equal(credentials.isOAuth, true);
    assert.equal(credentials.authToken, 'sk-ant-oat01-live-rotation');
    assert.ok(credentials.defaultHeaders['user-agent'].includes('claude-cli'));
  });
});

test('a static API key in the file resolves to API-key mode', async () => {
  await withHarness(async ({ secretsPath }) => {
    writeSecrets(secretsPath, { anthropic: 'sk-ant-api03-static-key' });

    const { getAnthropicApiKey } = freshModules();
    const credentials = await getAnthropicApiKey();

    assert.equal(credentials.isOAuth, false);
    assert.equal(credentials.apiKey, 'sk-ant-api03-static-key');
  });
});

test('env remains the floor when the file has no anthropic entry', async () => {
  await withHarness(async ({ secretsPath }) => {
    writeSecrets(secretsPath, { xai: 'xai-something-else' });
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-oat01-env-floor';

    const { getAnthropicApiKey } = freshModules();
    const credentials = await getAnthropicApiKey();

    assert.equal(credentials.isOAuth, true);
    assert.equal(credentials.authToken, 'sk-ant-oat01-env-floor');
  });
});

test('force rereads the file inside the cache window (the auth-failure path)', async () => {
  await withHarness(async ({ secretsPath }) => {
    writeSecrets(secretsPath, { anthropic: 'sk-ant-oat01-before-revoke' });

    const oauthEngine = freshModules();
    const first = await oauthEngine.getAnthropicApiKey();
    assert.equal(first.authToken, 'sk-ant-oat01-before-revoke');

    writeSecrets(secretsPath, { anthropic: 'sk-ant-oat01-after-revoke' });
    const cached = await oauthEngine.getAnthropicApiKey();
    assert.equal(cached.authToken, 'sk-ant-oat01-before-revoke');

    const forced = await oauthEngine.getAnthropicApiKey(true);
    assert.equal(forced.authToken, 'sk-ant-oat01-after-revoke');
  });
});

test('no credentials anywhere still fails with the operator-facing message', async () => {
  await withHarness(async () => {
    const { getAnthropicApiKey } = freshModules();
    await assert.rejects(
      () => getAnthropicApiKey(),
      /No Anthropic credentials/
    );
  });
});
