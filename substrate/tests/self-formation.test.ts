/**
 * growth.v2 — governed self-application (SELF-FORMATION-PROTOCOL v1.1).
 *
 * What must hold: the power is a BIRTH property (genesis-recorded; absent →
 * proposals only, forever); passing whims get no organs (persistence gates:
 * ≥3 proposals, ≥48h event-time span, non-decreasing evidence, capture
 * ≥0.9); the covenant is hard (crystallize-only, additive, periphery
 * inviolable, cap 8); an application is receipted with full lineage and the
 * organ starts EMPTY; restore rebuilds the grown anatomy from the chain;
 * the whole thing is deterministic; and the organ-excision twin removes the
 * organ and ONLY the organ.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import { SeedLedger } from '../src/ledger.js';
import {
  evaluateSelfApplicationGates,
  SELF_APPLY_MIN_PROPOSALS,
  SELF_APPLY_MIN_SPAN_MS,
  SELF_APPLY_MIN_CAPTURE,
  SELF_APPLY_MAX_CELLS,
} from '../src/growth.js';
import type { GrowthProposal, PriorCrystallizeProposal } from '../src/growth.js';
import type { SourceEvent, AnatomyCellSpec } from '../src/types.js';

const MINIMAL_ANATOMY: AnatomyCellSpec[] = [
  { id: 'contact.owner', role: 'correction' },
  { id: 'periphery.open-field', role: 'periphery' },
];

function makeDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-selfform-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function knock(i: number, producedAt: string): SourceEvent {
  return {
    eventId: `evt_knock_${i}`,
    category: 'observation',
    sourceAuthority: 'seed.adapter',
    sourceRef: `visitor.knock:k${i}`,
    payload: {},
    producedAt,
  };
}

/** Live a round: N periphery-cluster knocks ending at `endIso`, then one
 * growth evaluation. Times within the round step by one minute. */
function liveRound(seed: SeedProcess, startIndex: number, n: number, endIso: string): void {
  const end = Date.parse(endIso);
  for (let i = 0; i < n; i++) {
    seed.transition(knock(startIndex + i, new Date(end - (n - 1 - i) * 60_000).toISOString()));
  }
  seed.evaluateGrowth(endIso);
}

function fakeProposal(overrides: Partial<GrowthProposal> = {}): GrowthProposal {
  return {
    op: 'crystallize',
    targetCellIds: ['periphery.open-field'],
    beforeAnatomy: MINIMAL_ANATOMY.map((a) => ({ ...a })),
    proposedAnatomy: [
      { id: 'contact.owner', role: 'correction' },
      { id: 'world.knock', role: 'observation' },
      { id: 'periphery.open-field', role: 'periphery' },
    ],
    seedAffinities: { 'world.knock': { 'visitor.knock': 0.3 } },
    evidence: {
      windowTransitions: 100, windowAdmissions: 0, cellTransitions: 60,
      cellAdmissions: 0, admissionShare: 0, prefixCounts: { 'visitor.knock': 60 },
    },
    shadowTrial: { peripheryShareBefore: 1, peripheryShareAfter: 0.1, clusterCapture: 0.95, eventsTried: 100 },
    ...overrides,
  };
}

function historyOf(entries: Array<[string, number]>): PriorCrystallizeProposal[] {
  return entries.map(([asOf, clusterCount], i) => ({ seq: i + 1, asOf, clusterPrefix: 'visitor.knock', clusterCount }));
}

// ─── The gates (pure) ────────────────────────────────────────────────────────

