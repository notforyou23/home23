import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import { SeedRunner } from '../src/runner.js';
import { SeedLedger } from '../src/ledger.js';
import { ResourceAccounting, RESIDENT_RESOURCE_BUDGET } from '../src/resource.js';
import { DEFAULT_RESOURCE_BUDGET, ResourceBudgetExceededError } from '../src/types.js';
import type { CheckpointManifest, SourceEvent } from '../src/types.js';

function event(id: string): SourceEvent {
  return {
    eventId: id, category: 'observation', sourceAuthority: 'seed.adapter', sourceRef: id,
    payload: { test: true }, producedAt: '2026-09-23T12:00:00.000Z',
  };
}

test('resident restores lifetime counters past old ceilings without rebirth; default and configured byte guards remain', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'resident-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'seed');
  const sourcePath = join(dir, 'events.jsonl');
  const born = SeedProcess.initialize(stateDir);
  const identity = born.getState().seedId;
  const checkpointId = born.checkpoint();
  const originalLedger = new SeedLedger(stateDir);
  const ledgerCursorBefore = originalLedger.currentCursor;
  const ledgerPrefix = readFileSync(originalLedger.path);
  const checkpointPath = join(stateDir, 'checkpoints', `${checkpointId}.json`);

  // A small, valid checkpoint/ledger carries synthetic lifetime telemetry.
  // Resource counters are excluded from stateHash, while restore still checks
  // the exact cell hash and ledger cursor; no 50k fsync loop is needed.
  const manifest = JSON.parse(readFileSync(checkpointPath, 'utf8')) as CheckpointManifest;
  manifest.resourceSnapshot.eventCount = DEFAULT_RESOURCE_BUDGET.maxEventCount;
  manifest.resourceSnapshot.transitionCount = DEFAULT_RESOURCE_BUDGET.maxTransitionCount;
  manifest.resourceSnapshot.checkpointCount = DEFAULT_RESOURCE_BUDGET.maxCheckpointCount;
  writeFileSync(checkpointPath, JSON.stringify(manifest));

  const ordinary = SeedProcess.restore(stateDir, checkpointId);
  assert.equal(ordinary.getState().seedId, identity);
  assert.throws(() => ordinary.transition(event('ordinary-refuses')),
    (error) => error instanceof ResourceBudgetExceededError && error.resource === 'eventCount');

  writeFileSync(sourcePath, `${JSON.stringify({
    event_id: 'resident-event', event_type: 'OutcomeObserved',
    object_id: 'review', timestamp: '2026-09-23T12:00:00.000Z',
  })}\n`);
  const runner = new SeedRunner({ stateDir, sourcePath, fromEnd: false, maxEvents: 1 });
  runner.start();
  const before = runner.seedProcess.getState();
  assert.equal(before.seedId, identity);
  assert.equal(before.transitionCount, 50_000);
  assert.equal(before.eventCount, 100_000);
  assert.equal(before.ledgerCursor, ledgerCursorBefore);
  const report = await runner.tick();
  assert.equal(report.transitioned, 1);
  assert.equal(runner.seedProcess.getState().transitionCount, 50_001);
  assert.equal(runner.seedProcess.getState().seedId, identity);
  assert.equal((await runner.tick()).transitioned, 0, 'maxEvents remains a per-run proof cap');
  runner.stop(); // Checkpoint counter at 100k must also advance for a resident.
  const afterLedger = readFileSync(originalLedger.path);
  assert.deepEqual(afterLedger.subarray(0, ledgerPrefix.length), ledgerPrefix, 'original ledger bytes remain identical');
  assert.ok(afterLedger.length > ledgerPrefix.length, 'new receipts append after the original prefix');

  const accounting = new ResourceAccounting(RESIDENT_RESOURCE_BUDGET);
  accounting.assertCellStateBudget('cell', DEFAULT_RESOURCE_BUDGET.maxStateBytesPerCell);
  assert.throws(() => accounting.assertCellStateBudget('cell', DEFAULT_RESOURCE_BUDGET.maxStateBytesPerCell + 1),
    (error) => error instanceof ResourceBudgetExceededError && error.resource.startsWith('stateBytesPerCell'));
  assert.throws(() => accounting.assertLedgerBudget(DEFAULT_RESOURCE_BUDGET.maxLedgerBytes + 1),
    (error) => error instanceof ResourceBudgetExceededError && error.resource === 'ledgerBytes');
  const explicit = new ResourceAccounting({ ...RESIDENT_RESOURCE_BUDGET, maxTransitionCount: 1 });
  explicit.recordTransition();
  assert.throws(() => explicit.assertTransitionBudget(),
    (error) => error instanceof ResourceBudgetExceededError && error.resource === 'transitionCount');
  accounting.restoreFromSnapshot({
    stateBytesPerCell: {}, ledgerBytes: 0, eventCount: Number.MAX_SAFE_INTEGER,
    transitionCount: Number.MAX_SAFE_INTEGER, checkpointCount: Number.MAX_SAFE_INTEGER,
  });
  for (const record of [() => accounting.recordEvent(), () => accounting.recordTransition(), () => accounting.recordCheckpoint()]) {
    assert.throws(record, (error) => error instanceof ResourceBudgetExceededError);
  }
});
