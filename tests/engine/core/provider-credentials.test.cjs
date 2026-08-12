'use strict';

/**
 * Engine-side provider credential resolution — the port of
 * src/agent/provider-credentials.ts (commit 159703ef) into the engine.
 *
 * The disease class: credentials distributed by value (frozen process env at
 * boot), so rotation requires restart lists. The cure: resolve at use from
 * config/secrets.yaml with an mtime-checked cache and a force-reread path.
 * Managed OAuth tokens (sk-ant-oat*, codex JWTs) are always resolved fresh;
 * a configured static key is a deliberate pin and respected as configured.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODULE_PATH = '../../../engine/src/core/provider-credentials';

const ENV_KEYS = [
  'HOME23_SECRETS_PATH',
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY', 'XAI_API_KEY', 'MINIMAX_API_KEY',
  'OLLAMA_CLOUD_API_KEY', 'GROQ_API_KEY', 'HF_TOKEN', 'HUGGINGFACE_TOKEN',
  'OPENAI_CODEX_AUTH_TOKEN', 'OPENAI_OAUTH_TOKEN',
];

function futureJwt(marker = 'fresh') {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: marker,
  })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function writeSecrets(filePath, providers) {
  const lines = ['providers:'];
  for (const [name, key] of Object.entries(providers)) {
    lines.push(`  ${name}:`);
    lines.push(`    apiKey: "${key}"`);
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

/** Run fn with a hermetic env: temp secrets file, provider env vars cleared. */
function withHarness(fn) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-creds-'));
  const secretsPath = path.join(dir, 'secrets.yaml');
  process.env.HOME23_SECRETS_PATH = secretsPath;

  const creds = require(MODULE_PATH);
  creds._resetCredentialCache();
  try {
    return fn({ creds, secretsPath });
  } finally {
    creds._resetCredentialCache();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('freshProviderKey reads the provider key from secrets.yaml', () => {
  withHarness(({ creds, secretsPath }) => {
    writeSecrets(secretsPath, { anthropic: 'sk-ant-oat01-fresh-from-file' });
    assert.equal(creds.freshProviderKey('anthropic'), 'sk-ant-oat01-fresh-from-file');
  });
});

test('freshProviderKey returns empty string when the file is absent, and never throws', () => {
  withHarness(({ creds }) => {
    assert.equal(creds.freshProviderKey('anthropic'), '');
  });
});

test('a configured static key is a deliberate pin and wins over the file', () => {
  withHarness(({ creds, secretsPath }) => {
    writeSecrets(secretsPath, { xai: 'xai-file-value' });
    assert.equal(creds.resolveProviderKey('xai', 'xai-pinned-static'), 'xai-pinned-static');
  });
});

test('a configured sk-ant-oat* token is managed, not a pin — the file wins', () => {
  withHarness(({ creds, secretsPath }) => {
    writeSecrets(secretsPath, { anthropic: 'sk-ant-oat01-rotated' });
    assert.equal(
      creds.resolveProviderKey('anthropic', 'sk-ant-oat01-stale-configured'),
      'sk-ant-oat01-rotated'
    );
  });
});

test('a configured codex OAuth JWT is managed, not a pin — the file wins', () => {
  withHarness(({ creds, secretsPath }) => {
    const rotated = futureJwt('rotated');
    writeSecrets(secretsPath, { 'openai-codex': rotated });
    assert.equal(
      creds.resolveProviderKey('openai-codex', futureJwt('stale')),
      rotated
    );
  });
});

test('env is the floor: used when the file and configured value are absent', () => {
  withHarness(({ creds }) => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-oat01-env-floor';
    assert.equal(creds.resolveProviderKey('anthropic'), 'sk-ant-oat01-env-floor');

    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api-second-floor';
    assert.equal(creds.resolveProviderKey('anthropic'), 'sk-ant-api-second-floor');
  });
});

test('env floor covers the engine-only providers (codex, groq, huggingface)', () => {
  withHarness(({ creds }) => {
    const envJwt = futureJwt('env');
    process.env.OPENAI_CODEX_AUTH_TOKEN = envJwt;
    process.env.GROQ_API_KEY = 'gsk-groq-env';
    process.env.HUGGINGFACE_TOKEN = 'hf-env-token';
    assert.equal(creds.resolveProviderKey('openai-codex'), envJwt);
    assert.equal(creds.resolveProviderKey('groq'), 'gsk-groq-env');
    assert.equal(creds.resolveProviderKey('huggingface'), 'hf-env-token');
  });
});

test('a fresh file value beats the env floor', () => {
  withHarness(({ creds, secretsPath }) => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-oat01-frozen-env';
    writeSecrets(secretsPath, { anthropic: 'sk-ant-oat01-live-file' });
    assert.equal(creds.resolveProviderKey('anthropic'), 'sk-ant-oat01-live-file');
  });
});

test('an unknown provider with nothing configured resolves to empty string', () => {
  withHarness(({ creds }) => {
    assert.equal(creds.resolveProviderKey('no-such-provider'), '');
  });
});

test('within the check window the cache serves; force rereads immediately', () => {
  withHarness(({ creds, secretsPath }) => {
    writeSecrets(secretsPath, { anthropic: 'sk-ant-oat01-before' });
    assert.equal(creds.resolveProviderKey('anthropic'), 'sk-ant-oat01-before');

    writeSecrets(secretsPath, { anthropic: 'sk-ant-oat01-after' });
    // Non-forced read inside the 15s check window: cached value.
    assert.equal(creds.resolveProviderKey('anthropic'), 'sk-ant-oat01-before');
    // Forced read (the auth-failure path): fresh value.
    assert.equal(creds.resolveProviderKey('anthropic', undefined, true), 'sk-ant-oat01-after');
  });
});

test('_resetCredentialCache drops the cache so the next read is fresh', () => {
  withHarness(({ creds, secretsPath }) => {
    writeSecrets(secretsPath, { anthropic: 'sk-ant-oat01-one' });
    assert.equal(creds.freshProviderKey('anthropic'), 'sk-ant-oat01-one');
    writeSecrets(secretsPath, { anthropic: 'sk-ant-oat01-two' });
    creds._resetCredentialCache();
    assert.equal(creds.freshProviderKey('anthropic'), 'sk-ant-oat01-two');
  });
});

test('isAuthError matches SDK statuses and raw provider bodies', () => {
  withHarness(({ creds }) => {
    assert.equal(creds.isAuthError({ status: 401 }), true);
    assert.equal(creds.isAuthError({ status: 403 }), true);
    assert.equal(creds.isAuthError(new Error('authentication_error: bad token')), true);
    assert.equal(creds.isAuthError(new Error('This token has been revoked')), true);
    // The same failure, three provider spellings — all must match.
    assert.equal(creds.isAuthError(new Error('invalid api key provided')), true);
    assert.equal(creds.isAuthError(new Error('invalid_api_key')), true);
    assert.equal(creds.isAuthError(new Error('invalid-api-key')), true);
    assert.equal(creds.isAuthError(new Error('OpenAI Codex 401: unauthorized')), true);
    assert.equal(creds.isAuthError(new Error('rate limit exceeded')), false);
    assert.equal(creds.isAuthError({ status: 500 }), false);
    assert.equal(creds.isAuthError(new Error('ECONNRESET')), false);
  });
});
