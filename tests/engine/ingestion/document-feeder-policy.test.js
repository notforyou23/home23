import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DocumentFeeder } = require('../../../engine/src/ingestion/document-feeder');

function makeFeeder(config = {}, logs = []) {
  return new DocumentFeeder({
    memory: { embed: async () => null },
    config,
    logger: {
      info: (message, meta) => logs.push({ level: 'info', message, meta }),
      warn: (message, meta) => logs.push({ level: 'warn', message, meta }),
      debug: () => {},
      error: (message, meta) => logs.push({ level: 'error', message, meta }),
    },
  });
}

test('document feeder applies configured exclude globs outside chokidar', () => {
  const feeder = makeFeeder({
    excludePatterns: [
      '**/health_jtr/raw_ingest/**',
      '**/health_jtr/ledgers/*.jsonl',
    ],
  });

  assert.equal(
    feeder._shouldIgnorePath('/tmp/home23/health_jtr/raw_ingest/healthkit_2026.json'),
    true
  );
  assert.equal(
    feeder._shouldIgnorePath('/tmp/home23/health_jtr/ledgers/daily_metrics.jsonl'),
    true
  );
  assert.equal(
    feeder._shouldIgnorePath('/tmp/home23/health_jtr/ledgers/pressure_correlation.json'),
    false
  );
});

test('document feeder skips oversized files before reading or compiling', async () => {
  const logs = [];
  const feeder = makeFeeder({ maxFileBytes: 5 }, logs);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-feeder-'));
  const filePath = path.join(dir, 'large.txt');
  fs.writeFileSync(filePath, '0123456789', 'utf8');

  await feeder._processFile(filePath, 'tmp');

  assert.equal(logs.some(entry => entry.message === 'Skipping file above feeder maxFileBytes'), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