test('gates: whims are refused, persistence qualifies, covenant is hard', () => {
  const day = (n: number, count: number): [string, number] => [`2026-08-${String(10 + n).padStart(2, '0')}T12:00:00.000Z`, count];

  assert.equal(evaluateSelfApplicationGates(historyOf([day(0, 60)]), fakeProposal(), 2).qualifies, false, 'one proposal is a whim');
  assert.equal(
    evaluateSelfApplicationGates(historyOf([day(0, 60), ['2026-08-10T13:00:00.000Z', 70], ['2026-08-10T14:00:00.000Z', 80]]), fakeProposal(), 2).qualifies,
    false, '3 proposals in 2 hours is still a whim (span gate)');
  assert.equal(
    evaluateSelfApplicationGates(historyOf([day(0, 80), day(1, 60), day(3, 90)]), fakeProposal(), 2).qualifies,
    false, 'evidence must be non-decreasing');
  assert.equal(
    evaluateSelfApplicationGates(historyOf([day(0, 60), day(1, 70), day(3, 80)]), fakeProposal({ shadowTrial: { peripheryShareBefore: 1, peripheryShareAfter: 0.2, clusterCapture: SELF_APPLY_MIN_CAPTURE - 0.05, eventsTried: 100 } }), 2).qualifies,
    false, 'weak capture is refused');
  assert.equal(
    evaluateSelfApplicationGates(historyOf([day(0, 60), day(1, 70), day(3, 80)]), fakeProposal({ op: 'merge' } as Partial<GrowthProposal>), 2).qualifies,
    false, 'covenant: only crystallize');
  assert.equal(
    evaluateSelfApplicationGates(historyOf([day(0, 60), day(1, 70), day(3, 80)]), fakeProposal(), SELF_APPLY_MAX_CELLS).qualifies,
    false, 'covenant: cell ceiling');
  const bad = fakeProposal();
  bad.proposedAnatomy = bad.proposedAnatomy.filter((c) => c.role !== 'periphery');
  assert.equal(evaluateSelfApplicationGates(historyOf([day(0, 60), day(1, 70), day(3, 80)]), bad, 2).qualifies, false, 'covenant: periphery must survive');

  const good = evaluateSelfApplicationGates(historyOf([day(0, 60), day(1, 70), day(3, 80)]), fakeProposal(), 2);
  assert.equal(good.qualifies, true, 'persistent, corroborated, well-captured pressure qualifies');
  assert.ok(good.spanMs >= SELF_APPLY_MIN_SPAN_MS);
  assert.equal(good.priorCount, SELF_APPLY_MIN_PROPOSALS);
});

// ─── The lived path: an organ is grown ───────────────────────────────────────

test('a life that keeps knocking grows the organ: receipted, routed, restored', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, {
    reservoirSeed: 808, anatomy: MINIMAL_ANATOMY, name: 'selfform-test', selfFormation: true,
  });

  // Three rounds of the same periphery cluster, spaced ≥200 seqs (cooldown)
  // and spanning 4 days of event-time (span gate).
  liveRound(seed, 0, 210, '2026-08-10T12:00:00.000Z');
  liveRound(seed, 300, 210, '2026-08-12T12:00:00.000Z');
  assert.equal(seed.getState().cellIds.length, 2, 'two proposals are not yet an organ');
  liveRound(seed, 600, 210, '2026-08-14T12:00:00.000Z');

  // The organ exists.
  const state = seed.getState();
  assert.equal(state.cellIds.length, 3, 'the third persistent proposal grew the organ');
  const organId = state.cellIds.find((id) => id.includes('knock'));
  assert.ok(organId !== undefined, 'the organ is named from the cluster');

  // The application is receipted with full lineage.
  const chain = new SeedLedger(dir).readAll();
  const application = chain.find((r) => r.category === 'act' && r.payload?.['growthApplication'] === true);
  assert.ok(application !== undefined, 'application receipted');
  assert.equal(application.payload['newCellId'], organId);
  assert.equal(application.payload['clusterPrefix'], 'visitor.knock');
  const gateEvidence = application.payload['gateEvidence'] as { proposals: number; proposalSeqs: number[] };
  assert.ok(gateEvidence.proposals >= SELF_APPLY_MIN_PROPOSALS);
  for (const seq of gateEvidence.proposalSeqs.slice(0, -1)) {
    const cited = chain.find((r) => r.seq === seq);
    assert.ok(cited !== undefined && cited.category === 'proposal', `gate evidence seq ${seq} is a real proposal receipt`);
  }
  assert.equal(new SeedLedger(dir).verifyChain().ok, true);

  // The organ starts EMPTY and then EARNS: the cluster now routes to it.
  const routed = seed.transition(knock(900, '2026-08-14T12:05:00.000Z'));
  assert.equal(routed.cellId, organId, 'the cluster routes to the grown organ (seeded affinity)');

  // Restore rebuilds the grown anatomy from the chain.
  seed.checkpoint();
  seed.stop();
  const restored = SeedProcess.restore(dir);
  assert.deepEqual([...restored.getState().cellIds].sort(), [...state.cellIds].sort(), 'restore carries the grown body');
  const routedAfter = restored.transition(knock(901, '2026-08-14T12:10:00.000Z'));
  assert.equal(routedAfter.cellId, organId, 'the organ still receives its cluster after restore');
});

