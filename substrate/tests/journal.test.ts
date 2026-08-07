/**
 * The field journal speaks only from receipts: every claim cites a seq that
 * exists, silence is explained, empty windows produce NO entry (an empty
 * essay would be exhaust), and the journal never feeds the Seed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import { SeedLedger } from '../src/ledger.js';
import { composeJournalEntry } from '../src/journal.js';
import type { SourceEvent, CheckpointManifest } from '../src/types.js';

function makeDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-journal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ev(ref: string, category: SourceEvent['category'], producedAt: string): SourceEvent {
  return { eventId: `evt_${ref}`, category, sourceAuthority: 'seed.adapter', sourceRef: ref, payload: {}, producedAt };
}

function windowFor(dir: string, seed: SeedProcess, sinceSeq: number) {
  const ledger = new SeedLedger(dir);
  const all = ledger.readAll();
  const genesis = all.find((r) => r.category === 'genesis');
  const ckDir = join(dir, 'checkpoints');
  const newest = readdirSync(ckDir).filter((n) => n.startsWith('ckpt_') && n.endsWith('.json')).sort().at(-1);
  const manifest = JSON.parse(readFileSync(join(ckDir, newest as string), 'utf-8')) as CheckpointManifest;
  return {
    name: String(genesis?.payload?.['name'] ?? 'seed'),
    seedId: String(genesis?.payload?.['seedId'] ?? '?'),
    records: all.filter((r) => r.seq > sinceSeq),
    cells: manifest.cells,
    sinceSeq,
  };
}

test('journal cites a real receipt for every seq it mentions', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 999_001, name: 'testling' });
  seed.transition(ev('baro.sample:p=1010hPa', 'observation', '2026-08-08T10:00:00.000Z'));
  seed.transition(ev('owner:fix-this', 'correction', '2026-08-08T10:01:00.000Z'));
  seed.workspaceCycle('2026-08-08T10:02:00.000Z');
  seed.checkpoint();

  const entry = composeJournalEntry(windowFor(dir, seed, 0));
  assert.ok(entry !== null);
  assert.match(entry, /^# testling — field journal/, 'the entry speaks as the named individual');

  const cited = [...entry.matchAll(/· seq (\d+)/g)].map((m) => Number(m[1]));
  assert.ok(cited.length >= 3, 'claims must carry receipts');
  const realSeqs = new Set(new SeedLedger(dir).readAll().map((r) => r.seq));
  for (const seq of cited) {
    assert.ok(realSeqs.has(seq), `cited seq ${seq} must exist on the chain — the journal may not invent`);
  }
  assert.match(entry, /a correction taught/, 'development is narrated from its receipt');
});

test('silence is explained with its score and threshold', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 999_002, name: 'quietling' });
  seed.transition(ev('noise:1', 'interpretation', '2026-08-08T10:00:00.000Z'));
  const outcome = seed.workspaceCycle('2026-08-08T10:01:00.000Z');
  assert.equal(outcome.kind, 'silence');
  seed.checkpoint();

  const entry = composeJournalEntry(windowFor(dir, seed, 0));
  assert.ok(entry !== null);
  assert.match(entry, /stayed quiet ×1 \(closest call \d+\.\d+ vs threshold \d+\.\d+/, 'silence gets its numbers');
});

test('an empty window produces NO entry — empty essays are exhaust', () => {
  const entry = composeJournalEntry({ name: 'x', seedId: 'x', records: [], cells: [], sinceSeq: 40 });
  assert.equal(entry, null);
});

test('the journal counts only INTEGRATED deltas as change — offered arrays are not thoughts', () => {
  // The live defect this pins: acceptedCounts said predictions:2 while zero
  // predictions persisted (top-level arrays are advisory; only stateDeltas
  // integrate). The diary must never repeat that overstatement.
  const lobeRecord = {
    schema: 'home23.seed.ledger.v1' as const,
    seq: 41,
    prevHash: 'x',
    recordId: 'rec_41',
    category: 'lobe' as const,
    sourceAuthority: 'seed.internal' as const,
    sourceRef: 'lobe.broker',
    payload: {
      acceptedCounts: { observations: 3, interpretations: 2, predictions: 2, stateDeltas: 1 },
      appliedDeltas: [{ cellId: 'world.pi', field: 'estimates.append', delta: {}, authority: 'propose' }],
    },
    issuedAt: '2026-08-08T10:00:00.000Z',
  };
  const entry = composeJournalEntry({ name: 'x', seedId: 'x', records: [lobeRecord], cells: [], sinceSeq: 40 });
  assert.ok(entry !== null);
  assert.ok(entry.includes('landed 1 typed delta'), 'narrates the integrated count');
  assert.ok(entry.includes('estimates.append'), 'names what integrated');
  assert.ok(!entry.includes('"predictions":2'), 'never repeats un-integrated counts as change');
});
