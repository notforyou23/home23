import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotifyChannel } from '../../../../engine/src/channels/notify/notify-channel.js';

test('NotifyChannel emits each new NOTIFY line as an UNCERTIFIED observation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-'));
  const path = join(dir, 'notifications.jsonl');
  writeFileSync(path, '');
  const ch = new NotifyChannel({ path });
  await ch.start();
  appendFileSync(path, JSON.stringify({
    id: 'n-1', kind: 'problem', summary: 'disk full', ts: '2026-04-21T00:00:00Z',
  }) + '\n');
  const out = [];
  for await (const parsed of ch.source()) {
    out.push(ch.verify(parsed));
    if (out.length >= 1) break;
  }
  await ch.stop();
  assert.equal(out.length, 1);
  assert.equal(out[0].channelId, 'notify.cognition');
  assert.equal(out[0].flag, 'UNCERTIFIED');
  assert.equal(out[0].payload.summary, 'disk full');
  assert.equal(out[0].payload.id, 'n-1');
});

test('NotifyChannel skips malformed JSON lines silently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-bad-'));
  const path = join(dir, 'notifications.jsonl');
  writeFileSync(path, '');
  const ch = new NotifyChannel({ path });
  await ch.start();
  appendFileSync(path, 'not-json\n');
  appendFileSync(path, JSON.stringify({ id: 'n-2', kind: 'note', summary: 'ok', ts: '2026-04-21T00:01:00Z' }) + '\n');
  const out = [];
  for await (const parsed of ch.source()) {
    out.push(parsed);
    if (out.length >= 1) break;
  }
  await ch.stop();
  assert.equal(out[0].payload.id, 'n-2');
});

test('NotifyChannel overlays dashboard ack state before emitting to bus', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-ack-'));
  const path = join(dir, 'notifications.jsonl');
  writeFileSync(path, '');
  writeFileSync(join(dir, 'notifications-ack.json'), JSON.stringify({
    'n-ack': { acknowledged_at: '2026-04-21T00:02:00Z' },
  }));
  const ch = new NotifyChannel({ path });
  await ch.start();
  appendFileSync(path, JSON.stringify({
    id: 'n-ack', kind: 'problem', summary: 'handled', acknowledged: false, ts: '2026-04-21T00:01:00Z',
  }) + '\n');
  const out = [];
  for await (const parsed of ch.source()) {
    out.push(ch.verify(parsed));
    if (out.length >= 1) break;
  }
  await ch.stop();
  assert.equal(out[0].payload.id, 'n-ack');
  assert.equal(out[0].payload.acknowledged, true);
  assert.equal(out[0].payload.acknowledged_at, '2026-04-21T00:02:00Z');
});

test('NotifyChannel emits an updated observation when ack state changes after notification append', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-ack-later-'));
  const path = join(dir, 'notifications.jsonl');
  const ackPath = join(dir, 'notifications-ack.json');
  writeFileSync(path, '');
  writeFileSync(ackPath, '{}');
  const ch = new NotifyChannel({ path });
  await ch.start();
  appendFileSync(path, JSON.stringify({
    id: 'n-later', kind: 'problem', summary: 'handle me', severity: 'attention', acknowledged: false, ts: '2026-04-21T00:01:00Z',
  }) + '\n');
  const first = await ch.source().next();
  assert.equal(first.value.payload.acknowledged, false);
  writeFileSync(ackPath, JSON.stringify({
    'n-later': { acknowledged_at: '2026-04-21T00:03:00Z' },
  }));
  const second = await ch.source().next();
  await ch.stop();
  assert.equal(second.value.payload.id, 'n-later');
  assert.equal(second.value.payload.acknowledged, true);
  assert.equal(second.value.payload.acknowledged_at, '2026-04-21T00:03:00Z');
});

test('NotifyChannel crystallize returns null (promoter owns the decision)', async () => {
  const ch = new NotifyChannel({ path: '/tmp/x-fake' });
  const v = ch.verify({ payload: { id: 'n-3', summary: 'x' }, sourceRef: 'notify:x', producedAt: '2026-04-21T00:00:00Z' });
  assert.equal(ch.crystallize(v), null);
});
