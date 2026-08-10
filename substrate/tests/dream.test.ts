/**
 * dream.v1 (REM) — the other half of sleep. Consolidation (NREM) retains
 * and decays mechanically at quiet-gap end; the dream is the mind WORKING
 * the residue at waking. Pins: the gap marks a pending dream, consumed
 * exactly once; the runner drives a dream recruitment under the lobe
 * guard; the packet flag reaches the prompt (DREAM CYCLE contract) and
 * the chain receipt (payload.dream); no gap → no dream.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import { SeedRunner } from '../src/runner.js';
import { buildLobePrompt, EchoLobe } from '../src/lobe.js';
import type { WorkspacePacket } from '../src/types.js';

function makeDir(prefix: string, t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function harnessLine(i: number, ts: string): string {
  // Corrections: the strongest contact signal — guarantees admission so the
  // dream recruitment has something to work at waking.
  return JSON.stringify({
    event_id: `he_${i}`,
    event_type: 'MemoryChallenged',
    session_id: `s${i}`,
    timestamp: ts,
    actor: 'test',
    payload: {},
  });
}

test('a quiet gap marks a pending dream; consumption is exactly-once; no gap → no dream', (t) => {
  const stateDir = makeDir('dream-state-', t);
  const seed = SeedProcess.initialize(stateDir);
  t.after(() => { try { seed.stop(); } catch { /* stopped in test */ } });

  seed.transition({
    eventId: 'e1', category: 'observation', sourceAuthority: 'external.inert',
    sourceRef: 'test:a', payload: {}, producedAt: '2026-08-09T10:00:00.000Z',
  });
  assert.equal(seed.consumePendingDream(), null, 'first contact is birth, not waking');

  // 5 minutes later — no gap (threshold is 30min event-time).
  seed.transition({
    eventId: 'e2', category: 'observation', sourceAuthority: 'external.inert',
    sourceRef: 'test:b', payload: {}, producedAt: '2026-08-09T10:05:00.000Z',
  });
  assert.equal(seed.consumePendingDream(), null, 'no gap → no dream');

  // 2 hours later — the gap ended; the seed wakes with a pending dream.
  seed.transition({
    eventId: 'e3', category: 'observation', sourceAuthority: 'external.inert',
    sourceRef: 'test:c', payload: {}, producedAt: '2026-08-09T12:05:00.000Z',
  });
  const dream = seed.consumePendingDream();
  assert.ok(dream !== null, 'gap end marks the dream');
  assert.ok(dream.quietSeconds >= 7000, 'carries the quiet duration');
  assert.equal(seed.consumePendingDream(), null, 'consumed exactly once');
});

test('the DREAM CYCLE contract enters the prompt only when the packet dreams', () => {
  const base: WorkspacePacket = {
    activeCellIds: ['world.home23'], eventRefs: [], tensions: [], predictions: [],
    uncertainty: 0.5, requestedCapability: 'lobe.recruit.model', authorityCeiling: 'propose',
    tokenBudget: 1000, outputContract: { allowedOutputKinds: ['stateDeltas'], maxTokenBudget: 1000 },
  };
  assert.ok(!buildLobePrompt(base).includes('DREAM CYCLE'), 'waking prompt carries no dream contract');
  const dreaming = { ...base, dream: { quietSeconds: 5400 } };
  const prompt = buildLobePrompt(dreaming);
  assert.ok(prompt.includes('DREAM CYCLE'), 'dream contract present');
  assert.ok(prompt.includes('~90 minutes'), 'names the quiet duration');
  assert.ok(prompt.includes('RESOLVE open predictions'), 'resolution duty rides the dream');
});

test('RUNNER: waking after a gap drives a dream recruitment; the chain receipt shows it', async (t) => {
  const srcDir = makeDir('dream-src-', t);
  const stateDir = makeDir('dream-run-', t);
  const sourcePath = join(srcDir, 'event-ledger.jsonl');
  // Enough pre-gap contact to make cells admissible, then the gap, then waking.
  const before = Array.from({ length: 9 }, (_, i) => harnessLine(i, `2026-08-09T10:0${i}:00.000Z`));
  writeFileSync(sourcePath, before.join('\n') + '\n');

  const lobe = new EchoLobe();
  const runner = new SeedRunner({
    stateDir, sourcePath, fromEnd: false, lobe,
    workspaceEveryN: 4, checkpointEveryN: 1000, lobeMinIntervalMs: 0,
  });
  runner.start();
  await runner.tick();

  // The gap, then the waking event.
  writeFileSync(sourcePath, before.join('\n') + '\n' + harnessLine(99, '2026-08-09T13:00:00.000Z') + '\n');
  await runner.tick();
  runner.stop();

  const ledger = readFileSync(join(stateDir, 'seed-ledger.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as { category: string; payload?: Record<string, unknown> });
  const dreamReceipts = ledger.filter((r) => r.category === 'lobe' && r.payload?.['dream'] !== undefined);
  assert.equal(dreamReceipts.length, 1, 'exactly one dream recruitment receipted');
  const quiet = (dreamReceipts[0]?.payload?.['dream'] as { quietSeconds: number }).quietSeconds;
  assert.ok(quiet > 10000, 'the receipt carries the quiet the dream worked');
  const consolidations = ledger.filter((r) => r.category === 'development' && r.payload?.['rule'] === 'consolidation.v1');
  assert.ok(consolidations.length >= 1, 'NREM (consolidation) fired at the same gap end');
});
