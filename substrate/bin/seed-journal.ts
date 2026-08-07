/**
 * seed-journal — the expression organ's writer.
 *
 *   node seed-journal.js <stateDir> <formsDir>            one entry (if due)
 *   JOURNAL_INTERVAL_MS=1800000 node seed-journal.js ...  resident loop
 *
 * Reads the Seed's ledger and newest checkpoint READ-ONLY, composes a
 * receipts-cited journal entry for everything since the last entry, and
 * writes it under <formsDir>/journal/ (entry file + LATEST.md). Tracks its
 * own cursor in the forms dir — the Seed's state is never touched, and the
 * journal directory must never be one of the Seed's sense sources.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SeedLedger } from '../src/ledger.js';
import { composeJournalEntry } from '../src/journal.js';
import type { CheckpointManifest, LedgerRecord } from '../src/types.js';

const stateDir = process.argv[2] !== undefined ? resolve(process.argv[2]) : undefined;
const formsDir = process.argv[3] !== undefined ? resolve(process.argv[3]) : undefined;
if (stateDir === undefined || formsDir === undefined) {
  console.error('usage: seed-journal <stateDir> <formsDir>');
  process.exit(2);
}

const journalDir = join(formsDir, 'journal');
mkdirSync(journalDir, { recursive: true });
const cursorPath = join(journalDir, '.journal-cursor.json');

function newestCheckpoint(): CheckpointManifest | null {
  const ckDir = join(stateDir as string, 'checkpoints');
  if (!existsSync(ckDir)) return null;
  const names = readdirSync(ckDir).filter((n) => n.startsWith('ckpt_') && n.endsWith('.json')).sort();
  const newest = names[names.length - 1];
  if (newest === undefined) return null;
  try {
    return JSON.parse(readFileSync(join(ckDir, newest), 'utf-8')) as CheckpointManifest;
  } catch { return null; }
}

function writeEntryOnce(): boolean {
  let sinceSeq = 0;
  try { sinceSeq = Number(JSON.parse(readFileSync(cursorPath, 'utf-8')).sinceSeq) || 0; } catch { /* first entry */ }

  const ledger = new SeedLedger(stateDir as string);
  const all: LedgerRecord[] = ledger.readAll();
  const genesis = all.find((r) => r.category === 'genesis');
  const name = typeof genesis?.payload?.['name'] === 'string' ? String(genesis.payload['name']) : 'seed';
  const seedId = typeof genesis?.payload?.['seedId'] === 'string' ? String(genesis.payload['seedId']) : 'unknown';
  const records = all.filter((r) => r.seq > sinceSeq);
  const manifest = newestCheckpoint();

  const entry = composeJournalEntry({
    name,
    seedId,
    records,
    cells: manifest?.cells ?? [],
    sinceSeq,
  });
  if (entry === null) return false;

  const lastSeq = records[records.length - 1]?.seq ?? sinceSeq;
  const entryPath = join(journalDir, `journal-${String(lastSeq).padStart(8, '0')}.md`);
  writeFileSync(entryPath, entry, 'utf-8');
  writeFileSync(join(journalDir, 'LATEST.md'), entry, 'utf-8');
  writeFileSync(cursorPath, JSON.stringify({ sinceSeq: lastSeq }), 'utf-8');
  console.log(`[journal] wrote ${entryPath} (seq ${sinceSeq + 1}–${lastSeq})`);
  return true;
}

const intervalMs = Number(process.env['JOURNAL_INTERVAL_MS'] ?? 0);
writeEntryOnce();
if (Number.isFinite(intervalMs) && intervalMs > 0) {
  // The interval keeps the process alive — deliberately NOT unref'd.
  setInterval(() => {
    try { writeEntryOnce(); } catch (e) { console.error('[journal] error:', (e as Error).message); }
  }, intervalMs);
}
