#!/usr/bin/env node
/**
 * OpenAI Codex OAuth Module
 *
 * Standalone, validated PKCE OAuth flow for OpenAI/ChatGPT OAuth access.
 * Built from test-codex-oauth.cjs and extended with token persistence helpers
 * for Evobrew runtime integration.
 */

const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// OAuth constants (from test-codex-oauth.cjs)
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';

// Backward-compatible alias
const APP_ID = CLIENT_ID;

// Auth profiles location
const AUTH_PROFILES_PATH = path.join(os.homedir(), '.evobrew', 'auth-profiles.json');

// Generate PKCE challenge
function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// Generate random state
function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

// Decode JWT payload
function decodeJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64').toString('utf8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

// Extract account ID from JWT
function extractAccountId(token) {
  const payload = decodeJWT(token);
  const auth = payload?.['https://api.openai.com/auth'];
  return auth?.chatgpt_account_id || null;
}

// Open URL in browser
function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
}

// Start local callback server
function startCallbackServer(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname !== '/auth/callback') {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      // Validate state
      if (state !== expectedState) {
        res.statusCode = 400;
        res.end('State mismatch');
        server.close();
        reject(new Error('State mismatch'));
        return;
      }

      if (!code) {
        res.statusCode = 400;
        res.end('Missing authorization code');
        server.close();
        reject(new Error('Missing code'));
        return;
      }

      // Success page
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html');
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>OAuth Success</title></head>
        <body>
          <h1>✅ Authentication Successful</h1>
          <p>You can close this window and return to your terminal.</p>
        </body>
        </html>
      `);

      server.close();
      resolve(code);
    });

    server.listen(1455, '127.0.0.1', () => {
      // Server ready
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error('Port 1455 already in use. Close other apps and try again.'));
      } else {
        reject(err);
      }
    });
  });
}

// Exchange authorization code for tokens
async function exchangeCodeForTokens(code, verifier) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

// Refresh access token
async function refreshAccessToken(refreshToken) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

// Main OAuth flow used by Evobrew setup and docs
async function loginWithCodexOAuth() {
  const { verifier, challenge } = generatePKCE();
  const state = generateState();

  // Step 1: Build OAuth URL
  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('id_token_add_organizations', 'true');
  authUrl.searchParams.set('codex_cli_simplified_flow', 'true');
  authUrl.searchParams.set('originator', 'evobrew');

  // Step 2: Start callback server and open browser
  const codePromise = startCallbackServer(state);
  openBrowser(authUrl.toString());

  // Step 3: Wait for callback and exchange
  const code = await codePromise;
  const tokens = await exchangeCodeForTokens(code, verifier);

  // Step 4: Extract accountId
  const accountId = extractAccountId(tokens.accessToken);
  if (!accountId) {
    throw new Error('Failed to extract account ID from token');
  }

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expires: Date.now() + (tokens.expiresIn * 1000),
    accountId,
  };
}

// Load credentials from auth-profiles.json
function loadCredentials() {
  try {
    if (!fs.existsSync(AUTH_PROFILES_PATH)) return null;
    const data = fs.readFileSync(AUTH_PROFILES_PATH, 'utf8');
    const profiles = JSON.parse(data);
    return profiles?.profiles?.['openai-codex:default'] || null;
  } catch {
    return null;
  }
}

// Save credentials to auth-profiles.json
function saveCredentials(creds) {
  const dir = path.dirname(AUTH_PROFILES_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let profiles = { version: 1, profiles: {} };
  if (fs.existsSync(AUTH_PROFILES_PATH)) {
    try {
      profiles = JSON.parse(fs.readFileSync(AUTH_PROFILES_PATH, 'utf8'));
    } catch {
      // Use default
    }
  }

  profiles.profiles['openai-codex:default'] = {
    type: 'oauth',
    provider: 'openai-codex',
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expires: creds.expires,
    accountId: creds.accountId,
  };

  fs.writeFileSync(AUTH_PROFILES_PATH, JSON.stringify(profiles, null, 2));
}

// Get credentials with auto-refresh
async function getCredentials() {
  const creds = loadCredentials();
  if (!creds) return null;

  const now = Date.now();
  const expiresIn = creds.expires - now;

  if (expiresIn < 5 * 60 * 1000) {
    try {
      const refreshed = await refreshAccessToken(creds.refreshToken);
      const newCreds = {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expires: Date.now() + (refreshed.expiresIn * 1000),
        accountId: creds.accountId,
      };
      saveCredentials(newCreds);
      return newCreds;
    } catch (err) {
      console.error('Token refresh failed:', err.message);
      return null;
    }
  }

  return creds;
}

// Optional: keep reference compatibility with standalone test naming
async function testOAuthFlow() {
  return loginWithCodexOAuth();
}

module.exports = {
  APP_ID,
  CLIENT_ID,
  AUTHORIZE_URL,
  TOKEN_URL,
  REDIRECT_URI,
  SCOPE,
  loginWithCodexOAuth,
  getCredentials,
  saveCredentials,
  loadCredentials,
  exchangeCodeForTokens,
  refreshAccessToken,
  testOAuthFlow,
};
