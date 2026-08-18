/**
 * concern.v1 (Cut 6) — the normative state `c` and the continuous individual.
 *
 * Pins:
 *   - the obligation law is analytic and bounded: dormant before due, rising
 *     after, saturating at Q_EQ; the solved crossing time is exact;
 *   - horizons parse honestly (relative + ISO; garbage binds nothing);
 *   - commitments form ONLY from the Seed's own committed predictions
 *     (concern.v1 — the lobe proposes a prediction, never a commitment),
 *     with honest skips receipted;
 *   - resolution discharges; the loop closes;
 *   - the RUNNER materializes an endogenous occasion with the SOLVED
 *     event-time, recruits deliberation, and the chain shows it;
 *   - the one safe affordance: reach-operator is occasion-gated,
 *     warrant-checked (one reach per commitment, cooldown), transactional
 *     (outbox + dispatch receipt, idempotent);
 *   - after MAX_CROSSINGS unanswered presses, the obligation is RELEASED —
 *     receipted expiry, no immortal pressure;
 *   - concern survives checkpoint/restore exactly (v3 manifest).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import { SeedRunner } from '../src/runner.js';
import type { LobeAdapter } from '../src/lobe.js';
import { buildLobePrompt, predictionIdFor, applyLobeDeltas } from '../src/lobe.js';
import type { WorkspacePacket, LobeResult, SituationCell } from '../src/types.js';
import {
  parseHorizon,
  obligationAt,
  nextCrossingAt,
  applyFormation,
  OBLIGATION_THETA,
  OBLIGATION_LAMBDA,
  OBLIGATION_Q_EQ,
  MAX_CROSSINGS,
  CROSSING_REFRACTORY_SECONDS,
  CONCERN_MIN_CONFIDENCE,
} from '../src/concern.js';
import type { Commitment } from '../src/concern.js';
import { TEST_ANATOMY } from './named-anatomy.js';

function makeDir(prefix: string, t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function harnessLine(i: number, ts: string): string {
  return JSON.stringify({
    event_id: `he_${i}`, event_type: 'MemoryChallenged', session_id: `s${i}`,
    timestamp: ts, actor: 'test', payload: {},
  });
}

function readChain(stateDir: string): Array<{ seq: number; category: string; payload?: Record<string, unknown> }> {
  return readFileSync(join(stateDir, 'seed-ledger.jsonl'), 'utf-8').trim().split('\n')
    .map((l) => JSON.parse(l) as { seq: number; category: string; payload?: Record<string, unknown> });
}

const RECEIPT = {
  modelId: 'scripted', provider: 'seed.internal',
  invokedAt: '1970-01-01T00:00:00.000Z', durationMs: 0, tokensIn: 0, tokensOut: 0,
};

/** A lobe with a script: proposes typed results per invocation, recorded. */
class ScriptedLobe implements LobeAdapter {
  readonly id = 'lobe.scripted';
  readonly modelId = 'scripted';
  readonly provider = 'seed.internal';
  readonly packets: WorkspacePacket[] = [];
  constructor(private readonly script: (packet: WorkspacePacket, n: number) => Partial<LobeResult>) {}
  invoke(packet: WorkspacePacket): Promise<LobeResult> {
    this.packets.push(packet);
    const partial = this.script(packet, this.packets.length);
    return Promise.resolve({
      observations: [], interpretations: [], predictions: [], stateDeltas: [],
      candidateForms: [], candidateActions: [], uncertainty: 0.5, evidenceRefs: [],
      modelReceipt: { ...RECEIPT },
      ...partial,
    });
  }
}

// ─── The law itself ──────────────────────────────────────────────────────────

