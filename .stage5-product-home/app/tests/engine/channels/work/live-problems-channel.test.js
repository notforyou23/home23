import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveProblemsChannel } from '../../../../engine/src/channels/work/live-problems-channel.js';

test('LiveProblemsChannel primes on first poll then emits on change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lp-'));
  const path = join(dir, 'live-problems.json');
  writeFileSync(path, JSON.stringify({ problems: [{ id: 'p1', state: 'open', updatedAt: '2026-04-21T00:00:00Z' }] }));
  const ch = new LiveProblemsChannel({ path, intervalMs: 10 });
  // First poll seeds baseline — should NOT emit
  assert.equal((await ch.poll()).length, 0);
  // Unchanged second poll
  assert.equal((await ch.poll()).length, 0);
  // Update state -> emit
  writeFileSync(path, JSON.stringify({ problems: [{ id: 'p1', state: 'resolved', updatedAt: '2026-04-21T01:00:00Z' }] }));
  const changed = await ch.poll();
  assert.equal(changed.length, 1);
  assert.equal(changed[0].state, 'resolved');
});
