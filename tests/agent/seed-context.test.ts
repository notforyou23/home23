/**
 * SUBSTRATE surface (Seed → situational awareness): composes carried state
 * from a Seed's checkpoint + ledger tail, read-only and degraded-honest —
 * missing state yields null (absence, never fabrication), torn mirror tails
 * are tolerated, and the block surfaces what the receipts actually say:
 * pressurized situations, development by rule, earned trust, open
 * expectations with deadlines, strongest estimates.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeSeedSituation } from '../../src/substrate/seed-context.js';

function makeSeedDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'seed-context-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFixture(dir: string): void {
  mkdirSync(join(dir, 'checkpoints'), { recursive: true });
  const cells = [
    {
      id: 'world.pi', generation: 905, workspacePressure: 0.26,
      energy: { current: 1.0 }, uncertainty: 0.24,
      estimates: [{ claim: 'Barometric pressure mean 1011.20 hPa', confidence: 0.84 }],
      predictions: [
        { claim: 'pressure will fall below 1010', confidence: 0.6, horizon: '2h', createdAt: '2026-08-08T12:00:00.000Z' },
        { claim: 'already answered', confidence: 0.7, horizon: '1h', createdAt: '2026-08-08T10:00:00.000Z', resolvedAt: '2026-08-08T11:00:00.000Z', error: 0.1 },
      ],
      intentions: [{ description: 'watch the door', magnitude: 0.6, open: true }],
    },
    {
      id: 'contact.jtr', generation: 4, workspacePressure: 0.15,
      energy: { current: 0.4 }, uncertainty: 0.4,
      estimates: [], predictions: [], intentions: [],
    },
  ];
  writeFileSync(
    join(dir, 'checkpoints', 'ckpt_aaaa0001_test.json'),
    JSON.stringify({ version: 2, ledgerSeq: 1234, cells }),
    'utf-8',
  );
  const ledger = [
    { seq: 1230, category: 'development', sourceRef: 'seed', payload: { rule: 'correction.v1', trustKey: 'worker.systems', trust: 1.3 } },
    { seq: 1231, category: 'development', sourceRef: 'seed', payload: { rule: 'resolution.v1', trustKey: 'self.prediction', trust: 1 } },
    { seq: 1232, category: 'transition', sourceRef: 'baro.sample:x', payload: {} },
  ];
  writeFileSync(join(dir, 'seed-ledger.jsonl'), ledger.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

test('composes carried situations, development, trust, open expectations, estimates', (t) => {
  const dir = makeSeedDir(t);
  writeFixture(dir);
  const block = composeSeedSituation(dir);
  assert.ok(block !== null);
  assert.ok(block.includes('world.pi'), 'situations present');
  assert.ok(block.indexOf('world.pi') < block.indexOf('contact.jtr'), 'ranked by presence');
  assert.ok(block.includes('1 open intention'), 'open intentions counted');
  assert.ok(block.includes('correction.v1 ×1'), 'development narrated by rule');
  assert.ok(block.includes('worker.systems (1.30)'), 'earned trust surfaced');
  assert.ok(!block.includes('self.prediction'), 'bookkeeping trust keys stay out');
  assert.ok(block.includes('pressure will fall below 1010'), 'open expectation surfaced');
  assert.ok(!block.includes('already answered'), 'resolved predictions are not open expectations');
  assert.ok(block.includes('1011.20 hPa'), 'strongest estimate surfaced');
  assert.ok(block.includes('seq 1234'), 'cites the chain position');
});

test('missing or unreadable state yields null — absence, never fabrication', (t) => {
  const dir = makeSeedDir(t);
  assert.equal(composeSeedSituation(dir), null, 'empty dir → null');
  assert.equal(composeSeedSituation(join(dir, 'nope')), null, 'missing dir → null');
  mkdirSync(join(dir, 'checkpoints'), { recursive: true });
  writeFileSync(join(dir, 'checkpoints', 'ckpt_bad_x.json'), '{torn', 'utf-8');
  assert.equal(composeSeedSituation(dir), null, 'corrupt checkpoint → null');
});

test('tolerates a torn ledger tail (live mirror) and respects the budget', (t) => {
  const dir = makeSeedDir(t);
  writeFixture(dir);
  appendFileSync(join(dir, 'seed-ledger.jsonl'), '{"seq":1233,"category":"transi', 'utf-8');
  const block = composeSeedSituation(dir);
  assert.ok(block !== null, 'torn tail does not break composition');

  const tiny = composeSeedSituation(dir, 200);
  assert.ok(tiny !== null && tiny.length <= 200, 'budget respected');
});
