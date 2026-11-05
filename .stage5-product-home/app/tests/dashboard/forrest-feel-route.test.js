import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('dashboard exposes /api/feel as a local proxy to the Forrest health API', () => {
  const source = readFileSync('/Users/jtr/_JTR23_/release/home23/engine/src/dashboard/server.js', 'utf8');

  assert.match(source, /HOME23_HEALTH_API_PORT/);
  assert.match(source, /this\.app\.post\(\['\/api\/feel', '\/home23\/api\/feel'\]/);
  assert.match(source, /\/api\/feel/);
});
