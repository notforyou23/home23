/**
 * Lived identity — v2 cut 7: identity = constitution (SOUL, authored) +
 * biography (composed from the chain, first person, receipts underneath).
 * Pins: birth + body + track record + earned facts + trust + rulings;
 * null without a seed (constitution-only identity, as before); budget
 * drops whole clauses from the tail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeLivedIdentity, readSeedGenesis } from '../../src/substrate/lived-identity.js';

function makeSeedDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'lived-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFixture(dir: string): void {
  mkdirSync(join(dir, 'checkpoints'), { recursive: true });
  writeFileSync(join(dir, 'checkpoints', 'ckpt_aaaa0001_t.json'), JSON.stringify({
    version: 2, ledgerSeq: 900,
    cells: [{
      id: 'world.home23', generation: 800, workspacePressure: 0.3,
      energy: { current: 1 }, uncertainty: 0.4, intentions: [], realityRefs: [],
      estimates: [
        { claim: 'Heartbeat cadence stable ~5min', confidence: 0.85, evidenceRefs: ['a', 'b', 'c'], createdAt: '2026-08-07T10:00:00.000Z' },
        { claim: 'Degradation recovers under 100ms', confidence: 0.78, evidenceRefs: ['d', 'e'], createdAt: '2026-08-07T11:00:00.000Z' },
      ],
      predictions: [
        { claim: 'held', confidence: 0.8, horizon: '24h', createdAt: 'x', resolvedAt: 'y', error: 0.0 },
        { claim: 'missed', confidence: 0.6, horizon: '6h', createdAt: 'x', resolvedAt: 'y', error: 1.0 },
        { claim: 'pending', confidence: 0.6, horizon: '6h', createdAt: 'x' },
      ],
    }],
  }));
  const ledger = [
    { seq: 1, category: 'genesis', sourceRef: 'genesis', issuedAt: '2026-08-07T15:10:00.000Z', payload: { seedId: 'seed_test_0001', createdAt: '2026-08-07T15:10:00.000Z', cellIds: ['world.home23'] } },
    { seq: 700, category: 'transition', sourceRef: 'x', issuedAt: '2026-08-08T00:00:00.000Z', payload: {} },
    { seq: 850, category: 'development', sourceRef: 'seed', issuedAt: '2026-08-09T00:00:00.000Z', payload: { rule: 'correction.v1', trustKey: 'worker.systems', trust: 1.4 } },
    { seq: 880, category: 'act', sourceRef: 'growth.operator-decision', issuedAt: '2026-08-09T01:00:00.000Z', payload: { operatorDecision: 'declined', op: 'dissolve', authorizedBy: 'jtr', reason: 'feed them, dont shrink them' } },
    { seq: 900, category: 'transition', sourceRef: 'x', issuedAt: '2026-08-09T02:00:00.000Z', payload: {} },
  ];
  writeFileSync(join(dir, 'seed-ledger.jsonl'), ledger.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('the biography composes in first person with receipts underneath', (t) => {
  const dir = makeSeedDir(t);
  writeFixture(dir);
  const bio = composeLivedIdentity(dir);
  assert.ok(bio !== null);
  assert.ok(bio.includes('I was born 2026-08-07 as seed_test_0001; my chain holds 900 lived events.'), 'birth + age');
  assert.ok(bio.includes('My body: world.home23 (gen 800)'), 'the body with wear');
  assert.ok(bio.includes('2 prediction(s) judged by reality — 1 right, 1 wrong, 0 partial; 1 still open'), 'honest track record');
  assert.ok(bio.includes('2 of my conclusions have earned fact-grade'), 'earned facts counted through the real gates');
  assert.ok(bio.includes('worker.systems (1.40)'), 'earned trust');
  assert.ok(bio.includes('jtr has ruled on my growth 1 time(s); last: declined my dissolve — "feed them, dont shrink them"'), "the operator's hand, his words");
  assert.ok(bio.includes('cannot be edited, only lived further'), 'names its own nature');
});

test('no seed → null: identity stays constitution-only', (t) => {
  const dir = makeSeedDir(t);
  assert.equal(composeLivedIdentity(dir), null);
  assert.equal(readSeedGenesis(dir), null);
});

test('budget drops whole clauses, never mid-sentence; genesis reader survives a long chain head', (t) => {
  const dir = makeSeedDir(t);
  writeFixture(dir);
  const tiny = composeLivedIdentity(dir, 300);
  assert.ok(tiny !== null && tiny.length <= 300);
  assert.ok(tiny.includes('I was born'), 'birth clause survives budgeting');
  const genesis = readSeedGenesis(dir);
  assert.ok(genesis !== null && genesis.seedId === 'seed_test_0001' && genesis.bornAt.startsWith('2026-08-07'));
});
