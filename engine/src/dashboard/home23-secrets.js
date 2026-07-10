'use strict';

const {
  updateHome23Secrets,
} = require('../../../shared/home23-secrets.cjs');

function updateSettingsSecrets(home23Root, mutator, options = {}) {
  return updateHome23Secrets(home23Root, mutator, options);
}

async function updateDashboardOAuthTokenSecrets(home23Root, provider, token, options = {}) {
  const providerName = String(provider || '').trim();
  const nextToken = String(token || '').trim();
  if (!providerName || !nextToken) {
    const error = new Error('oauth_secret_update_invalid');
    error.code = 'oauth_secret_update_invalid';
    throw error;
  }

  return updateSettingsSecrets(home23Root, (secrets) => {
    if (!secrets.providers || typeof secrets.providers !== 'object') secrets.providers = {};
    if (!secrets.providers[providerName] || typeof secrets.providers[providerName] !== 'object') {
      secrets.providers[providerName] = {};
    }
    const current = secrets.providers[providerName];
    const previousToken = current.apiKey || '';
    const changed = previousToken !== nextToken || current.oauthManaged !== true;
    if (changed) {
      current.apiKey = nextToken;
      current.oauthManaged = true;
    }
    return {
      changed,
      value: {
        previousToken,
        rotated: previousToken !== nextToken,
      },
    };
  }, options);
}

module.exports = {
  updateDashboardOAuthTokenSecrets,
  updateSettingsSecrets,
};
