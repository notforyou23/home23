import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedLedger } from '../src/ledger.js';

function makeDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('GENESIS anchor: first record has prevHash=GENESIS', (t) => {
  const dir = makeDir(t);
  const ledger = new SeedLedger(dir);
  const rec = ledger.append({
    category: 'genesis',
    sourceAuthority: 'seed.internal',
    sourceRef: 'test-seed-1',
    payload: { note: 'first' },
  });
  assert.equal(rec.seq, 1);
  assert.equal(rec.prevHash, 'GENESIS');
  assert.equal(rec.schema, 'home23.seed.ledger.v1');
});

test('monotonic seq across records', (t) => {
  const dir = makeDir(t);
  const ledger = new SeedLedger(dir);
  const r1 = ledger.append({ category: 'genesis', sourceAuthority: 'seed.internal', sourceRef: 'x', payload: {} });
  const r2 = ledger.append({ category: 'observation', sourceAuthority: 'seed.adapter', sourceRef: 'y', payload: {} });
  const r3 = ledger.append({ category: 'transition', sourceAuthority: 'seed.internal', sourceRef: 'z', payload: {} });
  assert.equal(r1.seq, 1);
  assert.equal(r2.seq, 2);
  assert.equal(r3.seq, 3);
});

test('hash chain: prevHash of record N is sha256 of record N-1 line', (t) => {
  const dir = makeDir(t);
  const ledger = new SeedLedger(dir);
  ledger.append({ category: 'genesis', sourceAuthority: 'seed.internal', sourceRef: 'a', payload: {} });
  ledger.append({ category: 'observation', sourceAuthority: 'seed.adapter', sourceRef: 'b', payload: {} });

  const result = ledger.verifyChain();
  assert.ok(result.ok, `chain invalid: ${JSON.stringify(result.errors)}`);
  assert.equal(result.totalRecords, 2);
  assert.equal(result.errors.length, 0);
});

test('chain survives seq across new SeedLedger instance (resume)', (t) => {
  const dir = makeDir(t);
  const l1 = new SeedLedger(dir);
  l1.append({ category: 'genesis', sourceAuthority: 'seed.internal', sourceRef: 'a', payload: {} });
  l1.append({ category: 'observation', sourceAuthority: 'seed.adapter', sourceRef: 'b', payload: {} });
  const seqAfterFirst = l1.currentSeq;

  // Open a second instance — must resume from tail
  const l2 = new SeedLedger(dir);
  assert.equal(l2.currentSeq, seqAfterFirst);

  const r3 = l2.append({ category: 'transition', sourceAuthority: 'seed.internal', sourceRef: 'c', payload: {} });
  assert.equal(r3.seq, seqAfterFirst + 1);

  const verify = l2.verifyChain();
  assert.ok(verify.ok, `chain broken after resume: ${JSON.stringify(verify.errors)}`);
  assert.equal(verify.totalRecords, 3);
});

test('tamper detection: modifying a line breaks verifyChain', (t) => {
  const dir = makeDir(t);
  const ledger = new SeedLedger(dir);
  ledger.append({ category: 'genesis', sourceAuthority: 'seed.internal', sourceRef: 'a', payload: {} });
  ledger.append({ category: 'observation', sourceAuthority: 'seed.adapter', sourceRef: 'b', payload: { data: 'original' } });
  ledger.append({ category: 'transition', sourceAuthority: 'seed.internal', sourceRef: 'c', payload: {} });

  // Tamper: change the payload in line 2
  const ledgerPath = join(dir, 'seed-ledger.jsonl');
  const raw = readFileSync(ledgerPath, 'utf-8');
  const lines = raw.split('\n');
  const line2 = lines[1];
  if (line2 !== undefined) {
    const parsed = JSON.parse(line2) as Record<string, unknown>;
    (parsed['payload'] as Record<string, unknown>)['data'] = 'TAMPERED';
    lines[1] = JSON.stringify(parsed);
  }
  writeFileSync(ledgerPath, lines.join('\n'), 'utf-8');

  // Open a fresh ledger instance and verify — must detect the break
  const l2 = new SeedLedger(dir);
  const result = l2.verifyChain();
  assert.ok(!result.ok, 'expected chain verification to fail after tamper');
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.some((e) => e.type === 'prev_hash_mismatch'));
});

