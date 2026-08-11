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
 * The engine is deliberately NOT in this list (2026-08-11). It used to be:
 * credentials were distributed by value into PM2 env at boot, so the only way
 * to hand the engine a new token was to cycle the process. That trade was
 * always bad — an engine restart is the single most dangerous routine
 * operation in this house (it is the process that owns saveState/loadState,
 * and a shutdown racing a save has destroyed the brain before) — and a
 * routine 30-minute poller was firing it. The engine now resolves provider
 * credentials at use from config/secrets.yaml (engine/src/core/
 * provider-credentials.js), rebuilds its SDK clients when the file rotates,
 * and spends one force-fresh retry on an auth failure. Writing secrets.yaml
 * IS the delivery; the restart bought nothing and risked the brain.
 *
 * The harness IS still restarted, and that is not an oversight. Its
 * AgentLoop binds an Anthropic client in the constructor
 * (src/agent/loop.ts createAnthropicRuntimeClient at construction) and
 * rebuilds it only on an explicit provider switch — never on a rotation and
 * never on a 401. Until that client learns rebuild-on-rotation, a running
 * harness cannot see a new token, so the restart is still load-bearing.
 * The harness owns no brain, so cycling it is comparatively cheap.
 *
 * Callers must pass only processes PM2 reports online: this list feeds
 * `pm2 restart --only`, and naming an offline app is what produced the
 * 2026-08-07 orphan (a racing `pm2 start` against an in-flight restart left
 * a duplicate alive on the bridge port).
 */
function rotationRestartTargets(agentNames, onlineNames) {
  const online = onlineNames instanceof Set ? onlineNames : new Set(onlineNames || []);
  return (agentNames || [])
    .map((name) => `home23-${name}-harness`)
    .filter((name) => online.has(name));
}

module.exports = { jwtExpMs, readCurrentSecretToken, mayDeferRestart, rotationRestartTargets };
