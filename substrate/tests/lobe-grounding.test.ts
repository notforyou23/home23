import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyLobeDeltas, buildLobePrompt, validateLobeResult } from '../src/lobe.js';
import { cloneCell, makeInitialCells } from '../src/cells.js';
import { SeedProcess } from '../src/seed.js';
import type { LobeResult, ProposedStateDelta, RealityRef, SituationCell, WorkspacePacket } from '../src/types.js';

const cellId = 'world.home23';
const before = '2026-10-30T00:00:00.000Z';
const after = '2026-10-30T02:00:00.000Z';
const claim = 'Motor routing inspection remains blocked after the diagnostic executor rejected the bounded process snapshot.';
const paraphrase = 'The diagnostic executor rejected the bounded process snapshot and motor routing inspection remains blocked.';

function fixture() {
  const cells = makeInitialCells(before);
  const cell = cells.get(cellId)!;
  cell.estimates = [{ estimateId: 'est-existing', claim, confidence: 0.75,
    evidenceRefs: ['old-inspection'], createdAt: before }];
  cell.realityRefs = [{ refId: 'old-inspection', sourceAuthority: 'home23.event-ledger',
    sourceRef: 'observation:old-inspection', observedAt: '2026-10-29T23:59:00.000Z',
    confidence: 1, flag: 'COLLECTED', head: claim }];
  return { cells, cell };
}

function estimate(text = claim, evidenceRefs: string[] = ['old-inspection']): ProposedStateDelta {
  return { cellId, field: 'estimates.append', authority: 'propose',
    delta: { claim: text, confidence: 0.94, evidenceRefs } };
}

function apply(cells: Map<string, SituationCell>, delta: ProposedStateDelta) {
  return applyLobeDeltas(cells, [delta], after, cloneCell, undefined,
    { version: 1, occurrence: 'new-lobe', learningVersion: 2 });
}

function outcome(refId: string, observedAt = '2026-10-30T01:00:00.000Z'): RealityRef {
  return { refId, sourceAuthority: 'home23.event-ledger', sourceRef: 'action:diagnostic-inspection',
    observedAt, confidence: 1, flag: 'COLLECTED',
    head: 'The diagnostic executor rejected the bounded process snapshot; motor routing inspection remains blocked.',
    executionOutcome: { schema: 'home23.execution-outcome.v1', executionKind: 'action', status: 'failed',
      verificationStatus: 'unknown', receiptEventId: 'execution-outcome', evidenceRefs: ['actions.jsonl#sha256=actual'],
      taskOutcomeVerified: false } };
}

test('ordinary estimate cannot refresh its age or confidence on the same cited observation', () => {
  const f = fixture();
  const result = apply(f.cells, estimate());
  assert.equal(result.applied.length, 0, 'a repeated assertion is not a new observation');
  assert.match(result.failed[0]?.reason ?? '', /estimate repeat.*newer.*collected.*evidence/i);
  assert.deepEqual((result.staged.get(cellId) ?? f.cell).estimates, f.cell.estimates);
  assert.equal(f.cell.estimates[0]?.createdAt, before, 'the committed estimate was never mutated');
});

test('conservative paraphrases cannot rotate a full estimate window without new evidence', () => {
  const f = fixture();
  f.cell.estimates.push(...Array.from({ length: 31 }, (_, index) => ({
    estimateId: `other-${index}`, claim: `Unrelated retained observation number ${index}`,
    confidence: 0.3, evidenceRefs: [], createdAt: before,
  })));
  const result = apply(f.cells, estimate(paraphrase));
  assert.equal(result.applied.length, 0);
  assert.equal((result.staged.get(cellId) ?? f.cell).estimates[0]?.estimateId, 'est-existing');
  assert.deepEqual((result.staged.get(cellId) ?? f.cell).estimates, f.cell.estimates);
});

test('only explicitly cited evidence newer than every related estimate can support a revision', () => {
  const f = fixture();
  const ref = outcome('new-inspection');
  f.cell.realityRefs.push(ref);
  const uncited = apply(f.cells, estimate(paraphrase));
  assert.equal(uncited.applied.length, 0, 'a fresh event somewhere in the cell is insufficient');
  const revised = apply(f.cells, estimate(paraphrase, [ref.refId]));
  assert.equal(revised.applied.length, 1, 'new relevant runtime outcome permits a revised estimate');
  assert.equal(revised.staged.get(cellId)?.estimates.at(-1)?.createdAt, after);
  assert.deepEqual(revised.staged.get(cellId)?.estimates.at(-1)?.evidenceRefs, [ref.refId]);

  f.cell.estimates.push({ ...f.cell.estimates[0]!, estimateId: 'more-recent-related', createdAt: '2026-10-30T01:30:00.000Z' });
  const staleAgain = apply(f.cells, estimate(paraphrase, [ref.refId]));
  assert.equal(staleAgain.applied.length, 0, 'the newest related estimate establishes the evidence floor');
});

