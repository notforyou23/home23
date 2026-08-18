import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import { AnatomyNotNamedError, CapabilityDeniedError, ResourceBudgetExceededError } from '../src/types.js';
import type { SourceEvent } from '../src/types.js';
import { TEST_ANATOMY } from './named-anatomy.js';

const TEST_CELL_IDS = TEST_ANATOMY.map((a) => a.id);

function makeDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-seed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeEvent(overrides: Partial<SourceEvent> = {}): SourceEvent {
  return {
    eventId: `evt_${Date.now().toString(36)}`,
    category: 'observation',
    sourceAuthority: 'seed.adapter',
    sourceRef: `ref-${Math.random().toString(36).slice(2)}`,
    payload: { test: true },
    producedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('birth without named anatomy refuses — no invented person', (t) => {
  const dir = makeDir(t);
  assert.throws(
    () => SeedProcess.initialize(dir),
    (err) => err instanceof AnatomyNotNamedError,
  );
});

test('named anatomy is recorded as the birth body', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY });
  const state = seed.getState();
  assert.deepEqual(state.cellIds.sort(), [...TEST_CELL_IDS].sort());
});

test('cells start with forming or living status (not dormant/dissolving)', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY });
  for (const id of TEST_CELL_IDS) {
    const cell = seed.getCell(id);
    assert.ok(cell !== undefined, `cell ${id} missing`);
    assert.ok(
      cell.status === 'forming' || cell.status === 'living',
      `cell ${id} has unexpected status: ${cell.status}`,
    );
  }
});

test('initial continuous state is all zeros', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY });
  for (const id of TEST_CELL_IDS) {
    const cs = seed.getContinuousState(id);
    assert.ok(cs !== undefined, `continuous state missing for ${id}`);
    const allZero = Array.from(cs).every((v) => v === 0);
    assert.ok(allZero, `${id} continuous state not all zero on init`);
  }
});

test('ingest writes to ledger and increments event count', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY });
  const before = seed.getState().eventCount;
  seed.ingest(makeEvent());
  const after = seed.getState().eventCount;
  assert.equal(after, before + 1);
});

test('transition updates continuous state (non-zero after event)', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY });
  const event = makeEvent({ category: 'observation' });
  seed.transition(event);
  // world.home23 is the default route for 'observation'
  const cs = seed.getContinuousState('world.home23');
  assert.ok(cs !== undefined);
  const anyNonZero = Array.from(cs).some((v) => v !== 0);
  assert.ok(anyNonZero, 'continuous state should be non-zero after transition');
});

test('state hash changes after each transition', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY });
  const h0 = seed.getState().stateHash;
  seed.transition(makeEvent({ sourceRef: 'e1', producedAt: '2026-01-01T00:00:00.000Z' }));
  const h1 = seed.getState().stateHash;
  seed.transition(makeEvent({ sourceRef: 'e2', producedAt: '2026-01-01T00:00:01.000Z' }));
  const h2 = seed.getState().stateHash;
  assert.notEqual(h0, h1);
  assert.notEqual(h1, h2);
});

test('transition result carries correct stateHashBefore and stateHashAfter', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY });
  const stateBefore = seed.getState().stateHash;
  const result = seed.transition(makeEvent());
  assert.equal(result.stateHashBefore, stateBefore);
  assert.equal(result.stateHashAfter, seed.getState().stateHash);
  assert.ok(result.stateHashBefore !== result.stateHashAfter);
  assert.ok(typeof result.ledgerCursor === 'string' && result.ledgerCursor.length === 64);
});

test('transition routes corrections to contact.jtr-jerry', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY });
  const before = seed.getContinuousState('contact.jtr-jerry')!.slice();
  seed.transition(makeEvent({ category: 'correction' }));
  const after = seed.getContinuousState('contact.jtr-jerry')!;
  const changed = Array.from(after).some((v, i) => v !== (before[i] ?? 0));
  assert.ok(changed, 'contact.jtr-jerry should change on correction event');
});

test('budget ceiling: maxEventCount exceeded throws ResourceBudgetExceededError', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, { maxEventCount: 2 }, { anatomy: TEST_ANATOMY });
  // GENESIS event already consumed 1 slot
  seed.ingest(makeEvent()); // 2nd event — hits ceiling next
  assert.throws(
    () => seed.ingest(makeEvent()),
    (err) => err instanceof ResourceBudgetExceededError && err.resource === 'eventCount',
  );
});

test('membrane: forbidden capability throws even when called from within seed context', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY });
  assert.throws(
    () => seed.mem.assert('home23.engine.modify'),
    (err) => err instanceof CapabilityDeniedError,
  );
});

test('checkpoint returns a string ID', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY });
  seed.transition(makeEvent());
  const id = seed.checkpoint();
  assert.ok(typeof id === 'string' && id.startsWith('ckpt_'));
});

test('stop returns checkpoint ID and ledger records a stop event', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY });
  seed.transition(makeEvent());
  const checkpointId = seed.stop();
  assert.ok(typeof checkpointId === 'string');
  assert.ok(seed.getState().ledgerSeq > 1);
});

