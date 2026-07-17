#!/usr/bin/env node
'use strict';

/**
 * Drain an agency pursuits.jsonl ledger down to its live state.
 *
 * The ledger is append-only and the engine's loadPursuitIndex keeps only the
 * LATEST record per pursuit id — all history is dead weight to the kernel.
 * jerry's reached 661MB (past V8's ~536MB string limit; bus init died reading
 * it at boot, 2026-07-17). This keeps the newest record per pursuit id,
 * re-diets it (evidence cap, no linkedEvidence, history cap), and atomically
 * replaces the file. The original is gzipped into ~/brain-backups first.
 *
 * RUN WITH THE AGENT'S ENGINE STOPPED — the engine appends to this file.
 *
 * Usage: node scripts/compact-pursuits-ledger.cjs <agent> [--apply]
 * Default is dry-run (prints what would happen, writes nothing).
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');

const MAX_PERSISTED_EVIDENCE = 40;

function diet(pursuit) {
  if (!pursuit || typeof pursuit !== 'object') return pursuit;
  const evidence = Array.isArray(pursuit.evidence)
    ? pursuit.evidence.slice(-MAX_PERSISTED_EVIDENCE)
    : [];
  const out = {
    ...pursuit,
    evidence,
    latestEvidence: Array.isArray(pursuit.latestEvidence)
      ? pursuit.latestEvidence.slice(-3)
      : evidence.slice(-3),
    history: Array.isArray(pursuit.history) ? pursuit.history.slice(-25) : [],
  };
  delete out.linkedEvidence;
  return out;
}

async function main() {
  const agent = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!agent || !/^[A-Za-z0-9_-]+$/.test(agent)) {
    console.error('usage: node scripts/compact-pursuits-ledger.cjs <agent> [--apply]');
    process.exit(2);
  }
  const home23Root = path.resolve(__dirname, '..');
  const ledgerPath = path.join(home23Root, 'instances', agent, 'brain', 'agency', 'pursuits.jsonl');
  if (!fs.existsSync(ledgerPath)) {
    console.error(`no ledger at ${ledgerPath}`);
    process.exit(1);
  }
  const beforeBytes = fs.statSync(ledgerPath).size;

  // Pass 1 (streaming): newest record per pursuit id. Rows without a pursuit
  // id are invisible to loadPursuitIndex — dropped, but counted loudly.
  const latest = new Map();
  let linesIn = 0;
  let orphanRows = 0;
  let unparseable = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(ledgerPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    linesIn += 1;
    let row;
    try { row = JSON.parse(line); } catch { unparseable += 1; continue; }
    const id = row?.pursuit?.id;
    if (!id) { orphanRows += 1; continue; }
    latest.set(id, row);
  }

  const report = {
    agent,
    linesIn,
    pursuitsKept: latest.size,
    orphanRowsDropped: orphanRows,
    unparseableDropped: unparseable,
    beforeMB: Math.round(beforeBytes / 1048576),
  };

  if (!apply) {
    console.log('DRY RUN', JSON.stringify(report));
    return;
  }

  // Backup: gzip the original before touching anything.
  const backupDir = path.join(process.env.HOME || '/Users/jtr', 'brain-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `pursuits-${agent}-${stamp}.jsonl.gz`);
  await pipeline(
    fs.createReadStream(ledgerPath),
    zlib.createGzip({ level: 6 }),
    fs.createWriteStream(backupPath),
  );

  // Atomic rewrite: temp file in the same dir, fsync, rename.
  const tmpPath = `${ledgerPath}.compact-tmp`;
  const out = fs.createWriteStream(tmpPath, { flags: 'wx' });
  for (const row of latest.values()) {
    const compacted = { ...row, pursuit: diet(row.pursuit) };
    out.write(`${JSON.stringify(compacted)}\n`);
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  const fd = fs.openSync(tmpPath, 'r');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmpPath, ledgerPath);

  report.afterMB = Math.round(fs.statSync(ledgerPath).size / 1048576 * 100) / 100;
  report.backup = backupPath;
  console.log('APPLIED', JSON.stringify(report));
}

main().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
