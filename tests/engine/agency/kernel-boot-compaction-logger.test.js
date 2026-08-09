import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgencyKernel } from '../../../engine/src/agency/resident-kernel.js';
import { SimpleLogger } from '../../../engine/lib/simple-logger.js';

// Regression: engine boot passes SimpleLogger (debug/info/warn/error — no
// .log) into AgencyKernel. When the pursuits ledger crossed the boot
// compaction threshold, the kernel's success message called this.logger.log,
// the constructor threw, and the whole [channels] init block in
// engine/src/index.js died with it — channel bus, decay worker, MemoryIngest
// — at every boot on live agents. The console default in tests masked it.

function bloatedBrainDir() {
  const dir = mkdtempSync(join(tmpdir(), 'home23-agency-logger-'));
  const agencyDir = join(dir, 'agency');
  mkdirSync(agencyDir, { recursive: true });
  // Superseded rows for one pursuit id push the ledger past the 8MB
  // compaction threshold while compacting down to a single live row.
  const row = JSON.stringify({
    type: 'updated',
    at: '2026-08-01T00:00:00.000Z',
    pursuit: { id: 'p_bloat', status: 'active', title: 'bloat row '.repeat(64) },
  });
  const target = 9 * 1024 * 1024;
  const rows = [];
  for (let bytes = 0; bytes < target; bytes += row.length + 1) rows.push(row);
  writeFileSync(join(agencyDir, 'pursuits.jsonl'), `${rows.join('\n')}\n`);
  return { dir, ledgerPath: join(agencyDir, 'pursuits.jsonl') };
}

test('AgencyKernel boots with the engine SimpleLogger when ledger compaction fires', () => {
  const { dir, ledgerPath } = bloatedBrainDir();
  const before = statSync(ledgerPath).size;

  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
    logger: new SimpleLogger('error'),
  });

  assert.ok(kernel);
  const after = statSync(ledgerPath).size;
  assert.ok(after < before, `compaction must fire for this test to mean anything (before=${before}, after=${after})`);
});

test('AgencyKernel boot survives a logger with no methods at all', () => {
  const { dir, ledgerPath } = bloatedBrainDir();
  const before = statSync(ledgerPath).size;

  const kernel = new AgencyKernel({
    brainDir: dir,
    agentName: 'jerry',
    config: { enabled: true, mode: 'dry_run' },
    logger: {},
  });

  assert.ok(kernel);
  const after = statSync(ledgerPath).size;
  assert.ok(after < before, `compaction must fire for this test to mean anything (before=${before}, after=${after})`);
});
