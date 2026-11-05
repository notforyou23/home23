import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CronsChannel } from '../../../../engine/src/channels/work/crons-channel.js';

test('CronsChannel skips initial seed, emits on lastFiredAt advance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crons-'));
  const path = join(dir, 'cron-jobs.json');
  writeFileSync(path, JSON.stringify({ jobs: [{ id: 'j1', lastFiredAt: '2026-04-21T00:00:00Z', schedule: '*/5 * * * *' }] }));
  const ch = new CronsChannel({ path, intervalMs: 10 });
  assert.equal((await ch.poll()).length, 0); // seed
  assert.equal((await ch.poll()).length, 0); // same
  writeFileSync(path, JSON.stringify({ jobs: [{ id: 'j1', lastFiredAt: '2026-04-21T00:05:00Z', schedule: '*/5 * * * *' }] }));
  const out = await ch.poll();
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'j1');
});