test('branch and replayFromSeq metadata are preserved', (t) => {
  const dir = makeDir(t);
  const ledger = new SeedLedger(dir);
  ledger.append({ category: 'genesis', sourceAuthority: 'seed.internal', sourceRef: 'a', payload: {} });
  const r2 = ledger.append({
    category: 'observation',
    sourceAuthority: 'seed.adapter',
    sourceRef: 'b',
    payload: {},
    branchId: 'branch-test-01',
    replayFromSeq: 1,
  });
  assert.equal(r2.branchId, 'branch-test-01');
  assert.equal(r2.replayFromSeq, 1);

  const all = ledger.readAll();
  const found = all.find((r) => r.seq === r2.seq);
  assert.ok(found !== undefined);
  assert.equal(found.branchId, 'branch-test-01');
});

test('fail-closed: SeedLedger throws on unwritable stateDir', () => {
  // The SeedLedger constructor mkdirSync fails on an impossible path.
  // Fail-closed: initialization throws, never silently accepts a bad state.
  assert.throws(
    () => new SeedLedger('/nonexistent-substrate-test-dir-xyz/state'),
    (err) => err instanceof Error,
  );
});

test('stateHashBefore and stateHashAfter are preserved in records', (t) => {
  const dir = makeDir(t);
  const ledger = new SeedLedger(dir);
  ledger.append({ category: 'genesis', sourceAuthority: 'seed.internal', sourceRef: 'a', payload: {} });
  const r = ledger.append({
    category: 'transition',
    sourceAuthority: 'seed.internal',
    sourceRef: 'b',
    payload: {},
    stateHashBefore: 'hash-before-abc',
    stateHashAfter: 'hash-after-def',
  });
  assert.equal(r.stateHashBefore, 'hash-before-abc');
  assert.equal(r.stateHashAfter, 'hash-after-def');

  const all = ledger.readAll();
  const found = all.find((rec) => rec.seq === r.seq);
  assert.ok(found !== undefined);
  assert.equal(found.stateHashBefore, 'hash-before-abc');
});

test('readFrom(seq) returns records >= seq', (t) => {
  const dir = makeDir(t);
  const ledger = new SeedLedger(dir);
  for (let i = 0; i < 5; i++) {
    ledger.append({ category: 'observation', sourceAuthority: 'seed.adapter', sourceRef: `e${i}`, payload: {} });
  }
  const tail = ledger.readFrom(3);
  assert.equal(tail.length, 3);
  assert.ok(tail[0] !== undefined && tail[0].seq === 3);
});

test('cursorAt(seq) equals the prevHash of the following record', (t) => {
  const dir = makeDir(t);
  const ledger = new SeedLedger(dir);
  ledger.append({ category: 'genesis', sourceAuthority: 'seed.internal', sourceRef: 's', payload: {} });
  ledger.append({ category: 'observation', sourceAuthority: 'seed.adapter', sourceRef: 'r1', payload: {} });
  ledger.append({ category: 'observation', sourceAuthority: 'seed.adapter', sourceRef: 'r2', payload: {} });

  const records = ledger.readAll();
  assert.equal(ledger.cursorAt(0), 'GENESIS');
  assert.equal(ledger.cursorAt(1), records[1]?.prevHash);
  assert.equal(ledger.cursorAt(2), records[2]?.prevHash);
  assert.equal(ledger.cursorAt(3), ledger.currentCursor);
  assert.throws(() => ledger.cursorAt(99), /No ledger record with seq/);
});

test('exists() reports a content-bearing ledger file only', (t) => {
  const dir = makeDir(t);
  assert.equal(SeedLedger.exists(dir), false);
  const ledger = new SeedLedger(dir);
  assert.equal(SeedLedger.exists(dir), false, 'constructor alone creates no ledger file');
  ledger.append({ category: 'genesis', sourceAuthority: 'seed.internal', sourceRef: 's', payload: {} });
  assert.equal(SeedLedger.exists(dir), true);
});
