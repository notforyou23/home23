/**
 * Anthropic Auth Module - Full PKCE OAuth Implementation + Token Import
 *
 * Supports two OAuth methods:
 * 1. PKCE OAuth Flow (Primary) - Full OAuth authorization with PKCE
 * 2. Token Import - Import tokens from Claude CLI's ~/.claude/auth.json
 *
 * PKCE OAuth Flow:
 * 1. Generate PKCE verifier/challenge
 * 2. User authorizes via browser
 * 3. Exchange authorization code for access + refresh tokens
 * 4. Auto-refresh when access token expires
 *
 * Token Import:
 * 1. User runs: claude setup-token (official Claude CLI handles OAuth)
 * 2. App imports token from ~/.claude/auth.json
 * 3. Token is stored in local database with encryption
 *
 * Based on the reference implementation at Cosmo Unified anthropic-oauth-engine.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { encryptApiKey, decryptApiKey } = require('./encryption');

// Ensure DATABASE_URL is set before Prisma import
// This supports both global config (~/.evobrew/database.db) and local (.env)
if (!process.env.DATABASE_URL) {
  // Check for global config first
  const globalConfigPath = path.join(os.homedir(), '.evobrew', 'config.json');
  if (fs.existsSync(globalConfigPath)) {
    const globalDbPath = path.join(os.homedir(), '.evobrew', 'database.db');
    process.env.DATABASE_URL = `file:${globalDbPath}`;
  } else {
    // Fall back to project-local database
    process.env.DATABASE_URL = 'file:./prisma/studio.db';
  }
}

const { PrismaClient } = require('@prisma/client');

// Lazy-load Prisma client
let prisma = null;
function getPrisma() {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

// Claude Code version for stealth mode (must match actual Claude Code CLI version)
const CLAUDE_CODE_VERSION = '2.1.32';

// Database key for storing OAuth tokens
const OAUTH_DB_KEY = 'anthropic_oauth';

// OAuth PKCE Flow Constants
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const OAUTH_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const OAUTH_SCOPES = 'org:create_api_key user:profile user:inference';

// In-memory cache to avoid DB hits on every request
let tokenCache = null;
let cacheExpiry = 0;
let systemConfigTableEnsured = false;

async function ensureSystemConfigTable(db) {
  if (systemConfigTableEnsured) {
    return;
  }

  try {
    const result = await db.$queryRaw`SELECT name FROM sqlite_master WHERE type='table' AND name='SystemConfig'`;
    if (Array.isArray(result) && result.length === 0) {
      await db.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "SystemConfig" (
          "key" TEXT NOT NULL PRIMARY KEY,
          "value" TEXT NOT NULL,
          "expiresAt" DATETIME,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
    systemConfigTableEnsured = true;
  } catch (error) {
    throw error;
  }
}

/**
 * Detect if a token is an OAuth token (from setup-token flow)
 * OAuth tokens contain "sk-ant-oauth" or "sk-ant-oat" in their format
 * Regular API keys contain "sk-ant-api"
 */
function isOAuthToken(token) {
  return token && (token.includes('sk-ant-oauth') || token.includes('sk-ant-oat'));
}

// ====================================================================
// PKCE OAuth Flow Implementation
// ====================================================================

/**
 * Base64url encode (no padding, URL-safe)
 * Used for PKCE verifier and challenge encoding
 */
