import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import { SeedLedger } from '../src/ledger.js';
import { applyLobeDeltas, predictionIdFor, type LobeAdapter } from '../src/lobe.js';
import { cloneCell, serializeCell } from '../src/cells.js';
import { buildPacket } from '../src/workspace.js';
import { computeStateHash } from '../src/checkpoint.js';
import type { LedgerRecord, LobeResult, ProposedStateDelta, SituationCell } from '../src/types.js';
import { readSeedLearning } from '../../shared/seed-learning.cjs';
import { projectFeedbackState } from '../../shared/seed-feedback-view.cjs';

const cellId = 'world.home23';
const claim = 'pressure will fall';
const modelReceipt = { modelId: 'fixture', provider: 'fixture', invokedAt: '2026-10-29T00:00:00Z', durationMs: 0, tokensIn: 0, tokensOut: 0 };
function lobe(deltas: ProposedStateDelta[]): LobeAdapter {
  return { id: 'lobe.fixture', modelId: 'fixture', provider: 'fixture', invoke: async () => ({ observations: [], interpretations: [], predictions: [],
    stateDeltas: deltas, candidateActions: [], candidateForms: [], evidenceRefs: [], uncertainty: 0.5, modelReceipt }) };
}
const neverInvoke: LobeAdapter = { id: 'lobe.fixture', modelId: 'fixture', provider: 'fixture', invoke: async () => { throw new Error('replay must not invoke any model'); } };
function packet(seed: SeedProcess) { return buildPacket([seed.getCell(cellId) as SituationCell], seed.getState().dispositions); }
function directory(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'seed-receipt-learning-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
function historicalReceipt(seed: SeedProcess, deltas: ProposedStateDelta[], asOf: string): LedgerRecord {
  const state = seed.getState();
  const cells = new Map(state.cellIds.map(id => [id, seed.getCell(id) as SituationCell]));
  const applied = applyLobeDeltas(cells, deltas, asOf, cloneCell, undefined, undefined, undefined, true);
  return { schema: 'home23.seed.ledger.v1', seq: state.ledgerSeq + 1, prevHash: state.ledgerCursor, recordId: 'historical-fixture',
    category: 'lobe', sourceAuthority: 'seed.internal', sourceRef: 'lobe.fixture', issuedAt: asOf,
    stateHashBefore: state.stateHash, stateHashAfter: computeStateHash({
      cells: [...cells].map(([id, cell]) => serializeCell(applied.staged.get(id) ?? cell)), dispositions: state.dispositions, development: {},
    }), payload: { asOf, lobeId: 'lobe.fixture', modelId: 'fixture', provider: 'fixture', modelReceipt,
      appliedDeltas: deltas, lobeUncertainty: 0.5, rejected: [] } };
}

test('new accepted prediction receipts replay their exact eligibility without model calls or re-admission', async t => {
  const first = directory(t), second = directory(t);
  const a = SeedProcess.initialize(first, undefined, { reservoirSeed: 331 });
  const baseCheckpoint = a.checkpoint(); cpSync(first, second, { recursive: true });
  const b = SeedProcess.restore(second);
  await a.recruitLobe(lobe([{ cellId, field: 'predictions.append', authority: 'propose', delta: { claim, confidence: 0.4, horizon: '1h' } }]), packet(a), '2026-10-29T00:00:00Z');
  const appendReceipt = new SeedLedger(first).readAll().find(record => record.category === 'lobe')!;
  await b.recruitLobe(neverInvoke, packet(b), '2026-10-29T00:00:00Z', 30_000, appendReceipt);
  assert.equal(a.getState().stateHash, b.getState().stateHash);
  const outcome = { eventId: 'pressure-measured', sourceAuthority: 'home23.event-ledger' as const, sourceRef: 'sensor.pressure:measured',
    category: 'observation' as const, targetCellId: cellId, producedAt: '2026-10-29T01:01:00Z', payload: { head: 'The pressure fall was measured at 5 hPa during the forecast window.' } };
  a.transition(outcome); b.transition(outcome);
  const predictionId = a.getCell(cellId)!.predictions[0]!.predictionId;
  await a.recruitLobe(lobe([{ cellId, field: 'predictions.resolve', authority: 'propose', delta: { predictionId, error: 0.1,
    evidenceRefs: [outcome.eventId], resolutionReason: 'The measured pressure fall supports this forecast within its stated window.' } }]), packet(a), '2026-10-29T01:02:00Z');
  const resolutionReceipt = new SeedLedger(first).readAll().filter(record => record.category === 'lobe').at(-1)!;
  await b.recruitLobe(neverInvoke, packet(b), '2026-10-29T01:02:00Z', 30_000, resolutionReceipt);
  assert.equal(a.getState().stateHash, b.getState().stateHash);
  const projected = projectFeedbackState(JSON.parse(readFileSync(join(first, 'checkpoints', `${baseCheckpoint}.json`), 'utf8')),
    new SeedLedger(first).readAll());
  assert.equal(projected.cells.find((cell: { id: string }) => cell.id === cellId)?.predictions[0]?.resolutionEvidence?.verificationStatus, 'assessed',
    'the between-checkpoint surface retains assessment grade rather than presenting a model verdict as verified reality');
  a.checkpoint();
  const learned = readSeedLearning(first).lessons[0]!;
  assert.equal(learned.basis, 'outcome-assessment');
  assert.equal(learned.corroborations, 0, 'a lobe verdict is not independent corroboration');
  assert.deepEqual(learned.context, a.getCell(cellId)!.predictions[0]!.eligibility!.context);
});

test('old accepted receipts keep old semantics; a new assessment cannot invent missing old eligibility', async t => {
  const dir = directory(t);
  const seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 332 });
  const oldAppend = historicalReceipt(seed, [{ cellId, field: 'predictions.append', authority: 'propose',
    delta: { claim, confidence: 0.4, horizon: '1h' } }], '2026-10-29T00:00:00Z');
  await seed.recruitLobe(neverInvoke, packet(seed), '2026-10-29T00:00:00Z', 30_000, oldAppend);
  assert.equal(seed.getCell(cellId)!.predictions[0]!.learningVersion, undefined);
  assert.equal(seed.getCell(cellId)!.predictions[0]!.predictionId, predictionIdFor(cellId, claim));
  seed.transition({ eventId: 'legacy-result', sourceAuthority: 'home23.event-ledger', sourceRef: 'sensor.pressure:legacy', category: 'observation',
    producedAt: '2026-10-29T01:01:00Z', targetCellId: cellId, payload: { head: 'The pressure fall was measured at 5 hPa.' } });
  const result = await seed.recruitLobe(lobe([{ cellId, field: 'predictions.resolve', authority: 'propose', delta: {
    predictionId: predictionIdFor(cellId, claim), error: 0.1, evidenceRefs: ['legacy-result'],
    resolutionReason: 'The collected pressure fall is relevant to the old forecast.' } }]), packet(seed), '2026-10-29T01:02:00Z');
  assert.equal(result.applied.length, 1);
  seed.checkpoint();
  assert.equal(readSeedLearning(dir).lessons.length, 0);
  assert.ok(new SeedLedger(dir).readAll().some(record => record.category === 'development'
    && record.payload['reason'] === 'prediction_time_eligibility_unavailable'));
});

