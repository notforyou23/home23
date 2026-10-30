import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SeedProcess } from '../src/seed.js';
import { EventLedgerTailAdapter } from '../src/adapters/event-ledger-tail.js';
import { EventLedger } from '../../src/agent/event-ledger.js';
import { conversationResponseHash } from '../../src/agent/conversation-judgment.js';
import { evaluateLearnedDecision, learningStateWithinBudget, readSeedLearning } from '../../shared/seed-learning.cjs';
import type { SourceEvent } from '../src/types.js';

// The writer captures its endpoint at import time. Fixture source teaching
// must never call the home embedder or discover the owner's configuration.
const isolatedHome = mkdtempSync(join(tmpdir(), 'conversation-learning-home-'));
const oldRoot = process.env.HOME23_ROOT, oldEndpoint = process.env.SEED_EMBED_ENDPOINT;
process.env.HOME23_ROOT = isolatedHome;
process.env.SEED_EMBED_ENDPOINT = 'http://127.0.0.1:1';
const { RelationshipLedger } = await import('../../src/agent/relationship-ledger.js');
after(() => {
  if (oldRoot === undefined) delete process.env.HOME23_ROOT; else process.env.HOME23_ROOT = oldRoot;
  if (oldEndpoint === undefined) delete process.env.SEED_EMBED_ENDPOINT; else process.env.SEED_EMBED_ENDPOINT = oldEndpoint;
  rmSync(isolatedHome, { recursive: true, force: true });
});