function base64urlEncode(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Generate PKCE verifier and challenge
 * PKCE (Proof Key for Code Exchange) prevents authorization code interception
 *
 * Returns: { verifier, challenge }
 */
function generatePKCE() {
  // Generate 32 random bytes for verifier
  const verifierBytes = crypto.randomBytes(32);
  const verifier = base64urlEncode(verifierBytes);

  // Compute SHA-256 challenge from verifier
  const challengeBytes = crypto.createHash('sha256').update(verifier).digest();
  const challenge = base64urlEncode(challengeBytes);

  return { verifier, challenge };
}

/**
 * Get authorization URL for OAuth flow
 * User opens this URL in browser to authorize the app
 *
 * Returns: { authUrl, verifier }
 * User must save the verifier to exchange the code later
 */
function getAuthorizationUrl() {
  const { verifier, challenge } = generatePKCE();

  const authParams = new URLSearchParams({
    code: 'true',
    client_id: OAUTH_CLIENT_ID,
    response_type: 'code',
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: verifier, // Store verifier in state for security
  });

  const authUrl = `${OAUTH_AUTHORIZE_URL}?${authParams.toString()}`;

  return { authUrl, verifier };
}

/**
 * Exchange authorization code for tokens
 * After user authorizes, Anthropic redirects with a code
 *
 * @param {string} code - Authorization code from callback URL
 * @param {string} state - State from callback (should match verifier)
 * @param {string} verifier - Original PKCE verifier from getAuthorizationUrl()
 * @returns {Promise<{ accessToken, refreshToken, expiresAt, expiresIn }>}
 */
async function exchangeCodeForTokens(code, state, verifier) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      grant_type: 'authorization_code',
      client_id: OAUTH_CLIENT_ID,
      code: code,
      state: state,
      redirect_uri: OAUTH_REDIRECT_URI,
      code_verifier: verifier,
    });

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(OAUTH_TOKEN_URL, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Token exchange failed: ${res.statusCode} - ${data}`));
          return;
        }

        try {
          const response = JSON.parse(data);

          // Calculate expiry with 5-minute buffer
          const expiresAt = Date.now() + (response.expires_in * 1000) - (5 * 60 * 1000);

          resolve({
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
            expiresAt: expiresAt,
            expiresIn: response.expires_in,
          });
        } catch (error) {
          reject(new Error(`Failed to parse token response: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Token exchange request failed: ${error.message}`));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Refresh access token using refresh token
 * Access tokens expire after 1 hour, use this to get a new one
 *
 * @param {string} refreshToken - Refresh token from previous exchange
 * @returns {Promise<{ accessToken, refreshToken, expiresAt }>}
 */
async function refreshAccessToken(refreshToken) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      grant_type: 'refresh_token',
      client_id: OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    });

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(OAUTH_TOKEN_URL, options, (res) => {
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
            expiresAt: expiresAt,
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

// ====================================================================
// End of PKCE OAuth Flow
// ====================================================================

/**
 * Get stealth headers for OAuth token authentication
 * These headers impersonate Claude Code to allow OAuth tokens to work
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
 * Import token from Claude CLI (~/.claude/auth.json)
 * This is the recommended way to get OAuth tokens
 */
async function importFromClaudeCLI() {
  const claudeAuthPath = path.join(os.homedir(), '.claude', 'auth.json');

  if (!fs.existsSync(claudeAuthPath)) {
    return {
      success: false,
      error: 'Claude CLI auth file not found. Run: claude setup-token'
    };
  }

  try {
    const claudeAuth = JSON.parse(fs.readFileSync(claudeAuthPath, 'utf-8'));

    // Claude CLI stores: { access_token, expires_at, email, ... }
    if (!claudeAuth.access_token) {
      return {
        success: false,
        error: 'No access token found in Claude CLI auth'
      };
    }

    // Store the token in our database
    const expiresAt = claudeAuth.expires_at
      ? new Date(claudeAuth.expires_at).getTime()
      : null;

    await storeToken(claudeAuth.access_token, expiresAt, claudeAuth.refresh_token || null);

    return {
      success: true,
      email: claudeAuth.email,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      isOAuth: isOAuthToken(claudeAuth.access_token)
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to parse Claude CLI auth: ${error.message}`
    };
  }
}

/**
 * Store token in database (encrypted)
 * Works for OAuth tokens (with refresh) and API keys (without refresh)
 *
 * @param {string} token - Access token or API key
 * @param {number|null} expiresAt - Expiry timestamp (null for API keys)
 * @param {string|null} refreshToken - Refresh token (only for OAuth)
 */
