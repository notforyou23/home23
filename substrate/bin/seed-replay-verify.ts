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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
