import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthChannel } from '../../../../engine/src/channels/domain/health-channel.js';

test('HealthChannel extracts nested metrics into flat payload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-'));
  const path = join(dir, 'health.jsonl');
  writeFileSync(path, '');
  const ch = new HealthChannel({ path });
  await ch.start();
  const line = JSON.stringify({
    ts: '2026-04-21T14:50:52Z',
    metrics: {
      heartRateVariability: { date: new Date().toISOString().slice(0, 10), unit: 'ms', value: 28.53 },
      restingHeartRate: { unit: 'bpm', value: 58 },
      sleepTime: { unit: 'min', value: 502.99 },
      vo2Max: { unit: 'mL/kg/min', value: 31.04 },
    },
  });
  appendFileSync(path, line + '\n');
  const out = [];
  for await (const p of ch.source()) { out.push(ch.verify(p)); if (out.length >= 1) break; }
  await ch.stop();
  assert.equal(out[0].payload.hrv, 28.53);
  assert.equal(out[0].payload.rhr, 58);
  assert.equal(out[0].payload.sleepMin, 502.99);
  assert.equal(out[0].payload.vo2, 31.04);
  assert.equal(out[0].payload.semanticStale, false);
  assert.equal(out[0].payload.interpretationPosture.hrv.role, 'adaptive_capacity_shadow');
  assert.equal(out[0].payload.interpretationPosture.hrv.forbiddenUse, 'readiness_command');
  assert.equal(out[0].payload.interpretationPosture.actionPosture, 'context_only');
  assert.match(out[0].payload.interpretationPosture.boundary, /not a red-green readiness tile/);
  assert.equal(out[0].flag, 'COLLECTED');
});

test('HealthChannel marks fresh wrapper writes around stale metric dates as uncertified', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-'));
  const path = join(dir, 'health.jsonl');
  writeFileSync(path, '');
  const ch = new HealthChannel({ path });
  await ch.start();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    metrics: {
      heartRateVariability: { date: '2026-04-21', unit: 'ms', value: 28.53 },
      restingHeartRate: { date: '2026-04-21', unit: 'bpm', value: 58 },
    },
  });
  appendFileSync(path, line + '\n');
  const out = [];
  for await (const p of ch.source()) { out.push(ch.verify(p)); if (out.length >= 1) break; }
  await ch.stop();
  assert.equal(out[0].payload.semanticStale, true);
  assert.equal(out[0].payload.healthDataEndDate, '2026-04-21');
  assert.equal(out[0].flag, 'UNCERTIFIED');
  assert.equal(out[0].verifierId, 'health:kit-export-stale');
});