async function storeToken(token, expiresAt = null, refreshToken = null) {
  try {
    const db = getPrisma();
    await ensureSystemConfigTable(db);

    const tokenData = JSON.stringify({
      token,
      refreshToken,
      expiresAt,
      updatedAt: Date.now(),
      type: isOAuthToken(token) ? 'oauth' : 'api_key'
    });

    const encrypted = encryptApiKey(tokenData);

    await db.systemConfig.upsert({
      where: { key: OAUTH_DB_KEY },
      update: {
        value: encrypted,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        updatedAt: new Date()
      },
      create: {
        key: OAUTH_DB_KEY,
        value: encrypted,
        expiresAt: expiresAt ? new Date(expiresAt) : null
      }
    });

    // Update cache
    tokenCache = { token, refreshToken, expiresAt };
    cacheExpiry = expiresAt || Date.now() + (365 * 24 * 60 * 60 * 1000); // 1 year default

    console.log('[OAuth] Token stored successfully');
    if (expiresAt) {
      console.log(`[OAuth] Expires: ${new Date(expiresAt).toISOString()}`);
    }
    if (refreshToken) {
      console.log('[OAuth] Refresh token stored');
    }

    return true;
  } catch (error) {
    console.error('[OAuth] Error storing token:', error.message);
    return false;
  }
}

/**
 * Get current token from database
 * Returns { token, refreshToken, expiresAt } or null
 * Note: Does NOT auto-refresh, use getAnthropicApiKey() for that
 * Note: Returns tokens even if expired (refresh token might still work)
 */
async function getStoredToken() {
  try {
    // Check cache first
    if (tokenCache && Date.now() < cacheExpiry) {
      return tokenCache;
    }

    const db = getPrisma();
    await ensureSystemConfigTable(db);
    const config = await db.systemConfig.findUnique({
      where: { key: OAUTH_DB_KEY }
    });

    if (!config) return null;

    // Decrypt and parse
    const decrypted = decryptApiKey(config.value);
    const data = JSON.parse(decrypted);

    // Update cache (even if expired, we might have refresh token)
    tokenCache = {
      token: data.token,
      refreshToken: data.refreshToken || null,
      expiresAt: data.expiresAt
    };
    cacheExpiry = data.expiresAt || Date.now() + (365 * 24 * 60 * 60 * 1000);

    return tokenCache;
  } catch (error) {
    console.error('[OAuth] Error reading token from database:', error.message);
    return null;
  }
}

/**
 * Clear token from database
 */
async function clearToken() {
  try {
    const db = getPrisma();
    await ensureSystemConfigTable(db);
    await db.systemConfig.delete({
      where: { key: OAUTH_DB_KEY }
    });

    // Clear cache
    tokenCache = null;
    cacheExpiry = 0;

    console.log('[OAuth] Token cleared');
    return true;
  } catch (error) {
    if (error.code === 'P2025') {
      // Record not found - that's fine
      return true;
    }
    console.error('[OAuth] Error clearing token:', error.message);
    return false;
  }
}

/**
 * Get Anthropic API credentials with auto-refresh
 * Priority: OAuth token (auto-refresh if expired) > .env API key
 * Returns object compatible with Anthropic SDK
 *
 * For OAuth tokens (sk-ant-oauth*):
 * - Auto-refreshes if expired and refresh token available
 * - Returns { authToken, defaultHeaders, dangerouslyAllowBrowser, isOAuth: true }
 *
 * For API keys (sk-ant-api*):
 * - Returns { apiKey, isOAuth: false }
 */
