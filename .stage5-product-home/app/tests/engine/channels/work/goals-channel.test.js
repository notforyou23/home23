import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalsChannel } from '../../../../engine/src/channels/work/goals-channel.js';

test('GoalsChannel emits state from parent directory name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goals-'));
  for (const sub of ['pending', 'assigned', 'acks', 'complete', 'revoked']) mkdirSync(join(dir, sub));
  const ch = new GoalsChannel({ goalsDir: dir, usePolling: true, interval: 50 });
  await ch.start();
  writeFileSync(join(dir, 'pending', 'g1.json'), JSON.stringify({ id: 'g1' }));
  const out = [];
  for await (const p of ch.source()) { out.push(p); if (out.length >= 1) break; }
  await ch.stop();
  assert.equal(out[0].payload.state, 'pending');
  assert.equal(out[0].payload.goalId, 'g1');
});
