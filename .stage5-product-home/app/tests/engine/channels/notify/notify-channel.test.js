import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotifyChannel } from '../../../../engine/src/channels/notify/notify-channel.js';

async function nextWithin(channel, timeoutMs = 2000) {
  let timer;
  try {
    return await Promise.race([
      channel.source().next(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('notify_test_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('NotifyChannel emits each new NOTIFY line as an UNCERTIFIED observation', { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-'));
  const path = join(dir, 'notifications.jsonl');
  writeFileSync(path, '');
  const ch = new NotifyChannel({ path });
  await ch.start();
  try {
    appendFileSync(path, JSON.stringify({
      id: 'n-1', kind: 'problem', summary: 'disk full', ts: '2026-04-21T00:00:00Z',
    }) + '\n');
    const parsed = await nextWithin(ch);
    const out = [ch.verify(parsed.value)];
    assert.equal(out.length, 1);
    assert.equal(out[0].channelId, 'notify.cognition');
    assert.equal(out[0].flag, 'UNCERTIFIED');
    assert.equal(out[0].payload.summary, 'disk full');
    assert.equal(out[0].payload.id, 'n-1');
  } finally {
    await ch.stop();
  }
});

test('NotifyChannel skips malformed JSON lines silently', { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-bad-'));
  const path = join(dir, 'notifications.jsonl');
  writeFileSync(path, '');
  const ch = new NotifyChannel({ path });
  await ch.start();
  try {
    appendFileSync(path, 'not-json\n');
    appendFileSync(path, JSON.stringify({ id: 'n-2', kind: 'note', summary: 'ok', ts: '2026-04-21T00:01:00Z' }) + '\n');
    const parsed = await nextWithin(ch);
    assert.equal(parsed.value.payload.id, 'n-2');
  } finally {
    await ch.stop();
  }
});

test('NotifyChannel overlays dashboard ack state before emitting to bus', { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-ack-'));
  const path = join(dir, 'notifications.jsonl');
  writeFileSync(path, '');
  writeFileSync(join(dir, 'notifications-ack.json'), JSON.stringify({
    'n-ack': { acknowledged_at: '2026-04-21T00:02:00Z' },
  }));
  const ch = new NotifyChannel({ path });
  await ch.start();
  try {
    appendFileSync(path, JSON.stringify({
      id: 'n-ack', kind: 'problem', summary: 'handled', acknowledged: false, ts: '2026-04-21T00:01:00Z',
    }) + '\n');
    const parsed = await nextWithin(ch);
    const out = ch.verify(parsed.value);
    assert.equal(out.payload.id, 'n-ack');
    assert.equal(out.payload.acknowledged, true);
    assert.equal(out.payload.acknowledged_at, '2026-04-21T00:02:00Z');
  } finally {
    await ch.stop();
  }
});

test('NotifyChannel emits an updated observation when ack state changes after notification append', { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-ack-later-'));
  const path = join(dir, 'notifications.jsonl');
  const ackPath = join(dir, 'notifications-ack.json');
  writeFileSync(path, '');
  writeFileSync(ackPath, '{}');
  const ch = new NotifyChannel({ path });
  await ch.start();
  try {
    appendFileSync(path, JSON.stringify({
      id: 'n-later', kind: 'problem', summary: 'handle me', severity: 'attention', acknowledged: false, ts: '2026-04-21T00:01:00Z',
    }) + '\n');
    const first = await nextWithin(ch);
    assert.equal(first.value.payload.acknowledged, false);
    writeFileSync(ackPath, JSON.stringify({
      'n-later': { acknowledged_at: '2026-04-21T00:03:00Z' },
    }));
    const second = await nextWithin(ch);
    assert.equal(second.value.payload.id, 'n-later');
    assert.equal(second.value.payload.acknowledged, true);
    assert.equal(second.value.payload.acknowledged_at, '2026-04-21T00:03:00Z');
  } finally {
    await ch.stop();
  }
});

test('NotifyChannel crystallize returns null (promoter owns the decision)', async () => {
  const ch = new NotifyChannel({ path: '/tmp/x-fake' });
  const v = ch.verify({ payload: { id: 'n-3', summary: 'x' }, sourceRef: 'notify:x', producedAt: '2026-04-21T00:00:00Z' });
  assert.equal(ch.crystallize(v), null);
});
