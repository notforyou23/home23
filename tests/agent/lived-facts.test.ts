/**
 * FACTS@seed — v2 cut 4, where beliefs go load-bearing. Pins the gates
 * (they ARE the honesty machinery): confidence ≥0.75, ≥2 evidence refs,
 * and the belief must have STOOD through the recent event window — a
 * fresh conclusion waits, however confident. Too few gate-passers → null
 * (no facts surface is claimed). Provenance rides every line.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeLivedFacts } from '../../src/substrate/lived-facts.js';

function makeSeedDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'lived-facts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Chain: seqs 1..1000; the age window (200) opens at seq 800, whose record
 * is stamped 2026-08-09T00:00 — beliefs created after that are too young. */
function writeFixture(dir: string, estimates: Array<Record<string, unknown>>): void {
  mkdirSync(join(dir, 'checkpoints'), { recursive: true });
  writeFileSync(join(dir, 'checkpoints', 'ckpt_aaaa0001_t.json'), JSON.stringify({
    version: 2, ledgerSeq: 1000,
    cells: [{
      id: 'world.home23', generation: 500, workspacePressure: 0.3,
      energy: { current: 1 }, uncertainty: 0.4,
      estimates, predictions: [], intentions: [], realityRefs: [],
    }],
  }), 'utf-8');
  const ledger = [
    { seq: 800, category: 'transition', sourceRef: 'x', issuedAt: '2026-08-09T00:00:00.000Z', payload: {} },
    { seq: 1000, category: 'transition', sourceRef: 'x', issuedAt: '2026-08-09T12:00:00.000Z', payload: {} },
  ];
  writeFileSync(join(dir, 'seed-ledger.jsonl'), ledger.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

const AGED = '2026-08-07T10:00:00.000Z'; // predates the window opening

test('only gate-passing beliefs become facts; every exclusion is honest', (t) => {
  const dir = makeSeedDir(t);
  writeFixture(dir, [
    { claim: 'Heartbeat cadence is stable at ~5-minute intervals', confidence: 0.85, evidenceRefs: ['a', 'b', 'c'], createdAt: AGED },
    { claim: 'Retrieval degradation recovers in under 100ms', confidence: 0.78, evidenceRefs: ['d', 'e'], createdAt: AGED },
    { claim: 'echo estimate over 8 refs (deadbeef)', confidence: 0.5, evidenceRefs: ['f', 'g', 'h'], createdAt: AGED },
    { claim: 'confident but unevidenced hunch', confidence: 0.9, evidenceRefs: ['only-one'], createdAt: AGED },
    { claim: 'brilliant but brand-new correlation', confidence: 0.88, evidenceRefs: ['i', 'j'], createdAt: '2026-08-09T11:00:00.000Z' },
  ]);
  const facts = composeLivedFacts(dir);
  assert.ok(facts !== null);
  assert.ok(facts.includes('Heartbeat cadence is stable'), 'aged, confident, evidenced → fact');
  assert.ok(facts.includes('recovers in under 100ms'), 'second gate-passer → fact');
  assert.ok(!facts.includes('echo estimate'), 'low confidence excluded');
  assert.ok(!facts.includes('unevidenced hunch'), 'thin evidence excluded, however confident');
  assert.ok(!facts.includes('brand-new correlation'), 'a fresh belief waits — it has not stood through lived time');
  assert.ok(facts.includes('(0.85, 3 refs, held since 2026-08-07)'), 'provenance rides the line');
  assert.ok(facts.includes('stood while ≥200 chain events'), 'the surface states its own gates');
});

test('fewer than two gate-passers → null: no facts surface is claimed at all', (t) => {
  const dir = makeSeedDir(t);
  writeFixture(dir, [
    { claim: 'single lonely fact', confidence: 0.9, evidenceRefs: ['a', 'b'], createdAt: AGED },
    { claim: 'echo noise', confidence: 0.5, evidenceRefs: ['c', 'd'], createdAt: AGED },
  ]);
  assert.equal(composeLivedFacts(dir), null);
  const empty = makeSeedDir(t);
  assert.equal(composeLivedFacts(empty), null, 'no state → null');
});

test('budget drops whole facts from the low-confidence end, never mid-line', (t) => {
  const dir = makeSeedDir(t);
  writeFixture(dir, Array.from({ length: 8 }, (_, i) => ({
    claim: `durable observed regularity number ${i} with enough words to cost real budget in the rendering`,
    confidence: 0.75 + i * 0.02,
    evidenceRefs: ['a', 'b'],
    createdAt: AGED,
  })));
  const tiny = composeLivedFacts(dir, 600);
  assert.ok(tiny !== null && tiny.length <= 600);
  assert.ok(tiny.includes('regularity number 7'), 'highest confidence survives');
  assert.ok(tiny.includes('FACTS (lived)'), 'header survives');
});
