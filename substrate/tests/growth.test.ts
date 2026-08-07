/**
 * Growth pressure (Cut 5): detectors fire only on repeated real pressure,
 * proposals are typed + bounded + carry rollback, shadow trials run the real
 * router, cooldowns prevent spam, and the receipted path mutates nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateGrowthPressure,
  computeRent,
  proposalKey,
  GROWTH_MIN_WINDOW_TRANSITIONS,
  MAX_PROPOSALS_PER_EVAL,
  PROPOSAL_COOLDOWN_SEQS,
} from '../src/growth.js';
import { SeedProcess } from '../src/seed.js';
import type { LedgerRecord, AnatomyCellSpec, SourceEvent } from '../src/types.js';

const BOBBY_LIKE_ANATOMY: AnatomyCellSpec[] = [
  { id: 'contact.jtr', role: 'correction' },
  { id: 'world.pi', role: 'observation' },
  { id: 'work.house', role: 'consequence' },
  { id: 'frontier.becoming', role: 'interpretation' },
  { id: 'periphery.open-field', role: 'periphery' },
];

let seqCounter = 0;

function transitionRecord(cellId: string, sourceRef: string, producedAt: string): LedgerRecord {
  seqCounter++;
  return {
    schema: 'home23.seed.ledger.v1',
    seq: seqCounter,
    prevHash: 'x',
    recordId: `rec_${seqCounter}`,
    category: 'transition',
    sourceAuthority: 'seed.adapter',
    sourceRef,
    payload: { targetCellId: cellId, originalCategory: 'observation', producedAt },
    issuedAt: producedAt,
  };
}

function admissionRecord(cellIds: string[], producedAt: string): LedgerRecord {
  seqCounter++;
  return {
    schema: 'home23.seed.ledger.v1',
    seq: seqCounter,
    prevHash: 'x',
    recordId: `rec_${seqCounter}`,
    category: 'workspace',
    sourceAuthority: 'seed.internal',
    sourceRef: 'seed',
    payload: { admittedCellIds: cellIds, uncertainty: 0.4 },
    issuedAt: producedAt,
  };
}

/** A window shaped like Bobby's actual life: world.pi dominating admissions
 * with two source clusters (air vs machine). */
function overloadedWindow(): LedgerRecord[] {
  seqCounter = 0;
  const records: LedgerRecord[] = [];
  for (let i = 0; i < 60; i++) {
    const prefix = i % 2 === 0 ? 'baro.sample' : 'vitals.sample';
    records.push(transitionRecord('world.pi', `${prefix}:reading-${i}`, `2026-08-07T2${i % 4}:0${i % 6}:00.000Z`));
    if (i > 0 && i % 9 === 0) records.push(admissionRecord(['world.pi'], `2026-08-07T2${i % 4}:0${i % 6}:30.000Z`));
  }
  return records;
}

test('split fires on a real overload shape and its shadow trial separates the clusters', () => {
  const proposals = evaluateGrowthPressure(overloadedWindow(), BOBBY_LIKE_ANATOMY, new Map(), seqCounter);
  const split = proposals.find((p) => p.op === 'split');
  assert.ok(split !== undefined, 'overload with two clusters must propose a split');
  assert.deepEqual(split.targetCellIds, ['world.pi']);
  assert.ok(split.evidence.admissionShare >= 0.8);
  assert.equal(split.beforeAnatomy.length, BOBBY_LIKE_ANATOMY.length, 'rollback carries the full before-anatomy');
  assert.equal(split.proposedAnatomy.length, BOBBY_LIKE_ANATOMY.length + 1, 'one cell becomes two');
  assert.ok(split.shadowTrial.eventsTried >= GROWTH_MIN_WINDOW_TRANSITIONS);
  assert.ok(split.shadowTrial.clusterCapture > 0.9,
    `seeded affinities must capture the clusters in the trial (got ${split.shadowTrial.clusterCapture})`);
  // The periphery must never be proposed away.
  assert.ok(split.proposedAnatomy.some((c) => c.role === 'periphery'));
});

