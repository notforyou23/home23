#!/usr/bin/env node
/**
 * Force one OpenAI Codex OAuth refresh through Home23's credential authority.
 * Used by diagnostics and older scheduled jobs. The broker owns locking and
 * atomic persistence in config/secrets.yaml; no external profile is read or
 * written.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHome23OAuthBroker } = require('../shared/home23-oauth.cjs');

async function refresh() {
  const broker = createHome23OAuthBroker({});
  const before = await broker.status('openai-codex');
  if (!before.configured || !before.refreshable) {
    throw new Error('Home23 Codex OAuth is not configured with a refresh credential');
  }
  const credentials = await broker.credentials('openai-codex', { force: true });
  if (!credentials) throw new Error('Home23 Codex OAuth refresh did not return credentials');
  return {
    ok: true,
    source: 'home23',
    expiresAt: credentials.expiresAt ? new Date(credentials.expiresAt).toISOString() : null,
    hasRefreshCredential: credentials.refreshToken !== null,
  };
}

refresh()
  .then((result) => {
    console.log(JSON.stringify(result));
    process.exit(0);
  })
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exit(1);
  });
