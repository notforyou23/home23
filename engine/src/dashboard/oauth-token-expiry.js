/**
 * OAuth token expiry helpers for the dashboard's refresh poller.
 *
 * Why this exists (2026-08-09): the poller skipped its ENTIRE tick — including
 * the raw-token fetch that triggers cosmo23's lazy re-mint AND the secrets
 * sync — whenever a COSMO research run was active. A long-lived run therefore
 * let the codex access token expire (2026-08-09T00:26Z) and both engines ran
 * auth-dead for 8+ hours overnight. The poller now always fetches + syncs, and
 * only the process RESTART is deferrable — and never deferred when the token
 * the running processes hold is already expired or about to be.
 */

'use strict';

const fs = require('fs');
const yaml = require('js-yaml');

/** Decode a JWT's exp claim to epoch millis. Returns null for opaque/invalid tokens. */
function jwtExpMs(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Read the provider token currently in secrets.yaml (what running processes were booted with, at newest). */
function readCurrentSecretToken(secretsPath, provider) {
  try {
    const parsed = yaml.load(fs.readFileSync(secretsPath, 'utf8')) || {};
    const value = parsed?.providers?.[provider]?.apiKey;
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether a post-rotation restart may be deferred for an active
 * research run. Defer ONLY when the prior token is still comfortably valid
 * (or is opaque — non-JWT tokens keep the old conservative behavior).
 * A prior token that is expired or inside the grace window means the fleet
 * is running dead or about to — restart now, research or not.
 */
function mayDeferRestart(priorToken, nowMs, graceMs = 15 * 60 * 1000) {
  const expMs = jwtExpMs(priorToken);
  if (expMs === null) return true;
  return expMs - nowMs > graceMs;
}

module.exports = { jwtExpMs, readCurrentSecretToken, mayDeferRestart };
