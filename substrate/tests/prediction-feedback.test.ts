import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { getClaimFeedback } = createRequire(import.meta.url)('../../shared/prediction-feedback.cjs');
import { SeedProcess } from '../src/seed.js';
import { applyLobeDeltas, buildLobePrompt, predictionIdFor, type LobeAdapter } from '../src/lobe.js';
import { buildPacket, admissionScore } from '../src/workspace.js';
import { cloneCell, makeInitialCells } from '../src/cells.js';
import type { ProposedStateDelta, SituationCell, LobeResult } from '../src/types.js';

const cellId = 'world.home23';
const claim = 'The watcher process will increase contact tension within six hours';
const repeat = 'Contact tension will increase from the watcher process during the next six hours';
const dispositions = { globalWakeThreshold: 0.3, silencePolicy: 'default' as const, modelRecruitmentPolicy: 'none' as const, quietTimeEnabled: false };
const append = (text: string, extra: Record<string, unknown> = {}): ProposedStateDelta => ({
  cellId, field: 'predictions.append', authority: 'propose',
  delta: { claim: text, confidence: 0.8, horizon: '6h', ...extra },
});
function lobe(deltas: ProposedStateDelta[]): LobeAdapter {
  return { id: 'test.feedback', modelId: 'test', provider: 'test', invoke: async () => ({
    observations: [], interpretations: [], predictions: [], stateDeltas: deltas,
    candidateActions: [], candidateForms: [], evidenceRefs: [], uncertainty: 0.5,
    modelReceipt: { modelId: 'test', provider: 'test', invokedAt: '2026-09-26T00:00:00Z', durationMs: 1, tokensIn: 1, tokensOut: 1 },
  } as LobeResult) };
}
function packet(seed: SeedProcess) { return buildPacket([seed.getCell(cellId) as SituationCell], dispositions); }
function chain(dir: string) { return readFileSync(join(dir, 'seed-ledger.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s)); }

test('failed repetitions stop creating obligations; newer evidenced revision and unrelated curiosity remain possible', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-feedback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 812 });
  const recruit = (deltas: ProposedStateDelta[], at: string) => seed.recruitLobe(lobe(deltas), packet(seed), at);
  const first = await recruit([append(claim)], '2026-09-26T00:00:00Z');
  const firstId = (first.applied[0]?.delta as { predictionId: string }).predictionId;
  await recruit([{ cellId, field: 'predictions.resolve', authority: 'propose', delta: { predictionId: firstId, error: 0.9 } }], '2026-09-26T00:10:00Z');
  const second = await recruit([append(repeat)], '2026-09-26T01:00:00Z');
  const secondId = (second.applied[0]?.delta as { predictionId: string }).predictionId;
  await recruit([{ cellId, field: 'predictions.resolve', authority: 'propose', delta: { predictionId: secondId, error: 0.95 } }], '2026-09-26T01:10:00Z');
  const context = packet(seed);
  assert.equal(context.resolvedPredictions?.length, 2);
  assert.match(buildLobePrompt(context), /resolvedPredictions/);
  assert.ok(context.resolvedPredictions?.every(p => (p.error ?? 0) >= 0.7));

  const before = seed.getState().stateHash;
  const formedBefore = chain(dir).filter(r => r.category === 'concern').length;
  const blocked = await recruit([append(claim)], '2026-09-26T02:00:00Z');
  assert.equal(blocked.applied.length, 0);
  assert.match(blocked.rejected[0]?.reason ?? '', /failed prediction family/);
  assert.equal(seed.getState().stateHash, before);
  assert.equal(chain(dir).filter(r => r.category === 'concern').length, formedBefore);

  const twice = await recruit([{ cellId, field: 'predictions.resolve', authority: 'propose', delta: { predictionId: secondId, error: 0.95 } }], '2026-09-26T02:01:00Z');
  assert.equal(twice.applied.length, 0);
  assert.match(twice.rejected[0]?.reason ?? '', /already resolved/);
  assert.equal(seed.getState().stateHash, before, 'repeat resolution cannot repeat development');

  const creative = await recruit([{ cellId, field: 'estimates.append', authority: 'propose', delta: {
    claim: 'The offbeat in this music suggests a playful question about anticipation', confidence: 0.35, evidenceRefs: [],
  } }], '2026-09-26T02:02:00Z');
  assert.equal(creative.applied.length, 1);
  assert.equal(chain(dir).filter(r => r.category === 'concern').length, formedBefore, 'association makes no prediction debt');

  const event = seed.transition({ eventId: 'new-owner-evidence', sourceAuthority: 'home23.event-ledger', sourceRef: 'conversation.jtr:test',
    category: 'observation', producedAt: '2026-09-26T03:00:00Z', payload: { head: 'I measured a new watcher process failure and contact delay after the configuration changed.' } });
  assert.equal(event.cellId, cellId);
  const revision = { evidenceRefs: ['new-owner-evidence'], revisesPredictionIds: [secondId], revisionReason: 'A newly measured process failure after configuration changed supplies evidence the earlier guesses lacked.' };
  const accepted = await recruit([append(claim, revision)], '2026-09-26T03:01:00Z');
  assert.equal(accepted.applied.length, 1);
  const newId = (accepted.applied[0]?.delta as { predictionId: string }).predictionId;
  assert.notEqual(newId, firstId, 'revisiting identical words creates a distinct occurrence');
  const revised = seed.getCell(cellId)!.predictions.at(-1)!;
  assert.equal(revised.revisionEvidence?.refs[0]?.refId, 'new-owner-evidence');
  assert.equal((accepted.applied[0]?.delta as { revisionEvidence?: { version: number } }).revisionEvidence?.version, 1);
  assert.equal(getClaimFeedback({ ...seed.getCell(cellId), realityRefs: [] }, revised).hasSupportedRevision, true,
    'receipt-carried evidence preserves admission after the reference window moves on');

  const formation = chain(dir).filter(r => r.category === 'concern').at(-1);
  assert.equal(formation.payload.formed[0].predictionId, newId);
  const duplicate = await recruit([append(repeat, revision)], '2026-09-26T03:02:00Z');
  assert.equal(duplicate.applied.length, 0);
  assert.match(duplicate.rejected[0]?.reason ?? '', /already open/);
  const beforeRestore = seed.getState().stateHash;
  seed.stop();
  const restored = SeedProcess.restore(dir);
  assert.equal(restored.getState().stateHash, beforeRestore);
  assert.deepEqual(restored.getCell(cellId)?.predictions.at(-1)?.evidenceRefs, ['new-owner-evidence']);
});

