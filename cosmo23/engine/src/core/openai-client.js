const OpenAI = require('openai');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from local .env file
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

let cachedClient;

// OAuth state — only active when OPENAI_OAUTH_ENABLED=true
let isOAuthMode = false;
let credentialsFetchedAt = 0;

/**
 * Self-contained OpenAI client for Phase 2B
 * Replaces dependency on external cosmo backend.
 *
 * OAuth mode: Set OPENAI_OAUTH_ENABLED=true + run: node engine/import-oauth-openai.js
 * When OAuth is active, the JWT Bearer token is passed as apiKey to the OpenAI SDK.
 * The SDK sends it as Authorization: Bearer <jwt> which OpenAI accepts for OAuth tokens.
 * No base URL override is needed — api.openai.com/v1 accepts JWT Bearer tokens directly.
 */
function getOpenAIClient() {
  if (!cachedClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    const baseURL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }

    cachedClient = new OpenAI({
      apiKey,
      baseURL,
    });
  }

  return cachedClient;
}

/**
 * Initialize OpenAI client using OAuth token from database.
 * Non-blocking — called at startup and on 30-min background interval.
 * Falls back to API key mode silently if OAuth not configured.
 */
async function initOpenAIClientOAuth() {
  if (process.env.OPENAI_OAUTH_ENABLED !== 'true') return;

  try {
    const { getOpenAIApiKey } = require('../services/openai-oauth-engine');
    const credentials = await getOpenAIApiKey();
    const baseURL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

    isOAuthMode = credentials.isOAuth;
    credentialsFetchedAt = Date.now();
    cachedClient = new OpenAI({ apiKey: credentials.apiKey, baseURL });

    if (credentials.isOAuth) {
      console.log('[OpenAI-Client] Initialized with OAuth JWT token');
    }
  } catch (err) {
    // OAuth not configured or failed — leave cachedClient alone, API key will be used
    if (process.env.OPENAI_OAUTH_ONLY === 'true') {
      console.error('[OpenAI-Client] OAuth-only mode but init failed:', err.message);
      throw err;
    }
    // Silently fall back
  }
}

/**
 * Async getter — refreshes OAuth credentials if >50 min old.
 * Used by GPT5Client._getClient() before each generate() call.
 */
async function getOpenAIClientAsync() {
  if (isOAuthMode && credentialsFetchedAt > 0) {
    const age = Date.now() - credentialsFetchedAt;
    if (age > 50 * 60 * 1000) { // >50 minutes
      await initOpenAIClientOAuth();
    }
  }
  return getOpenAIClient();
}

/**
 * Get OpenAI configuration for debugging
 */
function getOpenAIConfig() {
  return {
    apiKey: process.env.OPENAI_API_KEY ? '[REDACTED]' : 'NOT SET',
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
    oauthEnabled: process.env.OPENAI_OAUTH_ENABLED === 'true',
    oauthMode: isOAuthMode,
    envFile: path.join(__dirname, '..', '..', '.env'),
  };
}

// Non-blocking OAuth init at module load time (only when OPENAI_OAUTH_ENABLED=true)
if (process.env.OPENAI_OAUTH_ENABLED === 'true') {
  initOpenAIClientOAuth().catch((err) => {
    console.error('[OpenAI-Client] Startup OAuth init failed:', err.message);
  });

  // Background refresh every 30 minutes to avoid mid-request expiry
  setInterval(() => {
    initOpenAIClientOAuth().catch((err) => {
      console.error('[OpenAI-Client] Background OAuth refresh failed:', err.message);
    });
  }, 30 * 60 * 1000);
}

module.exports = {
  getOpenAIClient,
  getOpenAIClientAsync,
  initOpenAIClientOAuth,
  getOpenAIConfig,
};
