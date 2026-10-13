import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHouseSense, houseSenseConfig, type HouseTransition } from '../src/house-sense.js';

const START = Date.parse('2026-09-10T18:00:00.000Z');

test('importing the house runner requires no runtime configuration and starts no writer', () => {
  const runner = resolve(import.meta.dirname, '../bin/house-sense.ts');
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `await import(${JSON.stringify(runner)}); console.log('IMPORTED');`], {
    env: { ...process.env, SHIPPER_STREAM_PATH: '', pm_exec_path: '' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'IMPORTED');
});

test('house defaults are quieter and rate, cooldown and polling remain configurable', () => {
  assert.deepEqual(houseSenseConfig({}), { pollMs: 15_000, maxPerHour: 20, entityCooldownMs: 300_000 });
  assert.deepEqual(houseSenseConfig({ HOUSE_POLL_MS: '30000', HOUSE_MAX_PER_HOUR: '8', HOUSE_ENTITY_COOLDOWN_MS: '600000' }),
    { pollMs: 30_000, maxPerHour: 8, entityCooldownMs: 600_000 });
  assert.equal(houseSenseConfig({ HOUSE_MAX_PER_HOUR: '0' }).maxPerHour, 0, 'zero cap can disable the stream');
  for (const env of [{ HOUSE_MAX_PER_HOUR: '-1' }, { HOUSE_MAX_PER_HOUR: 'NaN' },
    { HOUSE_ENTITY_COOLDOWN_MS: '-5' }, { HOUSE_POLL_MS: '0' }]) assert.throws(() => houseSenseConfig(env));
});

test('house sensing caps transitions in a rolling hour and only admits new changes after capacity returns', () => {
  const shipped: HouseTransition[] = [];
  const sense = createHouseSense({ maxPerHour: 2, entityCooldownMs: 0, ship: turn => shipped.push(turn) });
  const state = (value: string) => ['a', 'b', 'c'].map(name => ({ entity_id: `cover.${name}`, state: value }));
  assert.deepEqual(sense.process(state('closed'), START), { primed: true, shipped: 0, droppedByCap: 0, droppedByCooldown: 0 });
  const capped = sense.process(state('open'), START + 1);
  assert.equal(capped.shipped, 2);
  assert.equal(capped.droppedByCap, 1);
  assert.equal(sense.process(state('open'), START + 3_600_002).shipped, 0, 'a dropped transition must not replay');
  assert.equal(sense.process(state('closed'), START + 3_600_003).shipped, 2);
  assert.equal(shipped.length, 4);
  assert.equal(shipped[0]!.ts, new Date(START + 1).toISOString(), 'the event keeps observed time');
});

test('entity cooldown suppresses chatter while a different entity remains audible', () => {
  const shipped: HouseTransition[] = [];
  const sense = createHouseSense({ maxPerHour: 20, entityCooldownMs: 300_000, ship: turn => shipped.push(turn) });
  sense.process([{ entity_id: 'cover.door', state: 'closed' }, { entity_id: 'cover.garage', state: 'closed' }], START);
  assert.equal(sense.process([{ entity_id: 'cover.door', state: 'open' }], START + 1).shipped, 1);
  const next = sense.process([{ entity_id: 'cover.door', state: 'closed' }, { entity_id: 'cover.garage', state: 'open' }], START + 2);
  assert.equal(next.shipped, 1);
  assert.equal(next.droppedByCooldown, 1);
  assert.equal(sense.process([{ entity_id: 'cover.door', state: 'open' }], START + 300_001).shipped, 1);
  assert.deepEqual(shipped.map(turn => turn.entity), ['cover.door', 'cover.garage', 'cover.door']);
});

test('ambient telemetry, unknown states and motion ending do not consume the house budget', () => {
  const shipped: HouseTransition[] = [];
  const sense = createHouseSense({ maxPerHour: 1, entityCooldownMs: 0, ship: turn => shipped.push(turn) });
  sense.process([{ entity_id: 'sensor.temperature', state: '70' }, { entity_id: 'binary_sensor.motion', state: 'on' },
    { entity_id: 'cover.door', state: 'unknown' }], START);
  assert.equal(sense.process([{ entity_id: 'sensor.temperature', state: '71' }, { entity_id: 'binary_sensor.motion', state: 'off' },
    { entity_id: 'cover.door', state: 'closed' }], START + 1).shipped, 0);
  assert.equal(sense.process([{ entity_id: 'binary_sensor.motion', state: 'on' }], START + 2).shipped, 1);
  assert.equal(shipped[0]!.text, 'binary_sensor.motion detected');
});

test('an unsuccessful stream write does not consume budget or lose the transition', () => {
  let fail = true;
  const shipped: HouseTransition[] = [];
  const sense = createHouseSense({ maxPerHour: 1, entityCooldownMs: 300_000, ship(turn) {
    if (fail) throw new Error('fixture write failed');
    shipped.push(turn);
  } });
  sense.process([{ entity_id: 'cover.door', state: 'closed' }], START);
  assert.throws(() => sense.process([{ entity_id: 'cover.door', state: 'open' }], START + 1), /fixture write failed/);
  fail = false;
  assert.equal(sense.process([{ entity_id: 'cover.door', state: 'open' }], START + 2).shipped, 1);
  assert.equal(shipped.length, 1);
});
