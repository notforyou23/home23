/**
 * OpenAI Codex OAuth Service
 *
 * Bridges the standalone oauth-codex.cjs module (PKCE flow + evobrew auth-profiles)
 * with server-side Prisma DB storage and encryption.
 *
 * Two credential sources:
 * 1. Import from ~/.evobrew/auth-profiles.json (via loadCredentials)
 * 2. Full PKCE OAuth flow (via loginWithCodexOAuth) — spins up callback server on port 1455
 *
 * Tokens stored encrypted in SystemConfig table under key 'openai_codex_oauth'.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { encryptApiKey, decryptApiKey } = require('./encryption');
const { loginWithCodexOAuth, loadCredentials, saveCredentials, refreshAccessToken } = require('../../lib/oauth-codex.cjs');

// Ensure DATABASE_URL is set before Prisma import
if (!process.env.DATABASE_URL) {
  const globalConfigPath = process.env.COSMO23_CONFIG_PATH || path.join(os.homedir(), '.cosmo2.3', 'config.json');
  if (fs.existsSync(globalConfigPath)) {
    const globalDbPath = path.join(os.homedir(), '.cosmo2.3', 'database.db');
    process.env.DATABASE_URL = `file:${globalDbPath}`;
  } else {
    process.env.DATABASE_URL = 'file:./prisma/cosmo2.3.db';
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

// Database key for storing OAuth tokens
const OAUTH_DB_KEY = 'openai_codex_oauth';

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
 * Store Codex OAuth token in database (encrypted)
 *
 * @param {string} token - Access token
 * @param {string|null} refreshToken - Refresh token
 * @param {number|null} expiresAt - Expiry timestamp (ms)
 * @param {string|null} accountId - OpenAI account ID
 */
