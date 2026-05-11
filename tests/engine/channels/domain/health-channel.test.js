import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthChannel } from '../../../../engine/src/channels/domain/health-channel.js';

function isoDate(daysAgo = 0) {
  const date = new Date(Date.now() - daysAgo * 86400000);
  return date.toISOString().slice(0, 10);
}

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
  assert.equal(out[0].payload.interpretationPosture.hrv.baseline.status, 'building');
  assert.equal(out[0].payload.interpretationPosture.actionPosture, 'context_only');
  assert.equal(out[0].payload.interpretationPosture.coalition.posture, 'ask_neighboring_signals_before_action');
  assert.match(out[0].payload.interpretationPosture.coalition.forbiddenConclusion, /HRV alone/);
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

test('HealthChannel compares HRV to local baseline and requires neighboring signals before interpretation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-baseline-'));
  const path = join(dir, 'health.jsonl');
  const hrvHistory = [50, 52, 51, 49, 50, 53, 52];
  const history = hrvHistory.map((hrv, index) => JSON.stringify({
    ts: `${isoDate(10 - index)}T08:00:00Z`,
    metrics: {
      heartRateVariability: { date: isoDate(10 - index), unit: 'ms', value: hrv },
      restingHeartRate: { date: isoDate(10 - index), unit: 'bpm', value: 55 },
      sleepTime: { date: isoDate(10 - index), unit: 'min', value: 480 },
    },
  })).join('\n');
  writeFileSync(path, `${history}\n`);

  const ch = new HealthChannel({ path });
  await ch.start();
  const current = JSON.stringify({
    ts: new Date().toISOString(),
    metrics: {
      heartRateVariability: { date: isoDate(0), unit: 'ms', value: 35 },
      restingHeartRate: { date: isoDate(0), unit: 'bpm', value: 68 },
      sleepTime: { date: isoDate(1), unit: 'min', value: 300 },
      wristTemperature: { date: isoDate(1), unit: 'degF', value: 98.7 },
    },
  });
  appendFileSync(path, current + '\n');

  const out = [];
  for await (const p of ch.source()) { out.push(ch.verify(p)); if (out.length >= 1) break; }
  await ch.stop();

  const posture = out[0].payload.interpretationPosture;
  assert.equal(posture.hrv.baseline.status, 'ready');
  assert.equal(posture.hrv.baseline.sampleDays, 7);
  assert.equal(posture.hrv.baseline.band, 'below_baseline');
  assert.equal(posture.hrv.baseline.median, 51);
  assert.equal(posture.coalition.agreement, 'neighbor_health_signals_support_recovery_load_hypothesis');
  assert.equal(posture.coalition.confidence, 'medium');
  assert.deepEqual(posture.coalition.missingExternalSignals, ['pressure', 'sauna', 'weather', 'subjectiveNotes']);
  assert.match(posture.coalition.requiredBeforeInstruction.join(' '), /personal baseline/);
});
