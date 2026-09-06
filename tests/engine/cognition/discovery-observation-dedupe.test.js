import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DiscoveryEngine } = require('../../../engine/src/cognition/discovery-engine.js');

const logger = { info() {}, warn() {}, debug() {} };

function engine() {
  return new DiscoveryEngine({
    memory: { nodes: new Map(), edges: new Map(), clusters: new Map() },
    logger,
    config: {
      observationDedupe: {
        enabled: true,
        windowMs: 60 * 60 * 1000,
        channels: ['machine.cpu', 'machine.memory'],
      },
    },
  });
}

test('DiscoveryEngine suppresses repeated machine CPU observation buckets', () => {
  const d = engine();
  const base = {
    channelId: 'machine.cpu',
    flag: 'COLLECTED',
    confidence: 0.95,
    receivedAt: '2026-05-01T12:00:00.000Z',
    payload: { cpuCount: 10, loadAvg: [6.8, 6.7, 6.6] },
  };

  assert.equal(d.injectObservation({ ...base, sourceRef: 'cpu:t1', producedAt: '2026-05-01T12:00:00.000Z' }), true);
  assert.equal(d.pop(1)[0].key, 'observation:machine.cpu:cpu:elevated');

  assert.equal(d.injectObservation({ ...base, sourceRef: 'cpu:t2', producedAt: '2026-05-01T12:10:00.000Z', payload: { cpuCount: 10, loadAvg: [7.1, 6.9, 6.7] } }), false);
  assert.equal(d.peek(1).length, 0);
  assert.equal(d.getStats().candidatesByeSignal['observation-suppressed'], 1);

  assert.equal(d.injectObservation({ ...base, sourceRef: 'cpu:t3', producedAt: '2026-05-01T12:20:00.000Z', payload: { cpuCount: 10, loadAvg: [11.5, 10.9, 10.2] } }), true);
  assert.equal(d.pop(1)[0].key, 'observation:machine.cpu:cpu:overcommitted');
});

test('DiscoveryEngine allows repeated machine observation bucket after dedupe window', () => {
  const d = engine();
  const base = {
    channelId: 'machine.memory',
    flag: 'COLLECTED',
    confidence: 0.95,
    receivedAt: '2026-05-01T12:00:00.000Z',
    payload: { total: 16, free: 1, freePct: 6.5 },
  };

  assert.equal(d.injectObservation({ ...base, sourceRef: 'mem:t1', producedAt: '2026-05-01T12:00:00.000Z' }), true);
  d.pop(1);

  assert.equal(d.injectObservation({ ...base, sourceRef: 'mem:t2', producedAt: '2026-05-01T12:30:00.000Z', payload: { total: 16, free: 1.1, freePct: 6.8 } }), false);
  assert.equal(d.injectObservation({ ...base, sourceRef: 'mem:t3', producedAt: '2026-05-01T13:01:00.000Z', payload: { total: 16, free: 1.2, freePct: 6.9 } }), true);
  assert.equal(d.pop(1)[0].key, 'observation:machine.memory:memory:low');
});

test('DiscoveryEngine prefers Darwin pressure capacity buckets over raw free percent', () => {
  const cases = [
    [10, 'critical'],
    [20, 'severe'],
    [35, 'low'],
    [50, 'tight'],
    [50.1, 'normal'],
  ];

  for (const [pressureFreePct, bucket] of cases) {
    const d = engine();
    const at = `2026-05-01T12:00:${String(Math.floor(pressureFreePct)).padStart(2, '0')}.000Z`;
    assert.equal(d.injectObservation({
      channelId: 'machine.memory',
      flag: 'COLLECTED',
      confidence: 0.95,
      sourceRef: `mem:${pressureFreePct}`,
      producedAt: at,
      payload: { freePct: 1.8, rawFreePct: 1.8, pressureFreePct },
    }), true);
    assert.equal(d.pop(1)[0].key, `observation:machine.memory:memory:${bucket}`);
  }
});

test('DiscoveryEngine retains legacy raw-free memory buckets without pressure capacity', () => {
  const d = engine();
  assert.equal(d.injectObservation({
    channelId: 'machine.memory',
    flag: 'COLLECTED',
    confidence: 0.95,
    sourceRef: 'mem:legacy',
    producedAt: '2026-05-01T12:00:00.000Z',
    payload: { freePct: 4.9 },
  }), true);
  assert.equal(d.pop(1)[0].key, 'observation:machine.memory:memory:severe');
});

test('DiscoveryEngine does not enqueue Good Life telemetry as deep-thought material', () => {
  const d = engine();

  assert.equal(d.injectObservation({
    channelId: 'domain.good-life',
    flag: 'COLLECTED',
    confidence: 0.88,
    sourceRef: 'good-life:repair:2026-05-01T18:00:00.000Z',
    producedAt: '2026-05-01T18:00:00.000Z',
    payload: {
      policy: { mode: 'repair', reason: 'critical viability drift' },
      lanes: { viability: { status: 'critical', reasons: ['5 unresolved live problem(s)'] } },
    },
  }), false);

  assert.equal(d.peek(1).length, 0);
  assert.equal(d.getStats().candidatesByeSignal['good-life-regulated'], 1);
});