async function storeCodexToken(token, refreshToken = null, expiresAt = null, accountId = null) {
  try {
    const db = getPrisma();
    await ensureSystemConfigTable(db);

    const tokenData = JSON.stringify({
      token,
      refreshToken,
      expiresAt,
      accountId,
      type: 'oauth',
      updatedAt: Date.now(),
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

    // Update cache
    tokenCache = { token, refreshToken, expiresAt, accountId };
    cacheExpiry = expiresAt || Date.now() + (365 * 24 * 60 * 60 * 1000);

    console.log('[OpenAI-Codex-OAuth] Token stored successfully');
    if (expiresAt) {
      console.log(`[OpenAI-Codex-OAuth] Expires: ${new Date(expiresAt).toISOString()}`);
    }
    if (accountId) {
      console.log(`[OpenAI-Codex-OAuth] Account: ${accountId}`);
    }

    return true;
  } catch (error) {
    console.error('[OpenAI-Codex-OAuth] Error storing token:', error.message);
    return false;
  }
}

/**
 * Get stored token from database
 * Returns { token, refreshToken, expiresAt, accountId } or null
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
      where: { key: OAUTH_DB_KEY },
    });

    if (!config) return null;

    // Decrypt and parse
    const decrypted = decryptApiKey(config.value);
    const data = JSON.parse(decrypted);

    // Update cache
    tokenCache = {
      token: data.token,
      refreshToken: data.refreshToken || null,
      expiresAt: data.expiresAt,
      accountId: data.accountId || null,
    };
    cacheExpiry = data.expiresAt || Date.now() + (365 * 24 * 60 * 60 * 1000);

    return tokenCache;
  } catch (error) {
    console.error('[OpenAI-Codex-OAuth] Error reading token from database:', error.message);
    return null;
  }
}

/**
 * Import credentials from ~/.evobrew/auth-profiles.json
 * Reads the openai-codex:default profile and stores in DB
 *
 * @returns {{ success: boolean, expiresAt?: string, accountId?: string, error?: string }}
 */
async function importFromEvobrew() {
  try {
    const creds = loadCredentials();

    if (!creds || !creds.accessToken) {
      return { success: false, error: 'No OpenAI Codex credentials found in ~/.evobrew/auth-profiles.json' };
    }

    const expiresAt = creds.expires || null;
    const accountId = creds.accountId || null;

    await storeCodexToken(creds.accessToken, creds.refreshToken || null, expiresAt, accountId);

    return {
      success: true,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      accountId,
    };
  } catch (error) {
    console.error('[OpenAI-Codex-OAuth] Import from evobrew failed:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Start full PKCE OAuth flow
 * Spins up a temporary HTTP server on port 1455 and opens the browser.
 * Blocks until the user completes authorization.
 *
 * @returns {{ success: boolean, expiresAt?: string, accountId?: string, error?: string }}
 */
async function startOAuthFlow() {
  try {
    console.log('[OpenAI-Codex-OAuth] Starting PKCE OAuth flow...');
    const result = await loginWithCodexOAuth();

    if (!result || !result.accessToken) {
      return { success: false, error: 'OAuth flow completed but no access token received' };
    }

    const expiresAt = result.expires || null;
    const accountId = result.accountId || null;

    // Store in DB
    await storeCodexToken(result.accessToken, result.refreshToken || null, expiresAt, accountId);

    // Also save to evobrew auth-profiles for consistency
    try {
      saveCredentials({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expires: expiresAt,
        accountId,
      });
      console.log('[OpenAI-Codex-OAuth] Credentials also saved to evobrew auth-profiles');
    } catch (evoErr) {
      console.warn('[OpenAI-Codex-OAuth] Failed to save to evobrew auth-profiles:', evoErr.message);
    }

    return {
      success: true,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      accountId,
    };
  } catch (error) {
    console.error('[OpenAI-Codex-OAuth] OAuth flow failed:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Check stored token status
 *
 * @returns {{ configured: boolean, source: string, valid: boolean, expiresAt: string|null }}
 */
async function getCodexOAuthStatus() {
  const stored = await getStoredToken();

  if (!stored) {
    return {
      configured: false,
      source: 'none',
      valid: false,
      expiresAt: null,
    };
  }

  const isExpired = stored.expiresAt && stored.expiresAt < Date.now();

  return {
    configured: true,
    source: 'oauth',
    valid: !isExpired,
    expiresAt: stored.expiresAt ? new Date(stored.expiresAt).toISOString() : null,
  };
}

/**
 * Get Codex credentials with auto-refresh
 * If token is expired and a refresh token is available, attempts refresh.
 *
 * @returns {{ accessToken: string, refreshToken: string|null, accountId: string|null, expiresAt: number|null } | null}
 */
async function getCodexCredentials() {
  try {
    const stored = await getStoredToken();

    if (!stored || !stored.token) {
      return null;
    }

    // Check if token is expired (with 5-minute buffer)
    const isExpired = stored.expiresAt && (stored.expiresAt - 5 * 60 * 1000) < Date.now();

    if (isExpired && stored.refreshToken) {
      console.log('[OpenAI-Codex-OAuth] Access token expired, refreshing...');

      try {
        const refreshed = await refreshAccessToken(stored.refreshToken);

        const newExpiresAt = Date.now() + (refreshed.expiresIn * 1000);
        const accountId = stored.accountId;

        // Store refreshed tokens in DB
        await storeCodexToken(refreshed.accessToken, refreshed.refreshToken, newExpiresAt, accountId);

        // Also update evobrew auth-profiles
        try {
          saveCredentials({
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expires: newExpiresAt,
            accountId,
          });
        } catch (evoErr) {
          // Non-fatal
          console.warn('[OpenAI-Codex-OAuth] Failed to update evobrew auth-profiles after refresh:', evoErr.message);
        }

        console.log('[OpenAI-Codex-OAuth] Token refreshed successfully');
        return {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          accountId,
          expiresAt: newExpiresAt,
        };
      } catch (refreshError) {
        console.error('[OpenAI-Codex-OAuth] Token refresh failed:', refreshError.message);
        return null;
      }
    }

    if (isExpired) {
      console.warn('[OpenAI-Codex-OAuth] Token expired and no refresh token available');
      return null;
    }

    return {
      accessToken: stored.token,
      refreshToken: stored.refreshToken,
      accountId: stored.accountId,
      expiresAt: stored.expiresAt,
    };
  } catch (error) {
    console.error('[OpenAI-Codex-OAuth] Error getting credentials:', error.message);
    return null;
  }
}

/**
 * Clear stored Codex token from database and cache
 */
async function clearCodexToken() {
  try {
    const db = getPrisma();
    await ensureSystemConfigTable(db);
    await db.systemConfig.delete({
      where: { key: OAUTH_DB_KEY },
    });

    // Clear cache
    tokenCache = null;
    cacheExpiry = 0;

    console.log('[OpenAI-Codex-OAuth] Token cleared');
    return true;
  } catch (error) {
    if (error.code === 'P2025') {
      // Record not found — already cleared
      tokenCache = null;
      cacheExpiry = 0;
      return true;
    }
    console.error('[OpenAI-Codex-OAuth] Error clearing token:', error.message);
    return false;
  }
}

module.exports = {
  importFromEvobrew,
  startOAuthFlow,
  getCodexOAuthStatus,
  getCodexCredentials,
  clearCodexToken,
  storeCodexToken,
};
