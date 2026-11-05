import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SaunaChannel } from '../../../../engine/src/channels/domain/sauna-channel.js';

test('SaunaChannel emits state transition events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sauna-'));
  const path = join(dir, 'sauna.jsonl');
  writeFileSync(path, '');
  const ch = new SaunaChannel({ path });
  await ch.start();
  appendFileSync(path, JSON.stringify({ event: 'start', ts: '2026-04-21T10:00:00Z', temp: 80, targetTemp: 190, status: 'On' }) + '\n');
  const out = [];
  for await (const p of ch.source()) { out.push(ch.verify(p)); if (out.length >= 1) break; }
  await ch.stop();
  assert.equal(out[0].payload.event, 'start');
  const d = ch.crystallize(out[0]);
  assert.ok(d.tags.includes('start'));
  assert.ok(d.tags.includes('On'));
});