test('intentions can be released explicitly and their pressure contribution disappears', () => {
  const cells = makeInitialCells('2026-09-26T00:00:00Z');
  const added = applyLobeDeltas(cells, [{ cellId, field: 'intentions.append', authority: 'propose', delta: {
    description: 'Explore how syncopation changes expectation', direction: 'curiosity', magnitude: 0.8,
  } }], '2026-09-26T01:00:00Z', cloneCell, undefined, { version: 1, occurrence: '1' });
  const open = added.staged.get(cellId)!;
  const context = buildPacket([open], dispositions);
  assert.equal(context.tensions[0]?.description, open.intentions[0]?.description);
  const closed = applyLobeDeltas(added.staged, [{ cellId, field: 'intentions.resolve', authority: 'propose', delta: {
    tensionId: open.intentions[0]?.tensionId, reason: 'The question can rest until another listening experience gives it somewhere to go.',
  } }], '2026-09-26T02:00:00Z', cloneCell, undefined, { version: 1, occurrence: '2' });
  const settled = closed.staged.get(cellId)!;
  assert.equal(settled.intentions[0]?.open, false);
  assert.ok(admissionScore(settled) < admissionScore(open));
  assert.equal(buildPacket([settled], dispositions).tensions.length, 0);
  assert.equal(open.intentions[0]?.open, true, 'staging does not mutate original history');
});

