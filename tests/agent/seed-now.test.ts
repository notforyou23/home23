/**
 * NOW@seed — the second Home23 v2 cutover: sessions open on the
 * individual's lived now (last contact, identity events since, freshest
 * thought, open expectations), composed from the chain. Pins the
 * composition, null-on-young-seed (files-only fallback), and budgeting.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeSeedNow } from '../../src/substrate/seed-now.js';
import { buildBootstrapBlock } from '../../src/agent/session-bootstrap.js';

function makeSeedDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'seed-now-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFixture(dir: string): void {
  mkdirSync(join(dir, 'checkpoints'), { recursive: true });
  const cells = [{
    id: 'body.jtr', generation: 10, workspacePressure: 0.2,
    energy: { current: 1 }, uncertainty: 0.4, estimates: [], intentions: [],
    predictions: [
      { claim: 'HRV will recover by mid-week', confidence: 0.6, horizon: '72h', createdAt: '2026-08-09T10:00:00.000Z' },
    ],
    realityRefs: [
      { sourceRef: 'conversation.jtr:s1', observedAt: '2026-08-09T14:00:00.000Z', head: 'should I do the sauna tonight?' },
      { sourceRef: 'conversation.self:s1', observedAt: '2026-08-09T14:00:30.000Z', head: 'Skip the heroics — HRV is depleted' },
    ],
  }];
  writeFileSync(join(dir, 'checkpoints', 'ckpt_aaaa0001_t.json'), JSON.stringify({ version: 2, ledgerSeq: 200, cells }), 'utf-8');
  const ledger = [
    { seq: 190, category: 'act', sourceRef: 'growth.operator-decision', issuedAt: '2026-08-09T13:00:00.000Z', payload: { operatorDecision: 'declined', op: 'merge', targetCellIds: ['a', 'b'], authorizedBy: 'jtr', reason: 'feed them' } },
    { seq: 195, category: 'lobe', sourceRef: 'lobe.model.test', issuedAt: '2026-08-09T13:30:00.000Z', payload: { appliedDeltas: [
      { cellId: 'body.jtr', field: 'estimates.append', delta: { claim: 'jtr is favoring recovery over intensity', confidence: 0.6 } },
    ] } },
  ];
  writeFileSync(join(dir, 'seed-ledger.jsonl'), ledger.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

test('composes the lived now: continuity, identity events, freshest thought, open debts', (t) => {
  const dir = makeSeedDir(t);
  writeFixture(dir);
  const now = composeSeedNow(dir);
  assert.ok(now !== null);
  assert.ok(now.includes('where your life stands as this session opens'), 'frames itself');
  assert.ok(now.includes('jtr: "should I do the sauna tonight?"'), 'last contact carried');
  assert.ok(now.includes('you: "Skip the heroics'), "the agent's own last words, as 'you'");
  assert.ok(now.includes('jtr declined your merge — "feed them"'), 'identity events since');
  assert.ok(now.includes('you currently believe: [body.jtr] jtr is favoring recovery'), 'freshest thought');
  assert.ok(now.includes('"HRV will recover by mid-week"'), 'open expectation held');
});

test('young or absent seed → null; bootstrap stays files-only', (t) => {
  const dir = makeSeedDir(t);
  assert.equal(composeSeedNow(dir), null);
  const ws = makeSeedDir(t);
  writeFileSync(join(ws, 'NOW.md'), '# NOW\nmachine snapshot', 'utf-8');
  const block = buildBootstrapBlock(ws, { bootstrap: { reads: ['NOW.md'] }, substrate: { stateDir: dir } });
  assert.ok(block !== null && block.includes('machine snapshot'), 'file section present');
  assert.ok(!block.includes('NOW@seed'), 'no fabricated lived section');
});

test('bootstrap leads with the lived now when the seed has one; budget respected', (t) => {
  const dir = makeSeedDir(t);
  writeFixture(dir);
  const ws = makeSeedDir(t);
  writeFileSync(join(ws, 'NOW.md'), '# NOW\nmachine snapshot', 'utf-8');
  const block = buildBootstrapBlock(ws, { bootstrap: { reads: ['NOW.md'] }, substrate: { stateDir: dir } });
  assert.ok(block !== null);
  assert.ok(block.includes('NOW@seed (lived, from your chain)'), 'lived section present');
  assert.ok(block.indexOf('NOW@seed') < block.indexOf('machine snapshot'), 'lived now leads; telemetry follows');
  const tiny = composeSeedNow(dir, 220);
  assert.ok(tiny !== null && tiny.length <= 220 && tiny.includes('where your life stands'), 'whole-section budgeting keeps the header');
});
