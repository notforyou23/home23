import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import { WORKSPACE_CAPACITY, scoreCells, admissionScore } from '../src/workspace.js';
import { makeInitialCells } from '../src/cells.js';
import type { SourceEvent } from '../src/types.js';
import { TEST_ANATOMY } from './named-anatomy.js';

function makeDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-workspace-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixedEvent(ref: string, category: SourceEvent['category'], producedAt: string): SourceEvent {
  return {
    eventId: `evt_${ref}`,
    category,
    sourceAuthority: 'seed.adapter',
    sourceRef: ref,
    payload: {},
    producedAt,
  };
}

test('a fresh quiet seed is SILENT, and the silence is receipted', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY, reservoirSeed: 31 });

  const outcome = seed.workspaceCycle('2026-08-07T10:00:00.000Z');
  assert.equal(outcome.kind, 'silence', 'no pressure, no admission — silence is the correct transition');

  const records = seed.getState();
  assert.ok(records.ledgerSeq >= 2, 'silence must leave a ledger receipt');
});

test('pressure from real contact admits the pressured cell; admission spends the pressure', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY, reservoirSeed: 32 });

  // A burst of corrections routed to contact.jtr-jerry builds pressure there.
  for (let i = 0; i < 8; i++) {
    seed.transition(fixedEvent(`corr-${i}`, 'correction', `2026-08-07T10:0${i}:00.000Z`));
  }

  const first = seed.workspaceCycle('2026-08-07T10:10:00.000Z');
  assert.equal(first.kind, 'workspace', 'sustained correction pressure must cross the workspace threshold');
  if (first.kind === 'workspace') {
    assert.ok(
      first.packet.activeCellIds.includes('contact.jtr-jerry'),
      `the pressured cell must be admitted (got ${first.packet.activeCellIds.join(', ')})`,
    );
    assert.ok(first.packet.eventRefs.length > 0, 'the packet must carry real reality refs, not narration');
  }

  // Admission released the pressure — an immediate second cycle without new
  // contact must fall back toward silence (scarcity, not a standing broadcast).
  const second = seed.workspaceCycle('2026-08-07T10:11:00.000Z');
  if (second.kind === 'workspace') {
    assert.ok(
      !second.packet.activeCellIds.includes('contact.jtr-jerry'),
      'an admitted cell must not stay in the workspace with no new contact',
    );
  }
});

test('scarcity: never more than WORKSPACE_CAPACITY cells admitted', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY, reservoirSeed: 33 });

  // Pump three different cells via their routing categories.
  const pump: Array<[string, SourceEvent['category']]> = [
    ['a', 'correction'],      // contact.jtr-jerry
    ['b', 'observation'],     // world.home23
    ['c', 'consequence'],     // project.shakedown
  ];
  for (let round = 0; round < 8; round++) {
    for (const [ref, category] of pump) {
      seed.transition(fixedEvent(`${ref}-${round}`, category, `2026-08-07T1${round}:0${pump.findIndex(([r]) => r === ref)}:00.000Z`));
    }
  }

  const outcome = seed.workspaceCycle('2026-08-07T19:00:00.000Z');
  assert.equal(outcome.kind, 'workspace');
  if (outcome.kind === 'workspace') {
    assert.ok(
      outcome.packet.activeCellIds.length <= WORKSPACE_CAPACITY,
      `admitted ${outcome.packet.activeCellIds.length} > capacity ${WORKSPACE_CAPACITY}`,
    );
    const admitted = outcome.scores.filter((s) => s.admitted).length;
    assert.ok(admitted <= WORKSPACE_CAPACITY);
  }
});

test('inhibition damps non-admitted pressure — repeated silence cycles shrink pressure monotonically', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY, reservoirSeed: 34 });

  // One mild event: some pressure, below admission threshold.
  seed.transition(fixedEvent('mild', 'interpretation', '2026-08-07T10:00:00.000Z'));

  const pressures: number[] = [];
  for (let i = 0; i < 4; i++) {
    const cell = seed.getCell('frontier.substrate-os');
    assert.ok(cell !== undefined);
    pressures.push(cell.workspacePressure);
    seed.workspaceCycle(`2026-08-07T10:0${i + 1}:00.000Z`);
  }
  for (let i = 1; i < pressures.length; i++) {
    const prev = pressures[i - 1] ?? 0;
    const curr = pressures[i] ?? 0;
    assert.ok(curr <= prev, `pressure must not ratchet under silence (step ${i}: ${prev} → ${curr})`);
  }
});

test('workspace outcomes are deterministic pure functions of cell state', () => {
  const cellsA = makeInitialCells('2026-08-07T10:00:00.000Z', TEST_ANATOMY);
  const cellsB = makeInitialCells('2026-08-07T10:00:00.000Z', TEST_ANATOMY);
  const dispositions = { globalWakeThreshold: 0.3, silencePolicy: 'default' as const, modelRecruitmentPolicy: 'none' as const, quietTimeEnabled: false };
  const s1 = scoreCells(cellsA.values(), dispositions);
  const s2 = scoreCells(cellsB.values(), dispositions);
  assert.deepEqual(s1, s2);
  for (const cell of cellsA.values()) {
    const score = admissionScore(cell);
    assert.ok(score >= 0 && score <= 1);
  }
});

test('workspace and silence receipts carry before/after state hashes that verify', (t) => {
  const dir = makeDir(t);
  const seed = SeedProcess.initialize(dir, undefined, { anatomy: TEST_ANATOMY, reservoirSeed: 35 });
  seed.transition(fixedEvent('x', 'correction', '2026-08-07T10:00:00.000Z'));
  seed.workspaceCycle('2026-08-07T10:01:00.000Z');
  seed.stop();

  const restored = SeedProcess.restore(dir);
  assert.ok(restored.getState().ledgerSeq >= 4, 'transition + workspace + checkpoint + stop must all be receipted');
});
