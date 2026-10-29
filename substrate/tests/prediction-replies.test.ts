import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversationShipper } from '../src/conversation-shipper.js';
import { EventLedgerTailAdapter } from '../src/adapters/event-ledger-tail.js';
import { SeedProcess } from '../src/seed.js';
import { makeInitialCells } from '../src/cells.js';
import { predictionOutcomeRefs, type LobeAdapter } from '../src/lobe.js';
import { buildPacket } from '../src/workspace.js';
import type { LobeResult, Prediction, ProposedStateDelta, RealityRef, SituationCell } from '../src/types.js';

const claim = 'Jason will confirm he picked up the Atlas';
function lobe(deltas: ProposedStateDelta[]): LobeAdapter {
  return { id: 'reply.fixture', provider: 'fixture', modelId: 'fixture', invoke: async () => ({ observations: [], interpretations: [], predictions: [],
    candidateActions: [], candidateForms: [], evidenceRefs: [], stateDeltas: deltas, uncertainty: 0.5,
    modelReceipt: { modelId: 'fixture', provider: 'fixture', invokedAt: '2026-10-29T00:00:00Z', durationMs: 0, tokensIn: 0, tokensOut: 0 } } as LobeResult) };
}

test('an actual Core reply link survives the shipper and lets a short answer resolve only its referenced question', async t => {
  const root = mkdtempSync(join(tmpdir(), 'seed-owner-reply-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projection = join(root, 'contact.jsonl'), stream = join(root, 'conversation-stream.jsonl');
  const record = (messageId: string, role: string, content: string, ts: string, replyToMessageId?: string) => ({
    schema: 'home23.resident.contact.v1', contactId: `message:${messageId}`, messageId, sourceRef: `coordination.message:${messageId}`,
    channelId: 'owner-channel', session: 'coordination:owner-channel', role, content, ts,
    voice: role === 'assistant' ? 'self' : 'jtr', actor: { kind: role === 'assistant' ? 'bot' : 'owner', principalId: role, displayName: role },
    ...(replyToMessageId ? { replyToMessageId } : {}) });
  writeFileSync(projection, [record('question-message', 'assistant', 'Did you pick it up?', '2026-10-29T00:00:00Z'),
    record('answer-message', 'user', 'Yes.', '2026-10-29T00:02:00Z', 'question-message')].map(value => JSON.stringify(value)).join('\n') + '\n');
  const shipper = createConversationShipper({ conversationsDir: join(root, 'none'), streamPath: stream, cursorPath: join(root, 'cursor.json'),
    coordinationSource: projection, backfillBytes: 0, maxAgeDays: 1, embed: () => null });
  assert.equal(shipper.pass(), 2);
  assert.equal(JSON.parse(readFileSync(stream, 'utf8').trim().split('\n')[1]!).replyToMessageId, 'question-message');
  const adapter = new EventLedgerTailAdapter({ sourcePath: stream, sourceType: 'conversation-stream', cursorDir: join(root, 'adapter'), fromEnd: false });
  const events = await adapter.pull();
  const seed = SeedProcess.initialize(join(root, 'seed'), undefined, { reservoirSeed: 225 });
  seed.transition(events[0]!);
  const packet = () => buildPacket([seed.getCell('world.home23') as SituationCell], seed.getState().dispositions);
  await seed.recruitLobe(lobe([{ cellId: 'world.home23', field: 'predictions.append', authority: 'propose', delta: {
    claim, confidence: 0.4, horizon: '1h', evidenceRefs: ['question-message'] } }]), packet(), '2026-10-29T00:01:00Z');
  seed.transition(events[1]!);
  const predictionId = seed.getCell('world.home23')!.predictions[0]!.predictionId;
  const result = await seed.recruitLobe(lobe([{ cellId: 'world.home23', field: 'predictions.resolve', authority: 'propose', delta: {
    predictionId, error: 0.1, evidenceRefs: ['answer-message'], resolutionReason: 'The owner explicitly replied yes to the recorded pickup question.' } }]), packet(), '2026-10-29T01:02:00Z');
  assert.equal(result.applied.length, 1);
  assert.equal(seed.getCell('world.home23')!.predictions[0]!.resolutionEvidence!.verificationStatus, 'assessed');
});

test('a unique named-subject report can support assessment, while unrelated contact and ambiguous or interrogative replies cannot', () => {
  const cells = makeInitialCells('2026-10-29T00:00:00Z'), world = cells.get('world.home23')!;
  const prediction: Prediction = { predictionId: 'pickup', claim, confidence: 0.8, horizon: '1h', createdAt: '2026-10-29T00:00:00Z' };
  world.predictions.push(prediction);
  const ref = (head: string): RealityRef => ({ refId: 'owner-report', sourceRef: 'conversation.jtr:owner', sourceAuthority: 'home23.event-ledger',
    observedAt: '2026-10-29T01:00:00Z', confidence: 1, flag: 'COLLECTED', head });
  world.realityRefs.push(ref('The Atlas is in my driveway.'));
  assert.equal(predictionOutcomeRefs(cells.values(), prediction, '2026-10-29T02:00:00Z').length, 1);
  world.realityRefs = [ref('I enjoyed listening to that music today.')];
  assert.equal(predictionOutcomeRefs(cells.values(), prediction, '2026-10-29T02:00:00Z').length, 0);
  world.realityRefs = [ref('Is the Atlas in my driveway?')];
  assert.equal(predictionOutcomeRefs(cells.values(), prediction, '2026-10-29T02:00:00Z').length, 0);
  world.realityRefs = [ref('The Atlas is in my driveway.')];
  world.predictions.push({ ...prediction, predictionId: 'color', claim: 'The Atlas paint will seem blue at night' });
  assert.equal(predictionOutcomeRefs(cells.values(), prediction, '2026-10-29T02:00:00Z').length, 0);
});