test('quiet windows and small windows propose nothing', () => {
  seqCounter = 0;
  const tiny: LedgerRecord[] = [];
  for (let i = 0; i < GROWTH_MIN_WINDOW_TRANSITIONS - 1; i++) {
    tiny.push(transitionRecord('world.pi', `baro.sample:r${i}`, '2026-08-07T20:00:00.000Z'));
  }
  assert.deepEqual(evaluateGrowthPressure(tiny, BOBBY_LIKE_ANATOMY, new Map(), seqCounter), [],
    'below the window floor, detectors stay silent');

  // Balanced traffic, no overload, no periphery recurrence: nothing to say.
  // (Every non-periphery cell gets contact so starvation stays quiet too.)
  seqCounter = 0;
  const balanced: LedgerRecord[] = [];
  const cells = ['contact.jtr', 'world.pi', 'work.house', 'frontier.becoming'];
  for (let i = 0; i < 60; i++) {
    const cell = cells[i % 4] as string;
    balanced.push(transitionRecord(cell, `src${i % 8}.kind:r${i}`, '2026-08-07T20:00:00.000Z'));
    if (i % 9 === 0) balanced.push(admissionRecord([cells[(i / 9) % 4] as string], '2026-08-07T20:00:30.000Z'));
  }
  const proposals = evaluateGrowthPressure(balanced, BOBBY_LIKE_ANATOMY, new Map(), seqCounter);
  assert.ok(!proposals.some((p) => p.op === 'split'), 'no split without dominance');
  assert.ok(!proposals.some((p) => p.op === 'crystallize'), 'no crystallize without periphery recurrence');
});

test('crystallize fires when the periphery keeps catching the same thing', () => {
  seqCounter = 0;
  const records: LedgerRecord[] = [];
  for (let i = 0; i < 50; i++) {
    records.push(transitionRecord('world.pi', `baro.sample:r${i}`, '2026-08-07T20:00:00.000Z'));
  }
  for (let i = 0; i < 12; i++) {
    records.push(transitionRecord('periphery.open-field', `visitor.knock:k${i}`, '2026-08-07T21:00:00.000Z'));
  }
  const proposals = evaluateGrowthPressure(records, BOBBY_LIKE_ANATOMY, new Map(), seqCounter);
  const crystallize = proposals.find((p) => p.op === 'crystallize');
  assert.ok(crystallize !== undefined, 'recurring periphery cluster must propose crystallization');
  assert.ok(crystallize.proposedAnatomy.some((c) => c.id.includes('knock')), 'new cell named from the cluster');
  assert.ok(crystallize.proposedAnatomy.some((c) => c.role === 'periphery'), 'periphery survives crystallization');
  assert.ok(crystallize.shadowTrial.clusterCapture > 0.9);
});

test('starvation proposes merge for two starving cells, dissolve for one', () => {
  seqCounter = 0;
  const records: LedgerRecord[] = [];
  // Only world.pi and contact.jtr get contact; work.house + frontier starve.
  for (let i = 0; i < 60; i++) {
    records.push(transitionRecord(i % 3 === 0 ? 'contact.jtr' : 'world.pi', `src.a:r${i}`, '2026-08-07T20:00:00.000Z'));
  }
  const proposals = evaluateGrowthPressure(records, BOBBY_LIKE_ANATOMY, new Map(), seqCounter);
  const merge = proposals.find((p) => p.op === 'merge');
  assert.ok(merge !== undefined, 'two starving cells must propose a merge');
  assert.deepEqual([...merge.targetCellIds].sort(), ['frontier.becoming', 'work.house']);
  assert.equal(merge.proposedAnatomy.length, BOBBY_LIKE_ANATOMY.length - 1);

  // With exactly one starving cell, dissolve instead.
  seqCounter = 0;
  const oneStarver: LedgerRecord[] = [];
  for (let i = 0; i < 60; i++) {
    const cell = ['contact.jtr', 'world.pi', 'work.house'][i % 3] as string;
    oneStarver.push(transitionRecord(cell, `src.a:r${i}`, '2026-08-07T20:00:00.000Z'));
  }
  const dissolve = evaluateGrowthPressure(oneStarver, BOBBY_LIKE_ANATOMY, new Map(), seqCounter)
    .find((p) => p.op === 'dissolve');
  assert.ok(dissolve !== undefined);
  assert.deepEqual(dissolve.targetCellIds, ['frontier.becoming']);
});

