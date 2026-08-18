/**
 * Anatomy as a birth parameter: a birth is a deliberate act, cells name the
 * individual's OWN situations, and anatomy is identity — recorded in genesis,
 * preserved across restore, driving routing forever.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import { SeedLedger } from '../src/ledger.js';
import { CheckpointManager, computeStateHash } from '../src/checkpoint.js';
import { makeInitialCells, serializeCell } from '../src/cells.js';
import { AnatomyNotNamedError, PRE_ANATOMY_GENESIS_FALLBACK } from '../src/types.js';
import type { SourceEvent, AnatomyCellSpec, SeedDispositions } from '../src/types.js';
import { METABOLISM_VERSION } from '../src/metabolism.js';

function makeDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-anatomy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const BOBBY_ANATOMY: AnatomyCellSpec[] = [
  { id: 'contact.jtr', role: 'correction' },
  { id: 'world.pi', role: 'observation' },
  { id: 'work.house', role: 'consequence' },
  { id: 'frontier.becoming', role: 'interpretation' },
  { id: 'periphery.open-field', role: 'periphery' },
];

function ev(ref: string, category: SourceEvent['category'], producedAt: string): SourceEvent {
  return { eventId: `evt_${ref}`, category, sourceAuthority: 'seed.adapter', sourceRef: ref, payload: {}, producedAt };
}

test('a birth with custom anatomy names its own cells and routes by role', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 888_001, anatomy: BOBBY_ANATOMY, name: 'bobby' });

  assert.deepEqual(seed.getState().cellIds.sort(), BOBBY_ANATOMY.map((a) => a.id).sort());

  const r1 = seed.transition(ev('vitals:1', 'observation', '2026-08-08T10:00:00.000Z'));
  assert.equal(r1.cellId, 'world.pi', 'observations route to the anatomy observation cell');
  const r2 = seed.transition(ev('owner:1', 'correction', '2026-08-08T10:01:00.000Z'));
  assert.equal(r2.cellId, 'contact.jtr');
  const r3 = seed.transition(ev('run:1', 'consequence', '2026-08-08T10:02:00.000Z'));
  assert.equal(r3.cellId, 'work.house');
  const r4 = seed.transition(ev('idea:1', 'proposal', '2026-08-08T10:03:00.000Z'));
  assert.equal(r4.cellId, 'periphery.open-field', 'unclaimed categories fall to the periphery');

  // Genesis carries name + anatomy — identity on the chain.
  const genesis = new SeedLedger(dir).readAll().find((r) => r.category === 'genesis');
  assert.equal(genesis?.payload['name'], 'bobby');
  assert.equal((genesis?.payload['anatomy'] as unknown[]).length, 5);
});

test('anatomy survives restore: routing comes from the genesis, not the code default', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 888_002, anatomy: BOBBY_ANATOMY, name: 'bobby' });
  seed.transition(ev('vitals:1', 'observation', '2026-08-08T10:00:00.000Z'));
  seed.stop();

  const restored = SeedProcess.restore(dir);
  assert.deepEqual(restored.getState().cellIds.sort(), BOBBY_ANATOMY.map((a) => a.id).sort());
  const r = restored.transition(ev('vitals:2', 'observation', '2026-08-08T10:10:00.000Z'));
  assert.equal(r.cellId, 'world.pi', 'restored individual routes by ITS anatomy');
  const rc = restored.transition(ev('owner:2', 'correction', '2026-08-08T10:11:00.000Z'));
  assert.equal(rc.cellId, 'contact.jtr');
  assert.ok(restored.getState().developmentMagnitude > 0, 'and learns into its own cells');
});

test('birth without named anatomy refuses — no invented person', (t) => {
  const dir = makeDir(t);
  assert.throws(
    () => SeedProcess.initialize(dir, undefined, { reservoirSeed: 888_003 }),
    (err) => err instanceof AnatomyNotNamedError,
  );
});

test('pre-anatomy genesis restores through the historical fallback, not a new person', (t) => {
  const dir = makeDir(t);
  const now = '2026-08-08T10:00:00.000Z';
  const ledger = new SeedLedger(dir);
  ledger.append({
    category: 'genesis',
    sourceAuthority: 'seed.internal',
    sourceRef: 'seed_legacy',
    payload: {
      seedId: 'seed_legacy',
      cellIds: PRE_ANATOMY_GENESIS_FALLBACK.map((a) => a.id),
      reservoirSeed: 888_004,
      continuousStateDim: 64,
      metabolismVersion: METABOLISM_VERSION,
      createdAt: now,
    },
  });
  const dispositions: SeedDispositions = {
    globalWakeThreshold: 0.3,
    silencePolicy: 'default',
    modelRecruitmentPolicy: 'none',
    quietTimeEnabled: false,
  };
  const cells = Array.from(makeInitialCells(now, PRE_ANATOMY_GENESIS_FALLBACK).values()).map(serializeCell);
  const mgr = new CheckpointManager(dir);
  mgr.write({
    stateHash: computeStateHash({ cells, dispositions }),
    ledgerSeq: ledger.currentSeq,
    ledgerCursor: ledger.currentCursor,
    cells,
    dispositions,
    resourceSnapshot: {
      stateBytesPerCell: {},
      ledgerBytes: ledger.bytes,
      eventCount: 1,
      transitionCount: 0,
      checkpointCount: 0,
    },
  });

  const restored = SeedProcess.restore(dir);
  assert.deepEqual(restored.getState().cellIds.sort(), PRE_ANATOMY_GENESIS_FALLBACK.map((a) => a.id).sort());
  const r = restored.transition(ev('x', 'correction', '2026-08-08T10:01:00.000Z'));
  assert.equal(r.cellId, 'contact.jtr-jerry', 'the first individual continues as itself');
});
