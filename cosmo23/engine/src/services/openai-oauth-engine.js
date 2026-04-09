/**
 * OpenAI Auth Module - OAuth Token Management
 *
 * Mirrors anthropic-oauth-engine.js pattern precisely.
 * Imports tokens from evobrew auth-profiles.json (openai-codex:default profile).
 * Falls back to legacy OpenClaw path if evobrew not found.
 *
 * Key differences from Anthropic OAuth:
 * - Token format: JWT (eyJ...) not sk-ant-* prefix
 * - No stealth headers required — OpenAI accepts standard Bearer JWT
 * - No system prompt modification required
 * - Refresh endpoint: https://auth.openai.com/oauth/token
 * - Token passed as apiKey to OpenAI SDK (goes straight to Authorization: Bearer header)
 *
 * Token Import:
 * 1. User authenticates via OpenAI Codex in evobrew (or legacy OpenClaw)
 * 2. Token is stored in ~/.evobrew/auth-profiles.json (or legacy ~/.openclaw/...)
 * 3. Run: node engine/import-oauth-openai.js
 * 4. Set OPENAI_OAUTH_ENABLED=true in .env
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { PrismaClient } = require('@prisma/client');
const { encryptApiKey, decryptApiKey } = require('./encryption');

// Lazy-load Prisma client
let prisma = null;
function getPrisma() {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

// Database key for storing OAuth tokens
const OAUTH_DB_KEY = 'openai_oauth';

// OpenAI OAuth constants (from auth-profiles.json openai-codex:default)
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';

// Auth profiles paths (evobrew primary, openclaw legacy fallback)
const EVOBREW_AUTH_PROFILES = path.join(os.homedir(), '.evobrew', 'auth-profiles.json');
const OPENCLAW_AUTH_PROFILES = path.join(
  os.homedir(),
  '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json'
);

// In-memory cache to avoid DB hits on every request
let tokenCache = null;
let cacheExpiry = 0;

/**
 * Detect if a token is an OpenAI OAuth JWT token.
 * OpenAI OAuth tokens are JWTs (three base64url segments separated by dots).
 * Regular OpenAI API keys start with sk-.
 */
function isOpenAIOAuthToken(token) {
  return (
    token &&
    typeof token === 'string' &&
    token.startsWith('eyJ') &&
    token.split('.').length === 3
  );
}

/**
 * Refresh access token using stored refresh token.
 * Refresh tokens have format: rt_...
 *
 * @param {string} refreshToken - Refresh token from previous auth
 * @returns {Promise<{ accessToken, refreshToken, expiresAt }>}
 */
