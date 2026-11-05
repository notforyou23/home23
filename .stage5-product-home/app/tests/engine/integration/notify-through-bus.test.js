import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelBus } from '../../../engine/src/channels/bus.js';
import { NotifyChannel } from '../../../engine/src/channels/notify/notify-channel.js';

test('notify line written to disk reaches bus observers and persists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-int-'));
  const path = join(dir, 'notifications.jsonl');
  writeFileSync(path, '');
  const bus = new ChannelBus({ persistenceDir: join(dir, 'channels') });
  bus.register(new NotifyChannel({ path }));
  const got = [];
  bus.on('observation', (o) => got.push(o));
  await bus.start();
  appendFileSync(path, JSON.stringify({
    id: 'n-1', kind: 'note', summary: 'hello', ts: '2026-04-21T00:00:00Z',
  }) + '\n');
  await new Promise((r) => setTimeout(r, 400));
  await bus.stop();
  assert.ok(got.length >= 1);
  assert.equal(got[0].payload.summary, 'hello');
  assert.equal(got[0].flag, 'UNCERTIFIED');
  // Persistence sidecar should exist for this channel
  assert.ok(existsSync(join(dir, 'channels', 'work.notify.cognition.jsonl')));
});