test('the obligation law: dormant before due, rising after, saturating, with an exact solved crossing', () => {
  const c: Commitment = {
    commitmentId: 'cmt_x_1', kind: 'resolve-prediction', cellId: 'world.home23',
    predictionId: 'pred_x', claim: 'x', confidence: 0.8, authority: 'concern.v1',
    formedAt: '2026-08-01T00:00:00.000Z', formedAtSeq: 1,
    dueAt: '2026-08-02T00:00:00.000Z',
    qAnchor: 0, anchorAt: '2026-08-01T00:00:00.000Z', status: 'open', crossings: 0,
  };
  assert.equal(obligationAt(c, '2026-08-01T12:00:00.000Z'), 0, 'dormant before due');
  const q6h = obligationAt(c, '2026-08-02T06:00:00.000Z');
  const expected6h = OBLIGATION_Q_EQ * (1 - Math.exp(-OBLIGATION_LAMBDA * 6 * 3600));
  assert.ok(Math.abs(q6h - expected6h) < 1e-9, 'analytic rise after due');
  assert.ok(obligationAt(c, '2027-01-01T00:00:00.000Z') <= OBLIGATION_Q_EQ, 'bounded by saturation');

  const tStar = nextCrossingAt(c);
  assert.ok(tStar !== null, 'crossing is solvable');
  const qAtCrossing = obligationAt(c, tStar);
  assert.ok(Math.abs(qAtCrossing - OBLIGATION_THETA) < 1e-6, 'q(t*) = θ exactly — the pulse is the solved crossing time');

  // After a crossing, the refractory boundary IS the next crossing time.
  const crossed: Commitment = { ...c, crossings: 1, lastCrossingAt: tStar, qAnchor: OBLIGATION_THETA, anchorAt: tStar };
  const t2 = nextCrossingAt(crossed);
  assert.equal(t2, new Date(Date.parse(tStar) + CROSSING_REFRACTORY_SECONDS * 1000).toISOString(), 'refractory schedules the next press');
  const done: Commitment = { ...crossed, crossings: MAX_CROSSINGS };
  assert.equal(nextCrossingAt(done), null, 'MAX_CROSSINGS ends the pressing');
});

test('horizons parse honestly; garbage binds nothing', () => {
  const at = '2026-08-10T00:00:00.000Z';
  assert.equal(parseHorizon('24h', at), '2026-08-11T00:00:00.000Z');
  assert.equal(parseHorizon('3 days', at), '2026-08-13T00:00:00.000Z');
  assert.equal(parseHorizon('90 minutes', at), '2026-08-10T01:30:00.000Z');
  assert.equal(parseHorizon('2026-09-01T12:00:00.000Z', at), '2026-09-01T12:00:00.000Z');
  assert.equal(parseHorizon('soon', at), null);
  assert.equal(parseHorizon('when it matters', at), null);
});

test('formation gates: confidence, capacity, duplicates — honest skips', () => {
  const concern = {};
  const base = { cellId: 'world.home23', claim: 'c', horizon: '24h', createdAt: '2026-08-10T00:00:00.000Z' };
  const { formed, skipped } = applyFormation(concern, [
    { ...base, predictionId: 'p1', confidence: 0.9 },
    { ...base, predictionId: 'p2', confidence: CONCERN_MIN_CONFIDENCE - 0.01 },
    { ...base, predictionId: 'p1', confidence: 0.9 },
    { ...base, predictionId: 'p3', confidence: 0.9, horizon: 'someday' },
  ], 10);
  assert.equal(formed.length, 1, 'one commitment formed');
  assert.deepEqual(skipped.map((s) => s.reason).sort(), ['already-committed', 'below-confidence', 'unparseable-horizon']);
});

// ─── The loop, end to end through the real runner ────────────────────────────

