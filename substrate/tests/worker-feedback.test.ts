import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLedgerTailAdapter } from '../src/adapters/event-ledger-tail.js';
import { SeedProcess } from '../src/seed.js';
import { buildPacket } from '../src/workspace.js';
import type { SituationCell } from '../src/types.js';

function setup(t: { after(fn: () => void): void }, rows: Array<Record<string, unknown>>) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-feedback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sourcePath = join(dir, 'worker-runs.jsonl');
  writeFileSync(sourcePath, rows.map((row, i) => JSON.stringify({ schema: 'home23.worker-run-memory.v1', runId: `worker-${i}`,
    worker: 'fixture', startedAt: `2026-09-26T00:${String(i).padStart(2, '0')}:00Z`, ...row })).join('\n') + '\n');
  return { dir, adapter: new EventLedgerTailAdapter({ sourcePath, cursorDir: join(dir, 'cursor'), sourceType: 'worker-runs', fromEnd: false }) };
}

test('declared worker success cannot corroborate when verification failed, missing, unknown or not run', t => {
  const { adapter } = setup(t, [
    { status: 'fixed', verifierStatus: 'fail' }, { status: 'fixed', verifierStatus: 'pass' },
    { status: 'no_change', verifierStatus: 'unknown' }, { status: 'completed' },
    { status: 'fixed', verifierStatus: 'not_run' }, { status: 'failed', verifierStatus: 'unknown' },
    { status: 'blocked', verifierStatus: 'unknown' },
  ]);
  const events = adapter.pullSync();
  assert.deepEqual(events.map(e => e.category), ['correction', 'consequence', 'observation', 'observation', 'observation', 'correction', 'correction']);
  assert.equal(events[0]?.payload.status, 'fixed', 'keep what the worker declared');
  assert.equal(events[0]?.payload.verificationStatus, 'fail', 'keep the contrary verification');
  assert.equal(events[1]?.payload.verificationSource, 'worker-reported');
});

test('queued, running, cancelled and unknown worker states are not fabricated failures', t => {
  const { adapter } = setup(t, ['queued', 'pending', 'running', 'cancelled', 'unknown'].map(status => ({ status, verifierStatus: 'unknown' })));
  assert.ok(adapter.pullSync().every(e => e.category === 'observation'));
});

test('worker outcome words and verification reach actual Seed context as a qualified report', t => {
  const { dir, adapter } = setup(t, [{ status: 'fixed', verifierStatus: 'fail', summary: 'Watcher repair was attempted but the contact delay persists.',
    rootCause: 'The service is still using the previous configuration.', evidence: [{ type: 'check', status: 'fail', detail: 'The post-change probe still reports a delayed contact.' }] }]);
  const event = adapter.pullSync()[0]!;
  const seed = SeedProcess.initialize(join(dir, 'seed'), undefined, { reservoirSeed: 199 });
  const result = seed.transition(event);
  const cell = seed.getCell(result.cellId)!;
  const packet = buildPacket([cell as SituationCell], seed.getState().dispositions);
  const ref = packet.eventRefs.find(r => r.refId === event.eventId)!;
  assert.match(ref.head ?? '', /reported fixed; reported verification fail/);
  assert.match(ref.head ?? '', /not independent verification/);
  assert.match(ref.head ?? '', /previous configuration/);
  assert.match(ref.head ?? '', /post-change probe/);
  assert.equal(event.category, 'correction');
});