async function getAnthropicApiKey() {
  try {
    // Try stored token first
    let stored = await getStoredToken();

    if (stored && stored.token) {
      const isOAuth = isOAuthToken(stored.token);

      // Check if token is expired and we have a refresh token
      const isExpired = stored.expiresAt && stored.expiresAt < Date.now();
      if (isExpired && stored.refreshToken) {
        console.log('[OAuth] Access token expired, refreshing...');

        try {
          const refreshed = await refreshAccessToken(stored.refreshToken);

          // Store new tokens
          await storeToken(refreshed.accessToken, refreshed.expiresAt, refreshed.refreshToken);

          // Use refreshed token
          console.log('[OAuth] Token refreshed successfully');
          return {
            authToken: refreshed.accessToken,
            defaultHeaders: getStealthHeaders(),
            dangerouslyAllowBrowser: true,
            isOAuth: true
          };
        } catch (refreshError) {
          console.error('[OAuth] Token refresh failed:', refreshError.message);
          console.log('[OAuth] Falling back to .env API key if available');
          // Fall through to .env fallback
        }
      } else if (!isExpired && isOAuth) {
        // Token still valid
        console.log('[OAuth] Using OAuth token (stealth mode)');
        return {
          authToken: stored.token,
          defaultHeaders: getStealthHeaders(),
          dangerouslyAllowBrowser: true,
          isOAuth: true
        };
      } else if (!isExpired && !isOAuth) {
        // API key (no expiry)
        console.log('[OAuth] Using API key from database');
        return {
          apiKey: stored.token,
          isOAuth: false
        };
      }
    }

    // Check if OAuth-only mode is enforced
    const OAUTH_ONLY = process.env.ANTHROPIC_OAUTH_ONLY === 'true' ||
                       process.env.FORCE_ANTHROPIC_OAUTH === 'true';

    if (OAUTH_ONLY) {
      console.error('[OAuth] OAuth-only mode enabled - API key fallback disabled');
      throw new Error('OAuth token required (ANTHROPIC_OAUTH_ONLY=true). No API key fallback allowed.');
    }

    // Fallback to .env API key (only if OAuth-only mode not enforced)
    if (process.env.ANTHROPIC_API_KEY) {
      console.log('[OAuth] Using fallback API key from .env (not OAuth)');
      return {
        apiKey: process.env.ANTHROPIC_API_KEY,
        isOAuth: false
      };
    }

    throw new Error('No Anthropic credentials configured. Start OAuth flow or set ANTHROPIC_API_KEY');
  } catch (error) {
    console.error('[OAuth] Error getting API key:', error.message);
    throw error;
  }
}

/**
 * Prepare system prompt for OAuth mode
 * OAuth tokens require "You are Claude Code..." prefix
 *
 * Usage:
 *   const systemPrompt = prepareSystemPrompt(myPrompt, credentials.isOAuth);
 */
function prepareSystemPrompt(systemPrompt, isOAuth) {
  if (!isOAuth) {
    return systemPrompt;
  }

  // Claude Code system prompt that must be prepended for OAuth
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

/**
 * Check OAuth status
 */
async function getOAuthStatus() {
  const stored = await getStoredToken();

  if (!stored) {
    return {
      configured: false,
      source: process.env.ANTHROPIC_API_KEY ? 'env_fallback' : 'none',
      valid: false,
      expiresAt: null
    };
  }

  const isExpired = stored.expiresAt && stored.expiresAt < Date.now();

  return {
    configured: true,
    source: isOAuthToken(stored.token) ? 'oauth' : 'api_key',
    valid: !isExpired,
    expiresAt: stored.expiresAt ? new Date(stored.expiresAt).toISOString() : null
  };
}

module.exports = {
  // Main functions
  importFromClaudeCLI,
  getAnthropicApiKey,

  // PKCE OAuth Flow
  generatePKCE,
  getAuthorizationUrl,
  exchangeCodeForTokens,
  refreshAccessToken,

  // Token management
  storeToken,
  getStoredToken,
  clearToken,

  // System prompt preparation
  prepareSystemPrompt,

  // Status
  getOAuthStatus,

  // Utilities
  isOAuthToken,
  getStealthHeaders,

  // Constants
  OAUTH_DB_KEY,
  OAUTH_CLIENT_ID,
  OAUTH_AUTHORIZE_URL,
  OAUTH_TOKEN_URL,
  OAUTH_REDIRECT_URI
};