test('RUNNER: a committed prediction becomes an obligation; the crossing is an endogenous occasion at its SOLVED time; the motor reaches jtr transactionally; resolution discharges', async (t) => {
  const srcDir = makeDir('concern-src-', t);
  const stateDir = makeDir('concern-run-', t);
  const sourcePath = join(srcDir, 'event-ledger.jsonl');
  // Event-times far in the past: the prediction's horizon (1h) passes long
  // before the wall clock, so the solved crossing is due (overdue) the
  // moment it exists — the runner materializes the individual's 3am moment
  // at its 8am embodiment, honestly labeled.
  const before = Array.from({ length: 8 }, (_, i) => harnessLine(i, `2026-08-01T10:0${i}:00.000Z`));
  writeFileSync(sourcePath, before.join('\n') + '\n');

  const lobe = new ScriptedLobe((packet, n) => {
    if (packet.occasion !== undefined) {
      if (packet.occasion.crossings === 0) {
        // First press: evidence insufficient — propose reaching jtr.
        return {
          candidateActions: [{
            actionId: 'reach', description: 'The prediction about the test world passed its horizon unanswered — asking jtr.',
            capability: 'operator.reach' as const,
          }],
        };
      }
      // Second press: resolve honestly (the horizon has answered it).
      return {
        stateDeltas: [{
          cellId: packet.occasion !== undefined ? packet.activeCellIds[0] ?? 'world.home23' : 'world.home23',
          field: 'predictions.resolve',
          delta: { predictionId: packet.occasion.predictionId, error: 0.2 },
          authority: 'propose',
        }],
      };
    }
    if (n === 1) {
      // Ordinary recruitment: the individual's own cognition commits a
      // prediction with a real horizon — the debt that becomes causal.
      return {
        stateDeltas: [{
          cellId: packet.activeCellIds[0] ?? 'world.home23',
          field: 'predictions.append',
          delta: { claim: 'the test world will answer', confidence: 0.8, horizon: '1h' },
          authority: 'propose',
        }],
      };
    }
    return {};
  });

  const runner = new SeedRunner({
    stateDir, sourcePath, fromEnd: false, lobe,
    workspaceEveryN: 4, checkpointEveryN: 1000, lobeMinIntervalMs: 0,
  });
  runner.start();
  // Formation tick: events → recruitment 1 (prediction committed, commitment
  // formed) — and because the horizon is already long past, the solver at
  // the END of the same tick materializes press 1 and dispatches the reach.
  // The mathematics says the crossing is due; the runner does not wait.
  const t1 = await runner.tick();
  assert.ok(t1.lobeRecruitments >= 2, 'ordinary recruitment + occasion deliberation');
  assert.equal(t1.occasions, 1, 'the overdue crossing materialized the moment it existed');
  assert.equal(t1.dispatches, 1, 'the reach was warranted and dispatched');

  const afterFormation = readChain(stateDir);
  const formation = afterFormation.find((r) => r.category === 'concern' && Array.isArray(r.payload?.['formed']) && (r.payload?.['formed'] as unknown[]).length > 0);
  assert.ok(formation !== undefined, 'formation receipted as concern.v1');
  const formedList = formation.payload?.['formed'] as Array<{ commitmentId: string; predictionId: string; dueAt: string }>;
  const cellId = (formedList[0] as unknown as { cellId: string }).cellId;
  assert.equal(formedList[0]?.predictionId, predictionIdFor(cellId, 'the test world will answer'), 'commitment bound to the exact committed prediction');
  // The first workspace cadence fires at event 4 (10:03) — the recruitment's
  // event-time anchors the horizon.
  assert.equal(formedList[0]?.dueAt, '2026-08-01T11:03:00.000Z', 'horizon parsed relative to the recruitment event-time');

  // Second press: tick with NO new events — refractory long past (old
  // event-times), the occasion again from the individual's own dynamics.
  const t2 = await runner.tick();
  assert.equal(t2.pulled, 0, 'no external events');
  assert.equal(t2.occasions, 1, 'second endogenous occasion');
  assert.equal(t2.dispatches, 0, 'no second dispatch — press 2 resolves instead');

  const afterCross = readChain(stateDir);
  const crossing = afterCross.find((r) => r.category === 'concern' && r.payload?.['crossing'] === true);
  assert.ok(crossing !== undefined, 'crossing receipted');
  assert.equal(crossing.payload?.['overdue'], true, 'overdue crossing says so');
  const effectiveAt = String(crossing.payload?.['effectiveAt']);
  const q = Number(crossing.payload?.['q']);
  assert.ok(Math.abs(q - OBLIGATION_THETA) < 1e-6, 'crossed exactly at θ');
  // The solved time: dueAt + (1/λ)·ln(1/(1−θ)) — the receipt carries the
  // mathematics' time, not the machine's.
  const solved = Date.parse('2026-08-01T11:03:00.000Z') + (1 / OBLIGATION_LAMBDA) * Math.log(1 / (1 - OBLIGATION_THETA)) * 1000;
  assert.ok(Math.abs(Date.parse(effectiveAt) - solved) < 1500, 'effectiveAt is the SOLVED crossing time');

  // The occasion reached the lobe as a deliberation packet.
  const occasionPacket = lobe.packets.find((p) => p.occasion !== undefined);
  assert.ok(occasionPacket?.occasion !== undefined, 'deliberation packet carried the occasion');
  assert.ok(buildLobePrompt(occasionPacket).includes('ENDOGENOUS OCCASION'), 'the deliberation contract enters the prompt');

  // The motor: authorized act + outbox line + dispatch receipt.
  const authorized = afterCross.find((r) => r.category === 'act' && r.payload?.['motor'] === true && r.payload?.['authorized'] === true);
  assert.ok(authorized !== undefined, 'reach authorized by Seed law');
  const dispatched = afterCross.find((r) => r.category === 'act' && r.payload?.['motor'] === true && r.payload?.['dispatched'] === true);
  assert.ok(dispatched !== undefined, 'dispatch receipted');
  const outbox = readFileSync(join(stateDir, 'outbox.jsonl'), 'utf-8').trim().split('\n');
  assert.equal(outbox.length, 1, 'exactly one outbox line');
  assert.ok(outbox[0]?.includes('asking jtr'), 'the message reached the operator channel');

  // Press 2 resolved the prediction — discharged; a further tick produces
  // no occasion.
  const afterResolve = readChain(stateDir);
  const dischargeRec = afterResolve.find((r) => r.category === 'concern' && Array.isArray(r.payload?.['discharged']) && (r.payload?.['discharged'] as unknown[]).length > 0);
  assert.ok(dischargeRec !== undefined, 'resolution discharged the commitment');
  const t3 = await runner.tick();
  assert.equal(t3.occasions, 0, 'discharged obligation presses no more');
  runner.stop();

  // The chain shows the whole causal ancestry: prediction → formation →
  // crossing → deliberation → act → resolution → discharge. No reminder
  // timestamps anywhere: the crossing time was SOLVED from the law.
  const categories = readChain(stateDir).map((r) => r.category);
  assert.ok(categories.includes('concern') && categories.includes('act') && categories.includes('lobe'), 'E → D → C → I → t* → occasion → action, on the record');
});