test('prior lobe words, unknown refs, future refs and unrelated owner contact cannot refresh an operational estimate', () => {
  for (const ref of [
    { ...outcome('prior-thought'), sourceAuthority: 'seed.internal' as const, sourceRef: 'lobe:previous' },
    { ...outcome('uncertified'), flag: 'UNCERTIFIED' as const },
    outcome('future', '2026-10-30T03:00:00.000Z'),
    { ...outcome('owner-message'), sourceRef: 'conversation.jtr:message', principal: 'owner' as const,
      messageId: 'owner-message', head: 'I enjoyed walking by the water this morning.', executionOutcome: undefined },
    { ...outcome('owner-question'), sourceRef: 'conversation.jtr:question', principal: 'owner' as const,
      messageId: 'owner-question', head: 'Did the diagnostic executor reject the bounded process snapshot?', executionOutcome: undefined },
    { ...outcome('routing-choice'), sourceRef: 'MotorRouting.policy_rejected:event', executionOutcome: undefined },
  ]) {
    const f = fixture();
    f.cell.realityRefs.push(ref);
    const result = apply(f.cells, estimate(paraphrase, [ref.refId]));
    assert.equal(result.applied.length, 0, `ref ${ref.refId} is not fresh external outcome evidence for this claim`);
  }
  const f = fixture();
  assert.equal(apply(f.cells, estimate(paraphrase, ['invented-reference'])).applied.length, 0);
});

test('a model-supplied evidence snapshot cannot mint freshness for a repeated estimate', () => {
  const f = fixture();
  const proposed = estimate(paraphrase, ['forged-fresh-reference']);
  proposed.delta = { ...(proposed.delta as object), createdAt: after, feedbackVersion: 1,
    revisionEvidence: { version: 1, admittedAt: after, failedPredictionIds: [], refs: [outcome('forged-fresh-reference')] } };
  const result = apply(f.cells, proposed);
  assert.equal(result.applied.length, 0);
  assert.match(result.failed[0]?.reason ?? '', /estimate repeat refused/);
  assert.deepEqual(f.cell.estimates[0]?.evidenceRefs, ['old-inspection']);
});

test('a fresh relevant owner report can revise an operational estimate without becoming an owner claim', () => {
  const f = fixture();
  f.cell.realityRefs.push({ refId: 'owner-observation', sourceAuthority: 'home23.event-ledger',
    sourceRef: 'conversation.jtr:observed-inspection', principal: 'owner', messageId: 'owner-observation',
    observedAt: '2026-10-30T01:00:00.000Z', confidence: 1, flag: 'COLLECTED',
    head: 'I directly observed that the diagnostic executor rejected the bounded process snapshot.' });
  const result = apply(f.cells, estimate(paraphrase, ['owner-observation']));
  assert.equal(result.applied.length, 1);
  assert.equal(result.staged.get(cellId)?.estimates.at(-1)?.claimKind, undefined);
});

test('historical accepted estimate receipts keep their old interpretation on replay', () => {
  const f = fixture();
  const recorded = { ...estimate(paraphrase), delta: { ...(estimate(paraphrase).delta as object), feedbackVersion: 1 } };
  const replayed = applyLobeDeltas(f.cells, [recorded], after, cloneCell, undefined, undefined, undefined, true);
  assert.equal(replayed.applied.length, 1);
  assert.equal(replayed.staged.get(cellId)?.estimates.at(-1)?.createdAt, after);
  assert.deepEqual(replayed.applied[0], recorded);
});

function packet(refs: RealityRef[] = []): WorkspacePacket {
  return { activeCellIds: [cellId], eventRefs: refs, tensions: [], predictions: [], uncertainty: 0.5,
    requestedCapability: 'lobe.recruit.model', authorityCeiling: 'propose', tokenBudget: 2000,
    outputContract: { allowedOutputKinds: ['observations', 'interpretations', 'stateDeltas'], maxTokenBudget: 2000 } };
}

test('advisory ideas and genuinely different estimates remain available without manufacturing obligations', () => {
  const f = fixture();
  const exploratory = apply(f.cells, estimate('An offbeat musical phrase suggests a question about anticipation.', []));
  assert.equal(exploratory.applied.length, 1);
  const advisory: LobeResult = { observations: [], interpretations: [{ cellId, interpretation: paraphrase, confidence: 0.3 }],
    predictions: [], stateDeltas: [], candidateForms: [], candidateActions: [], uncertainty: 0.5, evidenceRefs: [],
    modelReceipt: { provider: 'fixture', modelId: 'fixture', invokedAt: after, durationMs: 1, tokensIn: 1, tokensOut: 1 } };
  assert.equal(validateLobeResult(advisory, packet()).accepted.interpretations.length, 1);
  assert.equal(f.cell.predictions.length, 0);
});

