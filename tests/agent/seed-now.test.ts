/**
 * NOW@seed — the second Home23 v2 cutover: sessions open on the
 * individual's lived now (last contact, identity events since, freshest
 * thought, open expectations), composed from the chain. Pins the
 * composition, null-on-young-seed (files-only fallback), and budgeting.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeSeedNow } from '../../src/substrate/seed-now.js';
import { buildBootstrapBlock, resolveSubstrateStateDir } from '../../src/agent/session-bootstrap.js';
import { assembleContext } from '../../src/agent/context-assembly.js';

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
  assert.ok(now.includes('you considered: [body.jtr] jtr is favoring recovery'), 'freshest thought remains a hypothesis');
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
  assert.equal(tiny, composeSeedNow(dir), 'advisory target preserves continuity and commitments');
});

test('Seed continuity survives missing, stale, or malformed optional NOW telemetry', (t) => {
  const seed = makeSeedDir(t);
  writeFixture(seed);
  const ws = makeSeedDir(t);
  const config = { bootstrap: { reads: ['NOW.md'] }, substrate: { stateDir: seed } };

  const missing = buildBootstrapBlock(ws, config);
  assert.ok(missing?.includes('NOW@seed (lived, from your chain)'), 'missing cache preserves Seed');
  assert.ok(!missing?.includes('— NOW.md —'), 'missing cache is skipped');

  writeFileSync(join(ws, 'NOW.md'), [
    '# NOW — optional operational cache',
    '- Cache expires: `2026-09-01T00:00:00Z`',
    '- After expiry these are retained observations, never current truth.',
  ].join('\n'), 'utf-8');
  const stale = buildBootstrapBlock(ws, config);
  assert.ok(stale?.includes('NOW@seed (lived, from your chain)'), 'stale cache preserves Seed');
  assert.ok(stale?.includes('After expiry these are retained observations'), 'self-described expiry remains visible');
  assert.ok(stale!.indexOf('NOW@seed') < stale!.indexOf('— NOW.md —'), 'Seed still leads optional telemetry');

  writeFileSync(join(ws, 'NOW.md'), 'not a structured NOW cache', 'utf-8');
  const malformed = buildBootstrapBlock(ws, config);
  assert.ok(malformed?.includes('NOW@seed (lived, from your chain)'), 'malformed cache preserves Seed');
  assert.ok(malformed?.includes('not a structured NOW cache'), 'workspace text cannot block bootstrap');
});

test('a born Seed is derived from the workspace sibling without a substrate setting', async t => {
  const root = makeSeedDir(t);
  const workspace = join(root, 'workspace');
  const seed = join(root, 'substrate', 'seed-01');
  mkdirSync(workspace);
  assert.equal(resolveSubstrateStateDir(workspace), undefined, 'an absent Seed is not invented');
  mkdirSync(seed, { recursive: true });
  writeFixture(seed);
  assert.equal(resolveSubstrateStateDir(workspace, { bootstrap: {} }), seed);
  assert.equal(resolveSubstrateStateDir(workspace, { substrate: { stateDir: '/explicit/seed' } }), '/explicit/seed');
  const block = buildBootstrapBlock(workspace, { bootstrap: { reads: [] } });
  assert.match(block!, /NOW@seed \(lived, from your chain\)/);
  const context = await assembleContext('How am I doing?', 'owner-chat', [], {
    workspacePath: workspace, brainDir: join(root, 'brain'), enginePort: 5002, sessionId: 'owner-chat',
    signal: new AbortController().signal, semanticEmbed: () => null,
    contextSearch: async () => ({ results: [], sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'hit' } }),
  });
  assert.ok(context.surfacesLoaded.includes('RECENT@seed'), 'derived Seed reaches lived surfaces as well as bootstrap');
  assert.match(context.block, /sauna tonight/);
});

test('current personal contact selects its own carried situation instead of unrelated operational predictions', t => {
  const dir = makeSeedDir(t);
  writeFixture(dir);
  const file = join(dir, 'checkpoints', 'ckpt_aaaa0001_t.json');
  const checkpoint = JSON.parse(readFileSync(file, 'utf8'));
  checkpoint.cells.push({ id: 'world.home', estimates: [], intentions: [], predictions: [
    { claim: 'The disk will remain constrained while the planning queue holds 9000 items', confidence: 0.8, horizon: '72h', createdAt: '2026-08-09T10:00:00.000Z' },
  ], realityRefs: [
    { sourceRef: 'conversation.jtr:truck', observedAt: '2026-08-09T15:00:00.000Z', head: 'I leased an blue Atlas pickup' },
  ] });
  writeFileSync(file, JSON.stringify(checkpoint));
  const now = composeSeedNow(dir, undefined, { turnText: 'How do you like my new Atlas?', semanticEmbed: () => null });
  assert.match(now!, /blue Atlas pickup/);
  assert.doesNotMatch(now!, /disk will remain|planning queue|HRV will recover/);
});

test('personal bootstrap retains relevant Seed contact and a recovery pointer without the machine queue dump', t => {
  const seed = makeSeedDir(t);
  writeFixture(seed);
  const workspace = makeSeedDir(t);
  writeFileSync(join(workspace, 'NOW.md'), '# Runtime cache\nPlanning queue: 9000\nMachine memory: 5%.');
  writeFileSync(join(workspace, 'PLAYBOOK.md'), 'Read complete sources before acting.');
  const config = { bootstrap: { reads: ['NOW.md', 'PLAYBOOK.md'] }, substrate: { stateDir: seed } };
  const personal = buildBootstrapBlock(workspace, config, { turnText: 'Should I do the sauna tonight?', semanticEmbed: () => null });
  assert.match(personal!, /should I do the sauna tonight/);
  assert.doesNotMatch(personal!, /Planning queue: 9000/);
  assert.match(personal!, /NOW.md.*read_file/);
  assert.match(personal!, /Read complete sources/);
  const operational = buildBootstrapBlock(workspace, config, { turnText: 'Show the current system memory and planning queue', semanticEmbed: () => null });
  assert.match(operational!, /Planning queue: 9000/);
});
