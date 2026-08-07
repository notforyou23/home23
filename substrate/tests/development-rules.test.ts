/**
 * attenuation.v1 + resolution.v1 — the two development rules that close the
 * loop's remaining arcs: "care less" (teaching with the opposite sign) and
 * prediction resolution feeding development (consequence from the Seed's own
 * falsifiable claims).
 *
 * What must hold: attenuation reverses correction's grip WITHOUT touching the
 * teacher's trust or routing; resolution corroborates when right, loosens
 * provisionally when wrong, and teaches NOTHING in the ambiguous band; every
 * update is a receipted 'development' record with zero cell-state mutation;
 * all of it deterministic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import { SeedLedger } from '../src/ledger.js';
import {
  applyResolutionPlasticity,
  emptyDevelopment,
  RESOLUTION_ACCURATE_MAX,
  RESOLUTION_WRONG_MIN,
} from '../src/plasticity.js';
import { EventLedgerTailAdapter } from '../src/adapters/event-ledger-tail.js';
import type { LobeAdapter } from '../src/lobe.js';
import type { SourceEvent, LobeResult } from '../src/types.js';

function makeDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-dev-rules-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ev(overrides: Partial<SourceEvent>): SourceEvent {
  return {
    eventId: `evt_${Math.abs(JSON.stringify(overrides).split('').reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7))}`,
    category: 'observation',
    sourceAuthority: 'seed.adapter',
    sourceRef: 'owner:note',
    payload: {},
    producedAt: '2026-08-08T02:00:00.000Z',
    ...overrides,
  };
}

function devReceipts(stateDir: string): Array<Record<string, unknown>> {
  return new SeedLedger(stateDir).readAll()
    .filter((r) => r.category === 'development')
    .map((r) => r.payload);
}

// ─── attenuation.v1 ──────────────────────────────────────────────────────────

test('attenuation reverses correction: grip loosens, wake hardens, teacher keeps trust and routing', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 611 });

  // Teach twice in a context, then attenuate twice in the same context.
  seed.transition(ev({ category: 'correction', sourceRef: 'owner:that-mattered', producedAt: '2026-08-08T02:01:00.000Z' }));
  seed.transition(ev({ category: 'correction', sourceRef: 'owner:again', producedAt: '2026-08-08T02:02:00.000Z', eventId: 'evt_c2' }));
  const afterTeaching = devReceipts(dir);
  const taught = afterTeaching[afterTeaching.length - 1] as { wakeThresholdDelta: number; trust: number; routingAffinity: number };
  assert.ok(taught.wakeThresholdDelta < 0, 'corrections eased the wake threshold');
  assert.ok(taught.trust > 1, 'corrections built trust in the teacher');

  seed.transition(ev({ category: 'correction', sourceRef: 'owner:that-was-noise', producedAt: '2026-08-08T02:03:00.000Z', eventId: 'evt_a1', payload: { entry_type: 'attenuation' } }));
  const receipts = devReceipts(dir);
  const attenuated = receipts[receipts.length - 1] as {
    rule: string; wakeThresholdDelta: number; trust: number; routingAffinity: number; salienceDeltaNorm: number;
  };
  assert.equal(attenuated.rule, 'attenuation.v1');
  assert.ok(attenuated.wakeThresholdDelta > taught.wakeThresholdDelta, 'attenuation hardened the wake threshold back');
  assert.ok(attenuated.salienceDeltaNorm > 0, 'the trace actually moved');
  assert.equal(attenuated.trust, taught.trust, 'the TEACHER keeps their trust — care-less is about context, not channel');
  assert.equal(attenuated.routingAffinity, taught.routingAffinity, 'routing untouched — the channel still reaches the cell');
});

test('attenuation is deterministic: same genesis, same stream, identical development', (t) => {
  const dirA = makeDir(t);
  const dirB = makeDir(t);
  const born = SeedProcess.initialize(dirA, undefined, { reservoirSeed: 612 });
  born.checkpoint();
  born.stop();
  cpSync(dirA, dirB, { recursive: true });

  const run = (dir: string): string => {
    const seed = SeedProcess.restore(dir);
    seed.transition(ev({ category: 'correction', sourceRef: 'owner:a', producedAt: '2026-08-08T02:01:00.000Z' }));
    seed.transition(ev({ category: 'correction', sourceRef: 'owner:b', producedAt: '2026-08-08T02:02:00.000Z', eventId: 'evt_x', payload: { entry_type: 'attenuation' } }));
    const receipts = devReceipts(dir);
    return JSON.stringify(receipts[receipts.length - 1]);
  };
  assert.equal(run(dirA), run(dirB));
});

test('the relationship mapper routes attenuation entries onto the correction channel', () => {
  const adapter = new EventLedgerTailAdapter({ sourcePath: '/dev/null', sourceType: 'relationship-ledger', id: 'rel-test', cursorDir: mkdtempSync(join(tmpdir(), 'substrate-cursor-')) });
  const mapped = (adapter as unknown as {
    mapRelationshipLine(parsed: Record<string, unknown>, line: string, endOffset: number): { category: string; payload: Record<string, unknown> } | null;
  }).mapRelationshipLine(
    { ts: '2026-08-08T02:00:00.000Z', entry_id: 'e1', event_id: 'ev1', payload: { type: 'attenuation', actor: 'jtr' } },
    'line', 100,
  );
  assert.ok(mapped !== null);
  assert.equal(mapped.category, 'correction', 'attenuation rides the correction channel');
  assert.equal(mapped.payload['entry_type'], 'attenuation', 'the sign marker survives to the plasticity branch');
});

// ─── resolution.v1 ───────────────────────────────────────────────────────────

test('resolution bands: accurate corroborates, wrong loosens provisionally, ambiguity teaches nothing', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 613 });
  const routed = seed.transition(ev({ sourceRef: 'baro.sample:x', producedAt: '2026-08-08T02:01:00.000Z' }));
  const anyCell = seed.getCell(routed.cellId);
  assert.ok(anyCell !== undefined);
  if (anyCell === undefined) return;

  const accurate = applyResolutionPlasticity(emptyDevelopment(), anyCell, 'pred_1', RESOLUTION_ACCURATE_MAX - 0.05);
  assert.ok(accurate !== null);
  assert.equal(accurate.rule, 'resolution.v1');
  assert.ok(accurate.salienceDeltaNorm > 0, 'being right leaves a positive trace');

  const dev = emptyDevelopment();
  const wrong = applyResolutionPlasticity(dev, anyCell, 'pred_2', RESOLUTION_WRONG_MIN + 0.05);
  assert.ok(wrong !== null);
  assert.equal(dev[anyCell.id]?.corroborations, 0, 'being wrong corroborates nothing');
  assert.equal(dev[anyCell.id]?.updatesSinceConsolidation, 1, 'wrongness is provisional — consolidation can decay it');

  assert.equal(applyResolutionPlasticity(emptyDevelopment(), anyCell, 'pred_3', 0.5), null, 'the ambiguous band is not a teacher');
  assert.equal(applyResolutionPlasticity(emptyDevelopment(), anyCell, 'pred_4', Number.NaN), null, 'no error, no lesson');
});

test('end-to-end: a lobe resolving a prediction produces a resolution.v1 development receipt', async (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 614 });
  for (let i = 0; i < 8; i++) {
    seed.transition(ev({ category: 'correction', sourceRef: `owner:c${i}`, eventId: `evt_${i}`, producedAt: `2026-08-08T02:0${i}:00.000Z` }));
  }
  const outcome = seed.workspaceCycle('2026-08-08T02:09:00.000Z');
  assert.equal(outcome.kind, 'workspace');
  if (outcome.kind !== 'workspace') return;
  const cellId = outcome.packet.activeCellIds[0] as string;

  const lobeResult = (deltas: unknown[]): LobeResult => ({
    observations: [], interpretations: [], predictions: [],
    stateDeltas: deltas as LobeResult['stateDeltas'],
    candidateForms: [], candidateActions: [], evidenceRefs: [],
    uncertainty: 0.4,
    modelReceipt: { modelId: 't', provider: 't', invokedAt: '1970-01-01T00:00:00.000Z', durationMs: 1, tokensIn: 1, tokensOut: 1 },
  });
  const predictor: LobeAdapter = {
    id: 'lobe.p', modelId: 't', provider: 't',
    invoke: () => Promise.resolve(lobeResult([
      { cellId, field: 'predictions.append', delta: { claim: 'pressure will fall', confidence: 0.7, horizon: '1h' }, authority: 'propose' },
    ])),
  };
  await seed.recruitLobe(predictor, outcome.packet, '2026-08-08T02:10:00.000Z');
  const predictionId = seed.getCell(cellId)?.predictions[0]?.predictionId;
  assert.ok(predictionId !== undefined);

  const devBefore = devReceipts(dir).length;
  const stateHashBefore = seed.getState().stateHash;

  const resolver: LobeAdapter = {
    id: 'lobe.r', modelId: 't', provider: 't',
    invoke: () => Promise.resolve(lobeResult([
      { cellId, field: 'predictions.resolve', delta: { predictionId, error: 0.05 }, authority: 'propose' },
    ])),
  };
  const resolved = await seed.recruitLobe(resolver, outcome.packet, '2026-08-08T02:20:00.000Z');
  assert.equal(resolved.applied.length, 1, 'the resolution landed');

  const receipts = devReceipts(dir);
  assert.equal(receipts.length, devBefore + 1, 'exactly one development receipt from the resolution');
  const receipt = receipts[receipts.length - 1] as { rule: string; predictionId: string; predictionError: number; lobeSeq: number };
  assert.equal(receipt.rule, 'resolution.v1');
  assert.equal(receipt.predictionId, predictionId);
  assert.equal(receipt.predictionError, 0.05);
  assert.ok(receipt.lobeSeq > 0, 'the receipt cites the lobe receipt it came from');

  assert.notEqual(seed.getState().stateHash, stateHashBefore, 'the resolve delta itself moved cell state (resolvedAt)');
  assert.equal(new SeedLedger(dir).verifyChain().ok, true);

  // Ambiguous resolution: applied but develops nothing.
  const p2: LobeAdapter = {
    id: 'lobe.p2', modelId: 't', provider: 't',
    invoke: () => Promise.resolve(lobeResult([
      { cellId, field: 'predictions.append', delta: { claim: 'another', confidence: 0.6, horizon: '1h' }, authority: 'propose' },
    ])),
  };
  await seed.recruitLobe(p2, outcome.packet, '2026-08-08T02:30:00.000Z');
  const pred2 = seed.getCell(cellId)?.predictions.find((p) => p.resolvedAt === undefined)?.predictionId;
  const ambiguous: LobeAdapter = {
    id: 'lobe.a', modelId: 't', provider: 't',
    invoke: () => Promise.resolve(lobeResult([
      { cellId, field: 'predictions.resolve', delta: { predictionId: pred2, error: 0.5 }, authority: 'propose' },
    ])),
  };
  const before = devReceipts(dir).length;
  await seed.recruitLobe(ambiguous, outcome.packet, '2026-08-08T02:40:00.000Z');
  assert.equal(devReceipts(dir).length, before, 'the ambiguous band produced no development receipt');
});
