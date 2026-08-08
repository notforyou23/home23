/**
 * SUBSTRATE surface, expression.v2 (rebuilt after the 2026-08-08 integration
 * knife judged the always-on v1 dump decorative; per-turn fresh ride-alongs
 * then killed by knife v2's K2 — a measured, sham-validated tax on
 * unrelated turns). Pins the organ: per-turn surfacing is MATCH-ONLY (a
 * turn that touches nothing carried gets null, fresh events included);
 * matched items are lived narrative (judged predictions, jtr's operator
 * decisions in his own words, pending growth, trust SHIFTS) under a usage
 * contract; fresh identity events + open expectations surface at session
 * BOOTSTRAP only; the v1 telemetry dump (pressure %, rule counts) is dead.
 * Degraded-honest behavior is unchanged: absence, never fabrication.
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

/** Deterministic stand-in for the published-projection embedder: known
 * topics land on fixed axes (same axis ⇒ cosine 1, different ⇒ 0), unknown
 * text gets no vector — so matches are exact and hermetic. */
const DIM = 16;
function axis(i: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[i] = 1;
  return v;
}
const TOPICS: Array<[RegExp, number]> = [
  [/baro|pressure|1010|1011/i, 0],
  [/split|world\.pi/i, 1],
  [/already answered/i, 3],
  [/worker|systems/i, 4],
  [/dinner/i, 7],
];
function fakeEmbed(text: string): number[] | null {
  for (const [re, ax] of TOPICS) if (re.test(text)) return axis(ax);
  return null;
}

/** Fixture: two cells with lived history, plus a ledger tail holding a trust
 * shift, a resolution receipt, jtr's decline of a merge, and a pending split
 * proposal. `fresh` places the tail near the chain head (identity events in
 * the fresh window); stale places it far behind (outside the window). */
