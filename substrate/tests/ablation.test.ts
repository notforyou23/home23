/**
 * Cut 3 PROOF: the ablation knife.
 *
 * The discriminating question of the whole substrate program, in executable
 * form: teach a Seed through lived corrections, branch an ablated twin whose
 * EPISODES are identical but whose DEVELOPMENT is zeroed, present both with
 * the same later, differently-shaped events — and require that they behave
 * differently, for reasons traceable to the receipted developmental deltas.
 *
 * If these tests could not fail, the substrate claim would be unfalsifiable.
 * They can fail. That is the point.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import { SeedLedger } from '../src/ledger.js';
import type { SourceEvent } from '../src/types.js';

function makeDir(t: { after(fn: () => void): void }, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `substrate-ablation-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixedEvent(
  ref: string,
  category: SourceEvent['category'],
  producedAt: string,
): SourceEvent {
  return { eventId: `evt_${ref}`, category, sourceAuthority: 'seed.adapter', sourceRef: ref, payload: {}, producedAt };
}

/** Teaching: corrections from one source prefix, close together in event-time. */
function teachingEvents(): SourceEvent[] {
  return Array.from({ length: 6 }, (_, i) =>
    fixedEvent(`workreview:t-${i}`, 'correction', `2026-08-07T10:0${i}:00.000Z`),
  );
}

test('PROOF: development changes later handling; ablation removes the change; episodes survive', (t) => {
  const dirA = makeDir(t, 'a');
  const dirB = makeDir(t, 'b');

  // ── Teach ────────────────────────────────────────────────────────────────
  const seedA = SeedProcess.initialize(dirA, undefined, { reservoirSeed: 777_001 });
  for (const ev of teachingEvents()) seedA.transition({ ...ev });

  const taughtMagnitude = seedA.getState().developmentMagnitude;
  assert.ok(taughtMagnitude > 0, 'corrections must produce receipted development');
  seedA.checkpoint();

  // ── Branch the control arm ───────────────────────────────────────────────
  const { zeroedMagnitude } = SeedProcess.createAblatedTwin(dirA, dirB);
  assert.ok(Math.abs(zeroedMagnitude - taughtMagnitude) < 1e-9, 'the knife must report what it removed');

  const seedB = SeedProcess.restore(dirB);
  assert.equal(seedB.getState().developmentMagnitude, 0, 'twin has NO development');

  // Episodic history is intact in the twin: every teaching record survives.
  const ledgerB = new SeedLedger(dirB);
  const recordsB = ledgerB.readAll();
  const teachingTransitions = recordsB.filter((r) => r.category === 'transition');
  assert.equal(teachingTransitions.length, 6, 'all lived transitions preserved in the twin');
  const cellB = seedB.getCell('contact.jtr-jerry');
  const cellA2 = SeedProcess.restore(dirA).getCell('contact.jtr-jerry');
  assert.ok(cellB !== undefined && cellA2 !== undefined);
  assert.equal(cellB.realityRefs.length, cellA2.realityRefs.length, 'reality refs identical across the branch');
  for (let i = 0; i < cellB.continuousState.length; i++) {
    assert.ok(
      Object.is(cellB.continuousState[i], cellA2.continuousState[i]),
      'continuous state (episodic residue) is NOT the ablation target and must be identical',
    );
  }

  // ── Probe: same source, DIFFERENT category — related but differently shaped ──
  // Teaching was corrections from 'workreview'. The probe is an OBSERVATION
  // from 'workreview' — statically routed to world.home23. A developed Seed
  // has earned routing affinity (workreview → contact.jtr-jerry); the ablated
  // twin has not.
  const probe = fixedEvent('workreview:probe-1', 'observation', '2026-08-07T10:10:00.000Z');

  const liveA = SeedProcess.restore(dirA);
  const resultA = liveA.transition({ ...probe });
  const resultB = seedB.transition({ ...probe });

  assert.equal(resultA.cellId, 'contact.jtr-jerry', 'developed Seed routes the probe through its learned affinity');
  assert.equal(resultB.cellId, 'world.home23', 'ablated twin falls back to static routing — the learning is GONE');
  assert.notEqual(resultA.cellId, resultB.cellId, 'same event, same history, different machinery → different handling');
});

test('PROOF: identical teaching reproduces identical development (the learning is deterministic, not noise)', (t) => {
  const dir1 = makeDir(t, 'det-1');
  const dir2 = makeDir(t, 'det-2');

  const s1 = SeedProcess.initialize(dir1, undefined, { reservoirSeed: 777_002 });
  const s2 = SeedProcess.initialize(dir2, undefined, { reservoirSeed: 777_002 });
  for (const ev of teachingEvents()) {
    s1.transition({ ...ev });
    s2.transition({ ...ev });
  }
  assert.ok(s1.getState().developmentMagnitude > 0);
  assert.equal(
    s1.getState().developmentMagnitude,
    s2.getState().developmentMagnitude,
    'same lived history → bit-identical learned mass',
  );
  // Two separate BIRTHS are two individuals (birth wall-clock is identity),
  // so full-state hashes legitimately differ — hash-level determinism is
  // proven by the copied-checkpoint replay test. What must be identical here
  // is the DEVELOPMENT the identical teaching produced:
  const ck1 = s1.checkpoint();
  const ck2 = s2.checkpoint();
  const m1 = JSON.parse(readFileSync(join(dir1, 'checkpoints', `${ck1}.json`), 'utf-8')) as { development: unknown };
  const m2 = JSON.parse(readFileSync(join(dir2, 'checkpoints', `${ck2}.json`), 'utf-8')) as { development: unknown };
  assert.deepEqual(m1.development, m2.development, 'identical teaching → identical plastic state, field for field');
  // And the taught cell's continuous residue is byte-identical (event-time driven).
  const c1 = s1.getContinuousState('contact.jtr-jerry');
  const c2 = s2.getContinuousState('contact.jtr-jerry');
  assert.ok(c1 !== undefined && c2 !== undefined);
  for (let i = 0; i < c1.length; i++) assert.ok(Object.is(c1[i], c2[i]));
});