test('historical unversioned deltas keep their interpretation; new receipts replay exact occurrence metadata', () => {
  const start = makeInitialCells('2026-09-26T00:00:00Z');
  const old = applyLobeDeltas(start, [append(claim), append(claim)], '2026-09-26T01:00:00Z', cloneCell);
  const historical = old.staged.get(cellId)!;
  assert.equal(historical.predictions.length, 2, 'historical receipt is not re-admitted through new gates');
  assert.equal(historical.predictions[0]?.predictionId, predictionIdFor(cellId, claim));
  assert.equal(historical.predictions[1]?.predictionId, predictionIdFor(cellId, claim));
  assert.equal(historical.predictions[0]?.evidenceRefs, undefined, 'legacy state hash gains no synthetic fields');

  const current = applyLobeDeltas(start, [append(claim)], '2026-09-26T01:00:00Z', cloneCell, undefined, { version: 1, occurrence: '3' });
  const replay = applyLobeDeltas(start, current.applied, '2026-09-26T01:00:00Z', cloneCell);
  assert.deepEqual(replay.staged.get(cellId)?.predictions, current.staged.get(cellId)?.predictions);
  const resolved = applyLobeDeltas(current.staged, [{ cellId, field: 'predictions.resolve', authority: 'propose', delta: {
    predictionId: current.staged.get(cellId)?.predictions[0]?.predictionId, error: 0.9,
  } }], '2026-09-26T01:10:00Z', cloneCell, undefined, { version: 1, occurrence: '4' });
  const replayResolved = applyLobeDeltas(replay.staged, resolved.applied, '2026-09-26T01:10:00Z', cloneCell);
  assert.deepEqual(replayResolved.staged.get(cellId)?.predictions, resolved.staged.get(cellId)?.predictions);
});

test('checkpoint twins continue through feedback admission and intention closure with identical state', async t => {
  const original = mkdtempSync(join(tmpdir(), 'seed-feedback-original-'));
  const copied = mkdtempSync(join(tmpdir(), 'seed-feedback-copy-'));
  t.after(() => { rmSync(original, { recursive: true, force: true }); rmSync(copied, { recursive: true, force: true }); });
  const a = SeedProcess.initialize(original, undefined, { reservoirSeed: 91 });
  const first = await a.recruitLobe(lobe([append(claim), { cellId, field: 'intentions.append', authority: 'propose', delta: {
    description: 'Follow the question until there is an answer or a reason to release it', direction: 'curiosity', magnitude: 0.6,
  } }]), packet(a), '2026-09-26T00:00:00Z');
  const id = (first.applied[0]?.delta as { predictionId: string }).predictionId;
  a.checkpoint();
  cpSync(original, copied, { recursive: true });
  const b = SeedProcess.restore(copied);
  assert.equal(a.getState().stateHash, b.getState().stateHash);
  const continuation: ProposedStateDelta[] = [
    { cellId, field: 'predictions.resolve', authority: 'propose', delta: { predictionId: id, error: 0.95 } },
    { cellId, field: 'intentions.resolve', authority: 'propose', delta: { tensionId: a.getCell(cellId)?.intentions[0]?.tensionId, reason: 'The hypothesis failed; release the pressure and follow a different question.' } },
  ];
  await a.recruitLobe(lobe(continuation), packet(a), '2026-09-26T01:00:00Z');
  await b.recruitLobe(lobe(continuation), packet(b), '2026-09-26T01:00:00Z');
  assert.equal(a.getState().stateHash, b.getState().stateHash);
  assert.equal(a.getCell(cellId)?.intentions[0]?.open, false);
  assert.equal(b.getCell(cellId)?.predictions[0]?.error, 0.95);
});

test('new occurrence IDs never reuse a forgotten historical ID after bounded prediction eviction', () => {
  const empty = makeInitialCells('2026-09-26T00:00:00Z');
  const one = applyLobeDeltas(empty, [append(claim)], '2026-09-26T01:00:00Z', cloneCell, undefined, { version: 1, occurrence: '10' });
  // A later cell with no retained predictions is indistinguishable from the
  // original empty window; the monotonically receipted occurrence prevents reuse.
  const later = applyLobeDeltas(empty, [append(claim)], '2026-09-27T01:00:00Z', cloneCell, undefined, { version: 1, occurrence: '99' });
  assert.notEqual(one.staged.get(cellId)?.predictions[0]?.predictionId, later.staged.get(cellId)?.predictions[0]?.predictionId);
});

