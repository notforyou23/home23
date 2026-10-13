import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import { makeInitialCells, routeEvent, routingFromAnatomy, cloneCell } from '../src/cells.js';
import { evaluateWorkspace } from '../src/workspace.js';
import { applyLobeDeltas, buildLobePrompt } from '../src/lobe.js';
import { EventLedgerTailAdapter } from '../src/adapters/event-ledger-tail.js';
import { emptyCellPlasticState } from '../src/plasticity.js';
import { createConversationShipper } from '../src/conversation-shipper.js';
import { getClaimFeedback } from '../../shared/prediction-feedback.cjs';
import type { AnatomyCellSpec, SourceEvent, WorkspacePacket, ResourceBudget } from '../src/types.js';

const anatomy: AnatomyCellSpec[] = [
  { id: 'contact.owner.voice', role: 'owner' },
  { id: 'work.corrections', role: 'correction' },
  { id: 'world.home', role: 'observation' },
  { id: 'periphery.open-field', role: 'periphery' },
];
function owner(id: string, ts = '2026-10-13T12:00:00.000Z'): SourceEvent {
  return { eventId: `conv_${id}`, category: 'observation', sourceAuthority: 'home23.event-ledger',
    sourceRef: `conversation.jtr:coordination.message:${id}`, producedAt: ts,
    payload: { role: 'user', messageId: id, head: 'I want my conversations to matter.', actor: { kind: 'owner', principalId: 'owner-1' } } };
}
function dir(t: { after(fn: () => void): void }): string {
  const path = mkdtempSync(join(tmpdir(), 'substrate-owner-voice-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
test('owner voice routing is separate from house, peer and machine correction traffic', () => {
  const ids = anatomy.map(a => a.id);
  const routing = routingFromAnatomy(anatomy);
  assert.equal(routeEvent(owner('m1'), ids, undefined, routing), 'contact.owner.voice');
  assert.equal(routeEvent({ ...owner('m2'), sourceRef: 'house-sense:vitals' }, ids, undefined, routing), 'world.home');
  assert.equal(routeEvent({ ...owner('m3'), sourceRef: 'conversation.peer:coordination.message:m3', payload: { role: 'user', actor: { kind: 'bot' } } }, ids, undefined, routing), 'world.home');
  assert.equal(routeEvent({ ...owner('m4'), category: 'correction', sourceRef: 'work:failed', targetCellId: 'contact.owner.voice' }, ids, undefined, routing), 'work.corrections');
  const oldContact = emptyCellPlasticState();
  oldContact.routingAffinity['work'] = 1;
  assert.equal(routeEvent({ ...owner('m5'), category: 'correction', sourceRef: 'work:failed' }, [...ids, 'contact.owner'], { 'contact.owner': oldContact }, routing), 'work.corrections');
  assert.equal(routeEvent({ ...owner('m6'), payload: { ...owner('m6').payload, actor: { kind: 'bot', principalId: 'peer' } } }, ids, undefined, routing), 'world.home');
});
test('near-zero salience owner contact earns one workspace admission without house ref turnover', t => {
  const seed = SeedProcess.initialize(dir(t), undefined, { anatomy, reservoirSeed: 4242 });
  seed.transition(owner('m1'));
  for (let i = 0; i < 60; i++) seed.transition({ ...owner(`house-${i}`), sourceRef: `house-sense:vitals:${i}`, producedAt: `2026-10-13T12:${String(i).padStart(2, '0')}:01.000Z`, payload: {} });
  const cell = seed.getCell('contact.owner.voice')!;
  const nearZero = cloneCell(cell);
  nearZero.workspacePressure = 0.001;
  nearZero.uncertainty = 0;
  nearZero.energy.current = 0;
  const lowScoreOutcome = evaluateWorkspace(new Map([[nearZero.id, nearZero]]), seed.getState().dispositions, cloneCell);
  assert.equal(lowScoreOutcome.outcome.kind, 'workspace', 'pending owner voice crosses admission even with negligible metabolic pressure');
  const outcome = seed.workspaceCycle('2026-10-13T13:00:00.000Z');
  assert.equal(outcome.kind, 'workspace');
  if (outcome.kind !== 'workspace') return;
  assert.ok(outcome.packet.activeCellIds.includes('contact.owner.voice'));
  assert.equal(outcome.packet.eventRefs.find(ref => ref.messageId === 'm1')?.head, 'I want my conversations to matter.');
  const spent = cloneCell(seed.getCell('contact.owner.voice')!);
  spent.workspacePressure = 0;
  const next = evaluateWorkspace(new Map([['contact.owner.voice', spent]]), seed.getState().dispositions, cloneCell);
  assert.equal(next.outcome.kind, 'silence', 'the owner floor is spent until another owner event');
});
test('typed owner claims retain captured message evidence and reject machine or invented evidence', t => {
  const seed = SeedProcess.initialize(dir(t), undefined, { anatomy });
  seed.transition(owner('m1'));
  seed.transition(owner('m2', '2026-10-13T12:01:00.000Z'));
  const cells = new Map([['contact.owner.voice', seed.getCell('contact.owner.voice')!]]);
  const delta = { cellId: 'contact.owner.voice', field: 'estimates.append', authority: 'propose' as const,
    delta: { claim: 'The owner wants conversations to matter.', claimKind: 'owner.wants', confidence: 0.9, evidenceRefs: ['m1', 'm2'] } };
  const result = applyLobeDeltas(cells, [delta], '2026-10-13T12:02:00.000Z', cloneCell, undefined, { version: 1, occurrence: 'test' });
  assert.equal(result.failed.length, 0);
  const claim = result.staged.get('contact.owner.voice')!.estimates[0]!;
  assert.equal(claim.claimKind, 'owner.wants');
  assert.deepEqual(claim.ownerEvidence?.map(ref => ref.messageId), ['m1', 'm2']);
  assert.ok((result.applied[0]!.delta as Record<string, unknown>).ownerEvidence, 'full evidence snapshot is in the accepted receipt');
  const replay = applyLobeDeltas(cells, result.applied, '2026-10-13T12:02:00.000Z', cloneCell);
  assert.deepEqual(replay.staged.get('contact.owner.voice')?.estimates, result.staged.get('contact.owner.voice')?.estimates, 'captured owner receipt replays without a model');
  const bad = applyLobeDeltas(cells, [{ ...delta, delta: { ...delta.delta, evidenceRefs: ['invented'] } }], '2026-10-13T12:02:00.000Z', cloneCell, undefined, { version: 1, occurrence: 'test' });
  assert.match(bad.failed[0]?.reason ?? '', /owner.*evidence/i);
  const forged = applyLobeDeltas(cells, [{ ...delta, delta: { ...delta.delta, evidenceRefs: ['invented'], ownerClaimVersion: 1,
    ownerEvidence: [{ ...claim.ownerEvidence![0], messageId: 'invented', head: 'invented owner text' }] } }], '2026-10-13T12:02:00.000Z', cloneCell, undefined, { version: 1, occurrence: 'test' });
  assert.match(forged.failed[0]?.reason ?? '', /owner.*evidence/i, 'live admission ignores a forged model snapshot');
});

test('legacy-only direct owner contact survives shipper, adapter and owner routing; groups and missing canonical actors do not', t => {
  const path = dir(t);
  const conversationsDir = join(path, 'conversations');
  mkdirSync(conversationsDir);
  const turn = { role: 'user', content: 'Please keep this direct conversation.', ts: '2026-10-13T12:00:00.000Z' };
  writeFileSync(join(conversationsDir, 'jerry__12345.jsonl'), JSON.stringify(turn) + '\n');
  writeFileSync(join(conversationsDir, 'jerry__-12345.jsonl'), JSON.stringify({ ...turn, content: 'Group text lacks owner attribution.' }) + '\n');
  const streamPath = join(path, 'stream.jsonl');
  const shipper = createConversationShipper({ conversationsDir, streamPath, cursorPath: join(path, 'shipper-cursor.json'),
    backfillBytes: 4096, maxAgeDays: 30, embed: () => null });
  assert.equal(shipper.pass(), 1);
  const adapter = new EventLedgerTailAdapter({ sourcePath: streamPath, cursorDir: dir(t), sourceType: 'conversation-stream', fromEnd: false });
  const events = adapter.pullSync();
  assert.equal(events.length, 1);
  assert.equal(routeEvent(events[0]!, anatomy.map(a => a.id), undefined, routingFromAnatomy(anatomy)), 'contact.owner.voice');
  const missingActor = { ...owner('canonical'), payload: { role: 'user', contactId: 'message:canonical', sourceRef: 'coordination.message:canonical', head: 'Unknown principal' } };
  assert.equal(routeEvent(missingActor, anatomy.map(a => a.id), undefined, routingFromAnatomy(anatomy)), 'world.home');
});

test('owner claim witness growth respects the configured cell byte ceiling', async t => {
  const seed = SeedProcess.initialize(dir(t), undefined, { anatomy });
  const message = { ...owner('long'), payload: { ...owner('long').payload, head: 'x'.repeat(150_000) } };
  seed.transition(message);
  const outcome = seed.workspaceCycle('2026-10-13T12:01:00.000Z');
  assert.equal(outcome.kind, 'workspace');
  if (outcome.kind !== 'workspace') return;
  const hash = seed.getState().stateHash;
  const lobe = { id: 'lobe.test', modelId: 'test', provider: 'test', invoke: async () => ({
    observations: [], interpretations: [], predictions: [], candidateForms: [], candidateActions: [], evidenceRefs: [], uncertainty: 0.5,
    stateDeltas: [{ cellId: 'contact.owner.voice', field: 'estimates.append', authority: 'propose' as const,
      delta: { claim: 'The owner spoke.', claimKind: 'owner.said', confidence: 0.9, evidenceRefs: ['long'] } }],
    modelReceipt: { modelId: 'test', provider: 'test', invokedAt: '2026-10-13T12:02:00.000Z', durationMs: 1, tokensIn: 1, tokensOut: 1 },
  }) };
  const result = await seed.recruitLobe(lobe, outcome.packet, '2026-10-13T12:02:00.000Z');
  assert.equal(result.applied.length, 0);
  assert.match(result.rejected[0]?.reason ?? '', /state budget refused/);
  assert.equal(seed.getState().stateHash, hash);
  const withUnrelated = { ...lobe, invoke: async () => {
    const proposed = await lobe.invoke();
    return { ...proposed, stateDeltas: [...proposed.stateDeltas,
      { cellId: 'contact.owner.voice', field: 'uncertainty.adjust', authority: 'propose' as const, delta: { value: 0.1 } }] };
  } };
  const next = await seed.recruitLobe(withUnrelated, outcome.packet, '2026-10-13T12:03:00.000Z');
  assert.deepEqual(next.applied.map(d => d.field), ['uncertainty.adjust'], 'refusing a large witness preserves unrelated valid changes');
});
test('owner lobe contract requests typed said, wants and decided claims alongside operational deltas', () => {
  const cells = makeInitialCells('2026-10-13T12:00:00.000Z', anatomy);
  const packet: WorkspacePacket = { activeCellIds: ['contact.owner.voice'], eventRefs: [], tensions: [], predictions: [], uncertainty: 0.5,
    requestedCapability: 'lobe.recruit.model', authorityCeiling: 'propose', tokenBudget: 2000,
    outputContract: { allowedOutputKinds: ['stateDeltas'], maxTokenBudget: 2000 } };
  assert.ok(cells.has('contact.owner.voice'));
  const prompt = buildLobePrompt(packet);
  assert.match(prompt, /owner\.said/);
  assert.match(prompt, /owner\.wants/);
  assert.match(prompt, /owner\.decided/);
  assert.match(prompt, /messageId/);
});

test('typed owner revisions qualify with original message ids after the live ref window turns over', t => {
  const seed = SeedProcess.initialize(dir(t), undefined, { anatomy });
  seed.transition({ ...owner('revision', '2026-10-13T12:03:00.000Z'), payload: { ...owner('revision').payload, head: 'I changed my mind; my conversations should matter.' } });
  const cell = cloneCell(seed.getCell('contact.owner.voice')!);
  cell.predictions = [{ predictionId: 'failed', claim: 'The owner wants conversations to matter.', confidence: 0.9,
    createdAt: '2026-10-13T12:00:00.000Z', resolvedAt: '2026-10-13T12:01:00.000Z', horizon: '2026-10-13T12:01:00.000Z', error: 0.9 }];
  const cells = new Map([[cell.id, cell]]);
  const result = applyLobeDeltas(cells, [{ cellId: cell.id, field: 'estimates.append', authority: 'propose', delta: {
    claim: 'The owner wants conversations to matter.', claimKind: 'owner.wants', confidence: 0.9, evidenceRefs: ['revision'],
    revisesPredictionIds: ['failed'], revisionReason: 'The owner explicitly changed his preference after this failed prediction.',
  } }], '2026-10-13T12:04:00.000Z', cloneCell, undefined, { version: 1, occurrence: 'revision' });
  const revised = result.staged.get(cell.id)!.estimates[0]!;
  assert.ok(revised.revisionEvidence, 'the Seed captures real owner revision evidence');
  assert.equal(getClaimFeedback({ ...cell, realityRefs: [] }, revised).hasSupportedRevision, true);
});
test('existing seeds opt in by append-only receipt; old refs survive and continuation replays exactly', t => {
  const a = dir(t), b = dir(t);
  const seed = SeedProcess.initialize(a, undefined, { reservoirSeed: 4242 });
  seed.transition(owner('old'));
  const beforeRefs = seed.getCell('world.home23')!.realityRefs;
  assert.equal(seed.getCell('contact.owner.voice'), undefined);
  assert.throws(() => seed.enableOwnerVoice('', '2026-10-13T12:01:00.000Z'), /authorization/i);
  const enabled = seed.enableOwnerVoice('owner-approved PR4', '2026-10-13T12:01:00.000Z');
  assert.deepEqual(enabled.newCellIds, ['contact.owner.voice', 'work.corrections']);
  assert.deepEqual(seed.getCell('world.home23')!.realityRefs, beforeRefs);
  assert.equal(seed.getCell('contact.owner.voice')!.realityRefs.length, 0);
  assert.equal(seed.enableOwnerVoice('owner-approved PR4', '2026-10-13T12:02:00.000Z').alreadyEnabled, true);
  cpSync(a, b, { recursive: true });
  const restored = SeedProcess.restore(b);
  const events = [owner('new', '2026-10-13T12:03:00.000Z'), { ...owner('work', '2026-10-13T12:04:00.000Z'), category: 'correction' as const, sourceRef: 'work:failed' }];
  for (const e of events) { seed.transition(e); restored.transition(e); }
  assert.equal(seed.getCell('contact.owner.voice')!.realityRefs[0]?.messageId, 'new');
  assert.equal(seed.getCell('work.corrections')!.realityRefs.length, 1);
  assert.equal(restored.getState().stateHash, seed.getState().stateHash);
});

for (const [name, budget, reason] of [
  ['exhausted checkpoint allowance', { maxCheckpointCount: 1 }, /checkpointCount/],
  ['insufficient allowance for growth plus checkpoint events', { maxEventCount: 3 }, /eventCount/],
  ['new-cell byte ceiling', { maxStateBytesPerCell: 1 }, /stateBytesPerCell/],
] as Array<[string, Partial<ResourceBudget>, RegExp]>) {
  test(`owner opt-in refuses ${name} before changing the chain or cells`, t => {
    const path = dir(t);
    const seed = SeedProcess.initialize(path, budget);
    seed.checkpoint();
    const state = seed.getState();
    const cells = state.cellIds.map(id => seed.getCell(id));
    const ledger = readFileSync(join(path, 'seed-ledger.jsonl'));
    const checkpointIndex = readFileSync(join(path, 'checkpoints', 'CHECKPOINT_INDEX.json'));
    const resources = seed.resourceSnapshot();
    assert.throws(() => seed.enableOwnerVoice('owner-approved PR4', '2026-10-13T12:00:00.000Z'), reason);
    assert.deepEqual(seed.getState(), state);
    assert.deepEqual(seed.getState().cellIds.map(id => seed.getCell(id)), cells);
    assert.deepEqual(readFileSync(join(path, 'seed-ledger.jsonl')), ledger);
    assert.deepEqual(readFileSync(join(path, 'checkpoints', 'CHECKPOINT_INDEX.json')), checkpointIndex);
    assert.deepEqual(seed.resourceSnapshot(), resources);
  });
}
