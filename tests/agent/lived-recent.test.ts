/**
 * RECENT@seed — the first Home23 v2 file cutover. Pins: the lived record
 * composes from the chain (conversations with words, teachings, lobe
 * thoughts, judged predictions, development, operator acts); too little
 * lived material → null (file fallback); whole-section budgeting; absence
 * over fabrication.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeLivedRecent } from '../../src/substrate/lived-recent.js';

function makeSeedDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'lived-recent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFixture(dir: string): void {
  mkdirSync(join(dir, 'checkpoints'), { recursive: true });
  const cells = [
    {
      id: 'world.home23', generation: 900, workspacePressure: 0.3,
      energy: { current: 1 }, uncertainty: 0.4,
      estimates: [], intentions: [],
      predictions: [
        { claim: 'the heartbeat will stay steady', confidence: 0.8, horizon: '24h', createdAt: '2026-08-08T10:00:00.000Z', resolvedAt: '2026-08-08T20:00:00.000Z', error: 0.0 },
      ],
      realityRefs: [
        { sourceRef: 'conversation.jtr:sess-a', observedAt: '2026-08-08T18:00:00.000Z', head: 'give me two lines on what matters tonight' },
        { sourceRef: 'conversation.jerry:sess-a', observedAt: '2026-08-08T18:00:30.000Z', head: 'Skip the sauna heroics: HRV is depleted' },
        { sourceRef: 'relationship.correction:rel-1', observedAt: '2026-08-08T19:00:00.000Z', head: 'feed them, dont shrink them' },
        { sourceRef: 'RetrievalDegraded:x', observedAt: '2026-08-08T17:00:00.000Z' },
      ],
    },
  ];
  writeFileSync(join(dir, 'checkpoints', 'ckpt_aaaa0001_test.json'), JSON.stringify({ version: 2, ledgerSeq: 1500, cells }), 'utf-8');
  const ledger = [
    { seq: 1490, category: 'development', sourceRef: 'seed', issuedAt: '2026-08-08T15:00:00.000Z', payload: { rule: 'correction.v1' } },
    { seq: 1495, category: 'lobe', sourceRef: 'lobe.model.test', issuedAt: '2026-08-08T18:30:00.000Z', payload: {
      appliedDeltas: [
        { cellId: 'world.home23', field: 'estimates.append', delta: { claim: 'jtr is watching HRV closely this stretch', confidence: 0.6 } },
      ],
    } },
    { seq: 1498, category: 'act', sourceRef: 'growth.operator-decision', issuedAt: '2026-08-08T19:30:00.000Z', payload: {
      operatorDecision: 'declined', op: 'dissolve', targetCellIds: ['frontier.x'], authorizedBy: 'jtr', reason: 'feed them, dont shrink them',
    } },
  ];
  writeFileSync(join(dir, 'seed-ledger.jsonl'), ledger.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

test('composes the lived record: contact with words, thoughts, verdicts, development, body', (t) => {
  const dir = makeSeedDir(t);
  writeFixture(dir);
  const text = composeLivedRecent(dir);
  assert.ok(text !== null);
  assert.ok(text.includes('composed from the Seed\'s chain'), 'names its own provenance');
  assert.ok(text.includes('jtr: "give me two lines on what matters tonight"'), "jtr's words carried");
  assert.ok(text.includes('you: "Skip the sauna heroics'), "the agent's own words carried, addressed as 'you'");
  assert.ok(text.includes('Teachings taken:'), 'teachings section present');
  assert.ok(text.includes('believes: jtr is watching HRV closely'), "the lobe's thought surfaces");
  assert.ok(text.includes('reality agreed (error 0.00)'), 'judged prediction narrated');
  assert.ok(text.includes('correction.v1 ×1'), 'development summarized');
  assert.ok(text.includes('jtr declined his dissolve'), 'operator act in the record');
  assert.ok(!text.includes('conversation.jtr:sess-a'), 'sourceRefs never leak as prose');
});

test('too little lived material → null, so the caller falls back to the file', (t) => {
  const dir = makeSeedDir(t);
  mkdirSync(join(dir, 'checkpoints'), { recursive: true });
  writeFileSync(join(dir, 'checkpoints', 'ckpt_aaaa0001_test.json'), JSON.stringify({ version: 2, ledgerSeq: 10, cells: [
    { id: 'a', generation: 1, workspacePressure: 0, energy: { current: 1 }, uncertainty: 0.5, estimates: [], predictions: [], intentions: [], realityRefs: [] },
  ] }), 'utf-8');
  writeFileSync(join(dir, 'seed-ledger.jsonl'), JSON.stringify({ seq: 10, category: 'transition', sourceRef: 'x', payload: {} }) + '\n', 'utf-8');
  assert.equal(composeLivedRecent(dir), null);
});

test('missing state → null; budget drops whole sections from the tail', (t) => {
  const dir = makeSeedDir(t);
  assert.equal(composeLivedRecent(dir), null, 'no state → null');
  writeFixture(dir);
  const tiny = composeLivedRecent(dir, 320);
  assert.ok(tiny !== null && tiny.length <= 320, 'budget respected');
  assert.ok(tiny.includes('composed from the Seed'), 'header survives budgeting');
});
