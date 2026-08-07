/**
 * seed-status — read-only check-in on a resident Seed.
 *
 *   npm run seed:status              (defaults to jerry's seed-01)
 *   npm run seed:status -- <stateDir>
 *
 * Reads the ledger and latest checkpoint; writes NOTHING. Reports the life,
 * the development, and progress toward the LIVE-ABLATION-PROTOCOL trigger
 * (≥20 development receipts with ≥8 organic, or 7 days of residence).
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SeedLedger } from '../src/ledger.js';
import type { LedgerRecord, CheckpointManifest, SerializedCell, Prediction } from '../src/types.js';

const DEFAULT_DIR = resolve(import.meta.dirname ?? '.', '../../instances/jerry/substrate/seed-01');
const stateDir = process.argv[2] !== undefined ? resolve(process.argv[2]) : DEFAULT_DIR;

/** Backfill boundary from the protocol: development caused by events produced
 * after the spine widened counts as ORGANIC. */
const ORGANIC_AFTER = '2026-08-07T16:30:00.000Z';
const RESIDENCE_START = '2026-08-07T16:30:00.000Z';
const TRIGGER_RECEIPTS = 20;
const TRIGGER_ORGANIC = 8;
const TRIGGER_DAYS = 7;

if (!existsSync(join(stateDir, 'seed-ledger.jsonl'))) {
  console.error(`No seed ledger at ${stateDir}`);
  process.exit(2);
}

const ledger = new SeedLedger(stateDir);
const chain = ledger.verifyChain();
const records: LedgerRecord[] = ledger.readAll();

const byCategory: Record<string, number> = {};
for (const r of records) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;

const genesis = records.find((r) => r.category === 'genesis');
const seedId = typeof genesis?.payload['seedId'] === 'string' ? genesis.payload['seedId'] : 'unknown';
const lifetimes = (byCategory['stop'] ?? 0) + 1;

const dev = records.filter((r) => r.category === 'development');
const corrections = dev.filter((r) => r.payload['rule'] === 'correction.v1');
const consequences = dev.filter((r) => r.payload['rule'] === 'consequence.v1');
const consolidations = dev.filter((r) => r.payload['rule'] === 'consolidation.v1');
const organic = dev.filter((r) => {
  const producedAt = r.payload['producedAt'];
  return typeof producedAt === 'string' && producedAt > ORGANIC_AFTER;
});
const lastDev = dev.at(-1);
const magnitude = typeof lastDev?.payload['developmentMagnitude'] === 'number'
  ? lastDev.payload['developmentMagnitude'] : 0;

const lastRecord = records.at(-1);
const lastActivityMs = lastRecord !== undefined ? Date.now() - Date.parse(lastRecord.issuedAt) : Infinity;
const idleMinutes = Math.round(lastActivityMs / 60000);

// Latest checkpoint: open predictions + cell anatomy.
let openPredictions: Array<{ cellId: string; claim: string; horizon: string }> = [];
let cellLine = '';
try {
  const ckDir = join(stateDir, 'checkpoints');
  const newest = readdirSync(ckDir)
    .filter((n) => n.startsWith('ckpt_') && n.endsWith('.json'))
    .map((n) => ({ n, m: Number(readFileSync(join(ckDir, n), 'utf-8').length) }))
    .sort((a, b) => a.n.localeCompare(b.n))
    .at(-1);
  if (newest !== undefined) {
    const manifest = JSON.parse(readFileSync(join(ckDir, newest.n), 'utf-8')) as CheckpointManifest;
    cellLine = manifest.cells
      .map((c: SerializedCell) => `${c.id.split('.')[1] ?? c.id}:g${c.generation}`)
      .join('  ');
    for (const cell of manifest.cells) {
      for (const p of cell.predictions as Prediction[]) {
        if (p.resolvedAt === undefined) openPredictions.push({ cellId: cell.id, claim: p.claim.slice(0, 80), horizon: p.horizon });
      }
    }
  }
} catch { /* checkpoint unreadable — chain report already covers integrity */ }

const daysResident = (Date.now() - Date.parse(RESIDENCE_START)) / 86_400_000;
const triggerByCount = dev.length >= TRIGGER_RECEIPTS && organic.length >= TRIGGER_ORGANIC;
const triggerByTime = daysResident >= TRIGGER_DAYS;

console.log(`── Seed status ─ ${seedId}`);
console.log(`chain: ${chain.ok ? 'VERIFIED' : `BROKEN (${chain.errors.length} errors)`} | records: ${records.length} | lifetime: ${lifetimes} | last activity: ${idleMinutes}m ago`);
console.log(`life: ${byCategory['transition'] ?? 0} transitions | ${byCategory['workspace'] ?? 0} admissions | ${byCategory['silence'] ?? 0} silences | ${byCategory['lobe'] ?? 0} lobe recruitments`);
console.log(`development: ${dev.length} receipts (${corrections.length} corrections, ${consequences.length} consequences, ${consolidations.length} consolidations) | learned mass: ${magnitude.toFixed(4)}`);
console.log(`anatomy: ${cellLine}`);
if (openPredictions.length > 0) {
  console.log(`open predictions (${openPredictions.length}):`);
  for (const p of openPredictions.slice(0, 5)) console.log(`  [${p.cellId}] ${p.claim} (horizon ${p.horizon})`);
}
console.log(`── Knife trigger (LIVE-ABLATION-PROTOCOL) ─`);
console.log(`receipts: ${dev.length}/${TRIGGER_RECEIPTS} | organic: ${organic.length}/${TRIGGER_ORGANIC} | residence: ${daysResident.toFixed(1)}/${TRIGGER_DAYS} days`);
if (triggerByCount || triggerByTime) {
  console.log(`>>> TRIGGER MET (${triggerByCount ? 'development threshold' : 'time threshold'}) — the experiment may run. Do not run it casually; follow the quiesce runbook.`);
} else {
  const eta = new Date(Date.parse(RESIDENCE_START) + TRIGGER_DAYS * 86_400_000).toISOString().slice(0, 10);
  console.log(`trigger not met — time threshold lands ${eta} unless development gets there first.`);
}
