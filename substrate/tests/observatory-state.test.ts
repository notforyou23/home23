import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonlWindow, projectOutreach, projectGrowth, summarizeRouting } from '../src/observatory-state.js';
import { seedOutreachDeliveryId } from '../../src/substrate/operator-outreach.js';

test('bounded JSONL reading discards partial edges, preserves UTF-8 and reports coverage', t => {
  const dir = mkdtempSync(join(tmpdir(), 'observatory-window-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'chain.jsonl');
  const row = { seq: 2, claim: 'a shoreline and a jam — remembered' };
  writeFileSync(file, JSON.stringify({ seq: 1, claim: 'x'.repeat(10000) }) + '\n' + JSON.stringify(row) + '\n{"seq":3');
  const view = readJsonlWindow(file, 512);
  assert.deepEqual(view.records, [row]);
  assert.equal(view.available, true); assert.equal(view.coverage.fullHistory, false);
  assert.ok(view.coverage.bytesRead <= 512); assert.equal(view.coverage.tornTail, true);
});
test('missing, malformed and linked sources do not silently become a healthy empty history', t => {
  const dir = mkdtempSync(join(tmpdir(), 'observatory-window-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(readJsonlWindow(join(dir, 'absent')).available, false);
  writeFileSync(join(dir, 'broken'), '{bad}\n');
  assert.equal(readJsonlWindow(join(dir, 'broken')).available, false);
  writeFileSync(join(dir, 'real'), '{"seq":1}\n'); symlinkSync(join(dir, 'real'), join(dir, 'link'));
  assert.equal(readJsonlWindow(join(dir, 'link')).available, false);
});
test('operator requests require current commitments and exact canonical delivery joins', () => {
  const now = Date.parse('2026-10-30T13:00:00Z');
  const active = { idempotencyKey: 'reach-1', actSeq: 20, commitmentId: 'c1', message: 'Is this still the right question?', dispatchedAt: '2026-10-30T12:00:00Z' };
  const old = { ...active, idempotencyKey: 'old', actSeq: 1, commitmentId: 'closed', dispatchedAt: '2026-08-01T00:00:00Z' };
  const commitment = { c1: { status: 'open' }, closed: { status: 'confirmed' } };
  const missing = projectOutreach([active, old], commitment, [], now);
  assert.equal(missing.current.length, 0, 'outbox alone cannot claim delivery');
  assert.equal(missing.history.length, 2);
  const receipt = { deliveryId: seedOutreachDeliveryId(active), commitmentId: 'c1', actSeq: 20, status: 'committed', at: active.dispatchedAt, messageIds: ['msg-actual'], notification: 'not_confirmed' };
  const sent = projectOutreach([active, old], commitment, [receipt], now);
  assert.equal(sent.current.length, 1); assert.equal(sent.current[0]?.deliveryStatus, 'committed');
  assert.equal(sent.current[0]?.notification, 'not_confirmed');
  const queued = projectOutreach([active], commitment, [{ ...receipt, status: 'queued' }], now);
  assert.equal(queued.current.length, 0); assert.equal(queued.history[0]?.deliveryStatus, 'queued');
  const closed = projectOutreach([active], { c1: { status: 'expired' } }, [receipt], now);
  assert.equal(closed.current.length, 0);
  assert.equal(projectOutreach([active], commitment, [{ ...receipt, actSeq: 21 }], now).current.length, 0);
});
test('growth proposals are joined to decisions and applications rather than narrated as acts', () => {
  const records = [
    { seq: 10, category: 'proposal', sourceRef: 'growth.pressure', payload: { op: 'merge', targetCellIds: ['a', 'b'] } },
    { seq: 11, category: 'act', sourceRef: 'growth.operator-decision', payload: { proposalSeq: 10, operatorDecision: 'declined' } },
    { seq: 12, category: 'proposal', sourceRef: 'growth.pressure', payload: { op: 'split', targetCellIds: ['c'] } },
    { seq: 13, category: 'act', sourceRef: 'growth.operator-application', payload: { proposalSeq: 12, growthApplication: true, newCellIds: ['d', 'e'] } },
    { seq: 14, category: 'proposal', sourceRef: 'growth.pressure', payload: { op: 'dissolve', targetCellIds: ['z'] } },
  ];
  assert.deepEqual(projectGrowth(records, false).map(p => [p.seq, p.status]), [[10, 'declined'], [12, 'applied'], [14, 'unresolved_in_window']]);
  assert.equal(projectGrowth(records, true).at(-1)?.status, 'pending');
});
test('routing silence, policy refusal, dispatch and task outcome remain separate stages', () => {
  const events = [
    { event_id: 'one', event_type: 'MotorActionRouted', timestamp: '2026-10-30T12:00:00Z', payload: { routingVersion: 2, status: 'no_action', reasonCode: 'no_bounded_intent' } },
    { event_id: 'two', event_type: 'MotorActionRouted', timestamp: '2026-10-30T12:01:00Z', payload: { routingVersion: 2, status: 'rejected', reasonCode: 'policy_rejected' } },
    { event_id: 'three', event_type: 'MotorActionRouted', timestamp: '2026-10-30T12:02:00Z', payload: { routingVersion: 2, status: 'dispatched', reasonCode: 'dispatched', agendaId: 'a', turnId: 'turn-real' } },
    { event_id: 'four', event_type: 'ExecutionOutcomeObserved', timestamp: '2026-10-30T12:03:00Z', payload: { schema: 'home23.execution-outcome.v1', executionId: 'exec-a', status: 'completed', verificationStatus: 'unknown', taskOutcomeVerified: false } },
  ];
  const view = summarizeRouting(events);
  assert.equal(view.counts.no_bounded_intent, 1); assert.equal(view.counts.policy_rejected, 1);
  assert.equal(view.counts.dispatched, 1); assert.equal(view.counts.completed, 1);
  assert.equal(view.events.find(e => e.eventId === 'one')?.executionAttempted, false);
  assert.equal(view.events.find(e => e.eventId === 'three')?.taskOutcomeVerified, false);
  assert.equal(view.events.find(e => e.eventId === 'four')?.taskOutcomeVerified, false);
});
test('growth lifecycle requires the exact growth receipt source and preserves self-application evidence', () => {
  const proposal = { seq: 1, category: 'proposal', sourceRef: 'growth.pressure', payload: { op: 'crystallize', targetCellIds: ['new'] } };
  const unrelated = { seq: 2, category: 'act', sourceRef: 'other.action', payload: { proposalSeq: 1, growthApplication: true } };
  assert.equal(projectGrowth([proposal, unrelated], false)[0]?.status, 'unresolved_in_window');
  const selfApplication = { seq: 3, category: 'act', sourceRef: 'growth.self-application', payload: { growthApplication: true, newCellId: 'new', gateEvidence: { proposalSeqs: [1] } } };
  assert.equal(projectGrowth([proposal, selfApplication], true)[0]?.status, 'applied');
});