test('cooldown suppresses repeat proposals; expiry re-enables them', () => {
  const window = overloadedWindow();
  const first = evaluateGrowthPressure(window, BOBBY_LIKE_ANATOMY, new Map(), seqCounter);
  const split = first.find((p) => p.op === 'split');
  assert.ok(split !== undefined);
  const priors = new Map([[proposalKey(split.op, split.targetCellIds), seqCounter]]);
  const suppressed = evaluateGrowthPressure(window, BOBBY_LIKE_ANATOMY, priors, seqCounter + 10);
  assert.ok(!suppressed.some((p) => p.op === 'split'), 'inside cooldown, same proposal stays quiet');
  const expired = evaluateGrowthPressure(window, BOBBY_LIKE_ANATOMY, priors, seqCounter + PROPOSAL_COOLDOWN_SEQS + 1);
  assert.ok(expired.some((p) => p.op === 'split'), 'after cooldown, pressure may speak again');
});

test('proposals are deterministic and capped', () => {
  const a = evaluateGrowthPressure(overloadedWindow(), BOBBY_LIKE_ANATOMY, new Map(), seqCounter);
  const b = evaluateGrowthPressure(overloadedWindow(), BOBBY_LIKE_ANATOMY, new Map(), seqCounter);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), 'same window → identical proposals');
  assert.ok(a.length <= MAX_PROPOSALS_PER_EVAL);
});

test('rent accounting: earning cells pay, starving cells show zero', () => {
  seqCounter = 0;
  const records = overloadedWindow();
  const cells = BOBBY_LIKE_ANATOMY.map((spec) => ({
    id: spec.id,
    role: spec.role,
    generation: 1,
    energy: { current: 0.5, baseline: 0.5 },
    workspacePressure: 0,
    intentions: [],
    estimates: [],
    predictions: [],
    realityRefs: [],
    continuousState: [],
    lastTransitionAt: '2026-08-07T20:00:00.000Z',
    uncertainty: 0.4,
  })) as never[];
  const rents = computeRent(records, cells as never);
  const worldPi = rents.find((r) => r.cellId === 'world.pi');
  const starving = rents.find((r) => r.cellId === 'work.house');
  assert.ok(worldPi !== undefined && worldPi.rentPaid > 0, 'the earning cell pays rent');
  assert.ok(starving !== undefined && starving.rentPaid === 0, 'the starving cell pays nothing');
});

test('seed.evaluateGrowth receipts proposals with ZERO state mutation and survives restore', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-growth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 77, anatomy: BOBBY_LIKE_ANATOMY, name: 'growth-test' });
  // Live the overload: observations alternating two prefixes, admissions on cadence.
  for (let i = 0; i < 60; i++) {
    const prefix = i % 2 === 0 ? 'baro.sample' : 'vitals.sample';
    const event: SourceEvent = {
      eventId: `evt_${i}`,
      category: 'observation',
      sourceAuthority: 'seed.adapter',
      sourceRef: `${prefix}:r${i}`,
      payload: {},
      producedAt: `2026-08-07T20:${String(10 + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}.000Z`,
    };
    seed.transition(event);
    if (i > 0 && i % 9 === 0) seed.workspaceCycle(event.producedAt);
  }

  const hashBefore = seed.getState().stateHash;
  const proposals = seed.evaluateGrowth('2026-08-07T20:30:00.000Z');
  assert.ok(proposals.some((p) => p.op === 'split'), 'lived overload produces a receipted split proposal');
  assert.equal(seed.getState().stateHash, hashBefore, 'proposals must not move state');

  // Second evaluation inside cooldown: silent.
  assert.equal(seed.evaluateGrowth('2026-08-07T20:31:00.000Z').length, 0);

  seed.checkpoint();
  seed.stop();
  const restored = SeedProcess.restore(dir);
  assert.equal(restored.getState().stateHash, hashBefore, 'proposal receipts do not disturb restore');
});
