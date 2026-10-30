import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readDocument, readCheckpointView, projectConcernView, learningChoices, readLearningView } from '../src/observatory-evidence.js';
import { readJsonlWindow } from '../src/observatory-state.js';
import { computeStateHash } from '../src/checkpoint.js';

test('bounded document cache invalidates on replacement and refuses oversized documents', t => {
  const root = mkdtempSync(join(tmpdir(), 'observatory-doc-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'small.json'); writeFileSync(file, '{"version":1}');
  assert.equal(readDocument(file, 64).value?.version, 1);
  writeFileSync(file, '{"version":222}'); assert.equal(readDocument(file, 64).value?.version, 222);
  writeFileSync(file, 'x'.repeat(65)); assert.equal(readDocument(file, 64).available, false);
});
test('checkpoint selection uses its index and validates identity and actual state hash', t => {
  const root = mkdtempSync(join(tmpdir(), 'observatory-checkpoint-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'checkpoints'));
  const stateHash = computeStateHash({ cells: [], dispositions: {} as never, development: {} });
  const cp = { schema: 'home23.seed.checkpoint.v1', version: 2, checkpointId: 'ckpt_abc_12345678', ledgerSeq: 1, ledgerCursor: 'a'.repeat(64), stateHash, createdAt: '2026-10-30T12:00:00Z', cells: [], dispositions: {}, development: {} };
  writeFileSync(join(root, 'checkpoints', cp.checkpointId+'.json'), JSON.stringify(cp));
  writeFileSync(join(root, 'checkpoints', 'CHECKPOINT_INDEX.json'), JSON.stringify({ checkpoints: [{ checkpointId: cp.checkpointId, stateHash, ledgerSeq: 1 }] }));
  writeFileSync(join(root, 'checkpoints', 'ckpt_zzz_12345678.json'), '{"unindexed":"stray"}');
  assert.equal(readCheckpointView(root).available, true);
  assert.equal(readCheckpointView(root).document?.checkpointId, cp.checkpointId);
  writeFileSync(join(root, 'checkpoints', cp.checkpointId+'.json'), JSON.stringify({ ...cp, stateHash: 'bad' }));
  assert.equal(readCheckpointView(root).available, false);
});
test('concern projection follows contiguous accepted receipt fields and never invents current state across a gap', t => {
  const root = mkdtempSync(join(tmpdir(), 'observatory-concern-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const line = JSON.stringify({ seq: 1, category: 'checkpoint', payload: {}, stateHashAfter: 'checkpoint-hash' });
  const cursor = createHash('sha256').update(line).digest('hex');
  const second = JSON.stringify({ seq: 2, prevHash: cursor, category: 'concern', issuedAt: '2026-10-30T12:00:00Z', payload: { commitmentId: 'asked', status: 'expired', reason: 'bounded expiry' } });
  writeFileSync(join(root, 'chain'), line+'\n'+second+'\n');
  const view = projectConcernView({ ledgerSeq: 1, ledgerCursor: cursor, stateHash: 'checkpoint-hash', concern: { asked: { status: 'open', commitmentId: 'asked' } } }, readJsonlWindow(join(root, 'chain')));
  assert.equal(view.current, true); assert.equal(view.concern.asked?.status, 'expired');
  writeFileSync(join(root, 'chain'), JSON.stringify({ seq: 3, prevHash: 'wrong', category: 'concern', payload: {} })+'\n');
  assert.equal(projectConcernView({ ledgerSeq: 1, ledgerCursor: cursor, concern: { asked: { status: 'open' } } }, readJsonlWindow(join(root, 'chain'))).current, false);
});
test('learning display requires retained witnesses and exact same-session delivery identities', () => {
  const witness = { schema: 'home23.learning-decision.v1', decisionId: 'context:choice', scope: 'foreground.context', tags: ['operational', 'agency', 'agency_status', 'automatic'], sourceRefs: ['surface:AGENCY_STATUS'], criterion: 'owner-value', observedAt: '2026-10-30T12:00:00Z' };
  const decision = { event_type: 'LearningDecisionObserved', event_id: witness.decisionId, actor: 'assembly', session_id: 'session', timestamp: witness.observedAt, payload: { ...witness, choice: 'omit', relevant: true, explicit: false, behavior: { kind: 'context-selection', surface: 'AGENCY_STATUS', component: 'routine-operational-status', description: 'Routine machine status' }, learning: { available: true, adjustment: -0.25, lessonIds: ['lesson-applied'] } } };
  const delivery = { event_type: 'RetrievalExecuted', event_id: 'delivery', actor: 'assembly', session_id: 'session', timestamp: '2026-10-30T12:00:01Z', payload: { learningDecisionIds: [witness.decisionId], surfaces_selected: [], surfaces_loaded: [], surface_delivery: [] } };
  const snapshot = { version: 1, available: true, seq: 2, decisions: [witness], lessons: [] };
  const rows = learningChoices(snapshot as never, [decision, delivery]);
  assert.equal(rows[0]?.choice, 'omit'); assert.equal(rows[0]?.deliveryStatus, 'observed'); assert.equal(rows[0]?.deliveredChars, 0);
  assert.equal(learningChoices(snapshot as never, [decision, { ...delivery, session_id: 'another' }])[0]?.deliveryStatus, 'unavailable');
  assert.equal(learningChoices(snapshot as never, [{ ...decision, payload: { ...decision.payload, tags: ['other'] } }, delivery])[0]?.evidenceStatus, 'unavailable');
  assert.equal(learningChoices({ ...snapshot, available: false } as never, [decision, delivery]).length, 0);
  assert.equal(learningChoices(snapshot as never, [decision, { ...delivery, actor: 'model' }])[0]?.deliveryStatus, 'unavailable');
  assert.equal(learningChoices(snapshot as never, [decision, delivery, { ...delivery, event_id: 'conflicting', session_id: 'another' }])[0]?.deliveryStatus, 'unavailable');
  assert.equal(learningChoices(snapshot as never, [{ ...decision, payload: { ...decision.payload, behavior: { ...decision.payload.behavior, kind: 'prose' } } }, delivery])[0]?.evidenceStatus, 'unavailable');
});

test('accepted learning cannot follow a linked ledger or switch to an unindexed checkpoint', t => {
  const root = mkdtempSync(join(tmpdir(), 'observatory-learning-boundary-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'checkpoints'));
  const stateHash = computeStateHash({ cells: [], dispositions: {} as never, development: {} });
  const line = JSON.stringify({ seq: 1, stateHashAfter: stateHash });
  const cp = { schema: 'home23.seed.checkpoint.v1', version: 2, checkpointId: 'ckpt_abc_12345678', ledgerSeq: 1, ledgerCursor: createHash('sha256').update(line).digest('hex'), stateHash, cells: [], dispositions: {}, development: {} };
  writeFileSync(join(root, 'checkpoints', cp.checkpointId+'.json'), JSON.stringify(cp));
  writeFileSync(join(root, 'checkpoints/CHECKPOINT_INDEX.json'), JSON.stringify({ checkpoints: [{ checkpointId: cp.checkpointId, stateHash, ledgerSeq: 1 }] }));
  writeFileSync(join(root, 'real-ledger'), line+'\n'); symlinkSync(join(root, 'real-ledger'), join(root, 'seed-ledger.jsonl'));
  assert.equal(readLearningView(root, readCheckpointView(root)).available, false);
  unlinkSync(join(root, 'seed-ledger.jsonl')); writeFileSync(join(root, 'seed-ledger.jsonl'), line+'\n');
  assert.equal(readLearningView(root, readCheckpointView(root)).available, true);
  writeFileSync(join(root, 'checkpoints/ckpt_zzz_12345678.json'), JSON.stringify({ ...cp, checkpointId: 'ckpt_zzz_12345678' }));
  assert.equal(readLearningView(root, readCheckpointView(root)).available, false);
});
