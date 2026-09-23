import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.equal(before.eventCount, 100_001, 'the accepted checkpoint receipt counts after the snapshot');
  assert.equal(runner.seedProcess.resourceSnapshot().checkpointCount, 100_001);
  assert.equal(runner.seedProcess.resourceSnapshot().ledgerBytes, ledgerPrefix.length);
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

test('resident startup refuses a state-changing ledger tail without writing or retaining its lock', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'resident-tail-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'seed');
  const sourcePath = join(dir, 'events.jsonl');
  writeFileSync(sourcePath, '');
  const seed = SeedProcess.initialize(stateDir);
  const checkpointId = seed.checkpoint();
  const checkpointPath = join(stateDir, 'checkpoints', `${checkpointId}.json`);
  seed.transition(event('after-checkpoint'));
  const ledgerPath = new SeedLedger(stateDir).path;
  const ledgerBefore = readFileSync(ledgerPath);
  const checkpointBefore = readFileSync(checkpointPath);
  const indexPath = join(stateDir, 'checkpoints', 'CHECKPOINT_INDEX.json');
  const indexBefore = readFileSync(indexPath);
  const rootEntries = readdirSync(stateDir);
  const history = SeedProcess.restore(stateDir); // Historical direct restore remains available.
  assert.equal(history.getState().seedId, seed.getState().seedId);

  const runner = new SeedRunner({ stateDir, sourcePath, fromEnd: false });
  assert.throws(() => runner.start(), /Uncheckpointed Seed receipts need recovery/);
  assert.equal(existsSync(join(stateDir, '.runner.lock')), false);
  assert.deepEqual(readdirSync(stateDir), rootEntries);
  assert.deepEqual(readFileSync(ledgerPath), ledgerBefore);
  assert.deepEqual(readFileSync(checkpointPath), checkpointBefore);
  assert.deepEqual(readFileSync(indexPath), indexBefore);
});

test('resident startup accepts a checkpoint followed only by checkpoint and stop metadata', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'resident-clean-tail-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'seed');
  const sourcePath = join(dir, 'events.jsonl');
  writeFileSync(sourcePath, '');
  const seed = SeedProcess.initialize(stateDir);
  seed.transition(event('before-stop'));
  const checkpointId = seed.stop();
  const checkpoint = JSON.parse(readFileSync(join(stateDir, 'checkpoints', `${checkpointId}.json`), 'utf8')) as CheckpointManifest;
  const records = new SeedLedger(stateDir).readFrom(checkpoint.ledgerSeq + 1);
  assert.deepEqual(records.map((record) => record.category), ['checkpoint', 'stop']);
  const runner = new SeedRunner({ stateDir, sourcePath, fromEnd: false });
  runner.start();
  assert.equal(runner.seedProcess.getState().seedId, seed.getState().seedId);
  assert.equal(runner.seedProcess.getState().eventCount, checkpoint.resourceSnapshot.eventCount + 2);
  assert.equal(runner.seedProcess.resourceSnapshot().checkpointCount, checkpoint.resourceSnapshot.checkpointCount + 1);
  assert.equal(runner.seedProcess.resourceSnapshot().ledgerBytes, readFileSync(new SeedLedger(stateDir).path).length);
  runner.stop();
});

test('resident startup rejects postcheckpoint ingest and hashed no-op receipts', (t) => {
  for (const kind of ['ingest', 'hashed-noop'] as const) {
    const dir = mkdtempSync(join(tmpdir(), `resident-${kind}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const stateDir = join(dir, 'seed');
    const sourcePath = join(dir, 'events.jsonl');
    writeFileSync(sourcePath, '');
    const seed = SeedProcess.initialize(stateDir);
    seed.checkpoint();
    if (kind === 'ingest') {
      seed.ingest(event('uncheckpointed-ingest'));
    } else {
      const stateHash = seed.getState().stateHash;
      new SeedLedger(stateDir).append({
        category: 'silence', sourceAuthority: 'seed.internal', sourceRef: seed.getState().seedId,
        payload: { test: true }, stateHashBefore: stateHash, stateHashAfter: stateHash,
      });
    }
    const ledgerPath = new SeedLedger(stateDir).path;
    const before = readFileSync(ledgerPath);
    const runner = new SeedRunner({ stateDir, sourcePath });
    assert.throws(() => runner.start(), /Uncheckpointed Seed receipts need recovery/, kind);
    assert.deepEqual(readFileSync(ledgerPath), before);
    assert.equal(existsSync(join(stateDir, '.runner.lock')), false);
  }
});

test('saturated resident checkpoint and stop preflight before writing; runner stop releases lock', (t) => {
  for (const caseName of ['checkpoint-event', 'checkpoint-count', 'runner-restore', 'runner-stop'] as const) {
    const dir = mkdtempSync(join(tmpdir(), `resident-${caseName}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const stateDir = join(dir, 'seed');
    const sourcePath = join(dir, 'events.jsonl');
    writeFileSync(sourcePath, '');
    const born = SeedProcess.initialize(stateDir);
    const checkpointId = born.checkpoint();
    const checkpointPath = join(stateDir, 'checkpoints', `${checkpointId}.json`);
    const manifest = JSON.parse(readFileSync(checkpointPath, 'utf8')) as CheckpointManifest;
    if (caseName === 'checkpoint-count') manifest.resourceSnapshot.checkpointCount = Number.MAX_SAFE_INTEGER;
    else manifest.resourceSnapshot.eventCount = caseName === 'runner-stop'
      ? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER;
    writeFileSync(checkpointPath, JSON.stringify(manifest));
    const ledgerPath = new SeedLedger(stateDir).path;
    const indexPath = join(stateDir, 'checkpoints', 'CHECKPOINT_INDEX.json');
    const ledgerBefore = readFileSync(ledgerPath);
    const indexBefore = readFileSync(indexPath);
    const checkpointBefore = readFileSync(checkpointPath);
    const checkpointNames = readdirSync(join(stateDir, 'checkpoints'));
    if (caseName === 'runner-restore') {
      const runner = new SeedRunner({ stateDir, sourcePath });
      assert.throws(() => runner.start(),
        (error) => error instanceof ResourceBudgetExceededError && error.resource === 'eventCount');
      assert.equal(existsSync(join(stateDir, '.runner.lock')), false);
    } else if (caseName === 'runner-stop') {
      const runner = new SeedRunner({ stateDir, sourcePath });
      runner.start();
      assert.throws(() => runner.stop(), (error) => error instanceof ResourceBudgetExceededError && error.resource === 'eventCount');
      assert.equal(existsSync(join(stateDir, '.runner.lock')), false);
    } else {
      const restored = SeedProcess.restore(stateDir, checkpointId, { budget: RESIDENT_RESOURCE_BUDGET });
      assert.throws(() => restored.checkpoint(),
        (error) => error instanceof ResourceBudgetExceededError
          && error.resource === (caseName === 'checkpoint-count' ? 'checkpointCount' : 'eventCount'));
    }
    assert.deepEqual(readFileSync(ledgerPath), ledgerBefore);
    assert.deepEqual(readFileSync(indexPath), indexBefore);
    assert.deepEqual(readFileSync(checkpointPath), checkpointBefore);
    assert.deepEqual(readdirSync(join(stateDir, 'checkpoints')), checkpointNames);
  }
});
