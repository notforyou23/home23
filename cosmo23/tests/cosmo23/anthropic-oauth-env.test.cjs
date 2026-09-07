const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getAnthropicApiKey,
} = require('../../engine/src/services/anthropic-oauth-engine.js');

test('cosmo23 engine uses Home23 ANTHROPIC_AUTH_TOKEN before OAuth DB lookup', async () => {
  const previousAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  const previousOauthOnly = process.env.ANTHROPIC_OAUTH_ONLY;

  process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-oauth-home23-test-token';
  delete process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_OAUTH_ONLY = 'true';

  try {
    const credentials = await getAnthropicApiKey();

    assert.equal(credentials.authToken, 'sk-ant-oauth-home23-test-token');
    assert.equal(credentials.isOAuth, true);
    assert.equal(credentials.source, 'env');
    assert.equal(credentials.defaultHeaders['anthropic-dangerous-direct-browser-access'], 'true');
  } finally {
    if (previousAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = previousAuthToken;

    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousApiKey;

    if (previousOauthOnly === undefined) delete process.env.ANTHROPIC_OAUTH_ONLY;
    else process.env.ANTHROPIC_OAUTH_ONLY = previousOauthOnly;
  }
});
