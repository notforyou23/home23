/**
 * Cut 1 Proof: exact causal continuation from checkpoint and event cursor
 * after process stop/restart, without reconstructing state from a prose prompt.
 *
 * This test IS the proof of Cut 1 from the build contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import type { SourceEvent } from '../src/types.js';

function makeDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-demo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeEvent(sourceRef: string, category: SourceEvent['category'] = 'observation'): SourceEvent {
  return {
    eventId: `evt_${sourceRef}`,
    category,
    sourceAuthority: 'seed.adapter',
    sourceRef,
    payload: { demo: true },
    producedAt: `2026-08-07T12:00:0${sourceRef.slice(-1)}.000Z`,
  };
}

test('PROOF: stop → restart → exact state/hash/cursor continuation → next event advances causally', (t) => {
  const dir = makeDir(t);

  // ── Phase 1: Initialize and run transitions ──────────────────────────────

  const seed1 = SeedProcess.initialize(dir);

  // Three transitions across different cell types
  const r1 = seed1.transition(makeEvent('ref-alpha', 'observation'));       // → world.home23
  const r2 = seed1.transition(makeEvent('ref-beta', 'correction'));         // → contact.jtr-jerry
  const r3 = seed1.transition(makeEvent('ref-gamma', 'interpretation'));    // → frontier.substrate-os

  // Capture exact cell state before stop — this is what must be restored exactly
  const stateBeforeStop = seed1.getState();
  const hashBeforeStop = stateBeforeStop.stateHash;
  const transitionsBeforeStop = stateBeforeStop.transitionCount;

  // Capture Float32Array bytes for all five cells (byte-exact snapshot)
  const float32Snapshots: Record<string, number[]> = {};
  for (const cellId of stateBeforeStop.cellIds) {
    const cs = seed1.getContinuousState(cellId);
    assert.ok(cs !== undefined, `Missing continuous state for ${cellId}`);
    float32Snapshots[cellId] = Array.from(cs);
  }

  // Verify seq is monotonically increasing
  assert.ok(r1.seq < r2.seq && r2.seq < r3.seq, 'seq should be monotonically increasing');

  // Stop the process — writes checkpoint record + stop record to ledger
  // NOTE: stop() advances ledgerSeq beyond stateBeforeStop.ledgerSeq intentionally.
  // The stateHash is only about cell state, not ledger position.
  const checkpointId = seed1.stop();
  assert.ok(typeof checkpointId === 'string');

  // ── Phase 2: "Process restart" — new SeedProcess from checkpoint ─────────

  // Simulates process stop/restart: no variables from seed1 carried over.
  const seed2 = SeedProcess.restore(dir, checkpointId);

  // ── Proof assertion: exact state matches ─────────────────────────────────

  const restoredState = seed2.getState();

  assert.equal(
    restoredState.stateHash,
    hashBeforeStop,
    'stateHash must be identical after restore — cell state, not prose, is the substrate',
  );
  assert.equal(
    restoredState.transitionCount,
    transitionsBeforeStop,
    'transitionCount must be restored exactly from checkpoint resource snapshot',
  );
  // ledgerSeq after restore is >= the seq before stop (checkpoint + stop records were written)
  assert.ok(
    restoredState.ledgerSeq > stateBeforeStop.ledgerSeq,
    'ledgerSeq must have advanced past the pre-stop position (checkpoint + stop records appended)',
  );

  // Exact Float32Array byte match for all five cells
  for (const cellId of restoredState.cellIds) {
    const cs = seed2.getContinuousState(cellId);
    assert.ok(cs !== undefined, `Missing continuous state for ${cellId} after restore`);
    const restored = Array.from(cs);
    const original = float32Snapshots[cellId];
    assert.ok(original !== undefined, `No snapshot for ${cellId}`);
    for (let i = 0; i < restored.length; i++) {
      assert.ok(
        Object.is(restored[i], original[i]),
        `${cellId} slot ${i}: ${restored[i]} !== ${original[i]} — Float32 bytes differ after restore`,
      );
    }
  }

  // ── Phase 3: Continue from restored state — next event advances causally ─

  const stateAfterRestore = seed2.getState().stateHash;
  const seqAfterRestore = seed2.getState().ledgerSeq;

  const r4 = seed2.transition(makeEvent('ref-delta', 'consequence'));  // → project.shakedown

  const stateAfterContinue = seed2.getState();

  assert.ok(
    stateAfterContinue.ledgerSeq > seqAfterRestore,
    'ledgerSeq must advance after continuing from restored checkpoint',
  );
  assert.notEqual(
    stateAfterContinue.stateHash,
    stateAfterRestore,
    'stateHash must change after the next transition — causal advance, not fresh start',
  );
  assert.equal(
    r4.stateHashBefore,
    stateAfterRestore,
    'r4.stateHashBefore must equal the restored stateHash — causal continuity proven',
  );
  assert.ok(
    r4.seq > seqAfterRestore,
    'transition seq must continue from where the chain left off',
  );

  // ── Summary: no prose reconstruction occurred ─────────────────────────────
  // The state was restored from serialized bytes (Float32Array base64 + JSON),
  // not from loading a narrative summary into an LLM context.
});

test('two independent seeds in different directories have different state hashes', (t) => {
  const dir1 = mkdtempSync(join(tmpdir(), 'substrate-demo-a-'));
  const dir2 = mkdtempSync(join(tmpdir(), 'substrate-demo-b-'));
  t.after(() => {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  });

  const seed1 = SeedProcess.initialize(dir1);
  const seed2 = SeedProcess.initialize(dir2);

  const e1: SourceEvent = { eventId: 'x', category: 'observation', sourceAuthority: 'seed.adapter', sourceRef: 'ref-x', payload: {}, producedAt: '2026-08-07T12:00:00.000Z' };
  const e2: SourceEvent = { eventId: 'y', category: 'correction', sourceAuthority: 'seed.adapter', sourceRef: 'ref-y', payload: {}, producedAt: '2026-08-07T12:00:00.000Z' };

  seed1.transition(e1);
  seed2.transition(e2);

  assert.notEqual(
    seed1.getState().stateHash,
    seed2.getState().stateHash,
    'Different event histories must produce different state hashes',
  );
});

test('same events in same order produce identical state hashes (deterministic)', (t) => {
  const dir1 = mkdtempSync(join(tmpdir(), 'substrate-det-a-'));
  const dir2 = mkdtempSync(join(tmpdir(), 'substrate-det-b-'));
  t.after(() => {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  });

  // Fixed timestamps — determinism requires identical producedAt values
  const events: SourceEvent[] = [
    { eventId: 'e1', category: 'observation', sourceAuthority: 'seed.adapter', sourceRef: 'alpha', payload: {}, producedAt: '2026-08-07T10:00:00.000Z' },
    { eventId: 'e2', category: 'correction', sourceAuthority: 'seed.adapter', sourceRef: 'beta', payload: {}, producedAt: '2026-08-07T10:00:01.000Z' },
  ];

  const s1 = SeedProcess.initialize(dir1);
  const s2 = SeedProcess.initialize(dir2);

  for (const ev of events) {
    s1.transition({ ...ev });
    s2.transition({ ...ev });
  }

  // The Float32 state update is fully deterministic (sha256 of sourceRef+producedAt+category)
  for (const cellId of s1.getState().cellIds) {
    const cs1 = s1.getContinuousState(cellId);
    const cs2 = s2.getContinuousState(cellId);
    assert.ok(cs1 !== undefined && cs2 !== undefined);
    for (let i = 0; i < cs1.length; i++) {
      assert.ok(
        Object.is(cs1[i], cs2[i]),
        `${cellId}[${i}] differs between two seeds with identical event histories`,
      );
    }
  }
});
