import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import { readSeedLearning, evaluateLearnedDecision, learningLessonId } from '../../shared/seed-learning.cjs';
import type { SourceEvent } from '../src/types.js';

const scope = 'owner.outreach:machine.memory';
function event(id: string, payload: Record<string, unknown>, category: SourceEvent['category'] = 'observation'): SourceEvent {
  return { eventId: id, category, sourceAuthority: 'home23.event-ledger', sourceRef: category === 'correction' ? `relationship.attenuation:${id}` : `LearningDecisionObserved:${id}`,
    producedAt: '2026-10-29T12:00:00Z', payload: { learningVersion: 2, ...payload } };
}
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'seed-experience-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, seed: SeedProcess.initialize(dir, undefined, { reservoirSeed: 812 }) };
}
const decision = { schema: 'home23.learning-decision.v1', decisionId: 'outreach:one', scope,
  tags: ['routine', 'mild', 'unsolicited'], sourceRefs: ['memory:pressure'], criterion: 'owner-value' };
const teaching = { schema: 'home23.learning-feedback.v1', decisionId: decision.decisionId, scope,
  tags: ['routine', 'unsolicited'], excludes: ['critical'], direction: 'attenuate', evidenceRefs: ['message:owner-correction'], basis: 'owner-feedback' };

test('Seed receipts retain original decision context; post-checkpoint learning changes admission and survives restore', t => {
  const { dir, seed } = fixture(t);
  seed.transition(event('decision', { learningDecision: decision }));
  seed.checkpoint();
  const control = readSeedLearning(dir);
  const unrelatedBefore = seed.getContinuousState('contact.jtr-jerry');
  seed.transition(event('owner-feedback', { actor: 'jtr', learning: teaching, entry_type: 'attenuation' }, 'correction'));
  const learned = readSeedLearning(dir);
  const next = { scope, tags: ['routine', 'unsolicited', 'mild'] };
  assert.equal(evaluateLearnedDecision(control, next).suppress, false);
  assert.equal(evaluateLearnedDecision(learned, next).suppress, true);
  assert.equal(evaluateLearnedDecision(learned, { scope, tags: ['routine', 'unsolicited', 'critical'] }).suppress, false);
  assert.deepEqual(seed.getContinuousState('contact.jtr-jerry'), unrelatedBefore, 'feedback routes to the actual decision cell');
  const hash = seed.getState().stateHash;
  seed.stop();
  const restored = SeedProcess.restore(dir);
  assert.equal(restored.getState().stateHash, hash);
  assert.equal(evaluateLearnedDecision(readSeedLearning(dir), next).suppress, true);
  const receipts = readFileSync(join(dir, 'seed-ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(receipts.some(r => r.category === 'development' && r.payload.rule === 'experience.v1' && r.payload.applied));
});

test('late duplicate execution evidence gives one scoped capability credit and never validates owner usefulness', t => {
  const { dir, seed } = fixture(t);
  const payload = { outcomeCriterion: 'execution', outcomeTrialId: 'work:w1:a1', executionKind: 'work', action: 'research', status: 'completed', taskOutcomeVerified: false };
  seed.transition(event('execution-one', payload, 'consequence'));
  seed.transition(event('execution-late-evidence', payload, 'consequence'));
  seed.checkpoint();
  const snapshot = readSeedLearning(dir);
  assert.equal(snapshot.lessons.length, 1);
  assert.equal(snapshot.lessons[0]?.criterion, 'execution');
  assert.equal(snapshot.lessons[0]?.corroborations, 0);
  assert.equal(evaluateLearnedDecision(snapshot, { scope, tags: ['routine', 'unsolicited'] }).adjustment, 0);
});

test('new unattributed corrections do not invent a habit and broken tail coverage disables learned overrides', t => {
  const { dir, seed } = fixture(t);
  seed.transition(event('correction-without-target', { actor: 'jtr', entry_type: 'correction' }, 'correction'));
  seed.checkpoint();
  assert.equal(readSeedLearning(dir).lessons.length, 0);
  appendFileSync(join(dir, 'seed-ledger.jsonl'), JSON.stringify({ seq: 99999, prevHash: 'forged', category: 'development', payload: {} }) + '\n');
  assert.equal(readSeedLearning(dir).available, false);
});

test('feedback arriving before its decision waits and applies once with that exact witness', t => {
  const { dir, seed } = fixture(t);
  seed.transition(event('early-owner-feedback', { actor: 'jtr', learning: teaching, entry_type: 'attenuation' }, 'correction'));
  seed.checkpoint();
  assert.equal(readSeedLearning(dir).lessons.length, 0);
  seed.transition(event('later-decision-projection', { learningDecision: decision }));
  const snapshot = readSeedLearning(dir);
  assert.equal(snapshot.lessons.length, 1);
  assert.equal(snapshot.lessons[0]?.eligibility?.decisionId, decision.decisionId);
  const receipt = readFileSync(join(dir, 'seed-ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).at(-1);
  assert.deepEqual(new Set(Object.keys(receipt.payload.experienceCells)), new Set(['world.home23', 'contact.jtr-jerry']), 'only the decision cell and pending cell are changed');
  seed.transition(event('later-decision-projection-again', { learningDecision: decision }));
  assert.equal(readSeedLearning(dir).lessons.length, 1);
});

test('a newer feedback watermark cannot discard an earlier genuine pending lesson', t => {
  const { dir, seed } = fixture(t);
  const second = { ...decision, decisionId: 'outreach:second' };
  seed.transition(event('second-decision-first', { learningDecision: second }));
  seed.transition(event('pending-first', { actor: 'jtr', learning: teaching, entry_type: 'attenuation', learningStream: 'relationship', learningSequence: 1 }, 'correction'));
  seed.transition(event('applied-second', { actor: 'jtr', learning: { ...teaching, decisionId: second.decisionId }, entry_type: 'attenuation', learningStream: 'relationship', learningSequence: 2 }, 'correction'));
  seed.transition(event('first-decision-later', { learningDecision: decision }));
  seed.checkpoint();
  const snapshot = readSeedLearning(dir);
  assert.equal(snapshot.lessons.length, 2);
  assert.ok(snapshot.lessons.some(lesson => lesson.decisionId === decision.decisionId));
});

test('supersession and inactive compaction preserve exact checkpoint hashes and append-only history', t => {
  const { dir, seed } = fixture(t);
  seed.transition(event('choice-before-revisions', { learningDecision: decision }));
  const originalBytes = readFileSync(join(dir, 'seed-ledger.jsonl'));
  let previous: string | undefined;
  for (let i = 0; i < 24; i++) {
    const id = `revision-${i}`;
    seed.transition(event(id, { actor: 'jtr', learning: { ...teaching, supersedes: previous ? [previous] : [] }, entry_type: 'attenuation' }, 'correction'));
    previous = learningLessonId(id, scope);
  }
  const hash = seed.getState().stateHash;
  seed.stop();
  assert.deepEqual(readFileSync(join(dir, 'seed-ledger.jsonl')).subarray(0, originalBytes.length), originalBytes);
  const restored = SeedProcess.restore(dir);
  assert.equal(restored.getState().stateHash, hash);
  assert.equal(readSeedLearning(dir).lessons.filter(lesson => lesson.active).length, 1);
  assert.equal(evaluateLearnedDecision(readSeedLearning(dir), { scope, tags: decision.tags }).suppress, true);
});

test('continuous event-time ages distinct provisional scopes without quiet gaps or erasing owner teaching', t => {
  const { dir, seed } = fixture(t);
  seed.transition(event('standing-choice', { learningDecision: decision }));
  seed.transition(event('standing-teaching', { actor: 'jtr', learning: teaching, entry_type: 'attenuation' }, 'correction'));
  const start = Date.parse('2026-10-29T12:00:00Z');
  for (let i = 0; i <= 120; i++) {
    const at = new Date(start + i * 5 * 60 * 1000).toISOString();
    const trial = `work:run-${i}:attempt-1`, method = `method_${i}`;
    seed.transition({ ...event(`choice-${i}`, { learningDecision: { schema: 'home23.learning-decision.v1',
      decisionId: trial, scope: `execution:${method}`, tags: ['execution', 'work'], sourceRefs: [`worker:${i}`], criterion: 'execution' } }), producedAt: at });
    seed.transition({ ...event(`outcome-${i}`, { outcomeCriterion: 'execution', outcomeTrialId: trial,
      executionKind: 'work', action: method, status: 'completed' }, 'consequence'), producedAt: at });
  }
  seed.checkpoint();
  const snapshot = readSeedLearning(dir);
  assert.equal(snapshot.available, true);
  assert.ok(snapshot.lessons.some(lesson => lesson.scope === 'execution:method_120' && lesson.active),
    'new learning resumes after old provisional scope ages, even though no 30 minute quiet gap occurred');
  assert.equal(evaluateLearnedDecision(snapshot, { scope, tags: decision.tags }).suppress, true, 'owner authority survives');
  const ledger = readFileSync(join(dir, 'seed-ledger.jsonl'), 'utf8');
  assert.match(ledger, /experience-consolidation\.v1/);
  assert.doesNotMatch(ledger, /"rule":"consolidation\.v1"/);
  seed.transition({ ...event('owner-revises-old-choice', { actor: 'jtr', entry_type: 'correction', learning: { ...teaching,
    direction: 'reinforce', supersedes: [learningLessonId('standing-teaching', scope)] } }, 'correction'),
    sourceRef: 'relationship.correction:revised', producedAt: new Date(start + 605 * 60 * 1000).toISOString() });
  seed.checkpoint();
  assert.equal(evaluateLearnedDecision(readSeedLearning(dir), { scope, tags: decision.tags }).adjustment, 0.25,
    'a lasting owner lesson remains revisable using its retained original witness after the recent-decision ring turns over');
  const hash = seed.getState().stateHash;
  seed.stop();
  assert.equal(SeedProcess.restore(dir).getState().stateHash, hash);
});