async function refreshAccessToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      grant_type: 'refresh_token',
      client_id: OPENAI_CLIENT_ID,
      refresh_token: refreshToken,
    });

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(OPENAI_TOKEN_URL, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Token refresh failed: ${res.statusCode} - ${data}`));
          return;
        }
        try {
          const response = JSON.parse(data);
          // Calculate expiry with 5-minute buffer
          const expiresAt = Date.now() + (response.expires_in * 1000) - (5 * 60 * 1000);
          resolve({
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
            expiresAt,
          });
        } catch (error) {
          reject(new Error(`Failed to parse refresh response: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Token refresh request failed: ${error.message}`));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Store token in database (encrypted).
 *
 * @param {string} token - JWT access token
 * @param {number|null} expiresAt - Expiry timestamp in ms (null = no expiry)
 * @param {string|null} refreshToken - Refresh token (rt_...)
 */
async function storeToken(token, expiresAt = null, refreshToken = null) {
  try {
    const db = getPrisma();

    const tokenData = JSON.stringify({
      token,
      refreshToken,
      expiresAt,
      updatedAt: Date.now(),
      type: isOpenAIOAuthToken(token) ? 'oauth' : 'api_key',
    });

    const encrypted = encryptApiKey(tokenData);

    await db.systemConfig.upsert({
      where: { key: OAUTH_DB_KEY },
      update: {
        value: encrypted,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        updatedAt: new Date(),
      },
      create: {
        key: OAUTH_DB_KEY,
        value: encrypted,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      },
    });

    // Update in-memory cache
    tokenCache = { token, refreshToken, expiresAt };
    cacheExpiry = expiresAt || Date.now() + (365 * 24 * 60 * 60 * 1000); // 1 year default

    console.log('[OpenAI-OAuth] Token stored successfully');
    if (expiresAt) {
      console.log(`[OpenAI-OAuth] Expires: ${new Date(expiresAt).toISOString()}`);
    }
    if (refreshToken) {
      console.log('[OpenAI-OAuth] Refresh token stored');
    }

    return true;
  } catch (error) {
    console.error('[OpenAI-OAuth] Error storing token:', error.message);
    return false;
  }
}

/**
 * Get current token from database.
 * Returns { token, refreshToken, expiresAt } or null.
 * Note: Does NOT auto-refresh — use getOpenAIApiKey() for that.
 */
async function getStoredToken() {
  try {
    // Check in-memory cache first
    if (tokenCache && Date.now() < cacheExpiry) {
      return tokenCache;
    }

    const db = getPrisma();
    const config = await db.systemConfig.findUnique({
      where: { key: OAUTH_DB_KEY },
    });

    if (!config) return null;

    const decrypted = decryptApiKey(config.value);
    const data = JSON.parse(decrypted);

    // Update cache (even if expired — we may have a refresh token)
    tokenCache = {
      token: data.token,
      refreshToken: data.refreshToken || null,
      expiresAt: data.expiresAt,
    };
    cacheExpiry = data.expiresAt || Date.now() + (365 * 24 * 60 * 60 * 1000);

    return tokenCache;
  } catch (error) {
    console.error('[OpenAI-OAuth] Error reading token from database:', error.message);
    return null;
  }
}

/**
 * Clear token from database.
 */
async function clearToken() {
  try {
    const db = getPrisma();
    await db.systemConfig.delete({
      where: { key: OAUTH_DB_KEY },
    });

    tokenCache = null;
    cacheExpiry = 0;

    console.log('[OpenAI-OAuth] Token cleared');
    return true;
  } catch (error) {
    if (error.code === 'P2025') {
      return true; // Already gone
    }
    console.error('[OpenAI-OAuth] Error clearing token:', error.message);
    return false;
  }
}

/**
 * Get OpenAI API credentials with auto-refresh.
 * Priority: OAuth JWT token (auto-refresh if expired) > OPENAI_API_KEY env var
 *
 * Returns { apiKey, isOAuth }
 * The JWT is passed as apiKey — the OpenAI SDK sends it as Authorization: Bearer <jwt>
 * which OpenAI accepts for OAuth tokens.
 */
async function getOpenAIApiKey() {
  try {
    const stored = await getStoredToken();

    if (stored && stored.token) {
      const isOAuth = isOpenAIOAuthToken(stored.token);
      const isExpired = stored.expiresAt && stored.expiresAt < Date.now();

      if (isExpired && stored.refreshToken) {
        console.log('[OpenAI-OAuth] Access token expired, refreshing...');
        try {
          const refreshed = await refreshAccessToken(stored.refreshToken);
          await storeToken(refreshed.accessToken, refreshed.expiresAt, refreshed.refreshToken);
          console.log('[OpenAI-OAuth] Token refreshed successfully');
          return { apiKey: refreshed.accessToken, isOAuth: true };
        } catch (refreshError) {
          console.error('[OpenAI-OAuth] Token refresh failed:', refreshError.message);
          console.log('[OpenAI-OAuth] Falling back to OPENAI_API_KEY if available');
          // Fall through to env fallback
        }
      } else if (!isExpired && isOAuth) {
        console.log('[OpenAI-OAuth] Using OAuth JWT token');
        return { apiKey: stored.token, isOAuth: true };
      } else if (!isExpired && !isOAuth) {
        console.log('[OpenAI-OAuth] Using API key from database');
        return { apiKey: stored.token, isOAuth: false };
      }
    }

    // Check if OAuth-only mode is enforced
    if (process.env.OPENAI_OAUTH_ONLY === 'true') {
      throw new Error(
        'OPENAI_OAUTH_ONLY=true but no valid OAuth token. Run: node engine/import-oauth-openai.js'
      );
    }

    // Fallback to env var
    if (process.env.OPENAI_API_KEY) {
      console.log('[OpenAI-OAuth] Using OPENAI_API_KEY from environment');
      return { apiKey: process.env.OPENAI_API_KEY, isOAuth: false };
    }

    throw new Error(
      'No OpenAI credentials configured. Set OPENAI_API_KEY or run: node engine/import-oauth-openai.js'
    );
  } catch (error) {
    console.error('[OpenAI-OAuth] Error getting API key:', error.message);
    throw error;
  }
}

/**
 * Import token from auth-profiles.json (openai-codex:default profile).
 * Checks evobrew path first, falls back to legacy OpenClaw path.
 * This is the recommended way to get an OpenAI OAuth token into COSMO.
 */
async function importFromAuthProfiles() {
  // Find auth profiles file: evobrew primary, openclaw fallback
  let authProfilesPath = null;
  if (fs.existsSync(EVOBREW_AUTH_PROFILES)) {
    authProfilesPath = EVOBREW_AUTH_PROFILES;
  } else if (fs.existsSync(OPENCLAW_AUTH_PROFILES)) {
    authProfilesPath = OPENCLAW_AUTH_PROFILES;
  }

  if (!authProfilesPath) {
    return {
      success: false,
      error: `Auth profiles not found at ${EVOBREW_AUTH_PROFILES} or ${OPENCLAW_AUTH_PROFILES}`,
    };
  }

  try {
    const profiles = JSON.parse(fs.readFileSync(authProfilesPath, 'utf-8'));
    const profile = profiles.profiles && profiles.profiles['openai-codex:default'];

    const accessToken = profile && (profile.accessToken || profile.access);
    if (!profile || !accessToken) {
      return {
        success: false,
        error: `No openai-codex:default profile found in ${authProfilesPath}`,
      };
    }

    const refreshToken = profile.refreshToken || profile.refresh || null;
    await storeToken(accessToken, profile.expires || null, refreshToken);

    return {
      success: true,
      expiresAt: profile.expires ? new Date(profile.expires).toISOString() : null,
      isOAuth: isOpenAIOAuthToken(accessToken),
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to parse auth profiles (${authProfilesPath}): ${error.message}`,
    };
  }
}

// Backward compatibility alias
const importFromOpenClawProfiles = importFromAuthProfiles;

/**
 * Check OAuth status.
 */
async function getOAuthStatus() {
  const stored = await getStoredToken();

  if (!stored) {
    return {
      configured: false,
      source: process.env.OPENAI_API_KEY ? 'env_fallback' : 'none',
      valid: false,
      expiresAt: null,
    };
  }

  const isExpired = stored.expiresAt && stored.expiresAt < Date.now();

  return {
    configured: true,
    source: isOpenAIOAuthToken(stored.token) ? 'oauth' : 'api_key',
    valid: !isExpired,
    expiresAt: stored.expiresAt ? new Date(stored.expiresAt).toISOString() : null,
  };
}

module.exports = {
  // Main function
  importFromAuthProfiles,
  importFromOpenClawProfiles, // backward compat alias
  getOpenAIApiKey,

  // Token management
  refreshAccessToken,
  storeToken,
  getStoredToken,
  clearToken,

  // Status
  getOAuthStatus,

  // Utilities
  isOpenAIOAuthToken,

  // Constants
  OAUTH_DB_KEY,
  OPENAI_CLIENT_ID,
  OPENAI_TOKEN_URL,
};
