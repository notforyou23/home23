'use strict';

/**
 * getOpenAIClient must resolve its key at use — secrets.yaml first, env
 * floor second — and rebuild its cached client when the resolved key
 * changes. OpenAI keys are static pins in practice, but a file-only host
 * (no env at all) must still get a working client.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/engine/src/core/openai-client.js')
      || key.includes('/engine/src/core/provider-credentials.js')) {
      delete require.cache[key];
    }
  }
  return require('../../../engine/src/core/openai-client');
}

function credentialsModule() {
  return require('../../../engine/src/core/provider-credentials');
}

function writeSecrets(filePath, openaiKey) {
  fs.writeFileSync(filePath, `providers:\n  openai:\n    apiKey: "${openaiKey}"\n`);
}

async function withHarness(fn) {
  const saved = {};
  for (const key of ['HOME23_SECRETS_PATH', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-openai-'));
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

test('a file-only host gets a working client with no env at all', async () => {
  await withHarness(async ({ secretsPath }) => {
    writeSecrets(secretsPath, 'sk-proj-file-only');
    const { getOpenAIClient } = freshModules();
    const client = getOpenAIClient();
    assert.equal(client.apiKey, 'sk-proj-file-only');
  });
});

test('the cached client is rebuilt when the resolved key changes', async () => {
  await withHarness(async ({ secretsPath }) => {
    writeSecrets(secretsPath, 'sk-proj-first');
    const { getOpenAIClient } = freshModules();
    const first = getOpenAIClient();
    assert.equal(first.apiKey, 'sk-proj-first');

    writeSecrets(secretsPath, 'sk-proj-second');
    credentialsModule()._resetCredentialCache(); // stand-in for the 15s window elapsing

    const second = getOpenAIClient();
    assert.equal(second.apiKey, 'sk-proj-second');
    assert.notEqual(second, first);

    // Unchanged key keeps the cached instance.
    assert.equal(getOpenAIClient(), second);
  });
});

test('no key anywhere still throws the operator-facing error', async () => {
  await withHarness(async () => {
    const { getOpenAIClient } = freshModules();
    assert.throws(() => getOpenAIClient(), /OPENAI_API_KEY/);
  });
});