function writeFixture(dir: string, opts: { fresh: boolean }): void {
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
  const b = opts.fresh ? 1229 : 700;
  const ledger = [
    { seq: b + 1, category: 'development', sourceRef: 'seed', payload: { rule: 'correction.v1', trustKey: 'worker.systems', trust: 1.0 } },
    { seq: b + 2, category: 'development', sourceRef: 'seed', payload: { rule: 'correction.v1', trustKey: 'worker.systems', trust: 1.36 } },
    { seq: b + 3, category: 'development', sourceRef: 'seed', payload: { rule: 'resolution.v1', trustKey: 'self.prediction', trust: 1, predictionId: 'pred_x' } },
    {
      seq: b + 4, category: 'act', sourceRef: 'growth.operator-decision', payload: {
        operatorDecision: 'declined', proposalSeq: b, proposalKey: 'merge:cell.a+cell.b', op: 'merge',
        targetCellIds: ['cell.a', 'cell.b'], authorizedBy: 'jtr', reason: 'feed them, dont shrink them',
      },
    },
    { seq: b + 5, category: 'proposal', sourceRef: 'growth.pressure', payload: { op: 'split', targetCellIds: ['world.pi'] } },
  ];
  writeFileSync(join(dir, 'seed-ledger.jsonl'), ledger.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

test('a turn that touches nothing carried surfaces NOTHING — even with stale identity events on the chain', (t) => {
  const dir = makeSeedDir(t);
  writeFixture(dir, { fresh: false });
  const block = composeSeedSituation(dir, { turnText: 'whats for dinner tonight', embed: fakeEmbed });
  assert.equal(block, null, 'no semantic match + no fresh identity events → null, never a dump');
});

test('a matched turn surfaces exactly the lived facts it touches, under the usage contract', (t) => {
  const dir = makeSeedDir(t);
  writeFixture(dir, { fresh: false });
  const block = composeSeedSituation(dir, { turnText: 'will the pressure drop tonight?', embed: fakeEmbed });
  assert.ok(block !== null);
  assert.ok(block.includes('never recite or summarize this block'), 'usage contract present');
  assert.ok(block.includes('You are on the record expecting: "pressure will fall below 1010"'), 'open expectation surfaced');
  assert.ok(block.includes('You hold, from receipts: "Barometric pressure mean 1011.20 hPa"'), 'matched estimate surfaced');
  assert.ok(block.indexOf('on the record expecting') < block.indexOf('You hold, from receipts'), 'higher-reach items lead');
  assert.ok(!block.includes('feed them'), 'stale unmatched identity events stay out');
  assert.ok(!/(pressure|energy) \d+%/.test(block), 'v1 telemetry dump is dead');
  assert.ok(!block.includes('Recent development'), 'v1 rule counts are dead');
  assert.ok(block.includes('chain seq 1234'), 'cites the chain position');
});

test('per-turn narration is dead: even FRESH identity events do not ride unmatched turns (knife v2, K2 p=0.009)', (t) => {
  const dir = makeSeedDir(t);
  writeFixture(dir, { fresh: true });
  const block = composeSeedSituation(dir, { turnText: 'whats for dinner tonight', embed: fakeEmbed });
  assert.equal(block, null, 'on a turn: match or stay silent — no unprompted ride-alongs');
});

test("judged predictions narrate reality's answer", (t) => {
  const dir = makeSeedDir(t);
  writeFixture(dir, { fresh: true });
  const block = composeSeedSituation(dir, { turnText: 'was that already answered?', embed: fakeEmbed });
  assert.ok(block !== null);
  assert.ok(block.includes('You predicted "already answered" — reality agreed (error 0.10)'), 'resolution narrated with the verdict');
});

test('decided proposals are not pending; undecided ones are', (t) => {
  const dir = makeSeedDir(t);
  writeFixture(dir, { fresh: false });
  const block = composeSeedSituation(dir, { turnText: 'should we split world.pi?', embed: fakeEmbed });
  assert.ok(block !== null);
  assert.ok(block.includes('pending split proposal on world.pi'), 'undecided proposal surfaces on a matched turn');
  assert.ok(!block.includes('pending merge'), "jtr's declined merge is not pending");
});

test('trust surfaces as movement through lived corrections, not as a level', (t) => {
  const dir = makeSeedDir(t);
  writeFixture(dir, { fresh: false });
  const block = composeSeedSituation(dir, { turnText: 'how are the workers doing?', embed: fakeEmbed });
  assert.ok(block !== null);
  assert.ok(block.includes('Your trust in worker.systems has risen (1.00 → 1.36)'), 'shift narrated with direction');
});

test('bootstrap (no turn): fresh identity events + open expectations, never the dump', (t) => {
  const dir = makeSeedDir(t);
  writeFixture(dir, { fresh: true });
  const block = composeSeedSituation(dir, { embed: fakeEmbed });
  assert.ok(block !== null);
  assert.ok(block.includes('jtr declined your merge'), 'fresh operator decision present at bootstrap');
  assert.ok(block.includes('You are on the record expecting'), 'open commitments stay visible at bootstrap');
  assert.ok(!/(pressure|energy) \d+%/.test(block), 'v1 telemetry dump is dead at bootstrap too');
});

test('missing or unreadable state yields null — absence, never fabrication', (t) => {
  const dir = makeSeedDir(t);
  assert.equal(composeSeedSituation(dir), null, 'empty dir → null');
  assert.equal(composeSeedSituation(join(dir, 'nope')), null, 'missing dir → null');
  mkdirSync(join(dir, 'checkpoints'), { recursive: true });
  writeFileSync(join(dir, 'checkpoints', 'ckpt_bad_x.json'), '{torn', 'utf-8');
  assert.equal(composeSeedSituation(dir), null, 'corrupt checkpoint → null');
});

test('tolerates a torn ledger tail (live mirror) and honors the legacy numeric-budget shape', (t) => {
  const dir = makeSeedDir(t);
  writeFixture(dir, { fresh: true });
  appendFileSync(join(dir, 'seed-ledger.jsonl'), '{"seq":1235,"category":"transi', 'utf-8');
  const block = composeSeedSituation(dir, 200);
  assert.ok(block !== null, 'torn tail does not break composition');
  assert.ok(block.length <= 200, 'legacy numeric budget respected');
});
