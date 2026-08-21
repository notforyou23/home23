const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getAnthropicApiKey,
  selectAnthropicCredentialSource,
  _setTokenReadersForTests,
  _resetOAuthEngineForTests,
} = require('../../cosmo23/engine/src/services/anthropic-oauth-engine.js');

test('Cosmo Setup OAuth wins over Home23 PM2 ANTHROPIC_AUTH_TOKEN', async () => {
  const previousAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  const previousOauthOnly = process.env.ANTHROPIC_OAUTH_ONLY;

  process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-oauth-pm2-revoked';
  delete process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_OAUTH_ONLY = 'true';
  _resetOAuthEngineForTests();
  _setTokenReadersForTests({
    prisma: async () => ({
      token: 'sk-ant-oauth-setup-live',
      refreshToken: null,
      expiresAt: Date.now() + 60000,
    }),
    sqlite: async () => null,
    server: async () => null,
  });

  try {
    assert.equal(selectAnthropicCredentialSource({
      setup: { token: 'sk-ant-oauth-setup-live' },
      env: { authToken: 'sk-ant-oauth-pm2-revoked' },
    }), 'setup');

    const credentials = await getAnthropicApiKey();

    assert.equal(credentials.authToken, 'sk-ant-oauth-setup-live');
    assert.equal(credentials.source, 'setup');
    assert.equal(credentials.isOAuth, true);
    assert.equal(credentials.defaultHeaders['anthropic-dangerous-direct-browser-access'], 'true');
  } finally {
    _resetOAuthEngineForTests();
    if (previousAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = previousAuthToken;

    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousApiKey;

    if (previousOauthOnly === undefined) delete process.env.ANTHROPIC_OAUTH_ONLY;
    else process.env.ANTHROPIC_OAUTH_ONLY = previousOauthOnly;
  }
});
