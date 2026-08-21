const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getAnthropicApiKey,
  _setTokenReadersForTests,
  _resetOAuthEngineForTests,
} = require('../../cosmo23/engine/src/services/anthropic-oauth-engine.js');

test('cosmo23 engine uses Home23 ANTHROPIC_AUTH_TOKEN when Setup has no token', async () => {
  const previousAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  const previousOauthOnly = process.env.ANTHROPIC_OAUTH_ONLY;

  process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-oauth-home23-test-token';
  delete process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_OAUTH_ONLY = 'true';
  _setTokenReadersForTests({
    prisma: async () => null,
    sqlite: async () => null,
    server: async () => null,
  });

  try {
    const credentials = await getAnthropicApiKey();

    assert.equal(credentials.authToken, 'sk-ant-oauth-home23-test-token');
    assert.equal(credentials.isOAuth, true);
    assert.equal(credentials.source, 'env');
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
