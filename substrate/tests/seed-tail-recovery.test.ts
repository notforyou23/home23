import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { SeedRunner } from '../src/runner.js';
import { SeedLedger } from '../src/ledger.js';

for (const stoppedBoundary of [false, true]) {
  test(`lossless tail recovery preserves receipts and makes restart idempotent (stop boundary: ${stoppedBoundary})`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'seed-tail-recovery-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const stateDir = join(root, 'seed');
    const source = join(root, 'events.jsonl');
    writeFileSync(source, `${JSON.stringify({
      event_id: 'evt-recovery-1', event_type: 'Observation', timestamp: '2026-10-10T13:00:00.000Z',
      payload: { content: 'one valid lived event' },
    })}\n`);
    if (stoppedBoundary) {
      const prior = new SeedRunner({ stateDir, sourcePath: source, fromEnd: false, checkpointEveryN: 32 });
      prior.start();
      prior.stop();
    }
    const runner = new SeedRunner({ stateDir, sourcePath: source, fromEnd: false, checkpointEveryN: 32 });
    runner.start();
    await runner.tick();
    // Model an abrupt process death: release only the fixture lock, without a
    // final checkpoint. The immutable receipt remains on the valid chain.
    rmSync(join(stateDir, '.runner.lock'));
    const before = readFileSync(join(stateDir, 'seed-ledger.jsonl'));
    const blocked = new SeedRunner({ stateDir, sourcePath: source, fromEnd: false });
    assert.throws(() => blocked.start(), /Uncheckpointed Seed receipts need recovery/);

    const script = fileURLToPath(new URL('../bin/seed-recover-tail.ts', import.meta.url));
    const missingEvidence = spawnSync(process.execPath, ['--import', 'tsx', script, stateDir], {
      cwd: resolve('.'), encoding: 'utf8',
    });
    assert.equal(missingEvidence.status, 1);
    assert.match(missingEvidence.stderr, /source evidence missing/);
    assert.deepEqual(readFileSync(join(stateDir, 'seed-ledger.jsonl')), before,
      'failed recovery must not change a valid chain');

    if (stoppedBoundary) {
      // Keep a valid chain but break the stop's checkpoint binding. Recovery
      // must reject it, not accept arbitrary administrative receipts as no-ops.
      const malformedDir = join(root, 'malformed');
      cpSync(stateDir, malformedDir, { recursive: true });
      const records = new SeedLedger(malformedDir).readAll();
      const stopIndex = records.findIndex((r) => r.category === 'stop');
      assert.notEqual(stopIndex, -1);
      const originalLines = readFileSync(join(malformedDir, 'seed-ledger.jsonl'), 'utf8').trimEnd().split('\n');
      writeFileSync(join(malformedDir, 'seed-ledger.jsonl'), `${originalLines.slice(0, stopIndex).join('\n')}\n`);
      const malformedLedger = new SeedLedger(malformedDir);
      for (const [i, record] of records.slice(stopIndex).entries()) {
        malformedLedger.append({ ...record, payload: i === 0
          ? { ...record.payload, checkpointId: 'wrong-checkpoint' } : record.payload });
      }
      assert.equal(malformedLedger.verifyChain().ok, true);
      const malformedBefore = readFileSync(join(malformedDir, 'seed-ledger.jsonl'));
      const malformed = spawnSync(process.execPath, ['--import', 'tsx', script, malformedDir,
        '--source', `harness-ledger:${source}`], { cwd: resolve('.'), encoding: 'utf8' });
      assert.equal(malformed.status, 1);
      assert.match(malformed.stderr, /Uncheckpointed Seed receipts need recovery/);
      assert.deepEqual(readFileSync(join(malformedDir, 'seed-ledger.jsonl')), malformedBefore);
    }

    const indexBefore = readFileSync(join(stateDir, 'checkpoints', 'CHECKPOINT_INDEX.json'));
    const dryRun = spawnSync(process.execPath, ['--import', 'tsx', script, stateDir,
      '--source', `harness-ledger:${source}`], { cwd: resolve('.'), encoding: 'utf8' });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const verdict = JSON.parse(dryRun.stdout);
    assert.equal(verdict.replayVerified, true);
    assert.equal(verdict.apply, false);
    assert.equal(verdict.tailReceipts, new SeedLedger(stateDir).readFrom(verdict.checkpointSeq + 2).length);
    assert.deepEqual(readFileSync(join(stateDir, 'seed-ledger.jsonl')), before);
    assert.deepEqual(readFileSync(join(stateDir, 'checkpoints', 'CHECKPOINT_INDEX.json')), indexBefore);

    const backup = join(root, 'backup');
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, stateDir,
      '--source', `harness-ledger:${source}`, '--apply', '--backup-dir', backup], {
      cwd: resolve('.'), encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stderr}`);
    assert.equal(existsSync(join(backup, 'seed-ledger.jsonl')), true);
    assert.deepEqual(readFileSync(join(backup, 'seed-ledger.jsonl')), before);
    const afterRecovery = new SeedLedger(stateDir);
    assert.equal(afterRecovery.verifyChain().ok, true);
    assert.equal(afterRecovery.readAll().filter((r) => r.payload['eventId'] === 'evt-recovery-1').length, 1);

    const resumed = new SeedRunner({ stateDir, sourcePath: source, fromEnd: false });
    resumed.start();
    resumed.stop();
    const restarted = new SeedRunner({ stateDir, sourcePath: source, fromEnd: false });
    restarted.start();
    assert.equal(new SeedLedger(stateDir).verifyChain().ok, true);
    assert.equal(new SeedLedger(stateDir).readAll().filter((r) => r.payload['eventId'] === 'evt-recovery-1').length, 1);
    restarted.stop();
  });

}
