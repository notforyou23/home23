import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { prepareSeedBirth, FRESH_SEED_ANATOMY } from '../../cli/lib/seed-birth.js';

const { SeedProcess } = await tsImport('../../substrate/src/seed.ts', import.meta.url);
const { SeedLedger } = await tsImport('../../substrate/src/ledger.ts', import.meta.url);
const { SeedRunner } = await tsImport('../../substrate/src/runner.ts', import.meta.url);
const input = { name: 'river', ownerName: 'Casey', purpose: 'Help with garden projects.', provider: 'openai', model: 'gpt-5.4-mini' };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'home23 seed birth '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function snapshot(dir) {
  return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const parent = entry.parentPath ?? entry.path;
      const file = join(parent, entry.name);
      return [file.slice(dir.length), readFileSync(file).toString('base64')];
    }));
}

test('fresh creation makes a named, restorable Seed with its own anatomy and no historical life', async (t) => {
  const root = fixture(t);
  const { substrate, receipt, stateDir } = await prepareSeedBirth(root, input);
  assert.equal(substrate.enabled, true);
  assert.equal(substrate.lobeProvider, input.provider);
  assert.equal(substrate.lobeModel, input.model);
  assert.equal(substrate.selfFormation, true);
  const ledger = new SeedLedger(stateDir);
  assert.equal(ledger.verifyChain().ok, true);
  const records = ledger.readAll();
  assert.deepEqual(records.map((record) => record.category), ['genesis', 'checkpoint']);
  assert.equal(records[0].payload.name, 'river');
  assert.equal(records[0].payload.selfFormation, true);
  assert.deepEqual(records[0].payload.anatomy, FRESH_SEED_ANATOMY);
  assert.doesNotMatch(JSON.stringify(records), /jtr-jerry|shakedown|frontier\.substrate-os/);
  assert.equal(SeedProcess.restore(stateDir).getState().seedId, receipt.seedId);
  assert.equal(receipt.runtimeStarted, false);
  assert.equal(receipt.modelInvocations, 0);
  assert.equal(receipt.stateDir, 'substrate/seed-01');
});

test('retry preserves the exact lineage and all bytes, including life added after preparation', async (t) => {
  const root = fixture(t);
  const first = await prepareSeedBirth(root, input);
  const seed = SeedProcess.restore(first.stateDir);
  seed.transition({ eventId: 'evt_first', category: 'correction', sourceAuthority: 'seed.adapter',
    sourceRef: 'owner:first', payload: { text: 'My first observation' }, producedAt: new Date().toISOString() });
  seed.checkpoint();
  const before = snapshot(first.stateDir);
  const retried = await prepareSeedBirth(root, input);
  assert.deepEqual(retried.receipt, first.receipt);
  assert.deepEqual(snapshot(first.stateDir), before);
  assert.equal(new SeedLedger(first.stateDir).readAll().filter((record) => record.category === 'genesis').length, 1);
});

test('the real runner consumes a prepared resident life and resumes that same lineage', async (t) => {
  const root = fixture(t);
  const { receipt, stateDir } = await prepareSeedBirth(root, input);
  const sourcePath = join(root, 'resident-events.jsonl');
  const line = (id) => `${JSON.stringify({ event_id: id, event_type: 'MemoryChallenged',
    timestamp: new Date().toISOString(), payload: { text: 'Remember my garden project.' } })}\n`;
  writeFileSync(sourcePath, line('contact-1'));
  const sourceBefore = readFileSync(sourcePath, 'utf8');
  const first = new SeedRunner({ stateDir, sourcePath, fromEnd: false });
  try {
    first.start();
    assert.equal((await first.tick()).pulled, 1);
  } finally {
    first.stop();
  }
  assert.equal(readFileSync(sourcePath, 'utf8'), sourceBefore);
  appendFileSync(sourcePath, line('contact-2'));
  const restarted = new SeedRunner({ stateDir, sourcePath, fromEnd: false });
  try {
    restarted.start();
    assert.equal((await restarted.tick()).pulled, 1, 'only the new event follows a restart');
    assert.equal((await restarted.tick()).pulled, 0);
  } finally {
    restarted.stop();
  }
  const ledger = new SeedLedger(stateDir);
  assert.equal(ledger.verifyChain().ok, true);
  assert.equal(ledger.readAll().filter((record) => record.category === 'genesis').length, 1);
  const restored = SeedProcess.restore(stateDir);
  assert.equal(restored.getState().seedId, receipt.seedId);
  assert.equal(restored.getState().transitionCount, 2);
  assert.deepEqual(restored.getState().cellIds, FRESH_SEED_ANATOMY.map((cell) => cell.id));
});

test('different residents receive distinct lineages and changed creation inputs cannot rewrite a birth', async (t) => {
  const root = fixture(t);
  const first = await prepareSeedBirth(root, input);
  const second = await prepareSeedBirth(root, { ...input, name: 'moss' });
  assert.notEqual(first.receipt.seedId, second.receipt.seedId);
  const before = snapshot(first.stateDir);
  await assert.rejects(prepareSeedBirth(root, { ...input, ownerName: 'Another person' }), /does not match/);
  assert.deepEqual(snapshot(first.stateDir), before);
});

test('unreceipted existing Seed is preserved and refused', async (t) => {
  const root = fixture(t);
  const stateDir = join(root, 'instances', input.name, 'substrate', 'seed-01');
  mkdirSync(stateDir, { recursive: true });
  SeedProcess.initialize(stateDir).checkpoint();
  const before = snapshot(stateDir);
  await assert.rejects(prepareSeedBirth(root, input), /without a birth receipt/);
  assert.deepEqual(snapshot(stateDir), before);
});

test('damaged lineage or checkpoint is reported without repair or rebirth', async (t) => {
  const root = fixture(t);
  const first = await prepareSeedBirth(root, input);
  const checkpointPath = join(first.stateDir, 'checkpoints', `${first.receipt.checkpointId}.json`);
  writeFileSync(checkpointPath, '{}');
  const before = snapshot(first.stateDir);
  await assert.rejects(prepareSeedBirth(root, input), /checkpoint failed verification/);
  assert.deepEqual(snapshot(first.stateDir), before);
  const second = await prepareSeedBirth(root, { ...input, name: 'moss' });
  const ledgerPath = join(second.stateDir, 'seed-ledger.jsonl');
  writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8').replace('world.home', 'world.changed'));
  const damaged = snapshot(second.stateDir);
  await assert.rejects(prepareSeedBirth(root, { ...input, name: 'moss' }), /lineage failed verification/);
  assert.deepEqual(snapshot(second.stateDir), damaged);
});

test('invalid input does not create installation state', async (t) => {
  const root = fixture(t);
  await assert.rejects(prepareSeedBirth(root, { ...input, name: '../elsewhere' }), /agent name/);
  await assert.rejects(prepareSeedBirth(root, { ...input, model: '' }), /requires model/);
  assert.deepEqual(readdirSync(root), []);
});