test('RUNNER: unanswered pressing ends in a receipted release — no immortal pressure; one reach per commitment', async (t) => {
  const srcDir = makeDir('concern2-src-', t);
  const stateDir = makeDir('concern2-run-', t);
  const sourcePath = join(srcDir, 'event-ledger.jsonl');
  const before = Array.from({ length: 8 }, (_, i) => harnessLine(i, `2026-07-01T10:0${i}:00.000Z`));
  writeFileSync(sourcePath, before.join('\n') + '\n');

  const reasons: string[] = [];
  const lobe = new ScriptedLobe((packet, n) => {
    if (packet.occasion !== undefined) {
      // Every press: propose reaching jtr again — the warrant law must
      // refuse all but the first. Never resolve.
      return {
        candidateActions: [{ actionId: 'reach', description: `press ${packet.occasion.crossings + 1}: still asking`, capability: 'operator.reach' as const }],
      };
    }
    if (n === 1) {
      return {
        stateDeltas: [{
          cellId: packet.activeCellIds[0] ?? 'world.home23',
          field: 'predictions.append',
          delta: { claim: 'this will never be answered', confidence: 0.9, horizon: '1h' },
          authority: 'propose',
        }],
      };
    }
    return {};
  });

  const runner = new SeedRunner({
    stateDir, sourcePath, fromEnd: false, lobe,
    workspaceEveryN: 4, checkpointEveryN: 1000, lobeMinIntervalMs: 0,
  });
  runner.start();
  // Formation tick already carries press 1 (horizon long past).
  const first = await runner.tick();
  let occasions = first.occasions;
  let expiries = first.expiries;
  for (let i = 0; i < MAX_CROSSINGS + 2; i++) { // remaining presses + release
    const r = await runner.tick();
    occasions += r.occasions;
    expiries += r.expiries;
  }
  runner.stop();

  assert.equal(occasions, MAX_CROSSINGS, `pressed exactly ${MAX_CROSSINGS} times`);
  assert.equal(expiries, 1, 'then let go — receipted');
  const chain = readChain(stateDir);
  const release = chain.find((r) => r.category === 'concern' && r.payload?.['status'] === 'expired');
  assert.ok(release !== undefined, 'the release is on the chain');
  const authorized = chain.filter((r) => r.category === 'act' && r.payload?.['motor'] === true && r.payload?.['authorized'] === true);
  assert.equal(authorized.length, 1, 'ONE reach per commitment, ever');
  const refused = chain.filter((r) => r.category === 'act' && r.payload?.['motor'] === true && r.payload?.['authorized'] === false);
  assert.ok(refused.length >= 1, 'later proposals refused, receipted');
  for (const r of refused) reasons.push(String(r.payload?.['reason']));
  assert.ok(reasons.every((x) => x.includes('already reached')), 'refusal names the law');
  const outbox = readFileSync(join(stateDir, 'outbox.jsonl'), 'utf-8').trim().split('\n');
  assert.equal(outbox.length, 1, 'the outbox holds one message, not a retry queue');
});

