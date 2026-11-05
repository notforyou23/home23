import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readGoodLifeSleepPolicy } = require('../../../engine/src/good-life/sleep-policy.js');

test('Good Life rest policy forces sleep and raises wake threshold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-sleep-'));
  writeFileSync(join(dir, 'good-life-state.json'), JSON.stringify({
    policy: { mode: 'rest' },
    lanes: { friction: { status: 'strained' } },
    summary: 'rest - strained friction drift',
  }));

  const policy = readGoodLifeSleepPolicy(dir);
  assert.equal(policy.forceSleep, true);
  assert.equal(policy.minimumCycles, 4);
  assert.ok(policy.wakeThreshold >= 0.5);
});

test('Good Life repair policy suppresses new sleep when viability is critical', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-sleep-'));
  writeFileSync(join(dir, 'good-life-state.json'), JSON.stringify({
    policy: { mode: 'repair' },
    lanes: { viability: { status: 'critical' } },
    summary: 'repair - critical viability drift',
  }));

  const policy = readGoodLifeSleepPolicy(dir);
  assert.equal(policy.suppressNewSleep, true);
  assert.equal(policy.forceSleep, false);
});