const axes = { engagement: 'explore', initiative: 'ask_followup', continuity: 'grounded_connection', depth: 'developed' };
const at = (ordinal: number) => new Date(Date.parse('2026-01-01T12:00:00.000Z') + ordinal * 1_000).toISOString();
const scope = 'foreground.conduct.engagement';
const tags = ['situation:sharing', 'choice:explore'];

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'seed-conversation-learning-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'seed'), brain = join(root, 'brain');
  let seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 902 });
  seed.checkpoint();
  const source = new EventLedger(brain);
  const adapter = new EventLedgerTailAdapter({ sourcePath: join(brain, 'event-ledger.jsonl'), cursorDir: join(root, 'harness-cursor'), fromEnd: false });
  const feedbackAdapter = new EventLedgerTailAdapter({ sourcePath: join(brain, 'relationship-ledger.events.jsonl'),
    sourceType: 'relationship-ledger', cursorDir: join(root, 'relationship-cursor'), fromEnd: false });
  const routes = seed.getState().cellIds.filter(id => !id.startsWith('contact.')).slice(0, 3);
  assert.equal(routes.length, 3);
  const authorizations = new Map<string, string>();
  let time = at(0), suffix = 0;
  const relationships = new RelationshipLedger(brain, { agent: 'resident', now: () => time,
    idSuffix: () => String(++suffix).padStart(6, '0'), validateCorrectionIngress: ingress => {
      const valid = ingress.chatId === 'owner-chat' && authorizations.get(ingress.messageRef) === ingress.userText;
      if (valid) authorizations.delete(ingress.messageRef);
      return valid;
    } });
  const consume = (route: string) => {
    const events = adapter.pullSync();
    for (const event of events) { seed.transition({ ...event, targetCellId: route }); adapter.commit(event.endOffset); }
    return events;
  };
  const consumeFeedback = () => {
    const events = feedbackAdapter.pullSync();
    for (const event of events) { seed.transition(event); feedbackAdapter.commit(event.endOffset); }
    return events;
  };
  const decide = (episode: number, route: string) => {
    const selectionId = `conversation:episode-${episode}`;
    for (const [axis, value] of Object.entries(axes)) source.emitDurable({
      event_id: `${selectionId}:${axis}`, event_type: 'LearningDecisionObserved', actor: 'conversation',
      session_id: 'owner-chat', timestamp: at(episode * 3),
      payload: { schema: 'home23.learning-decision.v1', decisionId: `${selectionId}:${axis}`,
        scope: `foreground.conduct.${axis}`, tags: ['situation:sharing', `choice:${value}`],
        sourceRefs: [`owner:episode-${episode}`, 'conversation:owner-chat', selectionId], criterion: 'owner-value',
        // The Seed must ignore candidate-supplied occurrence claims.
        observedAt: '2099-01-01T00:00:00Z', occurrence: { stream: 'model-invented', sequence: 999_999 },
      },
    }, { newUnique: true });
    consume(route);
    return `${selectionId}:engagement`;
  };
  const teach = (decisionId: string, id: string, direction: 'attenuate' | 'reinforce', ordinal: number, standing = false) => {
    time = at(ordinal);
    const statement = direction === 'reinforce'
      ? (standing ? 'Going forward, keep exploring the meaning.' : 'I liked how you explored the meaning.')
      : (standing ? 'Going forward, stop exploring the meaning.' : 'Your exploration was unhelpful.');
    const messageRef = `owner:${id}`;
    authorizations.set(messageRef, statement);
    const selectionId = decisionId.slice(0, -':engagement'.length);
    const deliveredReply = 'You stayed with it until something shifted. What did that moment mean to you?';
    const entry = relationships.addConversationFeedbackBatch({
      deliveredReply, episode: { selectionId, responseHash: conversationResponseHash(deliveredReply),
        deliveryMessageRef: `coordination.message:delivered-${selectionId}`, ownerMessageRef: `coordination.message:owner-${id}` },
      interpretations: [{ decisionId, axis: 'engagement', value: 'explore', situation: 'sharing',
        quote: statement, direction, standing, conditions: [], supersedes: [] }],
      learning: [{ schema: 'home23.learning-feedback.v1', decisionId, scope, tags, direction,
        evidenceRefs: [messageRef], basis: 'owner-feedback', ...(standing ? { standing: true } : {}) }],
    }, { chatId: 'owner-chat', messageRef, userText: statement });
    assert.equal(entry.actor, 'jtr');
    assert.equal(entry.provenance.generation_method, 'jtr_correction');
    assert.equal(entry.seed_projections?.[0]?.status, 'projected');
    return { entry, events: consumeFeedback() };
  };
  const unrelated = (episode: number, route: string) => {
    seed.transition({ eventId: `unrelated:${episode}`, sourceAuthority: 'home23.event-ledger',
      sourceRef: `LearningDecisionObserved:operational-${episode}`, category: 'observation', targetCellId: route,
      producedAt: at(episode * 3 + 2), payload: { learningVersion: 2, learningDecision: {
        schema: 'home23.learning-decision.v1', decisionId: `read:${episode}`, scope: 'execution:read_file',
        criterion: 'execution', tags: ['execution', 'action'], sourceRefs: [`file:${episode}`],
      } } });
  };
  const restore = () => {
    const hash = seed.getState().stateHash;
    seed.checkpoint();
    const prefix = readFileSync(join(dir, 'seed-ledger.jsonl'));
    seed.stop();
    seed = SeedProcess.restore(dir);
    assert.equal(seed.getState().stateHash, hash);
    assert.deepEqual(readFileSync(join(dir, 'seed-ledger.jsonl')).subarray(0, prefix.length), prefix);
  };
  return { dir, root, source, adapter, routes, decide, teach, unrelated, restore,
    seed: () => seed,
    receipts: () => readFileSync(join(dir, 'seed-ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)),
  };
}

test('150 authenticated source encounters converge on one existing policy cell despite changed routing and restore', t => {
  const f = fixture(t);
  const birthCells = [...f.seed().getState().cellIds];
  let anchor: string | undefined;
  let finalDecision = '';
  for (let episode = 1; episode <= 150; episode++) {
    finalDecision = f.decide(episode, f.routes[episode % f.routes.length]!);
    f.teach(finalDecision, `feedback-${episode}`, 'reinforce', episode * 3 + 1);
    f.unrelated(episode, f.routes[(episode + 1) % f.routes.length]!);
    if (episode % 10 === 0) f.seed().checkpoint();
    if ([50, 100, 150].includes(episode)) f.restore();
    const state = readSeedLearning(f.dir);
    assert.equal(state.available, true, `episode ${episode} has complete receipt coverage`);
    anchor ??= state.conductAnchorCellId;
    assert.ok(anchor);
    assert.equal(state.conductAnchorCellId, anchor);
    const conduct = state.lessons.filter(lesson => lesson.scope === scope && lesson.active);
    assert.equal(conduct.length, 1, `episode ${episode} has one consolidated owner contribution`);
    assert.equal(conduct[0]!.eligibility!.cellId, anchor);
    assert.ok(state.decisions.filter(decision => decision.scope.startsWith('foreground.conduct.')).every(decision => decision.cellId === anchor));
    const eligibility = conduct[0]!.eligibility!;
    assert.equal(eligibility.observedAt, at(episode * 3));
    assert.ok(eligibility.occurrence?.stream.startsWith('tail_'));
    assert.notEqual(eligibility.occurrence?.stream, 'model-invented');
    assert.ok(state.conductCredits?.['engagement:sharing:explore']);
  }
  const state = readSeedLearning(f.dir);
  assert.equal(evaluateLearnedDecision(state, { scope, tags }).adjustment, 0.75);
  assert.deepEqual(f.seed().getState().cellIds, birthCells, 'learning does not grow or replace anatomy');
  const checkpoint = JSON.parse(readFileSync(join(f.dir, 'checkpoints', `${f.seed().checkpoint()}.json`), 'utf8'));
  const experiences = Object.entries(checkpoint.development).filter(([, value]) => (value as any).experience?.conductAnchor);
  assert.equal(experiences.length, 1);
  assert.ok(learningStateWithinBudget((experiences[0]![1] as any).experience));
  const oldestApplied = f.receipts().find(record => record.category === 'development' && record.payload.lesson?.scope === scope);
  assert.equal(oldestApplied.payload.lesson.value, 0.25, 'later reinforcement cannot rewrite the first committed lesson');

  // A new contrary encounter adjusts accumulated experience. A standing
  // revision replaces the preference, rather than adding more empirical credit.
  finalDecision = f.decide(151, f.routes[0]!);
  f.teach(finalDecision, 'genuine-miss', 'attenuate', 454);
  assert.equal(evaluateLearnedDecision(readSeedLearning(f.dir), { scope, tags }).adjustment, 0.5);
  f.teach(finalDecision, 'standing-revision', 'attenuate', 455, true);
  assert.equal(evaluateLearnedDecision(readSeedLearning(f.dir), { scope, tags }).adjustment, -0.25);
  f.teach(finalDecision, 'standing-revision-again', 'reinforce', 456, true);
  assert.equal(evaluateLearnedDecision(readSeedLearning(f.dir), { scope, tags }).adjustment, 0.25);
  f.teach(finalDecision, 'same-episode-praise', 'reinforce', 457);
  assert.equal(evaluateLearnedDecision(readSeedLearning(f.dir), { scope, tags }).adjustment, 0.25);
  assert.equal(f.receipts().at(-1).payload.reason, 'conduct_trial_already_credited');
  f.restore();
  assert.equal(evaluateLearnedDecision(readSeedLearning(f.dir), { scope, tags }).adjustment, 0.25);
});

test('D1 after D2 is refused by committed original occurrence, and a neutral policy retains its cell anchor', t => {
  const f = fixture(t);
  const first = f.decide(1, f.routes[0]!);
  f.teach(first, 'D1', 'reinforce', 4);
  const second = f.decide(2, f.routes[1]!);
  f.teach(second, 'D2', 'reinforce', 7);
  const anchor = readSeedLearning(f.dir).conductAnchorCellId;
  f.teach(first, 'D1-again', 'reinforce', 8);
  assert.equal(f.receipts().at(-1).payload.reason, 'conduct_trial_already_credited');
  assert.equal(evaluateLearnedDecision(readSeedLearning(f.dir), { scope, tags }).adjustment, 0.5);
  for (let episode = 3; episode <= 4; episode++) {
    const choice = f.decide(episode, f.routes[episode % f.routes.length]!);
    f.teach(choice, `counter-${episode}`, 'attenuate', episode * 3 + 1);
  }
  assert.equal(evaluateLearnedDecision(readSeedLearning(f.dir), { scope, tags }).adjustment, 0);
  f.restore();
  assert.equal(readSeedLearning(f.dir).conductAnchorCellId, anchor);
  const next = f.decide(5, f.routes[2]!);
  f.teach(next, 'after-neutral', 'reinforce', 16);
  const state = readSeedLearning(f.dir);
  assert.equal(state.conductAnchorCellId, anchor);
  assert.equal(state.lessons.find(lesson => lesson.active && lesson.scope === scope)!.eligibility!.cellId, anchor);
  assert.equal(evaluateLearnedDecision(state, { scope, tags }).adjustment, 0.25);
});

test('same-episode standing revisions without immutable feedback cursor remain refused by actual Seed application', t => {
  const f = fixture(t);
  const first = f.decide(1, f.routes[0]!);
  f.teach(first, 'initial-instruction', 'attenuate', 4, true);
  const before = evaluateLearnedDecision(readSeedLearning(f.dir), { scope, tags });
  const missingCursor: SourceEvent = { eventId: 'missing-source-cursor', sourceAuthority: 'home23.event-ledger',
    sourceRef: 'relationship.correction:missing-source-cursor', category: 'correction', producedAt: at(5),
    payload: { learningVersion: 2, actor: 'jtr', learning: {
      schema: 'home23.learning-feedback.v1', decisionId: first, scope, tags, direction: 'reinforce',
      standing: true, evidenceRefs: ['owner:missing-source-cursor'], basis: 'owner-feedback',
    } } };
  f.seed().transition(missingCursor);
  assert.equal(f.receipts().at(-1).payload.reason, 'conduct_revision_source_order_unavailable');
  assert.deepEqual(evaluateLearnedDecision(readSeedLearning(f.dir), { scope, tags }), before);
  f.restore();
  assert.equal(evaluateLearnedDecision(readSeedLearning(f.dir), { scope, tags }).adjustment, -0.25);
});

test('a pending source teaching uses the eventual original witness and the existing policy anchor', t => {
  const f = fixture(t);
  const first = f.decide(1, f.routes[0]!);
  f.teach(first, 'before-pending', 'reinforce', 4);
  const anchor = readSeedLearning(f.dir).conductAnchorCellId;
  f.teach('conversation:episode-2:engagement', 'pending-owner-feedback', 'reinforce', 7);
  assert.equal(f.receipts().at(-1).payload.reason, 'pending_decision_witness');
  const eventsBefore = f.receipts().length;
  f.decide(2, f.routes[2]!);
  const state = readSeedLearning(f.dir);
  assert.equal(state.conductAnchorCellId, anchor);
  assert.equal(evaluateLearnedDecision(state, { scope, tags }).adjustment, 0.5);
  assert.ok(f.receipts().slice(eventsBefore).some(row => row.payload.deferredApplied?.length === 1));
  f.restore();
  assert.equal(evaluateLearnedDecision(readSeedLearning(f.dir), { scope, tags }).adjustment, 0.5);
});

test('an out-of-order pending episode is explicitly refused and cannot exhaust the pending queue', t => {
  const f = fixture(t);
  const first = f.decide(1, f.routes[0]!);
  f.teach(first, 'first-credit', 'reinforce', 4);
  f.teach('conversation:episode-2:engagement', 'pending-older-episode', 'reinforce', 7);
  const later = f.decide(3, f.routes[1]!);
  f.teach(later, 'later-credit', 'reinforce', 10);
  const before = f.receipts().length;
  f.decide(2, f.routes[2]!);
  assert.ok(f.receipts().slice(before).some(row => row.payload.deferredRefused?.some(
    (refusal: { reason: string }) => refusal.reason === 'conduct_trial_already_credited')));
  assert.equal(evaluateLearnedDecision(readSeedLearning(f.dir), { scope, tags }).adjustment, 0.5);
  const checkpoint = JSON.parse(readFileSync(join(f.dir, 'checkpoints', `${f.seed().checkpoint()}.json`), 'utf8'));
  assert.ok(Object.values(checkpoint.development).every((entry: any) => (entry.experience?.pendingFeedback?.length ?? 0) === 0));
  f.restore();
  assert.equal(evaluateLearnedDecision(readSeedLearning(f.dir), { scope, tags }).adjustment, 0.5);
});
