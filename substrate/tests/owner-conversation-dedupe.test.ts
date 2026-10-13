import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedRunner } from '../src/runner.js';
import { SeedLedger } from '../src/ledger.js';
import type { SeedRunnerOptions } from '../src/runner.js';

function ownerLine(id: string, minute = 0): string {
  return JSON.stringify({ ts: `2026-10-13T12:${String(minute).padStart(2, '0')}:00.000Z`, role: 'user',
    text: `The owner asks for ${id}.`, voice: 'jtr', contactId: `message:${id}`,
    sourceRef: `coordination.message:${id}`, session: 'coordination:shared',
    actor: { kind: 'owner', principalId: 'owner-1' } }) + '\n';
}

function fixture(t: { after(fn: () => void): void }, opts: Partial<SeedRunnerOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'owner-contact-dedupe-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  const sourcePath = join(root, 'events.jsonl');
  const left = join(root, 'left.jsonl');
  const right = join(root, 'right.jsonl');
  for (const path of [sourcePath, left, right]) writeFileSync(path, '');
  const options: SeedRunnerOptions = { stateDir, sourcePath, fromEnd: false,
    workspaceEveryN: 1000, checkpointEveryN: 1000,
    anatomy: [
      { id: 'contact.owner.voice', role: 'owner' }, { id: 'world.home', role: 'observation' },
      { id: 'periphery.open-field', role: 'periphery' },
    ],
    extraSources: [
      { id: 'a-left', sourcePath: left, sourceType: 'conversation-stream' },
      { id: 'b-right', sourcePath: right, sourceType: 'conversation-stream' },
    ], ...opts };
  return { root, stateDir, sourcePath, left, right, options };
}

test('canonical owner mirrors transition once across streams, delayed arrival, restart and lost source cursor', async t => {
  const f = fixture(t);
  writeFileSync(f.left, ownerLine('same'));
  writeFileSync(f.right, ownerLine('same') + ownerLine('second', 1));
  const runner = new SeedRunner(f.options);
  runner.start();
  try {
    const first = await runner.tick();
    assert.equal(first.pulled, 3);
    assert.equal(first.transitioned, 2, 'a shared Core message is one owner contact');
    appendFileSync(f.left, ownerLine('second', 1));
    assert.equal((await runner.tick()).transitioned, 0, 'a later mirror is still the same contact');
  } finally { runner.stop(); }
  const ledgerPath = join(f.stateDir, 'seed-ledger.jsonl');
  const beforeRestart = readFileSync(ledgerPath, 'utf8');
  unlinkSync(join(f.stateDir, 'adapter-cursor.a-left.json'));
  const restarted = new SeedRunner(f.options);
  restarted.start();
  try {
    assert.equal((await restarted.tick()).transitioned, 0, 'accepted receipt identities survive lost adapter cursors');
    appendFileSync(f.right, ownerLine('third', 2));
    assert.equal((await restarted.tick()).transitioned, 1);
    assert.equal(restarted.seedProcess.getState().transitionCount, 3);
  } finally { restarted.stop(); }
  assert.ok(readFileSync(ledgerPath, 'utf8').startsWith(beforeRestart), 'history remains byte-identical');
  const ledger = new SeedLedger(f.stateDir);
  assert.equal(ledger.verifyChain().ok, true);
  const accepted = ledger.readAll().filter(record => record.category === 'transition');
  assert.equal(new Set(accepted.map(record => record.payload['eventId'])).size, 3);
});

for (const stopBy of ['maxEvents', 'requestStop'] as const) {
  test(`an unprocessed mirrored occurrence keeps its own cursor when ${stopBy} ends the tick`, async t => {
    const f = fixture(t, stopBy === 'maxEvents' ? { maxEvents: 1 } : {});
    writeFileSync(f.left, ownerLine('same'));
    writeFileSync(f.right, ownerLine('same') + ownerLine('later', 1));
    let runner: SeedRunner;
    runner = new SeedRunner({ ...f.options, log: line => {
      if (stopBy === 'requestStop' && line.startsWith('transition ')) runner.requestStop();
    } });
    runner.start();
    try { assert.equal((await runner.tick()).transitioned, 1); }
    finally { runner.stop(); }
    assert.equal(existsSync(join(f.stateDir, 'adapter-cursor.b-right.json')), false,
      'processing another adapter with the same event id does not acknowledge this occurrence');
    const resumed = new SeedRunner({ ...f.options, maxEvents: undefined });
    resumed.start();
    try {
      const report = await resumed.tick();
      assert.equal(report.pulled, 2);
      assert.equal(report.transitioned, 1, 'the mirror is skipped but the next distinct contact is retained');
      assert.equal(JSON.parse(readFileSync(join(f.stateDir, 'adapter-cursor.b-right.json'), 'utf8')).offset,
        Buffer.byteLength(readFileSync(f.right, 'utf8')));
    } finally { resumed.stop(); }
  });
}

test('an unsuccessful owner transition is not remembered as accepted contact', async t => {
  const f = fixture(t);
  writeFileSync(f.left, ownerLine('retry'));
  const runner = new SeedRunner(f.options);
  runner.start();
  const seed = runner.seedProcess;
  const transition = seed.transition.bind(seed);
  seed.transition = () => { throw new Error('injected receipt failure'); };
  try {
    await assert.rejects(runner.tick(), /injected receipt failure/);
    assert.equal(seed.getState().transitionCount, 0);
    seed.transition = transition;
    assert.equal((await runner.tick()).transitioned, 1);
  } finally { seed.transition = transition; runner.stop(); }
});

test('an opted-in owner lane deduplicates own conversation feeds, while legacy generic conversations keep replay semantics', async t => {
  const f = fixture(t);
  writeFileSync(f.left, ownerLine('own'));
  writeFileSync(f.right, ownerLine('own'));
  const ownSources = f.options.extraSources!.map(source => ({ ...source, sourceType: 'conversation-stream' as const }));
  const runner = new SeedRunner({ ...f.options, extraSources: ownSources, anatomy: [
    { id: 'contact.owner.voice', role: 'owner' }, { id: 'world.home', role: 'observation' },
    { id: 'periphery.open-field', role: 'periphery' },
  ] });
  runner.start();
  try { assert.equal((await runner.tick()).transitioned, 1); }
  finally { runner.stop(); }
  const legacy = fixture(t, { extraSources: ownSources, anatomy: undefined });
  const legacyRunner = new SeedRunner(legacy.options);
  legacyRunner.start();
  try { assert.equal((await legacyRunner.tick()).transitioned, 2, 'existing generic contact changes only after explicit opt-in'); }
  finally { legacyRunner.stop(); }
});
