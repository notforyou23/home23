#!/usr/bin/env node
/**
 * Headless OpenAI Codex OAuth (PKCE) helper.
 *
 * Why: the default oauth-codex.cjs flow tries to open a browser and run a localhost
 * callback server. That breaks on headless machines (Pi). This script implements a
 * 2-step flow:
 *
 *   1) start  -> prints the auth URL and saves a pending state file
 *   2) finish -> user pastes the final redirect URL; script exchanges code and stores creds
 *
 * Usage:
 *   node bin/codex-oauth-headless.cjs start
 *   node bin/codex-oauth-headless.cjs finish "<PASTE_REDIRECT_URL_HERE>"
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  AUTHORIZE_URL,
  CLIENT_ID,
  REDIRECT_URI,
  SCOPE,
  exchangeCodeForTokens,
  saveCredentials,
} = require('../lib/oauth-codex.cjs');

const PENDING_PATH = path.join(os.homedir(), '.evobrew', 'codex-oauth-pending.json');

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function generatePKCE() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

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

function extractAccountId(accessToken) {
  const payload = decodeJWT(accessToken);
  const auth = payload?.['https://api.openai.com/auth'];
  return auth?.chatgpt_account_id || null;
}

async function cmdStart() {
  const { verifier, challenge } = generatePKCE();
  const state = generateState();

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

  ensureDir(PENDING_PATH);
  fs.writeFileSync(PENDING_PATH, JSON.stringify({ verifier, state, createdAt: Date.now() }, null, 2));

  console.log('━'.repeat(72));
  console.log('OpenAI Codex OAuth (Headless) — Step 1/2');
  console.log('━'.repeat(72));
  console.log('\n1) Open this URL on a machine with a browser (your Mac):\n');
  console.log(authUrl.toString());
  console.log('\n2) After login, you will land on a redirect URL. Copy the FULL URL.');
  console.log('3) Paste it into:');
  console.log(`   node bin/codex-oauth-headless.cjs finish "<PASTE_URL>"`);
  console.log(`\nPending state saved to: ${PENDING_PATH}`);
}

async function cmdFinish(redirectUrl) {
  if (!redirectUrl) throw new Error('Missing redirect URL');
  if (!fs.existsSync(PENDING_PATH)) {
    throw new Error(`No pending state found at ${PENDING_PATH}. Run start first.`);
  }

  const pending = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
  const url = new URL(redirectUrl);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code) throw new Error('Redirect URL missing ?code=');
  if (!state) throw new Error('Redirect URL missing ?state=');
  if (state !== pending.state) throw new Error('State mismatch (wrong redirect URL or expired start)');

  const tokens = await exchangeCodeForTokens(code, pending.verifier);
  const accountId = extractAccountId(tokens.accessToken);
  if (!accountId) throw new Error('Failed to extract accountId from access token');

  saveCredentials({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expires: Date.now() + (tokens.expiresIn * 1000),
    accountId,
  });

  // Best-effort cleanup
  try { fs.unlinkSync(PENDING_PATH); } catch {}

  console.log('━'.repeat(72));
  console.log('OpenAI Codex OAuth (Headless) — Step 2/2 COMPLETE');
  console.log('━'.repeat(72));
  console.log('\n✅ OAuth tokens stored in ~/.evobrew/auth-profiles.json');
  console.log(`✅ accountId: ${accountId}`);
  console.log('\nRestart Evobrew to pick up new credentials:');
  console.log('  pm2 restart evobrew --update-env');
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('Usage:');
    console.log('  node bin/codex-oauth-headless.cjs start');
    console.log('  node bin/codex-oauth-headless.cjs finish "<redirectUrl>"');
    process.exit(0);
  }

  if (cmd === 'start') return cmdStart();
  if (cmd === 'finish') return cmdFinish(process.argv[3]);

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
