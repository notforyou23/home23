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

// The OAuth-refresh poller block: from the shared-secrets restart comment to
// the COSMO watchdog section that follows it.
function oauthRefreshRegion() {
  const start = serverSource.indexOf('Shared provider secrets affect every running Home23');
  const end = serverSource.indexOf('COSMO 2.3 health watchdog');
  assert.ok(start > 0, 'OAuth refresh block marker must exist');
  assert.ok(end > start, 'COSMO watchdog marker must follow the OAuth refresh block');
  return serverSource.slice(start, end);
}

test('OAuth refresh poller must not blind-fallback to pm2 start after a failed restart', () => {
  const region = oauthRefreshRegion();
  // 2026-08-07 forrest orphan incident: `pm2 restart` timed out client-side at
  // 45s while God was still stopping a slow harness; the catch-all fallback
  // then issued `pm2 start` for the same app, racing the in-flight restart and
  // orphaning the earlier spawn on the bridge port. Targets are filtered to
  // online (registered) apps four lines earlier, so a start fallback is never
  // the right response to a restart failure here.
  assert.ok(
    !region.includes("['start',"),
    'OAuth refresh block must not shell out to pm2 start as a restart fallback',
  );
  assert.ok(
    region.includes('did not confirm'),
    'restart failure must be reported as unconfirmed (God may still be completing it server-side)',
  );
});
