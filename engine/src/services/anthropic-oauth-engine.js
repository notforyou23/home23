/**
 * Anthropic Auth Module — Simplified for COSMO Home 2.3
 *
 * Credentials resolve AT USE TIME from config/secrets.yaml (the file the
 * OAuth mirror keeps fresh), via the shared provider-credentials resolver.
 * ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY remain the env floor for
 * credential-free hosts. Pass force=true after an auth failure to drop the
 * resolver cache and reread the file.
 *
 * The full PKCE OAuth flow from cosmo_2.3 is not needed here —
 * the token is mirrored into secrets.yaml by the dashboard's OAuth sync.
 */

const { resolveProviderKey } = require('../core/provider-credentials');

// Claude Code version for stealth mode headers
const CLAUDE_CODE_VERSION = '2.1.32';

/**
 * Detect if a token is an OAuth token
 */
function isOAuthToken(token) {
  return token && (token.includes('sk-ant-oauth') || token.includes('sk-ant-oat'));
}

/**
 * Get stealth headers for OAuth mode
 * Required to make OAuth tokens work with Anthropic API
 */
function getStealthHeaders() {
  // Beta string single-sourced from unified-client (P2-18) — the two engine
  // copies drifted only by luck before.
  const { ANTHROPIC_OAUTH_BETA } = require('../core/unified-client');
  return {
    'accept': 'application/json',
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-beta': ANTHROPIC_OAUTH_BETA,
    'user-agent': `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
    'x-app': 'cli'
  };
}

/**
 * Get Anthropic credentials — OAuth token or API key
 * Resolves at use: secrets.yaml first, env floor second. No database, no
 * PKCE flow. `force` drops the resolver cache (the auth-failure path).
 */
async function getAnthropicApiKey(force = false) {
  const key = resolveProviderKey('anthropic', undefined, force);

  if (key && isOAuthToken(key)) {
    console.log('[OAuth-Engine] Using OAuth token (stealth mode)');
    return {
      authToken: key,
      defaultHeaders: getStealthHeaders(),
      dangerouslyAllowBrowser: true,
      isOAuth: true
    };
  }

  if (key && key.length > 0) {
    console.log('[OAuth-Engine] Using API key');
    return {
      apiKey: key,
      isOAuth: false
    };
  }

  throw new Error('No Anthropic credentials. Set providers.anthropic.apiKey in config/secrets.yaml, or ANTHROPIC_AUTH_TOKEN (OAuth) / ANTHROPIC_API_KEY in the environment');
}

/**
 * Prepare system prompt for OAuth mode
 * OAuth tokens require "You are Claude Code..." prefix
 */
function prepareSystemPrompt(systemPrompt, isOAuth) {
  if (!isOAuth) {
    return systemPrompt;
  }

  const claudeCodePrompt = {
    type: 'text',
    text: "You are Claude Code, Anthropic's official CLI for Claude.",
    cache_control: { type: 'ephemeral' }
  };

  if (!systemPrompt) {
    return [claudeCodePrompt];
  }

  if (typeof systemPrompt === 'string') {
    return [
      claudeCodePrompt,
      { type: 'text', text: systemPrompt }
    ];
  }

  if (Array.isArray(systemPrompt)) {
    return [claudeCodePrompt, ...systemPrompt];
  }

  return [claudeCodePrompt];
}

module.exports = {
  getAnthropicApiKey,
  prepareSystemPrompt,
  isOAuthToken,
  getStealthHeaders,
};
