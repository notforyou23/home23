import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { jwtExpMs, readCurrentSecretToken, mayDeferRestart } = require(
  join(here, '..', '..', '..', 'engine', 'src', 'dashboard', 'oauth-token-expiry.js'),
);

function makeJwt(expSeconds) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc({ exp: expSeconds })}.sig`;
}

test('jwtExpMs decodes exp to millis and returns null for opaque tokens', () => {
  assert.equal(jwtExpMs(makeJwt(1_700_000_000)), 1_700_000_000_000);
  assert.equal(jwtExpMs('sk-opaque-token'), null);
  assert.equal(jwtExpMs(''), null);
  assert.equal(jwtExpMs(undefined), null);
});

test('readCurrentSecretToken reads providers.<name>.apiKey and fails soft', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oauth-expiry-'));
  const secretsPath = join(dir, 'secrets.yaml');
  writeFileSync(secretsPath, 'providers:\n  openai-codex:\n    apiKey: tok-123\n', 'utf8');
  assert.equal(readCurrentSecretToken(secretsPath, 'openai-codex'), 'tok-123');
  assert.equal(readCurrentSecretToken(secretsPath, 'anthropic'), null);
  assert.equal(readCurrentSecretToken(join(dir, 'missing.yaml'), 'openai-codex'), null);
  rmSync(dir, { recursive: true, force: true });
});

test('mayDeferRestart defers only while the prior token is comfortably valid', () => {
  const now = 1_700_000_000_000;
  const valid2h = makeJwt((now / 1000) + 2 * 3600);
  const dying5m = makeJwt((now / 1000) + 5 * 60);
  const expired = makeJwt((now / 1000) - 60);
  assert.equal(mayDeferRestart(valid2h, now), true, 'plenty of validity → defer allowed');
  assert.equal(mayDeferRestart(dying5m, now), false, 'inside grace window → restart now');
  assert.equal(mayDeferRestart(expired, now), false, 'expired → restart now');
  assert.equal(mayDeferRestart('sk-opaque', now), true, 'opaque token keeps old conservative deferral');
  assert.equal(mayDeferRestart(null, now), true, 'no prior token → defer (nothing provably dead)');
});

test('the poller never skips the sync for research, and defers restarts with a log line', () => {
  const { readFileSync } = require('node:fs');
  const src = readFileSync(
    join(here, '..', '..', '..', 'engine', 'src', 'dashboard', 'server.js'),
    'utf8',
  );
  const start = src.indexOf('OAuth refresh poller (STEP 18)');
  const end = src.indexOf('COSMO 2.3 health watchdog');
  assert.ok(start > 0 && end > start, 'poller block markers must exist');
  const block = src.slice(start, end);
  assert.ok(
    !/researchActive\)\s*\{?\s*\n?\s*return/.test(block),
    'tick must not early-return on researchActive — token sync must always run',
  );
  assert.ok(block.includes('restart deferred'), 'deferred restarts must be logged');
  assert.ok(block.includes('mayDeferRestart'), 'deferral must go through the tested helper');
});