test('exploratory interpretation is receipted and reaches the next Seed lobe without factual state or obligation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-advisory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 92 });
  const thought = 'Could syncopation make the space between notes feel like a conversation?';
  const think: LobeAdapter = { ...lobe([]), invoke: async p => ({
    ...await lobe([]).invoke(p), interpretations: [{ cellId, interpretation: thought, confidence: 0.4 }],
  }) };
  const before = seed.getState().stateHash;
  const formedBefore = Object.keys(seed.getConcern()).length;
  const result = await seed.recruitLobe(think, packet(seed), '2026-09-26T01:00:00Z');
  assert.equal(result.applied.length, 0);
  assert.equal(seed.getState().stateHash, before, 'exploration is not a belief mutation');
  assert.equal(Object.keys(seed.getConcern()).length, formedBefore);
  const receipt = chain(dir).find(r => r.seq === result.seq);
  assert.equal(receipt.payload.advisory.interpretations[0].interpretation, thought);
  seed.stop();
  const restored = SeedProcess.restore(dir);
  let carried: string | undefined;
  const next: LobeAdapter = { ...lobe([]), invoke: async p => {
    carried = p.recentConsiderations?.[0]?.text;
    assert.equal(p.recentConsiderations?.[0]?.kind, 'interpretation');
    assert.equal(p.recentConsiderations?.[0]?.seq, result.seq);
    assert.match(buildLobePrompt(p), /prior thoughts, not independent evidence/);
    return lobe([]).invoke(p);
  } };
  await restored.recruitLobe(next, packet(restored), '2026-09-26T02:00:00Z');
  assert.equal(carried, thought);
  assert.equal(restored.getState().stateHash, before);
});


test('the packet exposes every retained verdict that can gate a revision, including older failed IDs', () => {
  const cell = makeInitialCells('2026-09-26T00:00:00Z').get(cellId)!;
  cell.predictions = Array.from({ length: 20 }, (_, i) => ({ predictionId: `old-${i}`, claim: i < 2 ? claim : `Unrelated forecast number ${i}`,
    confidence: 0.8, horizon: '1h', createdAt: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    resolvedAt: `2026-09-${String(i + 1).padStart(2, '0')}T01:00:00Z`, error: i < 2 ? 0.9 : 0.1 }));
  const context = buildPacket([cell], dispositions);
  assert.equal(context.resolvedPredictions?.length, 20);
  assert.ok(context.resolvedPredictions?.some(p => p.predictionId === 'old-1'));
});

test('new resolution receipts distinguish legacy duplicate IDs even with identical creation times', () => {
  const empty = makeInitialCells('2026-09-26T00:00:00Z');
  const legacy = applyLobeDeltas(empty, [append(claim), append(claim)], '2026-09-26T01:00:00Z', cloneCell).staged;
  const oldId = predictionIdFor(cellId, claim);
  const firstClosed = applyLobeDeltas(legacy, [{ cellId, field: 'predictions.resolve', authority: 'propose', delta: { predictionId: oldId, error: 0.9 } }], '2026-09-26T02:00:00Z', cloneCell).staged;
  const secondClosed = applyLobeDeltas(firstClosed, [{ cellId, field: 'predictions.resolve', authority: 'propose', delta: { predictionId: oldId, error: 0.95 } }], '2026-09-26T03:00:00Z', cloneCell, undefined, { version: 1, occurrence: '9' });
  const replay = applyLobeDeltas(firstClosed, secondClosed.applied, '2026-09-26T03:00:00Z', cloneCell);
  assert.deepEqual(replay.staged.get(cellId)?.predictions, secondClosed.staged.get(cellId)?.predictions);
  assert.equal(replay.staged.get(cellId)?.predictions[0]?.error, 0.9);
  assert.equal(replay.staged.get(cellId)?.predictions[1]?.error, 0.95);
});