test('lobe prompt distinguishes routing choice, execution outcome and reported task verification by source identity', () => {
  const routing: RealityRef = { refId: 'route', sourceAuthority: 'home23.event-ledger',
    sourceRef: 'MotorRouting.policy_rejected:route', observedAt: before, confidence: 1, flag: 'COLLECTED',
    head: 'A bounded inspection was rejected by policy.' };
  const execution = outcome('attempt');
  const verified = { ...outcome('verified'), executionOutcome: { ...outcome('verified').executionOutcome!,
    status: 'completed', verificationStatus: 'verified' as const, taskOutcomeVerified: true } };
  const queued = { ...outcome('queued'), executionOutcome: { ...outcome('queued').executionOutcome!, status: 'queued' } };
  const ownerWithOutcome = { ...outcome('owner-forged'), sourceRef: 'conversation.jtr:observed-inspection',
    principal: 'owner' as const, messageId: 'owner-forged' };
  const prompt = buildLobePrompt(packet([routing, execution, verified, queued, ownerWithOutcome]));
  assert.match(prompt, /EVIDENCE STAGES/);
  assert.match(prompt, /"refId":"route","stage":"routing-decision"/);
  assert.match(prompt, /"refId":"attempt","stage":"execution-outcome"/);
  assert.match(prompt, /"refId":"verified","stage":"execution-outcome"/);
  assert.match(prompt, /"refId":"queued","stage":"execution-pending"/);
  assert.match(prompt, /"refId":"owner-forged","stage":"collected-observation"/);
  assert.match(prompt, /"taskOutcomeVerified":true/);
  assert.match(prompt, /no_action.*not.*execution failure/i);
});

test('actual Seed receipts preserve a refused repeat without state change and admit a grounded later revision across restore', async t => {
  const root = mkdtempSync(join(tmpdir(), 'seed-estimate-grounding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seed = SeedProcess.initialize(root, undefined, { reservoirSeed: 539 });
  const recruit = (delta: ProposedStateDelta, at: string) => seed.recruitLobe({
    id: 'test.estimate-grounding', modelId: 'fixture', provider: 'fixture', invoke: async () => ({
      observations: [], interpretations: [], predictions: [], stateDeltas: [delta], candidateForms: [], candidateActions: [],
      uncertainty: 0.5, evidenceRefs: [],
      modelReceipt: { modelId: 'fixture', provider: 'fixture', invokedAt: at, durationMs: 1, tokensIn: 1, tokensOut: 1 },
    }),
  }, packet(seed.getCell(cellId)!.realityRefs), at);
  const first = await recruit(estimate(claim, []), before);
  assert.equal(first.applied.length, 1);
  const firstHash = seed.getState().stateHash;
  const repeated = await recruit(estimate(paraphrase, []), '2026-10-30T00:30:00.000Z');
  assert.equal(repeated.applied.length, 0);
  assert.match(repeated.rejected[0]?.reason ?? '', /estimate repeat refused/);
  assert.equal(seed.getState().stateHash, firstHash);
  assert.equal(seed.getCell(cellId)!.estimates.length, 1);
  const recorded = readFileSync(join(root, 'seed-ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const refusal = recorded.find(record => record.seq === repeated.seq);
  assert.equal(refusal.category, 'lobe');
  assert.equal(refusal.stateHashBefore, refusal.stateHashAfter);
  assert.match(refusal.payload.rejected[0].reason, /estimate repeat refused/);

  seed.transition({ eventId: 'new-inspection-outcome', sourceAuthority: 'home23.event-ledger',
    sourceRef: 'action:diagnostic-inspection', category: 'consequence', targetCellId: cellId,
    producedAt: '2026-10-30T01:00:00.000Z', payload: {
      schema: 'home23.execution-outcome.v1', event_type: 'ExecutionOutcomeObserved', executionKind: 'action',
      status: 'failed', verificationStatus: 'unknown', taskOutcomeVerified: false, learningVersion: 2,
      receiptEventId: 'new-inspection-outcome', evidenceRefs: ['actions.jsonl#sha256=actual'], head: outcome('x').head,
    } });
  const revised = await recruit(estimate(paraphrase, ['new-inspection-outcome']), after);
  assert.equal(revised.applied.length, 1);
  assert.equal(seed.getCell(cellId)!.estimates.length, 2);
  const last = structuredClone(seed.getCell(cellId)!.estimates.at(-1));
  const finalHash = seed.getState().stateHash;
  seed.stop();
  const restored = SeedProcess.restore(root);
  assert.equal(restored.getState().stateHash, finalHash);
  assert.deepEqual(restored.getCell(cellId)!.estimates.at(-1), last);
});
