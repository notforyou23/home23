/**
 * seed-replay-verify — deterministic replay harness.
 *
 *   node seed-replay-verify.js <stateDir> <probes.jsonl>
 *
 * Restores the Seed at <stateDir> (a COPY/branch — never a live resident),
 * replays the probe events in file order, and prints a machine-comparable
 * verdict block: per-cell continuous-state hashes, the full state hash, and
 * development magnitude. Two machines replaying the same bundle must print
 * identical blocks — or the difference IS the finding.
 *
 * Also the probe runner the LIVE-ABLATION-PROTOCOL will use on both arms.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { SeedProcess } from '../src/seed.js';
import { continuousStateHash } from '../src/cells.js';
import type { SourceEvent } from '../src/types.js';

const stateDir = process.argv[2];
const probesPath = process.argv[3];
if (stateDir === undefined || probesPath === undefined) {
  console.error('usage: seed-replay-verify <stateDir> <probes.jsonl>');
  process.exit(2);
}

const probes: SourceEvent[] = readFileSync(resolve(probesPath), 'utf-8')
  .split('\n')
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as SourceEvent);

/**
 * LIVE-RESIDENT GUARD (added 2026-08-13).
 *
 * This script calls seed.transition(), which APPENDS to whatever chain it is
 * pointed at. The docstring above has always said "a COPY/branch — never a
 * live resident" — and until now nothing enforced it. Aimed at a live state
 * dir, the ablation protocol's own probe runner would fork the individual's
 * chain and race its runner. A forked chain is never repaired: restore refuses
 * it and it is archived as evidence. That mistake is permanent and it kills an
 * individual, so the instruction is now a mechanism.
 *
 * The .runner.lock is the authoritative pid registry — substrate law is read
 * the lock, never trust pgrep.
 */
const lockPath = join(resolve(stateDir), '.runner.lock');
if (existsSync(lockPath)) {
  const pid = Number(readFileSync(lockPath, 'utf-8').trim());
  let alive = false;
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (e) {
      // ESRCH = no such process (dead). EPERM = it EXISTS but is not ours — alive.
      alive = (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
  if (alive) {
    console.error(`REFUSED: ${stateDir} has a LIVE runner (pid ${pid}).`);
    console.error('This tool appends to the chain — replaying here would FORK it,');
    console.error('and a forked chain is never repaired. Copy the state dir first');
    console.error('and replay the copy.');
    process.exit(3);
  }
  console.error(`note: stale .runner.lock (pid ${pid} not alive) — proceeding`);
}

const seed = SeedProcess.restore(resolve(stateDir));
const before = seed.getState();
console.log(`REPLAY-VERIFY v1`);
console.log(`node=${process.version} arch=${process.arch} platform=${process.platform}`);
console.log(`seed=${before.seedId} fromSeq=${before.ledgerSeq} probes=${probes.length}`);

const routes: string[] = [];
for (const probe of probes) {
  const result = seed.transition(probe);
  routes.push(`${probe.eventId}->${result.cellId}`);
}

const after = seed.getState();
console.log(`routes=${routes.join(',')}`);
for (const cellId of after.cellIds) {
  const cell = seed.getCell(cellId);
  if (cell !== undefined) console.log(`cell=${cellId} gen=${cell.generation} csh=${continuousStateHash(cell)}`);
}
console.log(`stateHash=${after.stateHash}`);
console.log(`developmentMagnitude=${after.developmentMagnitude}`);
console.log(`ledgerSeq=${after.ledgerSeq}`);
