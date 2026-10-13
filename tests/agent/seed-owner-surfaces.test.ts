import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedProcess } from '../../substrate/src/seed.js';
import type { LobeAdapter } from '../../substrate/src/lobe.js';
import type { AnatomyCellSpec, ProposedStateDelta, SourceEvent } from '../../substrate/src/types.js';
import { FRESH_SEED_ANATOMY } from '../../cli/lib/seed-birth.js';
import { composeLivedFacts } from '../../src/substrate/lived-facts.js';
import { composeLivedRecent } from '../../src/substrate/lived-recent.js';

const start = Date.parse('2026-10-13T12:00:00.000Z');
const at = (minute: number) => new Date(start + minute * 60_000).toISOString();

function owner(messageId: string, minute: number, head: string): SourceEvent {
  return { eventId: `conv_${messageId}`, category: 'observation',
    sourceAuthority: 'home23.event-ledger', sourceRef: `conversation.jtr:coordination.message:${messageId}`,
    producedAt: at(minute), payload: { messageId, head, role: 'user', actor: { kind: 'owner', principalId: 'owner:test' } } };
}

test('new birth owner claims reach both harness surfaces and survive contact ref turnover and restore', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-voice-surfaces-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seed = SeedProcess.initialize(dir, undefined, {
    reservoirSeed: 424242, anatomy: FRESH_SEED_ANATOMY as readonly AnatomyCellSpec[],
  });
  seed.checkpoint(); // Birth publishes a checkpoint before the first contact.
  seed.transition(owner('owner-wants', 0, 'I want quieter house sensing.'));
  seed.transition(owner('owner-decided', 1, 'I decided Clay should hear my conversations.'));
  const admission = seed.workspaceCycle(at(2));
  assert.equal(admission.kind, 'workspace');
  if (admission.kind !== 'workspace') return;
  assert.ok(admission.packet.activeCellIds.includes('contact.owner.voice'));
  const lobe: LobeAdapter = { id: 'lobe.test.owner', modelId: 'fixture', provider: 'fixture',
    async invoke() {
      return { observations: [], interpretations: [], predictions: [], candidateActions: [], candidateForms: [],
        stateDeltas: [
          { cellId: 'contact.owner.voice', field: 'estimates.append', authority: 'propose',
            delta: { claim: 'The owner wants quieter house sensing.', claimKind: 'owner.wants', confidence: .9, evidenceRefs: ['owner-wants'] } },
          { cellId: 'contact.owner.voice', field: 'estimates.append', authority: 'propose',
            delta: { claim: 'The owner decided Clay should hear his conversations.', claimKind: 'owner.decided', confidence: .9, evidenceRefs: ['owner-decided'] } },
        ], evidenceRefs: admission.packet.eventRefs, uncertainty: .2,
        modelReceipt: { modelId: 'fixture', provider: 'fixture', invokedAt: at(2), durationMs: 1, tokensIn: 10, tokensOut: 10 } };
    } };
  const result = await seed.recruitLobe(lobe, admission.packet, at(2));
  assert.equal(result.rejected.length, 0);
  assert.equal(result.applied.length, 2);
  // The harness must project accepted receipts before the next checkpoint.
  assert.match(composeLivedFacts(dir) ?? '', /owner wants quieter house sensing/i);

  for (let i = 0; i < 40; i++) seed.transition(owner(`later-${i}`, i + 3, `Owner contact ${i}.`));
  for (let i = 0; i < 120; i++) seed.transition({ eventId: `house-${i}`, category: 'observation',
    sourceAuthority: 'seed.adapter', sourceRef: `house-sense:vitals:${i}`, payload: {}, producedAt: at(i + 43) });
  seed.checkpoint();
  assert.ok(seed.getCell('contact.owner.voice')!.realityRefs.every(ref => ref.messageId !== 'owner-wants'));
  const facts = composeLivedFacts(dir);
  assert.match(facts ?? '', /owner wants quieter house sensing/i);
  assert.match(facts ?? '', /owner decided Clay/);
  assert.match(facts ?? '', /owner-wants/);
  const recent = composeLivedRecent(dir);
  assert.match(recent ?? '', /quieter house sensing/);
  assert.match(recent ?? '', /Clay should hear/);
  const restored = SeedProcess.restore(dir, undefined, { requireCheckpointCoversTail: true });
  assert.equal(restored.getState().stateHash, seed.getState().stateHash);
  assert.deepEqual(restored.getCell('contact.owner.voice')!.estimates,
    seed.getCell('contact.owner.voice')!.estimates);
});

