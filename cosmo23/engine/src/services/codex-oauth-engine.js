/**
 * Codex OAuth Engine Module
 *
 * Reads Codex OAuth credentials from the encrypted database.
 * DB key: openai_codex_oauth (written by server/services/openai-codex-oauth.js)
 * Auto-refreshes expired tokens if a refresh token is available.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { PrismaClient } = require('@prisma/client');
const { encryptApiKey, decryptApiKey } = require('./encryption');

let prisma = null;
function getPrisma() {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

const OAUTH_DB_KEY = 'openai_codex_oauth';
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';

let tokenCache = null;
let cacheExpiry = 0;

/**
 * Refresh access token using stored refresh token.
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
          reject(new Error(`Codex token refresh failed: ${res.statusCode} - ${data}`));
          return;
        }
        try {
          const response = JSON.parse(data);
          const expiresAt = Date.now() + (response.expires_in * 1000) - (5 * 60 * 1000);
          resolve({
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
            expiresAt,
          });
        } catch (error) {
          reject(new Error(`Failed to parse Codex refresh response: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Codex token refresh request failed: ${error.message}`));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Store token in database (encrypted).
 */
async function storeToken(token, expiresAt = null, refreshToken = null, accountId = null) {
  try {
    const db = getPrisma();
    const tokenData = JSON.stringify({
      token, refreshToken, expiresAt, accountId,
      updatedAt: Date.now(), type: 'oauth',
    });
    const encrypted = encryptApiKey(tokenData);

    await db.systemConfig.upsert({
      where: { key: OAUTH_DB_KEY },
      update: { value: encrypted, expiresAt: expiresAt ? new Date(expiresAt) : null, updatedAt: new Date() },
      create: { key: OAUTH_DB_KEY, value: encrypted, expiresAt: expiresAt ? new Date(expiresAt) : null },
    });

    tokenCache = { token, refreshToken, expiresAt, accountId };
    cacheExpiry = expiresAt || Date.now() + (365 * 24 * 60 * 60 * 1000);
    console.log('[Codex-OAuth-Engine] Token stored successfully');
    return true;
  } catch (error) {
    console.error('[Codex-OAuth-Engine] Error storing token:', error.message);
    return false;
  }
}

/**
 * Get stored token from database.
 */
async function getStoredToken() {
  try {
    if (tokenCache && Date.now() < cacheExpiry) {
      return tokenCache;
    }
    const db = getPrisma();
    const config = await db.systemConfig.findUnique({ where: { key: OAUTH_DB_KEY } });
    if (!config) return null;

    const decrypted = decryptApiKey(config.value);
    const data = JSON.parse(decrypted);

    tokenCache = {
      token: data.token, refreshToken: data.refreshToken || null,
      expiresAt: data.expiresAt, accountId: data.accountId || null,
    };
    cacheExpiry = data.expiresAt || Date.now() + (365 * 24 * 60 * 60 * 1000);
    return tokenCache;
  } catch (error) {
    console.error('[Codex-OAuth-Engine] Error reading token:', error.message);
    return null;
  }
}

/**
 * Get Codex credentials with auto-refresh.
 * Returns { accessToken, refreshToken, accountId, expiresAt } or null.
 */
async function getCodexCredentials() {
  try {
    const stored = await getStoredToken();
    if (!stored || !stored.token) return null;

    const isExpired = stored.expiresAt && (stored.expiresAt - 5 * 60 * 1000) < Date.now();

    if (isExpired && stored.refreshToken) {
      console.log('[Codex-OAuth-Engine] Token expired, refreshing...');
      try {
        const refreshed = await refreshAccessToken(stored.refreshToken);
        await storeToken(refreshed.accessToken, refreshed.expiresAt, refreshed.refreshToken, stored.accountId);
        console.log('[Codex-OAuth-Engine] Token refreshed successfully');
        return {
          accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken,
          accountId: stored.accountId, expiresAt: refreshed.expiresAt,
        };
      } catch (refreshError) {
        console.error('[Codex-OAuth-Engine] Token refresh failed:', refreshError.message);
        return null;
      }
    }

    if (isExpired) {
      console.warn('[Codex-OAuth-Engine] Token expired, no refresh token');
      return null;
    }

    return {
      accessToken: stored.token, refreshToken: stored.refreshToken,
      accountId: stored.accountId, expiresAt: stored.expiresAt,
    };
  } catch (error) {
    console.error('[Codex-OAuth-Engine] Error getting credentials:', error.message);
    return null;
  }
}

module.exports = {
  getCodexCredentials,
  refreshAccessToken,
  storeToken,
  getStoredToken,
  OAUTH_DB_KEY,
};
