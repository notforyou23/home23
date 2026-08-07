/**
 * Seed runner entry point (shadow mode).
 *
 *   SEED_STATE_DIR      — the Seed's own state root (required)
 *   SEED_SOURCE         — harness event-ledger.jsonl to tail read-only (required)
 *   SEED_MAX_EVENTS     — stop after N transitions (transient/proof runs)
 *   SEED_BACKFILL_BYTES — start this many bytes before the source's end
 *   SEED_LOBE           — 'echo' recruits the deterministic EchoLobe; unset = none
 *   SEED_POLL_MS        — poll interval (default 2000)
 *
 * No PM2 registration here — persistent residency is an explicit operator
 * decision, not a side effect of running this file.
 */

import { SeedRunner } from '../src/runner.js';
import { EchoLobe } from '../src/lobe.js';

const stateDir = process.env['SEED_STATE_DIR'];
const sourcePath = process.env['SEED_SOURCE'];
if (stateDir === undefined || sourcePath === undefined) {
  console.error('SEED_STATE_DIR and SEED_SOURCE are required');
  process.exit(2);
}

const numEnv = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const runner = new SeedRunner({
  stateDir,
  sourcePath,
  maxEvents: numEnv('SEED_MAX_EVENTS'),
  backfillBytes: numEnv('SEED_BACKFILL_BYTES'),
  pollMs: numEnv('SEED_POLL_MS') ?? 2000,
  lobe: process.env['SEED_LOBE'] === 'echo' ? new EchoLobe() : undefined,
  log: (line) => console.log(`[seed] ${line}`),
});

process.on('SIGINT', () => runner.requestStop());
process.on('SIGTERM', () => runner.requestStop());

runner.run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[seed] fatal:', error);
    process.exit(1);
  });