test('without the birth property, the same life proposes and NEVER applies', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, {
    reservoirSeed: 808, anatomy: MINIMAL_ANATOMY, name: 'no-power-test',
  });
  liveRound(seed, 0, 210, '2026-08-10T12:00:00.000Z');
  liveRound(seed, 300, 210, '2026-08-12T12:00:00.000Z');
  liveRound(seed, 600, 210, '2026-08-14T12:00:00.000Z');

  assert.equal(seed.getState().cellIds.length, 2, 'no application without the birth property');
  const chain = new SeedLedger(dir).readAll();
  assert.ok(chain.some((r) => r.category === 'proposal'), 'life still proposes');
  assert.ok(!chain.some((r) => r.category === 'act' && r.payload?.['growthApplication'] === true), 'nothing self-applies');
});

test('self-formation is deterministic: twin geneses, same stream, same organ at the same seq', (t) => {
  const dirA = makeDir(t);
  const dirB = makeDir(t);
  const born = SeedProcess.initialize(dirA, undefined, {
    reservoirSeed: 809, anatomy: MINIMAL_ANATOMY, name: 'det-test', selfFormation: true,
  });
  born.checkpoint();
  born.stop();
  cpSync(dirA, dirB, { recursive: true });

  const grow = (dir: string): { seq: number | undefined; organ: string | undefined } => {
    const seed = SeedProcess.restore(dir);
    liveRound(seed, 0, 210, '2026-08-10T12:00:00.000Z');
    liveRound(seed, 300, 210, '2026-08-12T12:00:00.000Z');
    liveRound(seed, 600, 210, '2026-08-14T12:00:00.000Z');
    seed.stop();
    const application = new SeedLedger(dir).readAll().find((r) => r.category === 'act' && r.payload?.['growthApplication'] === true);
    return { seq: application?.seq, organ: application?.payload?.['newCellId'] as string | undefined };
  };
  const a = grow(dirA);
  const b = grow(dirB);
  assert.ok(a.seq !== undefined, 'organ grew in arm A');
  assert.deepEqual(a, b, 'same genesis + same stream → same organ at the same seq');
});

// ─── The excision blade ──────────────────────────────────────────────────────

test('organ excision removes the organ and ONLY the organ; birth anatomy is uncuttable', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, {
    reservoirSeed: 810, anatomy: MINIMAL_ANATOMY, name: 'excise-test', selfFormation: true,
  });
  // Teach the birth contact cell FIRST — unrelated development that must survive.
  seed.transition({
    eventId: 'evt_teach', category: 'correction', sourceAuthority: 'seed.adapter',
    sourceRef: 'owner:pay-attention', payload: {}, producedAt: '2026-08-09T12:00:00.000Z',
  });
  liveRound(seed, 0, 210, '2026-08-10T12:00:00.000Z');
  liveRound(seed, 300, 210, '2026-08-12T12:00:00.000Z');
  liveRound(seed, 600, 210, '2026-08-14T12:00:00.000Z');
  const organId = seed.getState().cellIds.find((id) => id.includes('knock'));
  assert.ok(organId !== undefined);
  seed.checkpoint();
  seed.stop();

  const twinDir = makeDir(t);
  rmSync(twinDir, { recursive: true, force: true });
  const result = SeedProcess.createOrganExcisedTwin(dir, twinDir, organId);
  assert.ok(result.checkpointId.length > 0);

  const twin = SeedProcess.restore(twinDir);
  assert.ok(!twin.getState().cellIds.includes(organId), 'the organ is gone from the twin');
  assert.ok(twin.getState().cellIds.includes('contact.owner') && twin.getState().cellIds.includes('periphery.open-field'), 'birth anatomy intact');
  // Unrelated development survives; the twin's chain records the excision.
  const twinChain = new SeedLedger(twinDir).readAll();
  const excision = twinChain.find((r) => r.category === 'act' && r.payload?.['organExcision'] === true);
  assert.ok(excision !== undefined, 'excision receipted');
  assert.ok(twinChain.some((r) => r.category === 'development' && r.payload?.['cellId'] === 'contact.owner'), 'episodes/development history preserved');
  // The cluster returns to the periphery in the excised twin.
  const routed = twin.transition(knock(950, '2026-08-14T13:00:00.000Z'));
  assert.equal(routed.cellId, 'periphery.open-field', 'without the organ, the cluster lands where birth anatomy sends it');

  // The original still has the organ (source untouched).
  const original = SeedProcess.restore(dir);
  assert.ok(original.getState().cellIds.includes(organId), 'the source individual keeps its organ');

  // Birth anatomy is uncuttable.
  const twinDir2 = makeDir(t);
  rmSync(twinDir2, { recursive: true, force: true });
  assert.throws(() => SeedProcess.createOrganExcisedTwin(dir, twinDir2, 'contact.owner'), /birth anatomy/);
});
