/**
 * Anthropic Auth Module — Simplified for COSMO Home 2.3
 *
 * Supports:
 * 1. OAuth token via ANTHROPIC_AUTH_TOKEN env var (from OpenClaw)
 * 2. API key fallback via ANTHROPIC_API_KEY env var
 *
 * The full PKCE OAuth flow from cosmo_2.3 is not needed here —
 * we import the token from OpenClaw's auth-profiles.
 */

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
  return {
    'accept': 'application/json',
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11',
    'user-agent': `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
    'x-app': 'cli'
  };
}

/**
 * Get Anthropic credentials — OAuth token or API key
 * Checks env vars. No database, no PKCE flow.
 */
async function getAnthropicApiKey() {
  // 1. OAuth token (preferred)
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (authToken && isOAuthToken(authToken)) {
    console.log('[OAuth-Engine] Using OAuth token (stealth mode)');
    return {
      authToken: authToken,
      defaultHeaders: getStealthHeaders(),
      dangerouslyAllowBrowser: true,
      isOAuth: true
    };
  }

  // 2. API key fallback
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && apiKey.length > 0) {
    console.log('[OAuth-Engine] Using API key from env');
    return {
      apiKey: apiKey,
      isOAuth: false
    };
  }

  throw new Error('No Anthropic credentials. Set ANTHROPIC_AUTH_TOKEN (OAuth) or ANTHROPIC_API_KEY');
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