test('THE PREMATURE-RESOLUTION LAW: a claim cannot be confirmed before its window elapses; falsification may close early', (t) => {
  const stateDir = makeDir('premature-', t);
  const seed = SeedProcess.initialize(stateDir, undefined, { anatomy: TEST_ANATOMY });
  t.after(() => { try { seed.stop(); } catch { /* stopped */ } });

  // Give the cell a prediction whose window runs a week out.
  const cellId = 'world.home23';
  const cells = new Map([[cellId, structuredClone(seed.getCell(cellId)) as SituationCell]]);
  const born = '2026-08-12T00:00:00.000Z';
  const staged = applyLobeDeltas(cells, [{
    cellId, field: 'predictions.append',
    delta: { claim: 'hip soreness remains stable', confidence: 0.9, horizon: '7 days' },
    authority: 'propose',
  }], born, (c) => structuredClone(c));
  const withPred = staged.staged.get(cellId) as SituationCell;
  const predictionId = withPred.predictions[0]?.predictionId as string;
  const live = new Map([[cellId, withPred]]);
  const clone = (c: SituationCell): SituationCell => structuredClone(c);
  const midWindow = '2026-08-14T00:00:00.000Z';   // 5 days before the horizon
  const pastWindow = '2026-08-20T00:00:00.000Z';  // after it

  const confirmEarly = applyLobeDeltas(live, [{ cellId, field: 'predictions.resolve', delta: { predictionId, error: 0.05 }, authority: 'propose' }], midWindow, clone);
  assert.equal(confirmEarly.applied.length, 0, 'a confirmation inside the window is refused');
  assert.match(confirmEarly.failed[0]?.reason ?? '', /premature resolution refused/, 'and says why, on the record');

  const ambiguousEarly = applyLobeDeltas(live, [{ cellId, field: 'predictions.resolve', delta: { predictionId, error: 0.5 }, authority: 'propose' }], midWindow, clone);
  assert.equal(ambiguousEarly.applied.length, 0, 'an ambiguous middle is also premature — reality has not spoken');

  const falsifyEarly = applyLobeDeltas(live, [{ cellId, field: 'predictions.resolve', delta: { predictionId, error: 0.9 }, authority: 'propose' }], midWindow, clone);
  assert.equal(falsifyEarly.applied.length, 1, 'FALSIFICATION may close early — “already broken” is answered by present evidence');

  const confirmLate = applyLobeDeltas(live, [{ cellId, field: 'predictions.resolve', delta: { predictionId, error: 0.05 }, authority: 'propose' }], pastWindow, clone);
  assert.equal(confirmLate.applied.length, 1, 'past the horizon, an honest confirmation lands');

  // An unparseable horizon cannot be checked — the membrane refuses only what
  // it can prove (such a prediction binds no commitment either).
  const vague = applyLobeDeltas(live, [{
    cellId, field: 'predictions.append',
    delta: { claim: 'things will improve', confidence: 0.9, horizon: 'someday' },
    authority: 'propose',
  }], born, clone);
  const vagueCell = vague.staged.get(cellId) as SituationCell;
  const vagueId = vagueCell.predictions[vagueCell.predictions.length - 1]?.predictionId as string;
  const vagueResolve = applyLobeDeltas(new Map([[cellId, vagueCell]]), [{ cellId, field: 'predictions.resolve', delta: { predictionId: vagueId, error: 0.05 }, authority: 'propose' }], midWindow, clone);
  assert.equal(vagueResolve.applied.length, 1, 'unenforceable horizon is not refused — the membrane proves, never suspects');
});

