import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import { SeedLedger } from '../src/ledger.js';

const CLI = resolve(import.meta.dirname, '../bin/seed-enable-owner-voice.ts');

function fixture(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'seed-owner-voice-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  SeedProcess.initialize(dir, undefined, { reservoirSeed: 1234 }).stop();
  return dir;
}

function run(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    encoding: 'utf8', timeout: 15_000,
  });
}

test('owner voice opt-in CLI appends a growth receipt without rewriting prior chain bytes', (t) => {
  const dir = fixture(t);
  const chainPath = join(dir, 'seed-ledger.jsonl');
  const before = readFileSync(chainPath, 'utf8');
  const result = run(dir, 'owner:test', '2026-10-13T14:00:00.000Z');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readFileSync(chainPath, 'utf8').startsWith(before));
  const ledger = new SeedLedger(dir);
  assert.equal(ledger.verifyChain().ok, true);
  const receipt = ledger.readAll().find((record) => record.sourceRef === 'growth.owner-voice-application');
  assert.ok(receipt, 'operator application must be recorded on the chain');
  assert.equal(receipt.payload['authorizedBy'], 'owner:test');
  assert.equal(receipt.payload['asOf'], '2026-10-13T14:00:00.000Z');
  const restored = SeedProcess.restore(dir, undefined, { requireCheckpointCoversTail: true });
  assert.ok(restored.getState().cellIds.includes('contact.owner.voice'));
  assert.equal(existsSync(join(dir, '.runner.lock')), false);
  const after = readFileSync(chainPath, 'utf8');
  const repeated = run(dir, 'owner:test', '2026-10-13T15:00:00.000Z');
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).alreadyEnabled, true);
  assert.equal(readFileSync(chainPath, 'utf8'), after, 'repeating opt-in must not create another growth episode');
});

test('owner voice opt-in CLI requires authorization and explicit event time before writing', (t) => {
  const dir = fixture(t);
  const before = readFileSync(join(dir, 'seed-ledger.jsonl'), 'utf8');
  for (const args of [[dir], [dir, ' ', '2026-10-13T14:00:00.000Z'], [dir, 'owner:test', 'invalid'],
    [dir, 'owner:test', '2026-02-30T14:00:00.000Z']]) {
    const result = run(...args);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(readFileSync(join(dir, 'seed-ledger.jsonl'), 'utf8'), before);
    assert.equal(existsSync(join(dir, '.runner.lock')), false);
  }
});

test('owner voice opt-in CLI refuses an occupied runner lock without touching the chain or lock', (t) => {
  const dir = fixture(t);
  const before = readFileSync(join(dir, 'seed-ledger.jsonl'), 'utf8');
  const lockPath = join(dir, '.runner.lock');
  writeFileSync(lockPath, String(process.pid));
  const result = run(dir, 'owner:test', '2026-10-13T14:00:00.000Z');
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /lock|runner/i);
  assert.equal(readFileSync(join(dir, 'seed-ledger.jsonl'), 'utf8'), before);
  assert.equal(readFileSync(lockPath, 'utf8'), String(process.pid));
});

test('owner voice opt-in CLI refuses uncheckpointed transitions without rewriting or repairing them', (t) => {
  const dir = fixture(t);
  const seed = SeedProcess.restore(dir);
  seed.transition({ eventId: 'pending', category: 'observation', sourceAuthority: 'seed.adapter',
    sourceRef: 'house.test:pending', payload: {}, producedAt: '2026-10-13T13:00:00.000Z' });
  const before = readFileSync(join(dir, 'seed-ledger.jsonl'), 'utf8');
  const result = run(dir, 'owner:test', '2026-10-13T14:00:00.000Z');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Uncheckpointed/);
  assert.equal(readFileSync(join(dir, 'seed-ledger.jsonl'), 'utf8'), before);
  assert.equal(existsSync(join(dir, '.runner.lock')), false);
});

test('owner voice opt-in CLI uses resident lifetime counters rather than proof-run caps', t => {
  const dir = fixture(t);
  const checkpointPath = join(dir, 'checkpoints', readdirSync(join(dir, 'checkpoints'))
    .find(name => name.startsWith('ckpt_') && name.endsWith('.json'))!);
  const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
  // Simulate a long-lived resident's telemetry in an isolated fixture.
  // These counters do not participate in the cell state hash or chain cursor.
  checkpoint.resourceSnapshot.eventCount = 100_001;
  checkpoint.resourceSnapshot.transitionCount = 100_001;
  checkpoint.resourceSnapshot.checkpointCount = 10_001;
  writeFileSync(checkpointPath, JSON.stringify(checkpoint));
  const result = run(dir, 'owner:test', '2026-10-13T14:00:00.000Z');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(new SeedLedger(dir).verifyChain().ok, true);
});
