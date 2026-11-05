import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PressureChannel } from '../../../../engine/src/channels/domain/pressure-channel.js';

test('PressureChannel parses BME280 JSONL line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'press-'));
  const path = join(dir, 'pressure.jsonl');
  writeFileSync(path, '');
  const ch = new PressureChannel({ path });
  await ch.start();
  appendFileSync(path, JSON.stringify({
    ts: '2026-04-21T10:51:20-04:00', pressure_pa: 102284, pressure_inhg: 30.2, temp_c: 19.3, temp_f: 66.7,
  }) + '\n');
  const out = [];
  for await (const p of ch.source()) { out.push(ch.verify(p)); if (out.length >= 1) break; }
  await ch.stop();
  assert.equal(out[0].payload.pressure_pa, 102284);
  assert.equal(out[0].flag, 'COLLECTED');
  const d = ch.crystallize(out[0]);
  assert.equal(d.method, 'sensor_primary');
});

test('PressureChannel skips lines missing pressure_pa', async () => {
  const ch = new PressureChannel({ path: '/tmp/x-fake' });
  assert.equal(ch.parseLine(JSON.stringify({ ts: 't', temp_c: 20 })), null);
  assert.equal(ch.parseLine(''), null);
});
