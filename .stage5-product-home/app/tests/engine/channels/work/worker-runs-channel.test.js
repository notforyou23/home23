import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkerRunsChannel } from '../../../../engine/src/channels/work/worker-runs-channel.js';

test('WorkerRunsChannel emits completed worker receipt after priming', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-worker-channel-'));
  const file = join(root, 'worker-runs.jsonl');
  writeFileSync(file, JSON.stringify({ runId: 'wr_1', worker: 'systems', updatedAt: '2026-05-02T00:00:00.000Z', status: 'running' }) + '\n');
  const channel = new WorkerRunsChannel({ path: file, intervalMs: 1000 });

  assert.deepEqual(await channel.poll(), []);
  appendFileSync(file, JSON.stringify({ runId: 'wr_1', worker: 'systems', finishedAt: '2026-05-02T00:01:00.000Z', status: 'no_change', verifierStatus: 'pass', summary: 'checked' }) + '\n');
  const raw = await channel.poll();
  assert.equal(raw.length, 1);
  const parsed = channel.parse(raw[0]);
  const obs = channel.verify(parsed);
  assert.equal(obs.channelId, 'work.worker-runs');
  assert.equal(obs.flag, 'COLLECTED');
  assert.equal(obs.payload.worker, 'systems');
  assert.deepEqual(channel.crystallize(obs).tags, ['work', 'worker-run', 'systems', 'no_change']);
});
