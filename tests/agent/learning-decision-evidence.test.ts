import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLearningDecisionEvidenceReader } from '../../src/agent/learning-decision-evidence.js';
import { normalizeLearningDecision } from '../../shared/seed-learning.cjs';
import { assembleContext } from '../../src/agent/context-assembly.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-decision-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'event-ledger.jsonl');
  const decision = { event_id: 'context:actual-status-choice', event_type: 'LearningDecisionObserved',
    actor: 'assembly', session_id: 'coordination:channel:work:actual', timestamp: '2026-10-29T12:00:00.000Z',
    payload: { schema: 'home23.learning-decision.v1', decisionId: 'context:actual-status-choice',
      scope: 'foreground.context', tags: ['operational', 'agency', 'agency_status', 'automatic'],
      sourceRefs: ['surface:AGENCY_STATUS'], criterion: 'owner-value', choice: 'admit', relevant: true, explicit: false,
      behavior: { kind: 'context-selection', surface: 'AGENCY_STATUS', component: 'routine-operational-status',
        description: 'Include routine resident mode, queue depth and runtime status in the model context.' } } };
  const witness = normalizeLearningDecision({ ...decision.payload, observedAt: decision.timestamp })!;
  const delivery = { event_id: 'retrieval:actual', event_type: 'RetrievalExecuted', actor: 'assembly',
    session_id: decision.session_id, timestamp: '2026-10-29T12:00:01.000Z', payload: {
      learningDecisionIds: [decision.event_id], surfaces_selected: ['AGENCY_STATUS'], surfaces_loaded: ['AGENCY_STATUS'],
      surface_delivery: [{ surface: 'AGENCY_STATUS', source: 'surface:AGENCY_STATUS', delivered_chars: 1234,
        pointer_only: false, complete: true }] } };
  const write = (rows: unknown[]) => fs.writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  const read = createLearningDecisionEvidenceReader(file);
  return { root, file, decision, witness, delivery, write, read };
}

test('a retained witness explains its actual component and delivery without changing Seed or exposing request text', async t => {
  const f = fixture(t);
  const privateRequestText = 'Private wording from a different conversation';
  f.write([{ ...f.decision, payload: { ...f.decision.payload, userText: privateRequestText } }, f.delivery]);
  const before = fs.readFileSync(f.file);
  const evidence = (await f.read([f.witness]))[f.witness.decisionId]!;
  assert.equal(evidence.status, 'verified');
  if (evidence.status !== 'verified') return;
  assert.equal(evidence.choice, 'admit');
  assert.equal(evidence.explicit, false);
  assert.equal(evidence.behavior.component, 'routine-operational-status');
  assert.deepEqual(evidence.delivery, { status: 'observed', sourceEventId: f.delivery.event_id,
    timestamp: f.delivery.timestamp, selected: true, loaded: true, deliveredChars: 1234,
    pointerOnly: false, complete: true });
  assert.equal(JSON.stringify(evidence).includes(privateRequestText), false);
  assert.deepEqual(fs.readFileSync(f.file), before, 'readback must not rewrite the source ledger');
});

test('a selected surface that loses the context budget is not reported as delivered', async t => {
  const f = fixture(t);
  f.write([f.decision, { ...f.delivery, payload: { ...f.delivery.payload, surfaces_loaded: [], surface_delivery: [] } }]);
  const evidence = (await f.read([f.witness]))[f.witness.decisionId]!;
  assert.equal(evidence.status, 'verified');
  if (evidence.status !== 'verified') return;
  assert.deepEqual(evidence.delivery, { status: 'observed', sourceEventId: f.delivery.event_id,
    timestamp: f.delivery.timestamp, selected: true, loaded: false, deliveredChars: 0 });
});

test('an omitted surface has observed zero delivery while partial content remains explicitly partial', async t => {
  const f = fixture(t);
  f.write([{ ...f.decision, payload: { ...f.decision.payload, choice: 'omit' } },
    { ...f.delivery, payload: { ...f.delivery.payload, surfaces_selected: [], surfaces_loaded: [], surface_delivery: [] } }]);
  let evidence = (await f.read([f.witness]))[f.witness.decisionId]!;
  assert.equal(evidence.status, 'verified');
  if (evidence.status !== 'verified') return;
  assert.equal(evidence.choice, 'omit');
  assert.equal(evidence.delivery.deliveredChars, 0);
  f.delivery.payload.surface_delivery[0]!.complete = false;
  f.write([f.decision, f.delivery]);
  evidence = (await f.read([f.witness]))[f.witness.decisionId]!;
  assert.equal(evidence.status, 'verified');
  if (evidence.status !== 'verified') return;
  assert.equal(evidence.delivery.complete, false);
  assert.equal(evidence.delivery.pointerOnly, false);
});