test('a fresh owner revision remains qualified after its failed prediction and message refs leave the contact window', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-revision-surfaces-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seed = SeedProcess.initialize(dir, undefined, {
    reservoirSeed: 424242, anatomy: FRESH_SEED_ANATOMY as readonly AnatomyCellSpec[],
  });
  seed.checkpoint();
  const claim = 'The owner wants Clay to hear his conversations.';
  const recruit = async (minute: number, stateDeltas: ProposedStateDelta[]) => {
    const outcome = seed.workspaceCycle(at(minute));
    assert.equal(outcome.kind, 'workspace');
    if (outcome.kind !== 'workspace') throw new Error('fixture owner contact must be admitted');
    const lobe: LobeAdapter = { id: 'lobe.test.revision', modelId: 'fixture', provider: 'fixture',
      async invoke() {
        return { observations: [], interpretations: [], predictions: [], candidateActions: [], candidateForms: [],
          stateDeltas, evidenceRefs: outcome.packet.eventRefs, uncertainty: .2,
          modelReceipt: { modelId: 'fixture', provider: 'fixture', invokedAt: at(minute), durationMs: 1, tokensIn: 10, tokensOut: 10 } };
      } };
    return seed.recruitLobe(lobe, outcome.packet, at(minute));
  };
  seed.transition(owner('initial', 0, 'Clay cannot yet hear my conversations.'));
  const predicted = await recruit(1, [{ cellId: 'contact.owner.voice', field: 'predictions.append', authority: 'propose',
    delta: { claim, confidence: .8, horizon: at(2), evidenceRefs: ['conv_initial'] } }]);
  assert.equal(predicted.rejected.length, 0);
  const predictionId = seed.getCell('contact.owner.voice')!.predictions[0]!.predictionId;
  seed.transition(owner('failure-evidence', 3, 'Clay cannot hear my conversations yet.'));
  const failed = await recruit(3, [{ cellId: 'contact.owner.voice', field: 'predictions.resolve', authority: 'propose',
    delta: { predictionId, error: .9 } }]);
  assert.equal(failed.rejected.length, 0);
  seed.transition(owner('new-owner-choice', 4, 'I want Clay to hear my conversations now.'));
  const revision = await recruit(5, [{ cellId: 'contact.owner.voice', field: 'estimates.append', authority: 'propose',
    delta: { claim, claimKind: 'owner.wants', confidence: .9, evidenceRefs: ['new-owner-choice'],
      revisesPredictionIds: [predictionId], revisionReason: 'The owner explicitly chose this in a new conversation.' } }]);
  assert.equal(revision.rejected.length, 0);
  assert.equal(revision.applied.length, 1);
  const assertSurfaces = () => {
    assert.ok(composeLivedFacts(dir)?.includes(claim), 'FACTS must qualify the supported revision');
    assert.ok(composeLivedRecent(dir)?.includes(`owner.wants: ${claim}`), 'RECENT must show the current owner revision');
  };
  assertSurfaces();
  for (let i = 0; i < 40; i++) seed.transition(owner(`turnover-${i}`, i + 6, `Later owner contact ${i}.`));
  seed.checkpoint();
  assert.ok(seed.getCell('contact.owner.voice')!.realityRefs.every(ref => ref.messageId !== 'new-owner-choice'));
  assertSurfaces();
  const restored = SeedProcess.restore(dir, undefined, { requireCheckpointCoversTail: true });
  assert.equal(restored.getState().stateHash, seed.getState().stateHash);
  assertSurfaces();
});