test('a model cannot forge revision admission evidence; genuine estimate witnesses replay unchanged', () => {
  const cells = makeInitialCells('2026-09-26T00:00:00Z');
  const cell = cells.get(cellId)!;
  cell.predictions = [0, 1].map(i => ({ predictionId: `failed-${i}`, claim, confidence: 0.8, horizon: '1h',
    createdAt: `2026-09-26T0${i}:00:00Z`, resolvedAt: `2026-09-26T0${i}:10:00Z`, error: 0.9 }));
  const ref = { refId: 'real', sourceRef: 'conversation.jtr:s', sourceAuthority: 'home23.event-ledger' as const,
    observedAt: '2026-09-26T02:00:00Z', head: 'A newly measured watcher process failure followed the configuration change.', confidence: 1, flag: 'COLLECTED' as const };
  const metadata = { evidenceRefs: ['real'], revisesPredictionIds: ['failed-1'], revisionReason: 'The new measurement records an actual watcher process failure after the configuration changed.',
    revisionEvidence: { version: 1, admittedAt: '2026-09-26T03:00:00Z', failedPredictionIds: ['failed-1'], refs: [ref] } };
  const refused = applyLobeDeltas(cells, [append(claim, metadata)], '2026-09-26T03:00:00Z', cloneCell, undefined, { version: 1, occurrence: '10' });
  assert.equal(refused.applied.length, 0, 'model snapshot cannot substitute for absent current evidence');
  const estimateDelta: ProposedStateDelta = { cellId, field: 'estimates.append', authority: 'propose', delta: { claim, confidence: 0.7, ...metadata } };
  const unsupported = applyLobeDeltas(cells, [estimateDelta], '2026-09-26T03:00:00Z', cloneCell, undefined, { version: 1, occurrence: '11' });
  assert.equal(unsupported.staged.get(cellId)?.estimates[0]?.revisionEvidence, undefined);
  cell.realityRefs = [ref];
  const real = applyLobeDeltas(cells, [estimateDelta], '2026-09-26T03:00:00Z', cloneCell, undefined, { version: 1, occurrence: '12' });
  const estimate = real.staged.get(cellId)!.estimates[0]!;
  assert.equal(estimate.revisionEvidence?.refs[0]?.refId, 'real');
  const replay = applyLobeDeltas(cells, real.applied, '2026-09-26T03:00:00Z', cloneCell);
  assert.deepEqual(replay.staged.get(cellId)?.estimates, real.staged.get(cellId)?.estimates);
  const withoutRefs = { ...cell, realityRefs: [] };
  assert.equal(getClaimFeedback(withoutRefs, estimate).hasSupportedRevision, true);
  withoutRefs.predictions = [...cell.predictions, { ...cell.predictions[1]!, predictionId: 'failed-again', resolvedAt: '2026-09-26T04:00:00Z', createdAt: '2026-09-26T03:00:00Z' }];
  assert.equal(getClaimFeedback(withoutRefs, estimate).hasSupportedRevision, false, 'later failure invalidates the earlier revision witness');
});

test('actual Seed refuses equivalent simultaneous inquiry pressure but allows a distinct inquiry and a released topic to return', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-intention-duplicates-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 815 });
  const intention = (description: string): ProposedStateDelta => ({cellId, field: 'intentions.append', authority: 'propose', delta: {description, direction: 'curiosity', magnitude: 0.6}});
  const description = 'Explore how syncopation changes musical expectation';
  await seed.recruitLobe(lobe([intention(description)]), packet(seed), '2026-09-26T01:00:00Z');
  const originalId = seed.getCell(cellId)!.intentions[0]!.tensionId;
  const repeat = await seed.recruitLobe(lobe([intention('Explore how musical expectation changes with syncopation!')]), packet(seed), '2026-09-26T02:00:00Z');
  assert.equal(repeat.applied.length, 0); assert.match(repeat.rejected[0]?.reason ?? '', /already open/);
  const different = await seed.recruitLobe(lobe([intention('Imagine a garden that changes colors with afternoon music')]), packet(seed), '2026-09-26T03:00:00Z');
  assert.equal(different.applied.length, 1);
  await seed.recruitLobe(lobe([{cellId, field: 'intentions.resolve', authority: 'propose', delta: {tensionId: originalId, reason: 'The question can rest until another listening experience.'}}]), packet(seed), '2026-09-26T04:00:00Z');
  const returned = await seed.recruitLobe(lobe([intention(description)]), packet(seed), '2026-09-26T05:00:00Z');
  assert.equal(returned.applied.length, 1);
  assert.notEqual(seed.getCell(cellId)!.intentions.at(-1)!.tensionId, originalId);
});