test('readback preserves a selected zero-content pointer from the actual context producer without claiming loaded content', async t => {
  const f = fixture(t);
  const workspacePath = path.join(f.root, 'workspace');
  fs.mkdirSync(workspacePath);
  fs.writeFileSync(path.join(workspacePath, 'POINTER.md'), 'SOURCE_CONTENT_MUST_NOT_BE_REPORTED_LOADED');
  const result = await assembleContext('pointer note', f.decision.session_id, [{ role: 'assistant', content: 'earlier' }], {
    workspacePath, brainDir: path.join(f.root, 'brain'), enginePort: 0, sessionId: f.decision.session_id,
    signal: new AbortController().signal, semanticEmbed: () => null,
    contextSearch: async () => ({ results: [], sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'no_match' } }),
    triggeredSurfaces: [{ file: 'POINTER.md', keywords: ['pointer note'], budget: 0 }],
  });
  const produced = result.events.find(event => event.event_type === 'RetrievalExecuted')!;
  const pointer = (produced.payload.surface_delivery as Array<Record<string, unknown>>).find(row => row.surface === 'POINTER')!;
  assert.equal(pointer.delivered_chars, 0);
  assert.equal(pointer.pointer_only, true);
  assert.equal(pointer.complete, false);
  assert.equal(result.surfacesLoaded.includes('POINTER'), false);
  // Preserve the producer's actual content/delivery fields. This fixture's
  // retained status witness supplies the matching source identity separately.
  f.write([f.decision, { ...f.delivery, payload: { ...f.delivery.payload, surfaces_loaded: [],
    surface_delivery: [{ ...pointer, surface: 'AGENCY_STATUS', source: 'surface:AGENCY_STATUS' }] } }]);
  const evidence = (await f.read([f.witness]))[f.witness.decisionId]!;
  assert.equal(evidence.status, 'verified');
  if (evidence.status !== 'verified') return;
  assert.deepEqual(evidence.delivery, { status: 'observed', sourceEventId: f.delivery.event_id,
    timestamp: f.delivery.timestamp, selected: true, loaded: false, deliveredChars: 0,
    pointerOnly: true, complete: false });
});

test('a non-pointer zero-content row cannot masquerade as observed delivery', async t => {
  const f = fixture(t);
  f.write([f.decision, { ...f.delivery, payload: { ...f.delivery.payload, surfaces_loaded: [],
    surface_delivery: [{ ...f.delivery.payload.surface_delivery[0], delivered_chars: 0, pointer_only: false }] } }]);
  const evidence = (await f.read([f.witness]))[f.witness.decisionId]!;
  assert.equal(evidence.status, 'verified');
  if (evidence.status !== 'verified') return;
  assert.deepEqual(evidence.delivery, { status: 'unavailable', reason: 'delivery_details_invalid' });
});

test('reused legacy sessions cannot supply delivery evidence without an explicit decision reference', async t => {
  const f = fixture(t);
  const payload = { ...f.delivery.payload } as Record<string, unknown>;
  delete payload.learningDecisionIds;
  f.write([f.decision, { ...f.delivery, payload }]);
  const evidence = (await f.read([f.witness]))[f.witness.decisionId]!;
  assert.equal(evidence.status, 'verified');
  if (evidence.status !== 'verified') return;
  assert.deepEqual(evidence.delivery, { status: 'unavailable', reason: 'explicit_delivery_reference_not_observed' });
});

test('an explicit delivery reference from another session, actor or earlier time is rejected', async t => {
  const f = fixture(t);
  for (const override of [{ session_id: 'other-chat' }, { actor: 'agent' }, { timestamp: '2026-10-29T11:59:59.000Z' }]) {
    f.write([f.decision, { ...f.delivery, ...override }]);
    const evidence = (await f.read([f.witness]))[f.witness.decisionId]!;
    assert.equal(evidence.status, 'verified');
    if (evidence.status !== 'verified') return;
    assert.deepEqual(evidence.delivery, { status: 'unavailable', reason: 'delivery_provenance_mismatch' });
  }
});

test('a receipt contradicting omission or naming another surface source cannot claim delivery', async t => {
  const f = fixture(t);
  f.write([{ ...f.decision, payload: { ...f.decision.payload, choice: 'omit' } }, f.delivery]);
  let evidence = (await f.read([f.witness]))[f.witness.decisionId]!;
  assert.equal(evidence.status, 'verified');
  if (evidence.status !== 'verified') return;
  assert.equal(evidence.delivery.reason, 'delivery_selection_conflict');
  f.delivery.payload.surface_delivery[0]!.source = 'surface:AGENCY';
  f.write([f.decision, f.delivery]);
  evidence = (await f.read([f.witness]))[f.witness.decisionId]!;
  assert.equal(evidence.status, 'verified');
  if (evidence.status !== 'verified') return;
  assert.equal(evidence.delivery.reason, 'delivery_details_invalid');
});

test('duplicate decision or delivery identities stay ambiguous instead of choosing the newest record', async t => {
  const f = fixture(t);
  f.write([f.decision, f.decision, f.delivery]);
  assert.deepEqual((await f.read([f.witness]))[f.witness.decisionId],
    { status: 'unavailable', reason: 'conflicting_decision_identity' });
  f.write([f.decision, f.delivery, { ...f.delivery, event_id: 'retrieval:second' }]);
  const evidence = (await f.read([f.witness]))[f.witness.decisionId]!;
  assert.equal(evidence.status, 'verified');
  if (evidence.status !== 'verified') return;
  assert.deepEqual(evidence.delivery, { status: 'unavailable', reason: 'conflicting_delivery_references' });
});

