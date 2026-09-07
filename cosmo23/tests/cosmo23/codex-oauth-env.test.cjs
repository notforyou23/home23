const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getCodexCredentials,
} = require('../../engine/src/services/codex-oauth-engine.js');

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

test('cosmo23 engine uses Home23 OPENAI_CODEX_AUTH_TOKEN before OAuth DB lookup', async () => {
  const previous = {
    OPENAI_CODEX_AUTH_TOKEN: process.env.OPENAI_CODEX_AUTH_TOKEN,
    OPENAI_CODEX_ACCESS_TOKEN: process.env.OPENAI_CODEX_ACCESS_TOKEN,
    OPENAI_CODEX_API_KEY: process.env.OPENAI_CODEX_API_KEY,
    CODEX_AUTH_TOKEN: process.env.CODEX_AUTH_TOKEN,
    OPENAI_CODEX_ACCOUNT_ID: process.env.OPENAI_CODEX_ACCOUNT_ID,
    OPENAI_CODEX_EXPIRES_AT: process.env.OPENAI_CODEX_EXPIRES_AT,
    DATABASE_URL: process.env.DATABASE_URL,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  };

  const expiresAt = Date.now() + 60 * 60 * 1000;
  const token = makeJwt({
    exp: Math.floor(expiresAt / 1000),
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct_home23_test'
    }
  });

  process.env.OPENAI_CODEX_AUTH_TOKEN = token;
  delete process.env.OPENAI_CODEX_ACCESS_TOKEN;
  delete process.env.OPENAI_CODEX_API_KEY;
  delete process.env.CODEX_AUTH_TOKEN;
  delete process.env.OPENAI_CODEX_ACCOUNT_ID;
  delete process.env.OPENAI_CODEX_EXPIRES_AT;
  delete process.env.DATABASE_URL;
  delete process.env.ENCRYPTION_KEY;

  try {
    const credentials = await getCodexCredentials();

    assert.equal(credentials.accessToken, token);
    assert.equal(credentials.accountId, 'acct_home23_test');
    assert.ok(credentials.expiresAt <= expiresAt);
    assert.ok(credentials.expiresAt > Date.now());
    assert.equal(credentials.source, 'env');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