test('PROOF: replay from a copied checkpoint reproduces development too (ablation experiments stand on this)', (t) => {
  const dirA = makeDir(t, 'replay-a');
  const dirB = makeDir(t, 'replay-b');

  const seedA = SeedProcess.initialize(dirA, undefined, { reservoirSeed: 777_003 });
  seedA.transition(fixedEvent('warm:1', 'observation', '2026-08-07T09:00:00.000Z'));
  seedA.checkpoint();
  cpSync(dirA, dirB, { recursive: true });

  const continuation = teachingEvents();
  for (const ev of continuation) seedA.transition({ ...ev });

  const seedB = SeedProcess.restore(dirB);
  for (const ev of continuation) seedB.transition({ ...ev });

  assert.equal(seedB.getState().stateHash, seedA.getState().stateHash, 'replayed development is byte-identical');
  assert.equal(seedB.getState().developmentMagnitude, seedA.getState().developmentMagnitude);
});

test('development receipts carry the rule and bounded changes; ablation is receipted, never silent', (t) => {
  const dir = makeDir(t, 'receipts');
  const twin = makeDir(t, 'receipts-twin');
  const seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 777_004 });
  for (const ev of teachingEvents().slice(0, 2)) seed.transition({ ...ev });
  seed.checkpoint();

  const ledger = new SeedLedger(dir);
  const devRecords = ledger.readAll().filter((r) => r.category === 'development');
  assert.equal(devRecords.length, 2, 'one development receipt per teaching correction');
  const payload = devRecords[0]?.payload as { rule?: string; salienceDeltaNorm?: number; wakeThresholdDelta?: number };
  assert.equal(payload.rule, 'correction.v1');
  assert.ok((payload.salienceDeltaNorm ?? 0) > 0);
  assert.ok((payload.wakeThresholdDelta ?? 0) < 0, 'corrections ease the wake threshold');

  SeedProcess.createAblatedTwin(dir, twin);
  const twinRecords = new SeedLedger(twin).readAll();
  const ablationRecord = twinRecords.filter((r) => r.category === 'development').at(-1);
  assert.equal((ablationRecord?.payload as { ablation?: boolean }).ablation, true, 'the knife leaves a receipt');
});

test('bounds hold under heavy teaching: no runaway weights, thresholds, or trust', (t) => {
  const dir = makeDir(t, 'bounds');
  const seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 777_005 });
  for (let i = 0; i < 60; i++) {
    const mm = String(i % 60).padStart(2, '0');
    const hh = String(10 + Math.floor(i / 60)).padStart(2, '0');
    seed.transition(fixedEvent(`workreview:h-${i}`, 'correction', `2026-08-07T${hh}:${mm}:00.000Z`));
  }
  seed.checkpoint();
  const restored = SeedProcess.restore(dir);
  const state = restored.getState();
  assert.ok(state.developmentMagnitude > 0);
  // Wake delta bounded at -0.15; salience weights clipped at 0.5/slot across
  // 64 slots + novelty + routing (0.3) + trust (0.5 over baseline) per cell:
  // magnitude has a hard ceiling ~66 per cell. 60 corrections must not breach it.
  assert.ok(state.developmentMagnitude < 70, `learned mass must stay bounded (got ${state.developmentMagnitude})`);
});

test('MIGRATION: a pre-plasticity (v1) checkpoint restores cleanly with empty development', async (t) => {
  const dir = makeDir(t, 'migrate');
  const seed = SeedProcess.initialize(dir, undefined, { reservoirSeed: 777_006 });
  seed.transition(fixedEvent('warm:m1', 'observation', '2026-08-07T09:00:00.000Z'));

  // Forge a v1 checkpoint the way Cut 2 wrote them: no development field.
  // (The live resident's checkpoints are exactly this shape.)
  const ck = seed.checkpoint();
  const ckPath = join(dir, 'checkpoints', `${ck}.json`);
  const manifest = JSON.parse(readFileSync(ckPath, 'utf-8'));
  delete manifest.development;
  manifest.version = 1;
  // v1 hashes were computed WITHOUT development — recompute the v1 way.
  const { computeStateHash } = await import('../src/checkpoint.js');
  manifest.stateHash = computeStateHash({ cells: manifest.cells, dispositions: manifest.dispositions });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(ckPath, JSON.stringify(manifest, null, 2), 'utf-8');
  const indexPath = join(dir, 'checkpoints', 'CHECKPOINT_INDEX.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
  index.checkpoints[index.checkpoints.length - 1].stateHash = manifest.stateHash;
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');

  const restored = SeedProcess.restore(dir);
  assert.equal(restored.getState().developmentMagnitude, 0, 'v1 seed resumes with empty development');
  restored.transition(fixedEvent('workreview:m2', 'correction', '2026-08-07T09:10:00.000Z'));
  assert.ok(restored.getState().developmentMagnitude > 0, 'and starts learning from its first post-migration correction');
  const ck2 = restored.checkpoint();
  const m2 = JSON.parse(readFileSync(join(dir, 'checkpoints', `${ck2}.json`), 'utf-8'));
  assert.equal(m2.version, 2, 'next checkpoint upgrades to v2');
});
