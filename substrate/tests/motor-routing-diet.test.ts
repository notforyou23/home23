import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLedgerTailAdapter } from '../src/adapters/event-ledger-tail.js';
import { sourcePrefix } from '../src/plasticity.js';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'motor-diet-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'events.jsonl'); writeFileSync(file, '');
  const adapter = new EventLedgerTailAdapter({ sourcePath: file, cursorDir: join(dir, 'cursor'), fromEnd: false });
  const add = (id: string, payload: Record<string, unknown>) => appendFileSync(file, JSON.stringify({ event_id: id, event_type: 'MotorActionRouted', timestamp: '2026-10-30T13:00:00Z', payload }) + '\n');
  return { file, adapter, add };
}
test('confirmed new no-intent telemetry stays in raw history without feeding correction attention', t => {
  const f = fixture(t);
  for (let i = 0; i < 500; i++) f.add('quiet-'+i, { routingVersion: 2, status: 'no_action', reasonCode: 'no_bounded_intent' });
  assert.deepEqual(f.adapter.pullSync(), []);
  assert.equal(readFileSync(f.file, 'utf8').split('\n').filter(Boolean).length, 500, 'raw evidence is intact');
  assert.deepEqual(f.adapter.pullSync(), [], 'excluded telemetry advances its source cursor');
  f.add('actual-refusal', { routingVersion: 2, status: 'rejected', reasonCode: 'policy_rejected', detail: 'bounded authority unavailable' });
  const next = f.adapter.pullSync(); assert.equal(next.length, 1); assert.equal(next[0]?.eventId, 'actual-refusal');
});
test('separate prospective routing stages cannot share the old learned source-affinity key', t => {
  const f = fixture(t);
  for (const [status, reasonCode] of [['rejected', 'policy_rejected'], ['queued', 'queued'], ['dispatched', 'dispatched'], ['failed', 'execution_failed']])
    f.add(reasonCode!, { routingVersion: 2, status, reasonCode, routingDecisionId: 'motor:'+reasonCode, agendaId: 'agenda', turnId: 'turn' });
  const events = f.adapter.pullSync();
  assert.equal(new Set(events.map(sourcePrefix)).size, 4);
  assert.equal(events[0]?.category, 'correction');
  assert.equal(events[1]?.category, 'observation');
  assert.ok(events.every(e => e.payload['taskOutcomeVerified'] === false));
  assert.equal(events[2]?.payload['routingDecisionId'], 'motor:dispatched');
  assert.equal(events[2]?.payload['turnId'], 'turn');
  assert.match(String(events[2]?.payload['head']), /execution result pending/);
});
test('legacy, unsupported and non-silent no-action records retain their original interpretation', t => {
  const f = fixture(t);
  f.add('legacy', { status: 'no_action', detail: 'old observation' });
  f.add('future', { routingVersion: 3, status: 'no_action', reasonCode: 'no_bounded_intent' });
  f.add('disabled', { routingVersion: 2, status: 'no_action', reasonCode: 'disabled' });
  f.add('inconsistent', { routingVersion: 2, status: 'failed', reasonCode: 'no_bounded_intent' });
  const events = f.adapter.pullSync(); assert.equal(events.length, 4);
  assert.equal(events[0]?.sourceRef, 'MotorActionRouted:legacy');
  assert.equal(events[1]?.sourceRef, 'MotorActionRouted:future');
  assert.equal(events[2]?.sourceRef, 'MotorRouting.disabled:disabled');
  assert.equal(events[3]?.category, 'correction', 'unknown/inconsistent failure is never silently dropped');
});