test('owner questions and unverified execution cannot resolve a world prediction', async t => {
  const dir = directory(t), seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 333 });
  await seed.recruitLobe(lobe([{ cellId, field: 'predictions.append', authority: 'propose',
    delta: { claim, confidence: 0.4, horizon: '1h' } }]), packet(seed), '2026-10-29T00:00:00Z');
  const predictionId = seed.getCell(cellId)!.predictions[0]!.predictionId;
  seed.transition({ eventId: 'owner-question', sourceAuthority: 'home23.event-ledger', sourceRef: 'conversation.jtr:question', category: 'observation',
    targetCellId: cellId, producedAt: '2026-10-29T01:01:00Z', payload: { head: 'Will the pressure fall now?' } });
  const delta = (id: string): ProposedStateDelta => ({ cellId, field: 'predictions.resolve', authority: 'propose', delta: {
    predictionId, error: 0.1, evidenceRefs: [id], resolutionReason: 'This reference contains the pressure fall words but does not establish the world outcome.' } });
  const question = await seed.recruitLobe(lobe([delta('owner-question')]), packet(seed), '2026-10-29T01:02:00Z');
  assert.equal(question.applied.length, 0);
  seed.transition({ eventId: 'handler-completed', sourceAuthority: 'home23.event-ledger', sourceRef: 'action:pressure-handler', category: 'consequence',
    targetCellId: cellId, producedAt: '2026-10-29T01:03:00Z', payload: { schema: 'home23.execution-outcome.v1',
      event_type: 'ExecutionOutcomeObserved', executionKind: 'action', executionId: 'pressure-handler', status: 'completed',
      learningVersion: 2, outcomeCriterion: 'execution', outcomeTrialId: 'action:pressure-handler', verificationStatus: 'unknown', taskOutcomeVerified: false,
      receiptEventId: 'handler-completed', evidenceRefs: ['receipt:handler'], head: 'The pressure fall check handler completed.' } });
  const execution = await seed.recruitLobe(lobe([delta('handler-completed')]), packet(seed), '2026-10-29T01:04:00Z');
  assert.equal(execution.applied.length, 0);
  assert.equal(seed.getCell(cellId)!.predictions[0]!.resolvedAt, undefined);
});

test('an agent-authored relationship correction is not external corroboration for its own prediction', async t => {
  const dir = directory(t), seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 334 });
  await seed.recruitLobe(lobe([{ cellId, field: 'predictions.append', authority: 'propose',
    delta: { claim, confidence: 0.4, horizon: '1h' } }]), packet(seed), '2026-10-29T00:00:00Z');
  const predictionId = seed.getCell(cellId)!.predictions[0]!.predictionId;
  seed.transition({ eventId: 'self-teaching', sourceAuthority: 'home23.event-ledger', sourceRef: 'relationship.correction:self', category: 'correction',
    producedAt: '2026-10-29T01:01:00Z', payload: { learningVersion: 2, actor: 'agent', entry_type: 'correction', head: 'The pressure fall occurred as I expected.' } });
  const result = await seed.recruitLobe(lobe([{ cellId, field: 'predictions.resolve', authority: 'propose', delta: {
    predictionId, error: 0.1, evidenceRefs: ['self-teaching'], resolutionReason: 'I wrote down the pressure fall myself, which does not establish an external outcome.' } }]), packet(seed), '2026-10-29T01:02:00Z');
  assert.equal(result.applied.length, 0);
  assert.equal(seed.getCell(cellId)!.predictions[0]!.resolvedAt, undefined);
});
