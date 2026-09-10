import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(
  join(here, '..', '..', '..', 'engine', 'src', 'dashboard', 'server.js'),
  'utf8',
);

// The Home23 OAuth readiness sweep through the update section that follows it.
function oauthRefreshRegion() {
  const start = serverSource.indexOf('Home23 OAuth refresh');
  const end = serverSource.indexOf('Home23 update check');
  assert.ok(start > 0, 'OAuth refresh block marker must exist');
  assert.ok(end > start, 'Home23 update marker must follow the OAuth refresh block');
  return serverSource.slice(start, end);
}

test('OAuth refresh performs no process lifecycle mutation', () => {
  const region = oauthRefreshRegion();
  assert.doesNotMatch(region, /\bpm2\b|execFileSync|execSync/);
  assert.match(region, /oauthBroker\.credentials\(provider\)/);
  assert.match(region, /timer\.unref/);
});