// ─── Fail-closed integrity fixes (post-review) ───────────────────────────────

test('transition append failure leaves state exactly unchanged (receipt before commit)', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY });
  seed.transition(makeEvent({ sourceRef: 'ref-warmup' }));

  const before = seed.getState();
  const snapshots = new Map<string, number[]>();
  for (const id of before.cellIds) {
    const cs = seed.getContinuousState(id);
    assert.ok(cs !== undefined);
    snapshots.set(id, Array.from(cs));
  }

  const ledgerPath = join(dir, 'seed-ledger.jsonl');
  chmodSync(ledgerPath, 0o444);
  t.after(() => {
    try { chmodSync(ledgerPath, 0o644); } catch { /* dir already removed */ }
  });

  assert.throws(
    () => seed.transition(makeEvent({ sourceRef: 'ref-blocked' })),
    'transition must throw when the receipt cannot be committed',
  );

  const after = seed.getState();
  assert.equal(after.stateHash, before.stateHash, 'stateHash must not move without a receipt');
  assert.equal(after.transitionCount, before.transitionCount, 'transitionCount must not move without a receipt');
  assert.equal(after.ledgerSeq, before.ledgerSeq, 'ledgerSeq must not move on a failed append');
  for (const id of after.cellIds) {
    const cs = seed.getContinuousState(id);
    const snap = snapshots.get(id);
    assert.ok(cs !== undefined && snap !== undefined);
    for (let i = 0; i < cs.length; i++) {
      assert.ok(Object.is(cs[i], snap[i]), `${id}[${i}] mutated despite failed receipt`);
    }
  }

  chmodSync(ledgerPath, 0o644);
  const resumed = seed.transition(makeEvent({ sourceRef: 'ref-resumed' }));
  assert.equal(resumed.stateHashBefore, before.stateHash, 'recovery must chain from the receipted state');
});

test('initialize refuses a stateDir that already holds a seed ledger', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY });
  seed.transition(makeEvent());
  assert.throws(
    () => SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY }),
    /already exists.*restore/s,
    'second initialize must refuse instead of forking identity with a new genesis',
  );
});

test('restore refuses a tampered ledger (chain verified on the restore path)', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY });
  seed.transition(makeEvent({ sourceRef: 'ref-a' }));
  seed.transition(makeEvent({ sourceRef: 'ref-b' }));
  const checkpointId = seed.stop();

  const ledgerPath = join(dir, 'seed-ledger.jsonl');
  const lines = readFileSync(ledgerPath, 'utf-8').split('\n').filter((l) => l.trim());
  const target = lines[1];
  assert.ok(target !== undefined);
  lines[1] = target.replace('"payload":{', '"payload":{"tampered":true,');
  writeFileSync(ledgerPath, lines.join('\n') + '\n', 'utf-8');

  assert.throws(
    () => SeedProcess.restore(dir, checkpointId),
    /chain verification/,
    'restore must refuse a ledger whose chain does not verify',
  );
});

test('restore refuses a checkpoint whose cursor does not match this ledger', (t) => {
  const dirA = makeDir(t);
  const dirB = makeDir(t);

  const seedA = SeedProcess.initialize(dirA, undefined, { anatomy: TEST_ANATOMY });
  seedA.transition(makeEvent({ sourceRef: 'a-1', producedAt: '2026-08-07T10:00:00.000Z' }));
  const checkpointId = seedA.stop();

  const seedB = SeedProcess.initialize(dirB, undefined, { anatomy: TEST_ANATOMY });
  for (let i = 0; i < 6; i++) {
    seedB.transition(makeEvent({ sourceRef: `b-${i}`, producedAt: `2026-08-07T10:00:0${i}.000Z` }));
  }
  seedB.stop();

  // Swap in B's (valid, longer) ledger under A's checkpoints: chain verifies,
  // seq is sufficient, but the cursor binding must expose the foreign chain.
  copyFileSync(join(dirB, 'seed-ledger.jsonl'), join(dirA, 'seed-ledger.jsonl'));

  assert.throws(
    () => SeedProcess.restore(dirA, checkpointId),
    /cursor mismatch/,
    'restore must bind the checkpoint to its own chain, not any sufficiently long chain',
  );
});

test('inspection API is copy-on-read: mutating returned state cannot touch the Seed', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY });
  seed.transition(makeEvent({ sourceRef: 'ref-inspect' }));
  const hashBefore = seed.getState().stateHash;

  const cs = seed.getContinuousState('world.home23');
  assert.ok(cs !== undefined);
  cs.fill(0.99);

  const cell = seed.getCell('world.home23');
  assert.ok(cell !== undefined);
  (cell as { uncertainty: number }).uncertainty = 0.01;
  (cell as { intentions: unknown[] }).intentions.push({ injected: true });

  assert.equal(
    seed.getState().stateHash,
    hashBefore,
    'no inspection-path mutation may move the state hash — state changes only through receipted transitions',
  );
  const fresh = seed.getCell('world.home23');
  assert.ok(fresh !== undefined);
  assert.equal(fresh.intentions.length, 0, 'internal cell must not have received the injected intention');
});