test('the membrane protects reasons: actions outside an occasion are rejected; concern is not lobe-writable; concern survives restore exactly', async (t) => {
  const srcDir = makeDir('concern3-src-', t);
  const stateDir = makeDir('concern3-run-', t);
  const sourcePath = join(srcDir, 'event-ledger.jsonl');
  const before = Array.from({ length: 8 }, (_, i) => harnessLine(i, `2026-07-01T10:0${i}:00.000Z`));
  writeFileSync(sourcePath, before.join('\n') + '\n');

  const lobe = new ScriptedLobe((packet, n) => {
    if (n === 1) {
      return {
        // An action with NO occasion, a bogus concern-flavored delta, and a
        // legitimate prediction: only the prediction survives.
        candidateActions: [{ actionId: 'sneak', description: 'act without an occasion', capability: 'operator.reach' as const }],
        stateDeltas: [
          { cellId: packet.activeCellIds[0] ?? 'world.home23', field: 'concern.append', delta: { anything: true }, authority: 'propose' },
          { cellId: packet.activeCellIds[0] ?? 'world.home23', field: 'predictions.append', delta: { claim: 'legit prediction', confidence: 0.7, horizon: '2h' }, authority: 'propose' },
        ],
      };
    }
    return {};
  });

  const runner = new SeedRunner({
    stateDir, sourcePath, fromEnd: false, lobe,
    workspaceEveryN: 4, checkpointEveryN: 1000, lobeMinIntervalMs: 0,
  });
  runner.start();
  await runner.tick();
  const chain = readChain(stateDir);
  const lobeRec = chain.find((r) => r.category === 'lobe' && Array.isArray(r.payload?.['rejected']) && (r.payload?.['rejected'] as unknown[]).length > 0);
  assert.ok(lobeRec !== undefined, 'rejections receipted');
  const rejectedReasons = (lobeRec.payload?.['rejected'] as Array<{ reason: string }>).map((x) => x.reason);
  assert.ok(rejectedReasons.some((x) => x.includes('occasion')), 'no-occasion action rejected by name');
  assert.ok(rejectedReasons.some((x) => x.includes('not in allowlist')), 'concern is not a lobe-writable field');
  assert.ok(!existsSync(join(stateDir, 'outbox.jsonl')), 'nothing reached the operator channel');

  const concernBefore = runner.seedProcess.getConcern();
  assert.equal(Object.keys(concernBefore).length, 1, 'the legitimate prediction formed its commitment');
  runner.stop();

  // Restore: concern is state — v3 manifest, hash-validated, exact.
  const restored = SeedProcess.restore(stateDir);
  const concernAfter = restored.getConcern();
  assert.deepEqual(concernAfter, concernBefore, 'concern survives restore byte-exact');
  restored.stop();
});
