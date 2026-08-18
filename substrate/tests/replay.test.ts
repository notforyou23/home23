/**
 * Cut 2 PROOF: replay reproducibility.
 *
 * Copy a Seed's entire stateDir at a checkpoint, continue the original with a
 * fixed event sequence, replay the SAME sequence on the copy — byte-identical
 * continuous state and identical state hashes. This is the property the
 * ablation experiments (Cut 3) stand on: if replay is not exact, "remove the
 * learned delta and replay" cannot distinguish development from noise.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import type { SourceEvent } from '../src/types.js';
import { TEST_ANATOMY } from './named-anatomy.js';

function makeDir(t: { after(fn: () => void): void }, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `substrate-replay-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixedEvent(ref: string, category: SourceEvent['category'], producedAt: string): SourceEvent {
  return {
    eventId: `evt_${ref}`,
    category,
    sourceAuthority: 'seed.adapter',
    sourceRef: ref,
    payload: { replay: true },
    producedAt,
  };
}

test('PROOF: replaying the same events from a copied checkpoint reproduces byte-identical state', (t) => {
  const dirA = makeDir(t, 'a');
  const dirB = makeDir(t, 'b');

  const seedA = SeedProcess.initialize(dirA, undefined, { anatomy: TEST_ANATOMY, reservoirSeed: 424242 });
  seedA.transition(fixedEvent('warm-1', 'observation', '2026-08-07T10:00:00.000Z'));
  seedA.transition(fixedEvent('warm-2', 'correction', '2026-08-07T10:05:00.000Z'));
  seedA.transition(fixedEvent('warm-3', 'consequence', '2026-08-07T11:00:00.000Z'));
  const checkpointId = seedA.checkpoint();

  // Snapshot the whole stateDir at this moment — ledger, checkpoints, index.
  cpSync(dirA, dirB, { recursive: true });

  // The continuation both timelines will live through.
  const continuation: SourceEvent[] = [
    fixedEvent('cont-1', 'observation', '2026-08-07T12:00:00.000Z'),
    fixedEvent('cont-2', 'interpretation', '2026-08-07T12:30:00.000Z'),
    fixedEvent('cont-3', 'correction', '2026-08-07T18:00:00.000Z'),
  ];

  for (const ev of continuation) seedA.transition({ ...ev });
  const hashA = seedA.getState().stateHash;

  const seedB = SeedProcess.restore(dirB, checkpointId);
  for (const ev of continuation) seedB.transition({ ...ev });
  const hashB = seedB.getState().stateHash;

  assert.equal(hashB, hashA, 'replayed timeline must reach the identical state hash');

  for (const cellId of seedA.getState().cellIds) {
    const a = seedA.getContinuousState(cellId);
    const b = seedB.getContinuousState(cellId);
    assert.ok(a !== undefined && b !== undefined);
    for (let i = 0; i < a.length; i++) {
      assert.ok(Object.is(a[i], b[i]), `${cellId}[${i}] diverged between original and replay`);
    }
  }
});

test('replay with a DIFFERENT event ordering reaches a different state (order is causal)', (t) => {
  const dirA = makeDir(t, 'ord-a');
  const dirB = makeDir(t, 'ord-b');

  const seedA = SeedProcess.initialize(dirA, undefined, { anatomy: TEST_ANATOMY, reservoirSeed: 424242 });
  seedA.transition(fixedEvent('base', 'observation', '2026-08-07T10:00:00.000Z'));
  const checkpointId = seedA.checkpoint();
  cpSync(dirA, dirB, { recursive: true });

  // Same two events, but routed to the SAME cell with swapped order via
  // identical categories — only sourceRef order differs.
  seedA.transition(fixedEvent('x', 'correction', '2026-08-07T11:00:00.000Z'));
  seedA.transition(fixedEvent('y', 'correction', '2026-08-07T12:00:00.000Z'));

  const seedB = SeedProcess.restore(dirB, checkpointId);
  seedB.transition(fixedEvent('y', 'correction', '2026-08-07T11:00:00.000Z'));
  seedB.transition(fixedEvent('x', 'correction', '2026-08-07T12:00:00.000Z'));

  assert.notEqual(
    seedA.getState().stateHash,
    seedB.getState().stateHash,
    'different lived order must leave a different interior',
  );
});

test('a restored seed uses the SAME frozen reservoir: fresh seed with a different reservoirSeed diverges on identical events', (t) => {
  const dirA = makeDir(t, 'res-a');
  const dirB = makeDir(t, 'res-b');

  const events: SourceEvent[] = [
    fixedEvent('e1', 'observation', '2026-08-07T10:00:00.000Z'),
    fixedEvent('e2', 'correction', '2026-08-07T10:30:00.000Z'),
  ];

  const seedA = SeedProcess.initialize(dirA, undefined, { anatomy: TEST_ANATOMY, reservoirSeed: 1000 });
  const seedB = SeedProcess.initialize(dirB, undefined, { anatomy: TEST_ANATOMY, reservoirSeed: 2000 });
  for (const ev of events) {
    seedA.transition({ ...ev });
    seedB.transition({ ...ev });
  }

  const a = seedA.getContinuousState('world.home23');
  const b = seedB.getContinuousState('world.home23');
  assert.ok(a !== undefined && b !== undefined);
  const different = Array.from(a).some((v, i) => !Object.is(v, b[i]));
  assert.ok(different, 'different frozen reservoirs must metabolize the same events differently');
});
