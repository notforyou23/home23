import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublishLedger, parseStarvationFloor, publishTargetsForCognitionMode } from '../../../engine/src/publish/publish-ledger.js';

test('PublishLedger records publications and detects starvation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pl-'));
  const ledger = new PublishLedger({
    path: join(dir, 'publish-ledger.jsonl'),
    starvationFloor: { workspace_insights: 6 * 3600 * 1000 },
  });
  await ledger.record({ target: 'workspace_insights', artifact: 'x.md', at: Date.now() - 7 * 3600 * 1000 });
  assert.ok(ledger.listStarving({ now: Date.now() }).includes('workspace_insights'));
  await ledger.record({ target: 'workspace_insights', artifact: 'y.md', at: Date.now() });
  assert.equal(ledger.listStarving({ now: Date.now() }).length, 0);
});

test('missing first publication is not reported as starvation during startup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pl-'));
  const ledger = new PublishLedger({
    path: join(dir, 'publish-ledger.jsonl'),
    starvationFloor: { workspace_insights: 6 * 3600 * 1000 },
  });
  assert.deepEqual(ledger.listStarving({ now: Date.now() + 24 * 3600 * 1000 }), []);
});

test('parseStarvationFloor ignores configured targets without active publishers', () => {
  const floor = parseStarvationFloor({
    workspace_insights: '6h',
    dashboard: '15m',
    invalid: 'soon',
  }, {
    activeTargets: ['workspace_insights'],
  });

  assert.deepEqual(floor, {
    workspace_insights: 6 * 3600 * 1000,
  });
});

test('publish starvation targets follow wired cognition mode', () => {
  assert.deepEqual(publishTargetsForCognitionMode('legacy_roles'), []);
  assert.deepEqual(publishTargetsForCognitionMode('thinking_machine'), ['workspace_insights', 'dream_log']);
});
