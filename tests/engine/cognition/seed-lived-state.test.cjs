/**
 * v2 first engine-side row — thinking cycles ground in the individual's
 * lived state. Pins: the JS composer (beliefs, contact, expectations,
 * fresh identity events; null on absent/young seed), the deep-dive prompt
 * carrying the lived block with its never-the-subject guardrail, and the
 * operational-telemetry exclusion (strict boundaries stay strict).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { composeLivedState } = require('../../../engine/src/substrate/seed-lived-state');
const { DeepDive } = require('../../../engine/src/cognition/deep-dive');

function makeSeedDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-lived-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFixture(dir) {
  fs.mkdirSync(path.join(dir, 'checkpoints'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'checkpoints', 'ckpt_aaaa0001_t.json'), JSON.stringify({
    version: 2, ledgerSeq: 500,
    cells: [{
      id: 'world.home23',
      estimates: [
        { claim: 'Heartbeat cadence stable at ~5min', confidence: 0.85, createdAt: '2026-08-08T10:00:00.000Z' },
        { claim: 'echo estimate over 8 refs (junk)', confidence: 0.7, createdAt: '2026-08-09T10:00:00.000Z' },
      ],
      predictions: [{ claim: 'degradation will recur within 6h', confidence: 0.6, horizon: '6h', createdAt: '2026-08-09T09:00:00.000Z' }],
      realityRefs: [
        { sourceRef: 'conversation.jtr:s1', observedAt: '2026-08-09T14:00:00.000Z', head: 'give jerry the house' },
        { sourceRef: 'conversation.self:s1', observedAt: '2026-08-09T14:00:30.000Z', head: 'The home becomes part of my continuous causal life' },
      ],
    }],
  }));
  fs.writeFileSync(path.join(dir, 'seed-ledger.jsonl'), [
    JSON.stringify({ seq: 480, category: 'act', sourceRef: 'growth.operator-decision', payload: { operatorDecision: 'declined', op: 'merge', authorizedBy: 'jtr', reason: 'feed them' } }),
    JSON.stringify({ seq: 500, category: 'transition', sourceRef: 'x', payload: {} }),
  ].join('\n') + '\n');
}

test('composes lived state: beliefs (echo junk excluded), contact, expectation, fresh acts', (t) => {
  const dir = makeSeedDir(t);
  writeFixture(dir);
  const lived = composeLivedState(dir);
  assert.ok(lived !== null);
  assert.ok(lived.includes('believes: [world.home23] Heartbeat cadence stable'), 'confident belief present');
  assert.ok(!lived.includes('echo estimate'), 'echo junk excluded');
  assert.ok(lived.includes('last contact — jtr: "give jerry the house"'), 'contact words carried');
  assert.ok(lived.includes('expecting: degradation will recur within 6h'), 'open expectation held');
  assert.ok(lived.includes('jtr declined his merge — "feed them"'), 'fresh identity event');
});

test('absent or empty seed → null; engine cognition is unchanged', (t) => {
  const dir = makeSeedDir(t);
  assert.equal(composeLivedState(dir), null);
  assert.equal(composeLivedState(path.join(dir, 'nope')), null);
});

test('deep-dive prompt carries the lived block with the never-the-subject guardrail', (t) => {
  const dir = makeSeedDir(t);
  writeFixture(dir);
  const dive = new DeepDive({
    unifiedClient: {}, memory: {}, logger: { info: () => {} },
    getLivedState: () => composeLivedState(dir),
  });
  const { input } = dive._buildPrompt(
    { nodeIds: [], signal: 'drift', score: 0.5 },
    { nodes: [] },
    { now: '2026-08-09T15:00:00.000Z' },
    null,
  );
  assert.ok(input.includes('What he is living'), 'lived block present in the cycle prompt');
  assert.ok(input.includes('give jerry the house'), 'real lived content flows into cognition');
  assert.ok(input.includes('NEVER the subject'), 'guardrail travels with the block');

  // Operational telemetry keeps its strict boundaries — no lived block.
  const { input: opInput } = dive._buildPrompt(
    { nodeIds: [], signal: 'bus', score: 0.5, observation: { channelId: 'machine.host', payload: {} } },
    { nodes: [] },
    { now: '2026-08-09T15:00:00.000Z' },
    null,
  );
  assert.ok(!opInput.includes('What he is living'), 'telemetry observations stay strictly bounded');
});
