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

/**
 * Which processes still have to be restarted for a rotated token to reach them.
 *
 * As of 2026-08-11: NONE. This returns an empty list, and that is the whole
 * point — a routine token rotation no longer cycles any process in this house.
 * The function is kept rather than deleted so the poller keeps one honest
 * place to answer the question, and so a future consumer that genuinely
 * cannot read-at-use has somewhere to declare itself.
 *
 * How each consumer got here:
 *   - The ENGINE (dropped first). Credentials used to be distributed by value
 *     into PM2 env at boot, so cycling the process was the only way to deliver
 *     a new token. That trade was always bad: the engine owns saveState/
 *     loadState, a shutdown racing a save has destroyed the brain before, and
 *     a 30-minute timer was firing it. It now resolves at use from
 *     config/secrets.yaml (engine/src/core/provider-credentials.js), rebuilds
 *     its SDK clients on rotation, and spends one force-fresh retry on a 401.
 *   - The HARNESS (dropped second). Its AgentLoop bound an Anthropic client in
 *     the constructor and rebuilt it only on an explicit provider switch, so a
 *     running harness genuinely could not see a new token. src/agent/loop.ts
 *     now tracks the credential its client was built with, rebuilds per turn
 *     when secrets.yaml rotates, and spends one force-fresh retry on an auth
 *     failure — the same shape as the engine and text-generation.ts.
 *
 * Writing secrets.yaml IS the delivery. If this list ever grows again, the
 * entry needs to say which consumer cannot read-at-use and why.
 *
 * Callers must still pass only processes PM2 reports online: this list feeds
 * `pm2 restart --only`, and naming an offline app is what produced the
 * 2026-08-07 orphan (a racing `pm2 start` against an in-flight restart left
 * a duplicate alive on the bridge port).
 */
function rotationRestartTargets(_agentNames, _onlineNames) {
  return [];
}

module.exports = { jwtExpMs, readCurrentSecretToken, mayDeferRestart, rotationRestartTargets };
