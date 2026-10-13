/**
 * Explicit operator opt-in for an existing Seed. Stop its runner first.
 *
 * node --import tsx substrate/bin/seed-enable-owner-voice.ts \
 *   <stateDir> <authorizedBy> <asOf ISO timestamp>
 *
 * Appends a typed growth receipt and checkpoint; never repairs old records,
 * reassigns prior contact, or changes the individual's encoder.
 */
import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SeedLedger } from '../src/ledger.js';
import { SeedProcess } from '../src/seed.js';
import { RESIDENT_RESOURCE_BUDGET } from '../src/resource.js';

const [stateDirArg, authorizedBy, asOf, extra] = process.argv.slice(2);
if (!stateDirArg || !authorizedBy?.trim() || !asOf || extra !== undefined
  || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(asOf)
  || !Number.isFinite(Date.parse(asOf))
  || new Date(asOf).toISOString() !== asOf.replace(/Z$/, asOf.includes('.') ? 'Z' : '.000Z')) {
  console.error('usage: seed-enable-owner-voice <stateDir> <authorizedBy> <asOf ISO timestamp>');
  process.exit(2);
}

const stateDir = resolve(stateDirArg);
if (!SeedLedger.exists(stateDir)) {
  console.error('REFUSED: an existing Seed ledger is required; this command does not create a Seed.');
  process.exit(1);
}

const lockPath = join(stateDir, '.runner.lock');
let lockFd: number;
try {
  lockFd = openSync(lockPath, 'wx');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
    console.error('REFUSED: the runner lock is occupied. Stop the runner and resolve stale locks before applying growth.');
    process.exit(3);
  }
  console.error('REFUSED: unable to acquire the runner lock.');
  process.exit(1);
}

try {
  writeFileSync(lockFd, String(process.pid));
  const seed = SeedProcess.restore(stateDir, undefined, {
    requireCheckpointCoversTail: true, budget: RESIDENT_RESOURCE_BUDGET,
  });
  const result = seed.enableOwnerVoice(authorizedBy.trim(), asOf);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`REFUSED: ${error instanceof Error ? error.message : 'owner voice growth failed'}`);
  process.exitCode = 1;
} finally {
  closeSync(lockFd);
  unlinkSync(lockPath);
}