test('changed retained identity, tags, scope, source or author cannot acquire a runtime description', async t => {
  const f = fixture(t);
  for (const override of [
    { decisionId: 'context:forged' }, { tags: ['operational', 'automatic'] },
    { scope: 'other.scope' }, { sourceRefs: ['surface:AGENCY'] },
  ]) {
    f.write([{ ...f.decision, payload: { ...f.decision.payload, ...override } }, f.delivery]);
    assert.equal((await f.read([f.witness]))[f.witness.decisionId]!.status, 'unavailable');
  }
  f.write([{ ...f.decision, actor: 'agent' }, f.delivery]);
  assert.deepEqual((await f.read([f.witness]))[f.witness.decisionId],
    { status: 'unavailable', reason: 'retained_witness_mismatch' });
});

test('legacy decisions remain witnesses but receive no invented component description', async t => {
  const f = fixture(t);
  const payload = { ...f.decision.payload } as Record<string, unknown>;
  delete payload.behavior;
  f.write([{ ...f.decision, payload }, f.delivery]);
  assert.deepEqual((await f.read([f.witness]))[f.witness.decisionId],
    { status: 'unavailable', reason: 'runtime_behavior_details_unavailable' });
});

test('unbounded descriptions and descriptions for a different surface are unavailable', async t => {
  const f = fixture(t);
  for (const behavior of [
    { ...f.decision.payload.behavior, description: 'x'.repeat(601) },
    { ...f.decision.payload.behavior, surface: 'AGENCY' },
    { ...f.decision.payload.behavior, component: 'made-up-behavior' },
    { ...f.decision.payload.behavior, component: 'pursuit-context' },
  ]) {
    f.write([{ ...f.decision, payload: { ...f.decision.payload, behavior } }, f.delivery]);
    assert.deepEqual((await f.read([f.witness]))[f.witness.decisionId],
      { status: 'unavailable', reason: 'runtime_behavior_details_unavailable' });
  }
});

test('behavior evidence must preserve the actual automatic/requested distinction and narrow component tags', async t => {
  const f = fixture(t);
  for (const payload of [
    { ...f.decision.payload, explicit: true },
    { ...f.decision.payload, relevant: false },
    { ...f.decision.payload, tags: ['operational', 'agency', 'automatic'] },
  ]) {
    const witness = normalizeLearningDecision({ ...payload, observedAt: f.decision.timestamp })!;
    f.write([{ ...f.decision, payload }, f.delivery]);
    assert.deepEqual((await f.read([witness]))[witness.decisionId],
      { status: 'unavailable', reason: 'runtime_behavior_details_unavailable' });
  }
});

test('missing and out-of-window decisions remain unavailable within the fixed recent-record budget', async t => {
  const f = fixture(t);
  assert.deepEqual((await f.read([f.witness]))[f.witness.decisionId],
    { status: 'unavailable', reason: 'decision_outside_recent_window' });
  f.write([f.decision, ...Array.from({ length: 513 }, (_, index) => ({ event_id: `other:${index}`, event_type: 'Other' }))]);
  assert.deepEqual((await f.read([f.witness]))[f.witness.decisionId],
    { status: 'unavailable', reason: 'decision_outside_recent_window' });
});

test('torn, oversized and symlink source tails cannot become evidence', async t => {
  const f = fixture(t);
  for (const suffix of ['{"event_id":', JSON.stringify({ event_id: 'complete-json-without-line-commit' }),
    'null\n', `${JSON.stringify({ value: 'x'.repeat(256 * 1024) })}\n`]) {
    f.write([f.decision, f.delivery]);
    fs.appendFileSync(f.file, suffix);
    assert.deepEqual((await f.read([f.witness]))[f.witness.decisionId],
      { status: 'unavailable', reason: 'bounded_runtime_ledger_unavailable' });
  }
  f.write([f.decision, f.delivery]);
  const link = path.join(f.root, 'untrusted-link.jsonl');
  fs.symlinkSync(f.file, link);
  assert.deepEqual((await createLearningDecisionEvidenceReader(link)([f.witness]))[f.witness.decisionId],
    { status: 'unavailable', reason: 'bounded_runtime_ledger_unavailable' });
});

test('cancellation and excessive witness requests fail closed without changing records', async t => {
  const f = fixture(t);
  f.write([f.decision, f.delivery]);
  const controller = new AbortController(); controller.abort();
  assert.deepEqual((await createLearningDecisionEvidenceReader(f.file, { signal: controller.signal })([f.witness]))[f.witness.decisionId],
    { status: 'unavailable', reason: 'bounded_runtime_ledger_unavailable' });
  const tooMany = Array.from({ length: 21 }, (_, index) => ({ ...f.witness, decisionId: `context:${index}` }));
  const results = await f.read(tooMany);
  assert.equal(Object.keys(results).length, 21);
  assert.equal(Object.values(results).every(value => value.status === 'unavailable' && value.reason === 'witness_request_exceeds_limit'), true);
});
