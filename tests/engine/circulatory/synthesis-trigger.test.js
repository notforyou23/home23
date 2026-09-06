// Synthesis freshness headroom for the SynthesisTrigger.
//
// The freshness verifier fails brain-state.json older than 360 minutes (6h).
// The five-hour threshold alone is not the guarantee — the sampling cadence is.
// A state can cross the threshold immediately after a check, so the worst-case
// trigger is threshold + CHECK_INTERVAL_MS. With a 30-minute check interval the
// synthesis request is guaranteed to START by 5h30m, leaving at least 30
// minutes for the durable run to commit before the verifier looks.
//
// These tests drive `tick(now)` with an explicit clock and an mtime derived
// from that same clock, so they are deterministic — no wall-clock dependence
// beyond the fixed relative ages.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SynthesisTrigger } = require('../../../engine/src/circulatory/synthesis-trigger.js');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const VERIFIER_LIMIT_MS = 360 * MINUTE; // brain-state.json age the verifier rejects
const CHECK_INTERVAL_MS = 30 * MINUTE; // the trigger's own sampling cadence

// A clock far past the 4h rate-limit window, so a fresh trigger (lastTriggerAt
// = 0) is never suppressed by rate limiting in these tests.
const BASE_NOW = 30 * 24 * HOUR;

function makeBrain(ageMs, now) {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-trigger-'));
  const statePath = path.join(brainDir, 'brain-state.json');
  fs.writeFileSync(statePath, '{}');
  const stamp = new Date(now - ageMs);
  fs.utimesSync(statePath, stamp, stamp);
  return brainDir;
}

function recordingAgent() {
  const runs = [];
  return {
    runs,
    agent: {
      async run(mode) {
        runs.push(mode);
        return { consolidatedInsights: [], durationMs: 0 };
      },
    },
  };
}

function makeTrigger(brainDir) {
  const { runs, agent } = recordingAgent();
  return {
    runs,
    trigger: new SynthesisTrigger({ brainDir, synthesisAgent: agent }),
  };
}

test('state just over five hours old triggers synthesis', async () => {
  const now = BASE_NOW;
  const ageMs = 5 * HOUR + MINUTE;
  const { runs, trigger } = makeTrigger(makeBrain(ageMs, now));

  const result = await trigger.tick(now);

  assert.equal(result?.triggered, true, 'a 5h01m-old brain state must trigger');
  assert.deepEqual(runs, ['auto_scheduled']);
  assert.match(result.reason, /^stale_brain_state_/);
  assert.ok(ageMs < VERIFIER_LIMIT_MS, 'and it must trigger while still inside the verifier limit');
});

test('state just under five hours old does not trigger synthesis', async () => {
  const now = BASE_NOW;
  const { runs, trigger } = makeTrigger(makeBrain(5 * HOUR - MINUTE, now));

  const result = await trigger.tick(now);

  assert.equal(result, null, 'a 4h59m-old brain state must not trigger');
  assert.deepEqual(runs, [], 'the synthesis agent must not run');
  assert.equal(trigger.getStats().triggerCount, 0);
});

test('worst-case sampling still starts synthesis 31 minutes before the verifier', async () => {
  // Worst case: a check lands one minute below the threshold, so the state
  // crosses it immediately after and must wait a full check interval. That
  // next sample is the latest synthesis can possibly start.
  const firstCheck = BASE_NOW;
  const ageAtFirstCheck = 5 * HOUR - MINUTE; // 4h59m
  const { runs, trigger } = makeTrigger(makeBrain(ageAtFirstCheck, firstCheck));

  assert.equal(await trigger.tick(firstCheck), null, 'below threshold: no trigger yet');
  assert.deepEqual(runs, []);

  const secondCheck = firstCheck + CHECK_INTERVAL_MS;
  const ageAtSecondCheck = ageAtFirstCheck + CHECK_INTERVAL_MS; // 5h29m
  const result = await trigger.tick(secondCheck);

  assert.equal(result?.triggered, true, 'the next 30-minute sample must trigger');
  assert.deepEqual(runs, ['auto_scheduled']);
  assert.equal(ageAtSecondCheck, 5 * HOUR + 29 * MINUTE, 'worst-case start is 5h29m');
  assert.equal(
    VERIFIER_LIMIT_MS - ageAtSecondCheck,
    31 * MINUTE,
    'leaving 31 minutes for the durable run to commit before the verifier',
  );
});
