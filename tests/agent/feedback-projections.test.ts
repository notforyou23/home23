import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { composeSeedNow } from '../../src/substrate/seed-now.js';
import { composeLivedRecent } from '../../src/substrate/lived-recent.js';
import { composeLivedIdentity } from '../../src/substrate/lived-identity.js';
import { composeLivedFacts } from '../../src/substrate/lived-facts.js';
import { composeSeedSituation } from '../../src/substrate/seed-context.js';
import { projectFeedbackState } from '../../shared/seed-feedback-view.cjs';
const require = createRequire(import.meta.url);
const { composeLivedState, composeDayResidue } = require('../../engine/src/substrate/seed-lived-state.js');
const claim = 'The watcher contact tension will cause another missed message';
const at = (n: number) => `2026-09-26T${String(n).padStart(2, '0')}:00:00.000Z`;
const prediction = (id: string, hour: number, error?: number) => ({ predictionId: id, claim, confidence: .95, horizon: '2h', createdAt: at(hour), ...(error === undefined ? {} : { resolvedAt: at(hour + 1), error }) });
function fixture(t: any, tail: any[], predictions = [prediction('p1', 1, .9), prediction('p2', 3), prediction('p3', 5)]) {
  const dir = mkdtempSync(join(tmpdir(), 'feedback-surfaces-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'checkpoints'));
  const cells = [{ id: 'world.home23', generation: 1, workspacePressure: .4, energy: { current: 1 }, uncertainty: .4,
    predictions, estimates: [{ claim, confidence: .99, createdAt: at(0), evidenceRefs: ['a','b'] }], intentions: [],
    realityRefs: ['a','b'].map(refId => ({ refId, sourceRef: 'house.sensor:watcher', sourceAuthority: 'seed.adapter', flag: 'COLLECTED', head: claim, observedAt: at(0) })).concat([{ refId: 'contact', sourceRef: 'conversation.jtr:s1', sourceAuthority: 'seed.adapter', flag: 'COLLECTED', head: 'Let us think about the music too.', observedAt: at(6) }]) }];
  const checkpoint = { ledgerSeq: 100, cells };
  writeFileSync(join(dir, 'checkpoints/ckpt_a_fixture.json'), JSON.stringify(checkpoint));
  writeFileSync(join(dir, 'seed-ledger.jsonl'), [{ seq: 1, category: 'genesis', payload: { seedId: 'test-life', createdAt: at(0) } }, ...tail].map(row => JSON.stringify(row)).join('\n') + '\n');
  return { dir, checkpoint };
}
const resolve = { seq: 101, category: 'lobe', issuedAt: at(12), payload: { asOf: at(6), appliedDeltas: [{ cellId: 'world.home23', field: 'predictions.resolve', delta: { predictionId: 'p2', predictionCreatedAt: at(3), predictionIndex: 1, feedbackVersion: 1, error: .95 } }] } };
const reflection = { seq: 102, category: 'lobe', issuedAt: at(12), payload: { asOf: at(7), advisory: { version: 1, interpretations: [{ cellId: 'world.home23', interpretation: 'That guitar phrasing recalls a conversation about listening.', confidence: .6 }] } } };

test('a verdict after checkpoint changes all actual surfaces without mutating the Seed', t => {
  const { dir, checkpoint } = fixture(t, [resolve, reflection]);
  const projected = projectFeedbackState(checkpoint, [resolve, reflection]);
  assert.equal(projected.cells[0].predictions[1].resolvedAt, at(6), 'receipt event time wins over process time');
  assert.equal(checkpoint.cells[0].predictions[1].resolvedAt, undefined);
  const now = composeSeedNow(dir)!;
  assert.match(now, /failed hypothesis/);
  assert.doesNotMatch(now, /You are on the record expecting/);
  assert.match(now, /guitar phrasing/);
  const engine = composeLivedState(dir);
  assert.match(engine, /failed hypothesis/);
  assert.doesNotMatch(engine, /tentative estimate:|expecting \(unresolved\)/);
  assert.match(engine, /earlier reflection \(not an observation or obligation\).*guitar/);
  assert.match(composeLivedRecent(dir)!, /reality said no/);
  assert.equal(composeLivedFacts(dir), null);
  assert.match(composeLivedIdentity(dir)!, /2 prediction\(s\) judged by reality — 0 right, 2 wrong/);
  const context = composeSeedSituation(dir, { turnText: 'watcher contact tension missed message', embed: text => text.includes('watcher') ? [1, 0] : [0, 1], recipeId: 'test', maxItems: 6 });
  // Selection can return null when the entire pool is semantically indistinct;
  // bootstrap must never revive the failed unresolved expectation either.
  assert.doesNotMatch(context || '', /on the record expecting|formed an estimate/);
  assert.doesNotMatch(composeSeedSituation(dir) || '', /on the record expecting/);
  assert.match(composeDayResidue(dir).join('\n'), /expectation broke/);
});

test('a receipt gap omits potentially stale active claims, preserving historical corrections', t => {
  const { dir, checkpoint } = fixture(t, [{ ...reflection, seq: 104 }]);
  const view = projectFeedbackState(checkpoint, [{ ...reflection, seq: 104 }]);
  assert.equal(view.feedbackView.complete, false);
  assert.equal(view.cells[0].estimates.length, 0);
  assert.equal(view.cells[0].predictions.length, 1);
  assert.match(composeSeedNow(dir)!, /coverage is incomplete/);
  assert.doesNotMatch(composeLivedState(dir), /expecting \(unresolved\)/);
});

test('versioned resolution targets exact legacy duplicate occurrence; old receipts retain first-match semantics', t => {
  const same = prediction('duplicate', 3);
  const { checkpoint } = fixture(t, [], [{ ...same, resolvedAt: at(4), error: .9 }, same]);
  const delta = { ...resolve.payload.appliedDeltas[0].delta, predictionId: 'duplicate', predictionIndex: 1 };
  const row = { ...resolve, payload: { ...resolve.payload, appliedDeltas: [{ cellId: 'world.home23', field: 'predictions.resolve', delta }] } };
  const modern = projectFeedbackState(checkpoint, [row]);
  assert.equal(modern.cells[0].predictions[0].error, .9);
  assert.equal(modern.cells[0].predictions[1].error, .95);
  delete (delta as any).feedbackVersion;
  const legacy = projectFeedbackState(checkpoint, [row]);
  assert.equal(legacy.cells[0].predictions[0].error, .95);
  assert.equal(legacy.cells[0].predictions[1].resolvedAt, undefined);
});

test('an accepted evidence-backed revision remains visible before checkpoint evidence catches up', t => {
  const freshRef = { refId: 'new', sourceAuthority: 'home23.event-ledger', sourceRef: 'tool.watcher:result', flag: 'COLLECTED', observedAt: at(7), head: 'Watcher contact diagnostics now reproduce the missed message.' };
  const revised = { seq: 102, category: 'lobe', issuedAt: at(12), payload: { asOf: at(8), appliedDeltas: [{ cellId: 'world.home23', field: 'predictions.append', delta: { feedbackVersion: 1, predictionId: 'new-occurrence', claim, confidence: .6, horizon: '2h', evidenceRefs: ['new'], revisesPredictionIds: ['p2'], revisionReason: 'A new diagnostic independently reproduces the watcher contact failure.', revisionEvidence: { version: 1, admittedAt: at(8), failedPredictionIds: ['p2'], refs: [freshRef] } } }] } };
  const { dir } = fixture(t, [resolve, revised], [prediction('p1', 1, .9), prediction('p2', 3)]);
  assert.match(composeSeedNow(dir)!, /You are on the record expecting/);
  assert.match(composeLivedState(dir), /expecting \(unresolved\)/);
  assert.equal(composeLivedFacts(dir), null, 'a supported revision is still an unresolved prediction, not truth');
});


test('an intention released after checkpoint closes the projected occurrence without rewriting the snapshot', () => {
  const checkpoint = { ledgerSeq: 4, cells: [{ id: 'c', intentions: [{ tensionId: 'i1', description: 'Ask about the music', open: true }], predictions: [], estimates: [] }] };
  const view = projectFeedbackState(checkpoint, [{ seq: 5, category: 'lobe', payload: { asOf: at(4), appliedDeltas: [
    { cellId: 'c', field: 'intentions.resolve', delta: { tensionId: 'i1', reason: 'The conversation answered it' } },
  ] } }]);
  assert.equal(view.cells[0].intentions[0].open, false);
  assert.equal(checkpoint.cells[0].intentions[0].open, true);
});
